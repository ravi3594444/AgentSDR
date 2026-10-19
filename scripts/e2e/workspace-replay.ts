/**
 * The conversation workspace replayed end to end against the local database:
 * WhatsApp webhooks go through the real ingest (ingestWhatsappWebhook → the
 * CRM bridge), replies through the CRM's classification job, the reply agent
 * and sendDraft, with a stand-in model and a recording send adapter. Every
 * other outgoing request is refused by an intercepted fetch, so nothing
 * leaves the machine.
 *
 *   bun run --conditions=react-server scripts/e2e/workspace-replay.ts
 *
 * The acceptance sequence: a pricing enquiry, the assistant's answer, the
 * owner's own reply from WhatsApp Web (a phone-origin echo), then a newer
 * inbound message. After each step it checks the message order, who answered
 * (from recorded evidence), the actual next action, stale drafts, that the
 * Action required badge equals the list's count, Needs you, and Activity's
 * replies. Around it: a pending and a proposed classification, an unrelated
 * open quote decision that a manual reply leaves open, a draft a manual reply
 * makes stale, a takeover a manual reply leaves in place, wrong-number and Do
 * Not Contact closure, a duplicate and a delayed webhook, an unavailable
 * provider, an unnamed lead shown by business and route, Instagram in the
 * channel filter and the accounts badge, a WhatsApp campaign step that is
 * never read as the owner's answer (one sent through the real sendWhatsapp to
 * a stand-in Unipile keeps that label after the lead is removed from the
 * campaign), the Errors filter narrowing Needs you and All replies (with
 * counts that match), and a second organization that sees and counts nothing.
 *
 * Creates its own organizations ("Workspace replay …") and leaves them.
 * Refuses a non-local DATABASE_URL.
 */
import { and, count, eq } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}

// ------------------------------------------------------------ no provider is reachable
// Except a stand-in Unipile, on a host that cannot resolve, that accepts a message into an existing chat and
// nothing else: the one campaign step sent through the real sendWhatsapp goes there.
const FAKE_UNIPILE = "https://unipile-workspace-replay.invalid";
const unipileSends: string[] = [];
const blocked: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return realFetch(input, init);
  if (url.origin === FAKE_UNIPILE && (init?.method ?? "GET").toUpperCase() === "POST" && /^\/api\/v1\/chats\/[^/]+\/messages$/.test(url.pathname)) {
    unipileSends.push(init?.body instanceof FormData ? String(init.body.get("text") ?? "") : "");
    return new Response(JSON.stringify({ object: "MessageSent", message_id: `wa-replay-unipile-${stamp}-${unipileSends.length}` }), { status: 201, headers: { "content-type": "application/json" } });
  }
  blocked.push(`${(init?.method ?? "GET").toUpperCase()} ${url.origin}${url.pathname}`);
  throw new TypeError(`The workspace replay check allows no outgoing request (${url.origin})`);
}) as typeof fetch;

const stamp = Date.now();
const { db } = await import("@/lib/db");
const { organizations, users, members } = await import("@/lib/auth/schema");
const { companies, people } = await import("@/lib/leads/schema");
const crm = await import("@/lib/crm/schema");
const schema = await import("@/lib/assistant/schema");
const { whatsappAccounts, whatsappMessages, whatsappChats, whatsappCampaigns, whatsappCampaignLeads, whatsappCampaignSends } = await import("@/lib/whatsapp/schema");
const { recordWhatsappOutboundInCrm } = await import("@/lib/whatsapp/crmBridge");
const { sendWhatsapp } = await import("@/lib/whatsapp/send");
const { removeWhatsappCampaignLead } = await import("@/lib/whatsapp/campaigns/campaigns.server");
const { gridProviderCredentials, gridProviders } = await import("@/lib/grid/schema");
const { encryptIntegrationCredentials } = await import("@/lib/integrations/credentials");
const { instagramAccounts } = await import("@/lib/instagram/schema");
const { runInOrganization, currentOrganizationId } = await import("@/lib/tenancy/scope");
const { ensureCrmDefaults } = await import("@/lib/crm/defaults");
const { ingestInboundReply } = await import("@/lib/crm/conversations");
const { handleClassificationJob } = await import("@/lib/crm/handlers");
const { saveDocumentKnowledge, updateBusinessProfile } = await import("@/lib/assistant/profile.server");
const { createAudience } = await import("@/lib/assistant/audiences.server");
const { createThread } = await import("@/lib/assistant/threads.server");
const { takeOverConversation } = await import("@/lib/assistant/decisions.server");
const { isPersonDoNotContact } = await import("@/lib/crm/policies");
const { ingestWhatsappWebhook } = await import("@/lib/whatsapp/messages");
const { getCrmRecordWorkspace, listCrmActions } = await import("@/lib/crm/queries");
const { loadConversationSummaries } = await import("@/lib/crm/conversationSummary.server");
const { conversationSummary, outboundActor } = await import("@/lib/crm/conversationSummary");
const { loadNavBadges } = await import("@/lib/nav/badges.server");
const { listReplies } = await import("@/lib/activity/activity.server");
type AgentModel = import("@/lib/assistant/replyAgent/agent.server").AgentModel;
type CrmSendAdapter = import("@/lib/crm/send").CrmSendAdapter;
type CrmJob = import("@/lib/crm/queue").CrmJob;
type ClassificationCompletion = import("@/lib/crm/ai/types").ClassificationCompletion;
type ConversationSummary = import("@/lib/crm/conversationSummary").ConversationSummary;

let failures = 0;
let passes = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) passes++;
  else failures++;
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 15));

// ------------------------------------------------------------ stand-ins
const sends: { body: string; thread: string | null }[] = [];
const send: CrmSendAdapter = async (input) => {
  sends.push({ body: input.bodyText, thread: input.providerThreadId });
  return { provider: "unipile", providerMessageId: `replay-sent-${stamp}-${sends.length}`, providerThreadId: input.providerThreadId, rfcMessageId: null, response: {} };
};
type Scripted = { action: string; reply?: string; ownerNote?: { kind: string; note: string } | null; category?: string };
const script = new Map<string, () => Scripted>();
const model: AgentModel = async ({ userPrompt }) => {
  const latest = /LEAD'S LATEST MESSAGE:\n([\s\S]*?)(?=\n\nYOUR PREVIOUS ATTEMPT|$)/.exec(userPrompt)?.[1]?.trim() ?? "";
  const answer = script.get(latest)?.() ?? { action: "reply", reply: "Thanks for your message! How many chairs do you have?" };
  const text = JSON.stringify({ reasoning: "stand-in", action: answer.action, reply: answer.reply ?? "", ownerNote: answer.ownerNote ?? null, category: answer.category ?? "other", confidence: 0.9 });
  return { text, provider: "stand-in", model: "stand-in-agent", request: {}, response: {} };
};
const agent = { model, send, allowNonProduction: true, brief: false };
/** The provider is not connected: the real send path, with no adapter. */
const agentWithoutProvider = { model, allowNonProduction: true, brief: false };
const classifierSaying = (categoryKey: string): ClassificationCompletion => async () => ({
  text: JSON.stringify({ categoryKey, subcategoryKey: null, confidence: 0.95, reasoning: "stand-in classifier", suggestedNextActionAt: null }),
  provider: "stand-in", model: "stand-in-classifier", request: {}, response: {},
});

// ------------------------------------------------------------ organizations
async function organization(label: string) {
  const [org] = await db.insert(organizations).values({ name: `Workspace replay ${label} ${stamp}`, slug: `workspace-replay-${label}-${stamp}` }).returning();
  const [owner] = await db.insert(users).values({ name: `Owner ${label}`, email: `owner-${label}-${stamp}@workspace-replay.test`, emailVerified: true }).returning();
  await db.insert(members).values({ organizationId: org!.id, userId: owner!.id, role: "owner" });
  return { org: org!, owner: owner! };
}
const A = await organization("a");
const B = await organization("b");
console.log(`Organizations ${A.org.id} (replayed) and ${B.org.id} (isolation)`);

const WA_ACCOUNT = `wa-replay-${stamp}`;
const ACCOUNT_JID = "919800000001@s.whatsapp.net";
const digits = String(stamp).slice(-6);
const phoneOf = (index: number) => `+9197${digits}${String(index).padStart(2, "0")}`;
type Lead = { key: string; personId: string; phone: string; chatId: string };

const recordIds: string[] = [];
let quoteDecisionId = "";

await runInOrganization(A.org.id, async () => {
  const orgId = currentOrganizationId();
  await ensureCrmDefaults();
  await updateBusinessProfile({ businessName: "Bright Path Dental Supplies", offer: "Same-week servicing for dental chairs and autoclaves", senderName: "Ravi", targetCustomers: "dental clinics", locations: "Pune" }, null);
  await saveDocumentKnowledge("Price list", "Monthly maintenance plan: ₹2,499 per chair per month, includes two visits. Service area: Pune and Pimpri-Chinchwad.");
  await db.insert(whatsappAccounts).values({ organizationId: orgId, unipileAccountId: WA_ACCOUNT, name: "Ravi", phone: "+919800000001", status: "connected", connectedAt: new Date(Date.now() - 7 * 86_400_000) });

  // Leads. The pricing lead has no name of their own, only a clinic.
  const [clinic] = await db.insert(companies).values({ organizationId: orgId, domain: `brightsmile-${stamp}.test`, name: "Bright Smile Clinic", source: "manual" }).returning();
  const lead = async (key: string, index: number, values: Partial<typeof people.$inferInsert> = {}): Promise<Lead> => {
    const [row] = await db.insert(people).values({ organizationId: orgId, phone: phoneOf(index), source: "workspace-replay", ...values }).returning({ id: people.id });
    return { key, personId: row!.id, phone: phoneOf(index), chatId: `wa-replay-chat-${key}-${stamp}` };
  };
  const pricing = await lead("pricing", 1, { companyId: clinic!.id });
  const review = await lead("review", 2, { fullName: "Dr Review" });
  const dnc = await lead("dnc", 3, { fullName: "Dr Stop" });
  const wrong = await lead("wrong", 4, { fullName: "Dr Wrong" });
  const offline = await lead("offline", 5, { fullName: "Dr Offline" });
  const taken = await lead("taken", 6, { fullName: "Dr Takeover" });
  const early = await lead("early", 7, { fullName: "Dr Early" });
  const late = await lead("late", 8, { fullName: "Dr Late" });
  const who = await lead("who", 9, { fullName: "Dr Who" });

  const audienceId = await createAudience({ name: "workspace replay", source: "list" });
  const thread = await createThread(A.owner.id);
  const plan = { assignments: [], sequences: {}, personalizationKey: "p_00000000", samples: [], limits: { maxLeads: 20, emailPerMailboxPerDay: 30, whatsappNewChatsPerDay: null }, excluded: [], estimate: { aiCalls: 0, aiCostUsd: null, days: 1 }, autopilot: true, instructions: null };
  const [autoRun] = await db.insert(schema.outreachRuns).values({ organizationId: orgId, threadId: thread.id, audienceId, name: "Automatic WhatsApp run", status: "running", channels: ["whatsapp"], plan, autopilot: true, approvedAt: new Date(Date.now() - 60_000) }).returning();
  const [reviewRun] = await db.insert(schema.outreachRuns).values({ organizationId: orgId, threadId: thread.id, audienceId, name: "Review WhatsApp run", status: "running", channels: ["whatsapp"], plan: { ...plan, autopilot: false }, autopilot: false }).returning();
  await db.insert(schema.outreachRunLeads).values([
    ...[pricing, dnc, wrong, offline, taken, early, late].map((item) => ({ organizationId: orgId, runId: autoRun!.id, personId: item.personId, channel: "whatsapp" as const })),
    { organizationId: orgId, runId: reviewRun!.id, personId: review.personId, channel: "whatsapp" as const },
  ]);

  // ------------------------------------------------------------ helpers
  let n = 0;
  const jidOf = (item: Lead) => `${item.phone.replace(/\D/g, "")}@s.whatsapp.net`;
  function payload(item: Lead, text: string, options: { id?: string; at?: Date; fromOwner?: boolean } = {}) {
    return {
      event: "message_received",
      account_type: "WHATSAPP",
      account_id: WA_ACCOUNT,
      account_info: { type: "WHATSAPP", user_id: ACCOUNT_JID },
      chat_id: item.chatId,
      message_id: options.id ?? `wa-replay-msg-${stamp}-${(n += 1)}`,
      message: text,
      timestamp: (options.at ?? new Date()).toISOString(),
      is_sender: Boolean(options.fromOwner),
      sender: options.fromOwner ? { attendee_provider_id: ACCOUNT_JID, attendee_name: "Ravi" } : { attendee_provider_id: jidOf(item) },
      attendees: [{ attendee_provider_id: jidOf(item) }, { attendee_provider_id: ACCOUNT_JID, attendee_name: "Ravi" }],
    };
  }
  /** One delivery of Unipile's messaging webhook, through the real ingest. */
  async function webhook(body: ReturnType<typeof payload>) {
    await pause();
    const outcome = await ingestWhatsappWebhook(body, []);
    const [stored] = await db.select({ crmId: crm.crmConversationMessages.id }).from(crm.crmConversationMessages)
      .innerJoin(crm.crmConversations, eq(crm.crmConversations.id, crm.crmConversationMessages.conversationId))
      .where(and(eq(crm.crmConversations.organizationId, orgId), eq(crm.crmConversationMessages.idempotencyKey, `whatsapp:${body.message_id}`))).limit(1);
    return { outcome, crmMessageId: stored?.crmId ?? null, body };
  }
  async function classify(messageId: string | null, extra: { replyAgent?: typeof agent | typeof agentWithoutProvider; complete?: ClassificationCompletion } = {}) {
    const [job] = await db.select().from(crm.crmJobs).where(and(eq(crm.crmJobs.kind, "classification"), eq(crm.crmJobs.entityId, messageId ?? ""))).limit(1);
    if (!job) throw new Error(`no classification job for ${messageId}`);
    await handleClassificationJob(job as unknown as CrmJob, { replyAgent: extra.replyAgent ?? agent, ...(extra.complete ? { complete: extra.complete } : {}) });
  }
  const recordOf = async (item: Lead) => (await db.select().from(crm.crmRecords).where(and(eq(crm.crmRecords.organizationId, orgId), eq(crm.crmRecords.personId, item.personId))).limit(1))[0]!;
  async function look(item: Lead) {
    const record = await recordOf(item);
    const workspace = await getCrmRecordWorkspace(record.id);
    const summary = workspace.summary as ConversationSummary;
    const order = workspace.timeline.map((message) => message.direction === "inbound" ? "in" : `out:${outboundActor(message as { idempotencyKey?: unknown; raw?: unknown }) ?? "?"}`);
    return { record, workspace, summary, order };
  }
  const draftsOf = async (recordId: string, status: string) => (await db.select().from(crm.crmDrafts).where(and(eq(crm.crmDrafts.crmRecordId, recordId), eq(crm.crmDrafts.status, status as never))));
  const takeoverCount = async () => Number((await db.select({ n: count() }).from(schema.autopilotTakeovers).where(eq(schema.autopilotTakeovers.organizationId, orgId)))[0]?.n ?? 0);
  /** The badge, the Action required list and the Needs you list, read side by side. */
  async function countsAgree(label: string) {
    const [badges, queue, needsYou, replies] = await Promise.all([
      loadNavBadges(A.owner.id),
      listCrmActions({ limit: 200 }),
      listCrmActions({ scope: "needs_you", limit: 200 }),
      listCrmActions({ scope: "replies", limit: 200 }),
    ]);
    const marked = replies.actions.filter((row) => row.summary?.needsYou).map((row) => row.id).sort();
    check(`${label}: the Action required badge equals the list's count`, badges.actionRequired === queue.total && queue.total === queue.scopeCounts?.actions, `badge ${badges.actionRequired}, list ${queue.total}`);
    check(`${label}: Needs you counts exactly the conversations that need you`,
      needsYou.total === queue.scopeCounts?.needs_you && JSON.stringify(needsYou.actions.map((row) => row.id).sort()) === JSON.stringify(marked),
      `count ${needsYou.total}, marked ${marked.length}`);
    return { badges, queue, needsYou, replies };
  }
  async function replyStates(item: Lead) {
    const record = await recordOf(item);
    return (await listReplies({ userId: A.owner.id, limit: 200 })).replies.filter((reply) => reply.recordId === record.id);
  }

  // ============================================================ 1. a pricing enquiry
  const enquiry = await webhook(payload(pricing, "How much is the maintenance plan?"));
  let seen = await look(pricing);
  recordIds.push(seen.record.id);
  check("1. the enquiry arrives through the webhook onto the CRM", enquiry.outcome === "ok" && Boolean(enquiry.crmMessageId) && seen.order.join(",") === "in", seen.order.join(","));
  check("1. classification pending: being classified, not urgent, not answered", seen.summary.nextAction.kind === "classifying" && !seen.summary.nextAction.urgent && seen.summary.answer.status === "unanswered" && seen.summary.pending.classification === "classifying", seen.summary.nextAction.label);
  check("1. reply mode Automatic, sent through the linked number", seen.summary.replyMode === "automatic" && seen.summary.account?.label === "Ravi · +919800000001" && seen.summary.channel === "whatsapp", `${seen.summary.replyModeLabel} / ${seen.summary.account?.label}`);
  check("1. the unnamed lead shows as business and route", seen.workspace.contactName === `Bright Smile Clinic · ${pricing.phone}`, seen.workspace.contactName);
  let counts = await countsAgree("1");
  check("1. it is not in Needs you or the queue while classifying, and is findable in All replies", !counts.needsYou.actions.some((row) => row.id === seen.record.id) && !counts.queue.actions.some((row) => row.id === seen.record.id) && counts.replies.actions.some((row) => row.id === seen.record.id));
  let states = await replyStates(pricing);
  check("1. Activity lists the reply as being handled, under the business and route", states.length === 1 && states[0]?.state === "processing" && states[0].personName === `Bright Smile Clinic · ${pricing.phone}`, `${states[0]?.stateLabel} / ${states[0]?.personName}`);

  // A duplicate delivery of the same inbound changes nothing.
  const duplicateInbound = await webhook(enquiry.body);
  const jobs = Number((await db.select({ n: count() }).from(crm.crmJobs).where(and(eq(crm.crmJobs.kind, "classification"), eq(crm.crmJobs.entityId, enquiry.crmMessageId!))))[0]?.n ?? 0);
  check("1. a duplicate inbound webhook is skipped: one message, one classification job", duplicateInbound.outcome === "skipped" && (await look(pricing)).order.length === 1 && jobs === 1);

  // ============================================================ 2. the assistant answers
  script.set("How much is the maintenance plan?", () => ({ action: "reply", reply: "The monthly maintenance plan is ₹2,499 per chair and includes two visits. How many chairs do you have?", category: "interested" }));
  let before = sends.length;
  await classify(enquiry.crmMessageId);
  seen = await look(pricing);
  check("2. the assistant's answer goes out once, through the send path", sends.length === before + 1 && /₹2,499/.test(sends.at(-1)?.body ?? ""));
  check("2. order: enquiry, then the assistant's answer", seen.order.join(",") === "in,out:assistant", seen.order.join(","));
  check("2. Answered by assistant · Waiting for their reply", seen.summary.answer.label === "Answered by assistant" && seen.summary.waitingForThem && seen.summary.headline === "Answered by assistant · Waiting for their reply", seen.summary.headline);
  check("2. the next action is Open conversation, not an urgent send", seen.summary.nextAction.kind === "open_conversation" && !seen.summary.nextAction.urgent && !seen.summary.needsYou);
  counts = await countsAgree("2");
  const row = counts.replies.actions.find((item) => item.id === seen.record.id);
  check("2. All replies keeps it, answered, with Open conversation as its action", Boolean(row) && row?.actionType === "Open conversation" && row?.contactName === `Bright Smile Clinic · ${pricing.phone}`, `${row?.actionType} / ${row?.contactName}`);
  states = await replyStates(pricing);
  check("2. Activity: Answered", states[0]?.state === "answered", states[0]?.stateLabel);

  // ============================================================ 3. the owner replies from WhatsApp Web
  const takeoversBefore = await takeoverCount();
  const ownerReply = await webhook(payload(pricing, "Hi, Ravi here. Happy to show you the plan in person too.", { fromOwner: true }));
  seen = await look(pricing);
  const [echoRow] = await db.select({ origin: whatsappMessages.origin }).from(whatsappMessages).where(eq(whatsappMessages.unipileMessageId, ownerReply.body.message_id));
  check("3. the echo is the owner's own message (origin phone) and lands on the CRM", ownerReply.outcome === "ok" && echoRow?.origin === "phone" && Boolean(ownerReply.crmMessageId));
  check("3. order: enquiry, assistant, owner", seen.order.join(",") === "in,out:assistant,out:you", seen.order.join(","));
  check("3. Answered by you · Waiting for their reply; still Open conversation", seen.summary.answer.label === "Answered by you" && seen.summary.waitingForThem && seen.summary.nextAction.kind === "open_conversation", seen.summary.headline);
  check("3. the reply mode is not changed by answering by hand", seen.summary.replyMode === "automatic" && (await takeoverCount()) === takeoversBefore);
  counts = await countsAgree("3");
  states = await replyStates(pricing);
  check("3. Activity: still Answered", states[0]?.state === "answered", states[0]?.stateLabel);
  const duplicateEcho = await webhook(ownerReply.body);
  check("3. a duplicate of the echo is skipped and records nothing", duplicateEcho.outcome === "skipped" && (await look(pricing)).order.length === 3);

  // ============================================================ 4. a newer inbound message
  const newer = await webhook(payload(pricing, "Do you also service autoclaves?"));
  seen = await look(pricing);
  check("4. order: enquiry, assistant, owner, newer message", seen.order.join(",") === "in,out:assistant,out:you,in", seen.order.join(","));
  check("4. the newer message is not answered yet and is being classified", seen.summary.answer.status === "unanswered" && seen.summary.nextAction.kind === "classifying" && seen.summary.latestInbound?.id === newer.crmMessageId);
  counts = await countsAgree("4");
  states = await replyStates(pricing);
  check("4. Activity: the newer reply is being handled, the earlier one stays Answered", states.length === 2 && states[0]?.state === "processing" && states[1]?.state === "answered", states.map((item) => item.stateLabel).join(","));
  script.set("Do you also service autoclaves?", () => ({ action: "reply", reply: "Yes, we service autoclaves as well as dental chairs, same week. How many do you have?" }));
  before = sends.length;
  await classify(newer.crmMessageId);
  seen = await look(pricing);
  check("4. the assistant answers the newer message once", sends.length === before + 1 && seen.order.join(",") === "in,out:assistant,out:you,in,out:assistant" && seen.summary.answer.label === "Answered by assistant", seen.order.join(","));
  // The assistant read it as "other", which waits for a person to confirm; the answer went out, so it is shown, not demanded.
  check("4. answered with its classification still proposed: Open conversation, out of the queue", seen.summary.pending.classification === "proposed" && seen.summary.nextAction.kind === "open_conversation" && seen.record.workflowState === "idle", `${seen.summary.pending.classification} / ${seen.summary.nextAction.label}`);
  counts = await countsAgree("4 answered");
  check("4. …and still findable in All replies", counts.replies.actions.some((item) => item.id === seen.record.id) && !counts.queue.actions.some((item) => item.id === seen.record.id));
  check("4. Activity: both replies Answered", (await replyStates(pricing)).every((item) => item.state === "answered"));

  // ============================================================ Review mode: a draft, a quote question, the owner answers by hand
  const quote = await webhook(payload(review, "What would 3 chairs cost? Any discount?"));
  recordIds.push((await recordOf(review)).id);
  script.set("What would 3 chairs cost? Any discount?", () => ({ action: "reply", reply: "Thanks for asking! I'll check with Ravi about a price for three chairs and confirm.", ownerNote: { kind: "question", note: "asks for a quote and a discount for three chairs" }, category: "interested" }));
  before = sends.length;
  await classify(quote.crmMessageId);
  seen = await look(review);
  const [quoteDecision] = await db.select().from(schema.ownerDecisions).where(and(eq(schema.ownerDecisions.organizationId, orgId), eq(schema.ownerDecisions.crmRecordId, seen.record.id), eq(schema.ownerDecisions.status, "open")));
  quoteDecisionId = quoteDecision?.id ?? "";
  const reviewDraft = (await draftsOf(seen.record.id, "awaiting_review"))[0];
  check("Review: nothing is sent; a draft waits and the quote question is opened", sends.length === before && Boolean(reviewDraft) && quoteDecision?.kind === "missing_info" && seen.record.workflowState === "action_required", seen.record.workflowState);
  check("Review: the next action is to review the draft; it is Needs you, reply mode Review", seen.summary.nextAction.kind === "review_draft" && seen.summary.needsYou && seen.summary.replyMode === "review" && seen.summary.pending.decisions.length === 1, seen.summary.nextAction.label);
  counts = await countsAgree("Review");
  check("Review: it is in the queue and in Needs you", counts.queue.actions.some((item) => item.id === seen.record.id) && counts.needsYou.actions.some((item) => item.id === seen.record.id));
  check("Review: Activity says Needs you", (await replyStates(review))[0]?.state === "needs_you");

  const handReply = await webhook(payload(review, "For 3 chairs I can do ₹2,299 each. I'll call you tomorrow.", { fromOwner: true }));
  seen = await look(review);
  const [staleDraft] = reviewDraft ? await db.select().from(crm.crmDrafts).where(eq(crm.crmDrafts.id, reviewDraft.id)) : [];
  const [stillOpen] = await db.select().from(schema.ownerDecisions).where(eq(schema.ownerDecisions.id, quoteDecisionId));
  check("Review, manual reply: the pending draft is stale and the record leaves Action required", handReply.outcome === "ok" && staleDraft?.status === "stale" && seen.record.workflowState === "idle", `${staleDraft?.status} / ${seen.record.workflowState}`);
  check("Review, manual reply: the unrelated quote decision stays open, so it stays in Needs you", stillOpen?.status === "open" && seen.summary.needsYou && seen.summary.nextAction.kind === "decide", seen.summary.nextAction.label);
  check("Review, manual reply: Answered by you; reply mode still Review", seen.summary.answer.label === "Answered by you" && seen.summary.replyMode === "review" && (await takeoverCount()) === takeoversBefore);
  counts = await countsAgree("Review, manual reply");
  check("Review, manual reply: out of the queue, still in Needs you and All replies", !counts.queue.actions.some((item) => item.id === seen.record.id) && counts.needsYou.actions.some((item) => item.id === seen.record.id) && counts.replies.actions.some((item) => item.id === seen.record.id));
  check("Review, manual reply: Activity keeps it as Needs you (the quote is open)", (await replyStates(review))[0]?.state === "needs_you");
  const duplicateHand = await webhook(handReply.body);
  const afterDuplicate = await look(review);
  check("Review: a duplicate echo is skipped and changes nothing", duplicateHand.outcome === "skipped" && afterDuplicate.order.join(",") === seen.order.join(",") && afterDuplicate.record.workflowState === "idle");

  // A newer inbound, then an echo that was delayed: sent before it, delivered after it.
  const delayedAt = new Date();
  await pause();
  const followUp = await webhook(payload(review, "OK. Can you also include the autoclave?"));
  script.set("OK. Can you also include the autoclave?", () => ({ action: "reply", reply: "Yes, we service autoclaves too, same week. How many do you have?", category: "interested" }));
  await classify(followUp.crmMessageId);
  const newerDraft = (await draftsOf((await recordOf(review)).id, "awaiting_review"))[0];
  const delayed = await webhook(payload(review, "(sent earlier) Also, our technician is Suresh.", { fromOwner: true, at: delayedAt }));
  seen = await look(review);
  const [newerDraftAfter] = newerDraft ? await db.select().from(crm.crmDrafts).where(eq(crm.crmDrafts.id, newerDraft.id)) : [];
  check("Review, delayed echo: recorded in its place, before the newer message", delayed.outcome === "ok" && seen.order.join(",") === "in,out:you,out:you,in", seen.order.join(","));
  check("Review, delayed echo: the newer message stays unanswered and its draft stays ready", seen.summary.answer.status === "unanswered" && newerDraftAfter?.status === "awaiting_review" && seen.record.workflowState === "action_required" && seen.summary.nextAction.kind === "review_draft", `${newerDraftAfter?.status} / ${seen.record.workflowState} / ${seen.summary.answer.status} / ${seen.summary.nextAction.label}`);
  counts = await countsAgree("Review, delayed echo");

  // ============================================================ a takeover and a proposed classification survive a manual reply
  const takenMessage = await webhook(payload(taken, "Who is this?"));
  recordIds.push((await recordOf(taken)).id);
  const [takenConversation] = await db.select({ id: crm.crmConversations.id }).from(crm.crmConversations).where(and(eq(crm.crmConversations.organizationId, orgId), eq(crm.crmConversations.personId, taken.personId)));
  await takeOverConversation(takenConversation!.id, A.owner.id);
  before = sends.length;
  await classify(takenMessage.crmMessageId, { complete: classifierSaying("other") });
  seen = await look(taken);
  check("Takeover: the assistant stays silent; the classification waits for confirmation", sends.length === before && seen.summary.replyMode === "takeover" && seen.summary.nextAction.kind === "confirm_classification" && !seen.summary.needsYou, seen.summary.nextAction.label);
  counts = await countsAgree("Takeover");
  await webhook(payload(taken, "Hi, it's Ravi from Bright Path — we spoke last week.", { fromOwner: true }));
  seen = await look(taken);
  check("Takeover, manual reply: answered by you; the takeover stays", seen.summary.answer.label === "Answered by you" && seen.summary.replyMode === "takeover" && (await takeoverCount()) === takeoversBefore + 1);
  check("Takeover, manual reply: the reply is settled — out of Action required, its proposal kept on the record", seen.record.workflowState === "idle" && seen.summary.pending.classification === "proposed" && seen.summary.nextAction.kind === "open_conversation", `${seen.record.workflowState} / ${seen.summary.nextAction.label}`);
  counts = await countsAgree("Takeover, manual reply");
  check("Takeover, manual reply: still findable in All replies", counts.replies.actions.some((item) => item.id === seen.record.id) && !counts.queue.actions.some((item) => item.id === seen.record.id));

  // ============================================================ the owner answers before the reply is classified
  // An assistant-run lead: the message, the owner's echo, then the classification job.
  before = sends.length;
  const earlyIn = await webhook(payload(early, "Can you come on Thursday?"));
  recordIds.push((await recordOf(early)).id);
  await webhook(payload(early, "Yes, Thursday works. I'll come at 11.", { fromOwner: true }));
  await classify(earlyIn.crmMessageId);
  seen = await look(early);
  check("Answered before classification: nothing is sent and the reply is settled, not left classifying", sends.length === before && seen.record.workflowState === "idle" && seen.summary.nextAction.kind !== "classifying" && seen.summary.answer.label === "Answered by you", `${seen.record.workflowState} / ${seen.summary.nextAction.label} / ${seen.summary.answer.label}`);
  // The echo delivered before the lead's message that it answers (sent earlier, delivered later).
  const lateFirst = await webhook(payload(late, "Hi, is this Bright Path?"));
  recordIds.push((await recordOf(late)).id);
  await classify(lateFirst.crmMessageId);
  await pause();
  const lateAt = new Date();
  await pause();
  before = sends.length;
  await webhook(payload(late, "Calling you in five minutes.", { fromOwner: true }));
  const lateIn = await webhook(payload(late, "Can you call me?", { at: lateAt }));
  await classify(lateIn.crmMessageId);
  seen = await look(late);
  check("…also when the owner's echo is delivered before the lead's message", sends.length === before && seen.record.workflowState === "idle" && seen.summary.nextAction.kind !== "classifying", `${seen.record.workflowState} / ${seen.summary.nextAction.label}`);
  counts = await countsAgree("Answered before classification");
  const answeredFirst = [(await recordOf(early)).id, (await recordOf(late)).id];
  check("…out of the queue and findable in All replies", answeredFirst.every((id) => counts.replies.actions.some((row) => row.id === id) && !counts.queue.actions.some((row) => row.id === id)));
  // A lead outside any run, its classification left proposed: settled the same whichever comes first.
  const whoIn = await webhook(payload(who, "Who is this?"));
  recordIds.push((await recordOf(who)).id);
  await webhook(payload(who, "Hi, it's Ravi from Bright Path — we spoke last week.", { fromOwner: true }));
  await classify(whoIn.crmMessageId, { complete: classifierSaying("other") });
  seen = await look(who);
  check("Answered before a proposed classification: settled, as when the answer comes after", seen.record.workflowState === "idle" && seen.summary.pending.classification === "proposed" && seen.summary.nextAction.kind === "open_conversation", `${seen.record.workflowState} / ${seen.summary.nextAction.label}`);
  counts = await countsAgree("Answered before a proposed classification");
  check("…out of the queue, still in All replies", counts.replies.actions.some((item) => item.id === seen.record.id) && !counts.queue.actions.some((item) => item.id === seen.record.id));

  // ============================================================ Do Not Contact
  before = sends.length;
  const stop = await webhook(payload(dnc, "Please stop messaging me, not interested"));
  recordIds.push((await recordOf(dnc)).id);
  await classify(stop.crmMessageId, { complete: classifierSaying("not_interested") });
  seen = await look(dnc);
  check("Do Not Contact: nothing is sent and the person is marked", sends.length === before && await isPersonDoNotContact(db, dnc.personId));
  check("Do Not Contact: the next action is not a reply, and it is not Needs you", seen.summary.nextAction.kind === "do_not_contact" && !seen.summary.nextAction.urgent && !seen.summary.needsYou && seen.summary.headline === "Outreach stopped · Do Not Contact", seen.summary.headline);
  counts = await countsAgree("Do Not Contact");

  // ============================================================ wrong number
  script.set("Wrong number", () => ({ action: "wrong_number", reply: "Sorry about that—we won't message this number again." }));
  before = sends.length;
  const wrongMessage = await webhook(payload(wrong, "Wrong number"));
  recordIds.push((await recordOf(wrong)).id);
  await classify(wrongMessage.crmMessageId);
  seen = await look(wrong);
  check("Wrong number: one apology, recorded as the assistant's", sends.length === before + 1 && seen.summary.answer.label === "Answered by assistant", seen.summary.answer.label ?? "");
  check("Wrong number: closed — the route is recorded and nothing is awaited", seen.summary.restrictions.wrongRoute?.ackStatus === "sent" && seen.summary.nextAction.kind === "wrong_number" && !seen.summary.waitingForThem && !seen.summary.needsYou && seen.record.workflowState === "idle", seen.summary.nextAction.label);
  counts = await countsAgree("Wrong number");
  before = sends.length;
  const wrongAgain = await webhook(payload(wrong, "I said wrong number"));
  await classify(wrongAgain.crmMessageId);
  check("Wrong number: a repeat sends nothing more", sends.length === before && (await look(wrong)).summary.nextAction.kind === "wrong_number");

  // ============================================================ the provider is unavailable
  script.set("Can you service our chairs this month?", () => ({ action: "reply", reply: "Yes, we service dental chairs in Pune, same week. How many chairs do you have?" }));
  before = sends.length;
  const offlineMessage = await webhook(payload(offline, "Can you service our chairs this month?"));
  recordIds.push((await recordOf(offline)).id);
  await classify(offlineMessage.crmMessageId, { replyAgent: agentWithoutProvider });
  seen = await look(offline);
  check("Unavailable provider: nothing is sent and nothing is recorded as sent", sends.length === before && seen.order.join(",") === "in" && seen.summary.answer.status === "unanswered", seen.order.join(","));
  check("Unavailable provider: the owner is told, so it is Needs you with an urgent next action", seen.summary.needsYou && seen.summary.nextAction.urgent && seen.summary.pending.decisions.length >= 1, `${seen.summary.nextAction.label} (${seen.summary.pending.decisions.map((item) => item.kind).join(",")})`);
  counts = await countsAgree("Unavailable provider");

  // ============================================================ Instagram
  const [igPerson] = await db.insert(people).values({ organizationId: orgId, source: "workspace-replay", raw: { instagram: { username: "brightsmile.pune" } } }).returning({ id: people.id });
  await db.insert(instagramAccounts).values({ organizationId: orgId, unipileAccountId: `ig-replay-${stamp}`, username: "brightpath.supplies", status: "disconnected" });
  const accountsBefore = counts.badges.accountsNeedingAttention;
  const ig = await ingestInboundReply({ personId: igPerson!.id, channel: "instagram", accountRef: `ig-replay-${stamp}`, providerThreadId: `ig-replay-chat-${stamp}`, providerContactId: `ig-replay-user-${stamp}`, idempotencyKey: `instagram:ig-replay-${stamp}`, bodyText: "Price for 2 chairs?", sentAt: new Date() });
  recordIds.push(ig.record.id);
  const instagramOnly = await listCrmActions({ scope: "replies", channel: "instagram", limit: 200 });
  check("Instagram: the channel filter returns the Instagram conversation only", instagramOnly.actions.length === 1 && instagramOnly.actions[0]?.id === ig.record.id && instagramOnly.actions[0]?.contactName === "@brightsmile.pune", instagramOnly.actions[0]?.contactName ?? "(none)");
  counts = await countsAgree("Instagram");
  check("Instagram: a disconnected Instagram account counts as an account needing attention", counts.badges.accountsNeedingAttention === accountsBefore + 1, `${accountsBefore} → ${counts.badges.accountsNeedingAttention}`);
  const igReply = (await listReplies({ userId: A.owner.id, channel: "instagram" })).replies[0];
  check("Instagram: Activity names the unnamed lead by handle", igReply?.personName === "@brightsmile.pune", igReply?.personName ?? "(none)");

  // ============================================================ a WhatsApp campaign step after a reply on another channel
  // The lead replied by email; a WhatsApp campaign (an assistant run's WhatsApp leg is one) later sends its step
  // through sendWhatsapp, which records it on that same record. The rows below are what that send and the campaign
  // engine wrote before steps carried the CRM origin "campaign" (origin agentsdr, told apart by the send row);
  // nothing is sent. Organization C below sends one through the real sendWhatsapp.
  const campaignLead = await lead("campaign", 7, { fullName: "Dr Campaign", email: `dr-campaign-${stamp}@workspace-replay.test` });
  const emailReply = await ingestInboundReply({ personId: campaignLead.personId, channel: "email", accountRef: `replay-mailbox-${stamp}@workspace-replay.test`, providerThreadId: `replay-email-thread-${stamp}`, providerContactId: `dr-campaign-${stamp}@workspace-replay.test`, idempotencyKey: `email:replay-${stamp}`, bodyText: "Sounds interesting, tell me more.", sentAt: new Date(Date.now() - 60_000) });
  recordIds.push(emailReply.record.id);
  const [waAccount] = await db.select({ id: whatsappAccounts.id }).from(whatsappAccounts).where(and(eq(whatsappAccounts.organizationId, orgId), eq(whatsappAccounts.unipileAccountId, WA_ACCOUNT)));
  const [campaignChat] = await db.insert(whatsappChats).values({ accountId: waAccount!.id, unipileChatId: campaignLead.chatId, providerId: jidOf(campaignLead), phone: campaignLead.phone, personId: campaignLead.personId }).returning();
  const stepBody = "Hi Dr Campaign, Ravi from Bright Path. Same-week servicing for dental chairs in Pune.";
  const [campaign] = await db.insert(whatsappCampaigns).values({ organizationId: orgId, name: "Replay WhatsApp campaign", status: "active", steps: [{ id: "replay-step-1", body: stepBody, delayHours: 0 }] }).returning();
  const [enrolled] = await db.insert(whatsappCampaignLeads).values({ campaignId: campaign!.id, personId: campaignLead.personId, phone: campaignLead.phone, status: "in_sequence", currentStep: 1, accountId: waAccount!.id }).returning();
  const stepAt = new Date();
  const stepUnipileId = `wa-replay-campaign-step-${stamp}`;
  const [stepMessage] = await db.insert(whatsappMessages).values({ chatId: campaignChat!.id, unipileMessageId: stepUnipileId, direction: "outbound", origin: "agentsdr", body: stepBody, sentAt: stepAt }).returning();
  const recordedStep = await recordWhatsappOutboundInCrm({ personId: campaignLead.personId, unipileAccountId: WA_ACCOUNT, unipileChatId: campaignLead.chatId, providerContactId: jidOf(campaignLead), unipileMessageId: stepUnipileId, body: stepBody, sentAt: stepAt, raw: null, origin: "agentsdr" });
  await db.update(whatsappMessages).set({ crmConversationMessageId: recordedStep.crmConversationMessageId }).where(eq(whatsappMessages.id, stepMessage!.id));
  await db.insert(whatsappCampaignSends).values({ leadId: enrolled!.id, step: 0, stepId: "replay-step-1", status: "sent", accountId: waAccount!.id, whatsappMessageId: stepMessage!.id, body: stepBody, sentAt: stepAt });
  seen = await look(campaignLead);
  check("Campaign step: recorded on the record the email reply opened, as its latest outbound", Boolean(recordedStep.crmConversationMessageId) && seen.record.id === emailReply.record.id && seen.summary.latestOutbound?.id === recordedStep.crmConversationMessageId);
  check("Campaign step: read as a campaign message, never Answered by you", seen.summary.answer.label === "Campaign message sent" && seen.summary.answer.actor === null && seen.summary.latestOutbound?.actor === null && !seen.summary.headline.includes("Answered by you"), `${seen.summary.answer.label} / ${seen.summary.headline}`);
  const campaignRow = (await listCrmActions({ scope: "replies", limit: 200 })).actions.find((item) => item.id === seen.record.id);
  check("Campaign step: the All replies row says the same", campaignRow?.summary?.answer.label === "Campaign message sent" && !campaignRow.summary.headline.includes("Answered by you"), campaignRow?.summary?.headline ?? "(none)");

  // ============================================================ every reply stays findable
  const all = await listCrmActions({ scope: "replies", limit: 200 });
  const replies = await listReplies({ userId: A.owner.id, limit: 200 });
  const inboundCount = Number((await db.select({ n: count() }).from(crm.crmConversationMessages)
    .innerJoin(crm.crmConversations, eq(crm.crmConversations.id, crm.crmConversationMessages.conversationId))
    .where(and(eq(crm.crmConversations.organizationId, orgId), eq(crm.crmConversationMessages.direction, "inbound"))))[0]?.n ?? 0);
  check("every conversation a reply arrived on is in All replies, answered and closed ones included", recordIds.every((id) => all.actions.some((item) => item.id === id)) && all.total === recordIds.length, `${all.total} of ${recordIds.length}`);
  check("every recorded inbound reply is in Activity's replies", replies.replies.length === inboundCount, `${replies.replies.length} of ${inboundCount}`);
  check("the quote decision is still open at the end", (await db.select().from(schema.ownerDecisions).where(eq(schema.ownerDecisions.id, quoteDecisionId)))[0]?.status === "open");

  // ============================================================ the Errors filter narrows a view; it does not replace it
  // The unavailable-provider record is an error that needs you; the taken-over one, put in error here, does not.
  const takenRecord = await recordOf(taken);
  await db.update(crm.crmRecords).set({ workflowState: "error" }).where(and(eq(crm.crmRecords.organizationId, orgId), eq(crm.crmRecords.id, takenRecord.id)));
  const [needsYouAll, needsYouErrors, repliesAll, repliesErrors, queueErrors] = await Promise.all([
    listCrmActions({ scope: "needs_you", limit: 200 }),
    listCrmActions({ scope: "needs_you", error: true, limit: 200 }),
    listCrmActions({ scope: "replies", limit: 200 }),
    listCrmActions({ scope: "replies", error: true, limit: 200 }),
    listCrmActions({ error: true, limit: 200 }),
  ]);
  const idsOf = (list: { actions: { id: string }[] }) => JSON.stringify(list.actions.map((item) => item.id).sort());
  const errorsIn = (list: { actions: { id: string; record: { workflowState: string } }[] }) => JSON.stringify(list.actions.filter((item) => item.record.workflowState === "error").map((item) => item.id).sort());
  check("Errors in Needs you: only the errors that need you", errorsIn(needsYouAll) !== "[]" && idsOf(needsYouErrors) === errorsIn(needsYouAll) && !needsYouErrors.actions.some((item) => item.id === takenRecord.id), `${needsYouErrors.total} listed, ${errorsIn(needsYouAll)} expected`);
  check("Errors in All replies: only the errors a reply was recorded on", idsOf(repliesErrors) === errorsIn(repliesAll) && repliesErrors.actions.some((item) => item.id === takenRecord.id), `${repliesErrors.total} listed`);
  check("Errors: each view's count is its list's", needsYouErrors.scopeCounts?.needs_you === needsYouErrors.total && repliesErrors.scopeCounts?.replies === repliesErrors.total && queueErrors.scopeCounts?.actions === queueErrors.total,
    `needs you ${needsYouErrors.scopeCounts?.needs_you}/${needsYouErrors.total}, replies ${repliesErrors.scopeCounts?.replies}/${repliesErrors.total}, queue ${queueErrors.scopeCounts?.actions}/${queueErrors.total}`);
  await db.update(crm.crmRecords).set({ workflowState: takenRecord.workflowState }).where(and(eq(crm.crmRecords.organizationId, orgId), eq(crm.crmRecords.id, takenRecord.id)));
});

// ============================================================ a campaign step keeps its label after the lead leaves the campaign
// The campaign engine sends its step through the real sendWhatsapp (to the stand-in Unipile) with the CRM origin
// "campaign", then writes its send row. "Remove from campaign" deletes the lead and, by cascade, that row: the step
// must still read as a campaign message, never as the owner's answer. Its own organization, so the stand-in Unipile
// connection touches nothing above; it is removed again at the end.
const C = await organization("c");
await runInOrganization(C.org.id, async () => {
  const orgId = currentOrganizationId();
  await ensureCrmDefaults();
  const [provider] = await db.insert(gridProviders).values({ organizationId: orgId, key: "platform-unipile", name: "Unipile (workspace replay)" }).returning();
  await db.insert(gridProviderCredentials).values({ providerId: provider!.id, encryptedPayload: encryptIntegrationCredentials({ baseUrl: FAKE_UNIPILE, apiKey: "workspace-replay" }) });
  const [account] = await db.insert(whatsappAccounts).values({ organizationId: orgId, unipileAccountId: `wa-replay-c-${stamp}`, name: "Ravi", phone: "+919800000002", status: "connected", connectedAt: new Date(Date.now() - 7 * 86_400_000) }).returning();
  try {
    const phone = phoneOf(8);
    const email = `dr-removed-${stamp}@workspace-replay.test`;
    const [person] = await db.insert(people).values({ organizationId: orgId, phone, fullName: "Dr Removed", email, source: "workspace-replay" }).returning({ id: people.id });
    const reply = await ingestInboundReply({ personId: person!.id, channel: "email", accountRef: `replay-mailbox-c-${stamp}@workspace-replay.test`, providerThreadId: `replay-email-thread-c-${stamp}`, providerContactId: email, idempotencyKey: `email:replay-c-${stamp}`, bodyText: "Sounds interesting, tell me more.", sentAt: new Date(Date.now() - 60_000) });
    // Where a classified reply waits on a person: an answer settles it.
    await db.update(crm.crmRecords).set({ workflowState: "action_required" }).where(and(eq(crm.crmRecords.organizationId, orgId), eq(crm.crmRecords.id, reply.record.id)));
    await db.insert(whatsappChats).values({ accountId: account!.id, unipileChatId: `wa-replay-chat-removed-${stamp}`, providerId: `${phone.replace(/\D/g, "")}@s.whatsapp.net`, phone, personId: person!.id });
    const stepBody = "Hi Dr Removed, Ravi from Bright Path. Same-week servicing for dental chairs in Pune.";
    const [campaign] = await db.insert(whatsappCampaigns).values({ organizationId: orgId, name: "Replay campaign (lead removed)", status: "active", steps: [{ id: "replay-removed-step-1", body: stepBody, delayHours: 0 }] }).returning();
    const [enrolled] = await db.insert(whatsappCampaignLeads).values({ campaignId: campaign!.id, personId: person!.id, phone, status: "in_sequence", accountId: account!.id }).returning();
    // What engine.ts sends for a step, then the send row it writes.
    const sent = await sendWhatsapp({ personId: person!.id, accountId: account!.id, text: stepBody, crmOrigin: "campaign" });
    await db.insert(whatsappCampaignSends).values({ leadId: enrolled!.id, step: 0, stepId: "replay-removed-step-1", status: "sent", accountId: account!.id, whatsappMessageId: sent.message.id, body: stepBody, sentAt: new Date() });
    const [settled] = await db.select().from(crm.crmRecords).where(and(eq(crm.crmRecords.organizationId, orgId), eq(crm.crmRecords.id, reply.record.id)));
    check("Campaign step through sendWhatsapp: Unipile got it once, and it settled the reply as a Messages-tab send does", unipileSends.length === 1 && unipileSends[0] === stepBody && settled?.workflowState === "idle", `${unipileSends.length} send(s), record ${settled?.workflowState}`);
    const before = (await getCrmRecordWorkspace(reply.record.id)).summary as ConversationSummary;
    check("Campaign step through sendWhatsapp: read as a campaign message", before.answer.label === "Campaign message sent", before.headline);

    await removeWhatsappCampaignLead(campaign!.id, enrolled!.id);
    const sendRowsLeft = Number((await db.select({ n: count() }).from(whatsappCampaignSends).where(eq(whatsappCampaignSends.leadId, enrolled!.id)))[0]?.n ?? 0);
    const after = await getCrmRecordWorkspace(reply.record.id);
    const summary = after.summary as ConversationSummary;
    check("Removed from the campaign: its send rows are gone, the step still reads as a campaign message", sendRowsLeft === 0 && summary.answer.label === "Campaign message sent" && summary.answer.actor === null && !summary.headline.includes("Answered by you"), `${sendRowsLeft} send row(s) left, ${summary.headline}`);
    const row = (await listCrmActions({ scope: "replies", limit: 200 })).actions.find((item) => item.id === reply.record.id);
    check("Removed from the campaign: the All replies row says the same", row?.summary?.answer.label === "Campaign message sent" && !row.summary.headline.includes("Answered by you"), row?.summary?.headline ?? "(none)");
    const timeline = conversationSummary(after.timeline as Parameters<typeof conversationSummary>[0]);
    check("Removed from the campaign: the record page's own reading of the timeline agrees", timeline.answered && timeline.answerLabel === "Campaign message sent", timeline.answerLabel);
  } finally {
    await db.delete(gridProviders).where(eq(gridProviders.id, provider!.id));
    await db.update(whatsappAccounts).set({ status: "disconnected" }).where(eq(whatsappAccounts.id, account!.id));
  }
});

// ============================================================ a second organization sees and counts nothing
await runInOrganization(B.org.id, async () => {
  await ensureCrmDefaults();
  const [queue, needsYou, replies, badges, activity, summaries] = await Promise.all([
    listCrmActions({ limit: 200 }),
    listCrmActions({ scope: "needs_you", limit: 200 }),
    listCrmActions({ scope: "replies", limit: 200 }),
    loadNavBadges(B.owner.id),
    listReplies({ userId: B.owner.id }),
    loadConversationSummaries(recordIds),
  ]);
  check("a second organization lists none of the first's conversations in any view", queue.total === 0 && needsYou.total === 0 && replies.total === 0 && activity.replies.length === 0 && summaries.size === 0);
  check("…and counts none", badges.actionRequired === 0 && badges.needsYou === 0 && badges.accountsNeedingAttention === 0 && queue.scopeCounts?.needs_you === 0 && queue.scopeCounts?.replies === 0);
  let opened = "opened";
  try { await getCrmRecordWorkspace(recordIds[0]!); } catch (error) { opened = error instanceof Error ? error.name : "error"; }
  check("…and cannot open one of its records", opened !== "opened", opened);
});

check("no request tried to leave the machine", blocked.length === 0, blocked.join(", "));
console.log(failures ? `\n${failures} of ${passes + failures} check(s) failed` : `\nAll ${passes} workspace replay checks passed`);
process.exit(failures ? 1 : 0);

/**
 * The reply agent (src/lib/assistant/replyAgent/), end to end against the
 * local database: a lead's message goes through the CRM's classification
 * job, the agent's loop and the real CRM send path, with a stand-in model
 * and a recording send adapter (nothing leaves the machine).
 *
 *   bun run --conditions=react-server scripts/e2e/reply-agent.ts
 *   AI_SOURCE_ORGANIZATION_ID=<org with AI Settings> bun run --conditions=react-server scripts/e2e/reply-agent.ts
 *
 * What it proves: a greeting is answered (and is not "interested"), a
 * question answered from the business information, an invented price is
 * handed back to the agent and fixed in the next turn, a reply that stays
 * unbacked becomes an honest holding line and a card for the owner, a ready
 * lead gets an answer and a Needs you card, a stop request sets Do Not
 * Contact and sends nothing, an acknowledgement needs no answer, Review
 * mode only drafts, a retried job never answers twice, a newer message wins,
 * a chat the owner took over and a lead outside a running run stay with the
 * classifier, a model outage still answers, and the Replies list shows the
 * outcome with its time.
 *
 * Wrong number (WhatsApp): in an Automatic run one brief apology goes out and
 * nothing after it (a repeat, a duplicate webhook, a retried or restarted
 * job, an ordinary draft, a duplicate record holding the same number); in
 * Review mode one draft waits and nothing is sent until it is approved, and
 * then only once; concurrent workers send one; a failed or uncertain apology
 * is never retried and the number stays stopped; a lead already marked Do
 * Not Contact, a chat the owner took over, and "Wrong number, stop messaging
 * me" get nothing (the last becomes Do Not Contact).
 *
 * With AI_SOURCE_ORGANIZATION_ID it also runs a few messages through the
 * real model and prints the answers and timings.
 *
 * Creates its own organization ("Reply agent check …") and leaves it behind.
 * Refuses a non-local DATABASE_URL.
 */
import { and, count, eq } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}

const stamp = Date.now();
const { db } = await import("@/lib/db");
const { organizations } = await import("@/lib/auth/schema");
const { people } = await import("@/lib/leads/schema");
const { mailboxes } = await import("@/lib/outreach/schema");
const crm = await import("@/lib/crm/schema");
const schema = await import("@/lib/assistant/schema");
const { runInOrganization, currentOrganizationId } = await import("@/lib/tenancy/scope");
const { ingestInboundReply } = await import("@/lib/crm/conversations");
const { handleClassificationJob } = await import("@/lib/crm/handlers");
const { ensureCrmDefaults } = await import("@/lib/crm/defaults");
const { isPersonDoNotContact } = await import("@/lib/crm/policies");
const { saveDocumentKnowledge, updateBusinessProfile } = await import("@/lib/assistant/profile.server");
const { createAudience } = await import("@/lib/assistant/audiences.server");
const { createThread } = await import("@/lib/assistant/threads.server");
const { takeOverConversation } = await import("@/lib/assistant/decisions.server");
const { runReplies } = await import("@/lib/assistant/runReplies.server");
const { runReplyAgent } = await import("@/lib/assistant/replyAgent/agent.server");
const { closeWrongNumber } = await import("@/lib/crm/wrongNumberAck.server");
const { DefiniteCrmSendError, sendDraft } = await import("@/lib/crm/send");
const { setPersonDoNotContact } = await import("@/lib/crm/policies");
const { loadPersonFacts } = await import("@/lib/assistant/audiences.server");
const { contactChannels } = await import("@/lib/assistant/audiences");
const { findWrongRoutes, wrongRouteSendRefusal } = await import("@/lib/crm/wrongRoutes");
const { wrongRouteAckLabel } = await import("@/lib/crm/wrongNumber");
const { getCrmRecordWorkspace, listCrmActions } = await import("@/lib/crm/queries");
const { applyHumanClassification } = await import("@/lib/crm/operations");
const { discardDraft } = await import("@/lib/crm/drafts");
const { recordAiClassificationInTransaction } = await import("@/lib/crm/records");
const { withCrmTransaction } = await import("@/lib/crm/repository");
const { AUTOPILOT_LIMITS } = await import("@/lib/crm/autopilot");
const { recordManualOutboundInTransaction } = await import("@/lib/crm/manualOutbound");
type AgentModel = import("@/lib/assistant/replyAgent/agent.server").AgentModel;
type CrmSendAdapter = import("@/lib/crm/send").CrmSendAdapter;
type CrmJob = import("@/lib/crm/queue").CrmJob;
type ClassificationCompletion = import("@/lib/crm/ai/types").ClassificationCompletion;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const sends: { body: string; to: string | null }[] = [];
const send: CrmSendAdapter = async (input) => {
  sends.push({ body: input.bodyText, to: input.recipientEmail });
  return { provider: "unipile", providerMessageId: `agent-check-${stamp}-${sends.length}`, providerThreadId: null, rfcMessageId: null, response: {} };
};

/** The stand-in model: answers by the lead's latest message, and remembers every prompt it was given. */
const prompts: string[] = [];
type Scripted = { action: string; reply?: string; ownerNote?: { kind: string; note: string } | null; category?: string };
const script = new Map<string, (turn: number, prompt: string) => Scripted | Error>();
const model: AgentModel = async ({ userPrompt }) => {
  prompts.push(userPrompt);
  const latest = /LEAD'S LATEST MESSAGE:\n([\s\S]*?)(?=\n\nYOUR PREVIOUS ATTEMPT|$)/.exec(userPrompt)?.[1]?.trim() ?? "";
  const turn = /\(turn (\d+)\) WAS NOT SENT/.exec(userPrompt) ? Number(/\(turn (\d+)\)/.exec(userPrompt)![1]) + 1 : 1;
  const answer = script.get(latest)?.(turn, userPrompt) ?? { action: "reply", reply: "Thanks for your message! What made you reach out?" };
  if (answer instanceof Error) throw answer;
  const text = JSON.stringify({ reasoning: "stand-in", action: answer.action, reply: answer.reply ?? "", ownerNote: answer.ownerNote ?? null, category: answer.category ?? "other", confidence: 0.9 });
  return { text, provider: "stand-in", model: "stand-in-agent", request: {}, response: {} };
};
const deps = { model, send, allowNonProduction: true, brief: false };

/** A number the first organization records as wrong; the second must not see it. */
let isolationPhone = "";

const [org] = await db.insert(organizations).values({ name: `Reply agent check ${stamp}`, slug: `reply-agent-check-${stamp}` }).returning();
console.log(`Organization ${org!.name} (${org!.id})`);

await runInOrganization(org!.id, async () => {
  const orgId = currentOrganizationId();
  const mailboxAddress = `owner-${stamp}@mail.reply-agent-check.test`;
  await db.insert(mailboxes).values({ organizationId: orgId, emailAddress: mailboxAddress, provider: "unipile", unipileAccountId: `agent-check-${stamp}`, displayName: "Ravi from Bright Path", status: "connected" });
  await updateBusinessProfile({ businessName: "Bright Path Dental Supplies", offer: "Same-week servicing for dental chairs and autoclaves", senderName: "Ravi", targetCustomers: "dental clinics", locations: "Pune" }, null);
  await saveDocumentKnowledge("Price list", "Monthly maintenance plan: ₹2,499 per chair per month, includes two visits. Service area: Pune and Pimpri-Chinchwad.");
  await ensureCrmDefaults();

  const persons = await db.insert(people).values(Array.from({ length: 14 }, (_, index) => ({
    organizationId: orgId,
    email: `lead${index + 1}-${stamp}@clinic-agent.test`,
    fullName: `Dr Agent ${index + 1}`,
    source: "reply-agent-check",
  }))).returning({ id: people.id });
  const P = persons.map((person) => person.id);
  const audienceId = await createAudience({ name: "reply agent check", source: "list" });
  const thread = await createThread(null);
  const plan = { assignments: [], sequences: {}, personalizationKey: "p_00000000", samples: [], limits: { maxLeads: 20, emailPerMailboxPerDay: 30, whatsappNewChatsPerDay: null }, excluded: [], estimate: { aiCalls: 0, aiCostUsd: null, days: 1 }, autopilot: true, instructions: null };
  const [autoRun] = await db.insert(schema.outreachRuns).values({ organizationId: orgId, threadId: thread.id, audienceId, name: "Automatic run", status: "running", channels: ["email"], plan, autopilot: true, approvedAt: new Date(Date.now() - 60_000) }).returning();
  const [reviewRun] = await db.insert(schema.outreachRuns).values({ organizationId: orgId, threadId: thread.id, audienceId, name: "Review run", status: "running", channels: ["email"], plan: { ...plan, autopilot: false }, autopilot: false }).returning();
  await db.insert(schema.outreachRunLeads).values([
    ...P.slice(0, 12).map((personId) => ({ organizationId: orgId, runId: autoRun!.id, personId, channel: "email" as const })),
    { organizationId: orgId, runId: reviewRun!.id, personId: P[12]!, channel: "email" as const },
    // P[13] is in no run: the classifier handles it.
  ]);

  let n = 0;
  async function inbound(personId: string, body: string, key = `t${(n += 1)}`) {
    const result = await ingestInboundReply({
      personId,
      channel: "email",
      accountRef: mailboxAddress,
      providerThreadId: `agent-${key}-${stamp}`,
      idempotencyKey: `agent-in-${key}-${stamp}-${n}-${Math.random()}`,
      providerMessageId: `agent-pm-${key}-${stamp}-${Math.random()}`,
      subject: "Re: Chair servicing",
      bodyText: body,
      sentAt: new Date(),
    });
    return result.message;
  }
  async function classify(messageId: string) {
    const [job] = await db.select().from(crm.crmJobs).where(and(eq(crm.crmJobs.kind, "classification"), eq(crm.crmJobs.entityId, messageId))).limit(1);
    await handleClassificationJob(job as unknown as CrmJob, { replyAgent: deps });
  }
  const agentRow = async (messageId: string) => (await db.select().from(schema.replyAgentRuns).where(eq(schema.replyAgentRuns.messageId, messageId)).limit(1))[0] ?? null;
  const classification = async (messageId: string) => (await db.select().from(crm.crmClassifications).where(eq(crm.crmClassifications.messageId, messageId)).limit(1))[0] ?? null;
  const card = async (personId: string, kind: string) => (await db.select().from(schema.ownerDecisions)
    .where(and(eq(schema.ownerDecisions.organizationId, orgId), eq(schema.ownerDecisions.personId, personId), eq(schema.ownerDecisions.kind, kind as never))).limit(1))[0] ?? null;
  const initialDrafts = async (messageId: string) => Number((await db.select({ n: count() }).from(crm.crmJobs)
    .innerJoin(crm.crmClassifications, eq(crm.crmClassifications.id, crm.crmJobs.entityId))
    .where(and(eq(crm.crmJobs.kind, "initial_draft"), eq(crm.crmClassifications.messageId, messageId))))[0]?.n ?? 0);

  // ------------------------------------------------------------ a greeting
  let before = sends.length;
  const hey = await inbound(P[0]!, "Hey");
  script.set("Subject: Re: Chair servicing\nHey", () => ({ action: "reply", reply: "Hi! Thanks for getting back to me. How do you look after your dental chairs at the moment?", category: "other" }));
  await classify(hey.id);
  let row = await agentRow(hey.id);
  check("a greeting is answered by the agent, in one turn, through the send path", sends.length === before + 1 && row?.status === "replied" && row.turns.length === 1, `${row?.status} turns=${row?.turns.length}`);
  check("the greeting is not marked interested", (await classification(hey.id))?.proposedCategoryKey === "other");
  check("the classifier's draft job did not also run", (await initialDrafts(hey.id)) === 0);
  check("the time from the message to the answer is recorded", typeof row?.totalMs === "number" && row.totalMs >= 0, `${row?.totalMs} ms`);
  check("the agent saw the business information and the owner's next step", /₹2,499/.test(prompts.at(-1) ?? "") && /NEXT STEP TO OFFER/.test(prompts.at(-1) ?? ""));

  // ------------------------------------------------------------ retry: never twice
  before = sends.length;
  const again = await runReplyAgent(hey.id, deps);
  check("running the same message again sends nothing", sends.length === before && again?.status === "stopped", again?.reason ?? "");

  // ------------------------------------------------------------ a question from the business information
  before = sends.length;
  const price = await inbound(P[1]!, "How much is the maintenance plan?");
  script.set("Subject: Re: Chair servicing\nHow much is the maintenance plan?", () => ({ action: "reply", reply: "The monthly maintenance plan is ₹2,499 per chair and includes two visits. How many chairs do you have?", category: "interested" }));
  await classify(price.id);
  row = await agentRow(price.id);
  check("a price question is answered from the business information", sends.length === before + 1 && /₹2,499/.test(sends.at(-1)?.body ?? "") && row?.status === "replied");

  // ------------------------------------------------------------ an invented price is handed back and fixed
  before = sends.length;
  const discount = await inbound(P[2]!, "Any discount for 3 chairs?");
  script.set("Subject: Re: Chair servicing\nAny discount for 3 chairs?", (turn) => turn === 1
    ? { action: "reply", reply: "Yes! For 3 chairs it is just ₹1,999 each.", category: "interested" }
    : { action: "reply", reply: "The plan is ₹2,499 per chair; I'll ask Ravi about a price for three chairs and confirm.", ownerNote: { kind: "question", note: "asks for a discount for 3 chairs" }, category: "interested" });
  await classify(discount.id);
  row = await agentRow(discount.id);
  const feedbackPrompt = prompts.at(-1) ?? "";
  check("an invented price is not sent; the agent is told what to fix", /PROBLEMS TO FIX/.test(feedbackPrompt) && /1,999/.test(feedbackPrompt), feedbackPrompt.split("PROBLEMS TO FIX:")[1]?.trim().split("\n")[0] ?? "");
  check("its second turn goes out, and the owner gets the question", sends.length === before + 1 && !/1,999/.test(sends.at(-1)?.body ?? "") && row?.turns.length === 2 && Boolean(await card(P[2]!, "missing_info")), `turns=${row?.turns.length}`);

  // ------------------------------------------------------------ never backed: holding line + card
  before = sends.length;
  const stubborn = await inbound(P[3]!, "Can you come Saturday at 5pm?");
  script.set("Subject: Re: Chair servicing\nCan you come Saturday at 5pm?", () => ({ action: "reply", reply: "Sure, Saturday at 5pm works, see you then!", category: "interested" }));
  await classify(stubborn.id);
  row = await agentRow(stubborn.id);
  check("a reply still unbacked after three turns becomes an honest holding line", sends.length === before + 1 && /get back to you/.test(sends.at(-1)?.body ?? "") && row?.turns.length === 3, sends.at(-1)?.body ?? "");
  check("…and the owner gets a card for it", Boolean(await card(P[3]!, "missing_info")));

  // ------------------------------------------------------------ a ready lead
  before = sends.length;
  const ready = await inbound(P[4]!, "Yes, please send someone to look at our chairs");
  script.set("Subject: Re: Chair servicing\nYes, please send someone to look at our chairs", () => ({ action: "reply", reply: "Great, I have noted it and Ravi will get back to you personally to arrange the visit. Which area of Pune is your clinic in?", ownerNote: { kind: "ready", note: "wants a technician visit" }, category: "interested" }));
  await classify(ready.id);
  const readyCard = await card(P[4]!, "ready");
  check("a ready lead gets an answer and a Needs you card marked as told", sends.length === before + 1 && Boolean(readyCard) && Boolean(readyCard?.handoverSentAt), readyCard?.reason ?? "");

  // ------------------------------------------------------------ stop
  before = sends.length;
  const stop = await inbound(P[5]!, "Not interested, leave us alone");
  script.set("Subject: Re: Chair servicing\nNot interested, leave us alone", () => ({ action: "stop_contact", category: "not_interested" }));
  await classify(stop.id);
  check("a stop request sets Do Not Contact and sends nothing", sends.length === before && await isPersonDoNotContact(db, P[5]!) && (await agentRow(stop.id))?.status === "stopped");

  // ------------------------------------------------------------ an acknowledgement
  before = sends.length;
  const ok = await inbound(P[1]!, "ok thanks", "t2");
  script.set("Subject: Re: Chair servicing\nok thanks", () => ({ action: "no_reply", category: "other" }));
  await classify(ok.id);
  check("an acknowledgement after an answer needs no answer when the agent says so", sends.length === before && (await agentRow(ok.id))?.status === "no_reply");

  // ------------------------------------------------------------ Review mode
  before = sends.length;
  const reviewMessage = await inbound(P[12]!, "How much is the maintenance plan?");
  await classify(reviewMessage.id);
  row = await agentRow(reviewMessage.id);
  const [reviewDraft] = row?.draftId ? await db.select().from(crm.crmDrafts).where(eq(crm.crmDrafts.id, row.draftId)) : [];
  check("Review mode: the answer is written and waits, nothing is sent", sends.length === before && row?.status === "drafted" && reviewDraft?.status === "awaiting_review");

  // ------------------------------------------------------------ a newer message wins
  before = sends.length;
  const first = await inbound(P[6]!, "Hi", "t-newer");
  let second: { id: string } | null = null;
  script.set("Subject: Re: Chair servicing\nHi", () => ({ action: "reply", reply: "Hi! How can I help with your chairs?" }));
  const slowModel: AgentModel = async (input) => {
    // The lead writes again while the agent is still answering the first message.
    if (!second) second = await inbound(P[6]!, "Do you also service autoclaves?", "t-newer");
    return model(input);
  };
  const firstOutcome = await runReplyAgent(first.id, { ...deps, model: slowModel });
  check("a newer message arriving while answering stops the older answer", sends.length === before && firstOutcome?.status === "stopped" && /newer/.test(firstOutcome.reason ?? ""), firstOutcome?.reason ?? "");
  script.set("Subject: Re: Chair servicing\nDo you also service autoclaves?", () => ({ action: "reply", reply: "Yes, we service autoclaves as well as dental chairs, same week. How many do you have?" }));
  await classify(second!.id);
  check("…and the newer message is answered with the whole conversation", sends.length === before + 1 && /CONVERSATION SO FAR[\s\S]*LEAD: Hi/.test(prompts.at(-1) ?? ""));

  // ------------------------------------------------------------ the classifier keeps what is not the agent's
  const taken = await inbound(P[7]!, "Hello?");
  await takeOverConversation(taken.conversationId, null);
  check("a chat the owner took over is left to the classifier", (await runReplyAgent(taken.id, deps)) === null);
  const outsider = await inbound(P[13]!, "Hello?");
  check("a lead outside any running run is left to the classifier", (await runReplyAgent(outsider.id, deps)) === null);

  // ------------------------------------------------------------ the model is down
  before = sends.length;
  const outage = await inbound(P[8]!, "What areas do you cover?", "t-outage");
  script.set("Subject: Re: Chair servicing\nWhat areas do you cover?", () => new Error("simulated model outage"));
  await classify(outage.id);
  row = await agentRow(outage.id);
  check("when the model is down the lead still gets a holding line and the owner a card", sends.length === before + 1 && row?.status === "replied" && Boolean(await card(P[8]!, "uncertain")), row?.turns.map((turn) => turn.error).join(" | ") ?? "");

  before = sends.length;
  const outageAgain = await inbound(P[8]!, "Hello? Anyone there?", "t-outage");
  script.set("Subject: Re: Chair servicing\nHello? Anyone there?", () => new Error("simulated model outage"));
  const [outageConversation] = await db.select({ id: crm.crmConversationMessages.conversationId }).from(crm.crmConversationMessages).where(eq(crm.crmConversationMessages.id, outage.id));
  if (outageAgain.conversationId === outageConversation?.id) {
    await classify(outageAgain.id);
    check("the holding line is not repeated in the same chat while the model stays down", sends.length === before && (await agentRow(outageAgain.id))?.status === "told_owner");
  } else {
    check("the second outage message lands in the same chat", false, "different conversation");
  }

  // ------------------------------------------------------------ the Replies list
  const replies = (await runReplies([autoRun!.id], 20))[autoRun!.id] ?? [];
  const shown = replies.find((item) => item.id === price.id);
  check("the Replies list shows the agent's outcome with its time", Boolean(shown && /Answered automatically in \d/.test(shown.state.text)), shown?.state.text ?? "(missing)");
  const shownOk = replies.find((item) => item.id === ok.id);
  check("…and a message that needed no answer", Boolean(shownOk && /No answer needed/.test(shownOk.state.text)), shownOk?.state.text ?? "(missing)");

  // ============================================================ wrong number (WhatsApp)
  const waAccount = `wa-agent-check-${stamp}`;
  const phoneOf = (index: number) => `+9198${String(stamp).slice(-6)}${String(index).padStart(2, "0")}`;
  const waPersons = await db.insert(people).values(Array.from({ length: 28 }, (_, index) => ({
    organizationId: orgId,
    phone: phoneOf(index),
    fullName: `Dr Wrong ${index + 1}`,
    source: "reply-agent-check",
  }))).returning({ id: people.id });
  const W = waPersons.map((person) => person.id);
  // W[1] is a duplicate record of W[0]'s lead: the same number, another row.
  await db.update(people).set({ phone: phoneOf(0) }).where(eq(people.id, W[1]!));
  // W[17] is a duplicate record of W[16]'s lead, whose chat is addressed by a privacy id (@lid).
  await db.update(people).set({ phone: phoneOf(16) }).where(eq(people.id, W[17]!));
  const waPlan = { ...plan, autopilot: true };
  const [waAuto] = await db.insert(schema.outreachRuns).values({ organizationId: orgId, threadId: thread.id, audienceId, name: "Automatic WhatsApp run", status: "running", channels: ["whatsapp"], plan: waPlan, autopilot: true, approvedAt: new Date(Date.now() - 60_000) }).returning();
  const [waReview] = await db.insert(schema.outreachRuns).values({ organizationId: orgId, threadId: thread.id, audienceId, name: "Review WhatsApp run", status: "running", channels: ["whatsapp"], plan: { ...waPlan, autopilot: false }, autopilot: false }).returning();
  const autoIdx = [0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 23, 24, 25, 26, 27];
  const reviewIdx = [2, 19];
  await db.insert(schema.outreachRunLeads).values([
    ...autoIdx.map((index) => ({ organizationId: orgId, runId: waAuto!.id, personId: W[index]!, channel: "whatsapp" as const })),
    ...reviewIdx.map((index) => ({ organizationId: orgId, runId: waReview!.id, personId: W[index]!, channel: "whatsapp" as const })),
    // W[13], W[18], W[20], W[21] and W[22] are in no run: the classifier path, Review semantics.
  ]);

  const waSends: { body: string; phone: string | null; thread: string | null }[] = [];
  const waSend: CrmSendAdapter = async (input) => {
    waSends.push({ body: input.bodyText, phone: input.recipientPhone ?? null, thread: input.providerThreadId });
    return { provider: "unipile", providerMessageId: `wa-check-${stamp}-${waSends.length}`, providerThreadId: input.providerThreadId, rfcMessageId: null, response: {} };
  };
  const waDeps = { model, send: waSend, allowNonProduction: true, brief: false };
  const sentTo = (index: number) => waSends.filter((item) => item.thread === `wa-chat-${index}-${stamp}`).length;
  const standInClassifier: ClassificationCompletion = async () => ({
    text: JSON.stringify({ categoryKey: "other", subcategoryKey: "wrong_number", confidence: 0.9, reasoning: "stand-in: wrong number", suggestedNextActionAt: null }),
    provider: "stand-in",
    model: "stand-in-classifier",
    request: {},
    response: {},
  });
  let waN = 0;
  /** A WhatsApp message from the number the person's chat is with (their own phone unless given; a privacy id when the chat is addressed by one). */
  async function waInbound(index: number, body: string, idempotencyKey = `wa-in-${index}-${stamp}-${(waN += 1)}`, phone = phoneOf(index), contactId?: string) {
    const digits = phone.replace(/\D/g, "");
    return ingestInboundReply({
      personId: W[index]!,
      channel: "whatsapp",
      accountRef: waAccount,
      providerThreadId: `wa-chat-${index}-${stamp}`,
      providerContactId: contactId ?? `${digits}@s.whatsapp.net`,
      idempotencyKey,
      providerMessageId: `wa-pm-${idempotencyKey}`,
      bodyText: body,
      sentAt: new Date(),
    });
  }
  async function waClassify(messageId: string, extra: { complete?: ClassificationCompletion; send?: CrmSendAdapter } = {}) {
    const [job] = await db.select().from(crm.crmJobs).where(and(eq(crm.crmJobs.kind, "classification"), eq(crm.crmJobs.entityId, messageId))).limit(1);
    await handleClassificationJob(job as unknown as CrmJob, { replyAgent: { ...waDeps, ...(extra.send ? { send: extra.send } : {}) }, ...(extra.complete ? { complete: extra.complete } : {}) });
  }
  const routeOf = async (index: number) => (await db.select().from(crm.crmWrongRoutes)
    .where(and(eq(crm.crmWrongRoutes.organizationId, orgId), eq(crm.crmWrongRoutes.route, phoneOf(index).replace(/\D/g, "")))).limit(1))[0] ?? null;
  const runLead = async (index: number) => (await db.select().from(schema.outreachRunLeads)
    .where(and(eq(schema.outreachRunLeads.organizationId, orgId), eq(schema.outreachRunLeads.personId, W[index]!))).limit(1))[0] ?? null;
  const recordOf = async (index: number) => (await db.select().from(crm.crmRecords).where(and(eq(crm.crmRecords.organizationId, orgId), eq(crm.crmRecords.personId, W[index]!))).limit(1))[0] ?? null;
  const awaitingDrafts = async (index: number) => {
    const record = await recordOf(index);
    return record ? db.select().from(crm.crmDrafts).where(and(eq(crm.crmDrafts.crmRecordId, record.id), eq(crm.crmDrafts.status, "awaiting_review"))) : [];
  };
  const APOLOGY = "Sorry about that—we won't message this number again.";
  script.set("Wrong number", () => ({ action: "wrong_number", reply: APOLOGY }));

  // ------------------------------------------------------------ Automatic: one apology, then nothing
  const wrongKey = `wa-in-0-first-${stamp}`;
  const wrong = await waInbound(0, "Wrong number", wrongKey);
  await waClassify(wrong.message.id);
  let route = await routeOf(0);
  check("Automatic: \"Wrong number\" gets exactly one brief apology", sentTo(0) === 1 && waSends.at(-1)?.body === APOLOGY && route?.ackStatus === "sent", `${sentTo(0)} sent, ack ${route?.ackStatus}`);
  check("…the number is recorded as wrong for the intended lead, not Do Not Contact", route?.personId === W[0] && route?.messageId === wrong.message.id && !(await isPersonDoNotContact(db, W[0]!)));
  check("…outreach to the number stopped (run lead stopped, not opted out)", (await runLead(0))?.status === "stopped");
  check("…and to a duplicate record holding the same number", (await runLead(1))?.status === "stopped");
  const dupFacts = (await loadPersonFacts([W[1]!])).get(W[1]!);
  check("…which no later run can enrol on WhatsApp", Boolean(dupFacts) && !contactChannels(dupFacts!).channels.includes("whatsapp"), contactChannels(dupFacts!).reason ?? "");
  let record = await recordOf(0);
  const [wrongClass] = await db.select().from(crm.crmClassifications).where(eq(crm.crmClassifications.messageId, wrong.message.id));
  const [wrongSub] = record?.subcategoryId ? await db.select().from(crm.crmSubcategories).where(eq(crm.crmSubcategories.id, record.subcategoryId)) : [];
  check("…filed as Wrong Number (other), not interested or not interested", record?.categoryKey === "other" && wrongSub?.key === "wrong_number" && wrongClass?.proposedCategoryKey === "other", `${record?.categoryKey}/${wrongSub?.key}`);
  check("…and nothing is left in Action required", record?.workflowState === "idle", record?.workflowState ?? "");
  check("…the reply agent logged it as a wrong number", (await agentRow(wrong.message.id))?.action === "wrong_number" && (await agentRow(wrong.message.id))?.status === "replied");

  let waBefore = waSends.length;
  const repeat = await waInbound(0, "I said wrong number!!");
  await waClassify(repeat.message.id);
  check("a repeated \"wrong number\" gets no second apology", waSends.length === waBefore && (await routeOf(0))?.ackStatus === "sent");
  check("…and no draft, and no Action required", (await awaitingDrafts(0)).length === 0 && (await recordOf(0))?.workflowState === "idle", (await recordOf(0))?.workflowState ?? "");
  const duplicate = await waInbound(0, "Wrong number", wrongKey);
  check("a duplicate webhook is the same message, not a new one", duplicate.duplicate && duplicate.message.id === wrong.message.id);
  await db.update(schema.replyAgentRuns).set({ status: "running", updatedAt: new Date(Date.now() - 10 * 60_000) }).where(eq(schema.replyAgentRuns.messageId, wrong.message.id));
  const restarted = await runReplyAgent(wrong.message.id, waDeps);
  const resumed = await closeWrongNumber({ messageId: wrong.message.id, source: "reply_agent", acknowledgement: APOLOGY, optOut: false, sendAllowed: true }, { send: waSend });
  check("a restarted job and a retried close send nothing more", waSends.length === waBefore && resumed?.ackStatus === "sent", `${restarted?.status ?? "not the agent's"} / ${resumed?.summary}`);

  record = await recordOf(0);
  const [salesDraft] = await db.insert(crm.crmDrafts).values({
    crmRecordId: record!.id, conversationId: wrong.conversation.id, replyForMessageId: null, sequenceStepRunId: null,
    expectedContextVersion: record!.contextVersion, channel: "whatsapp", subject: null, aiBodyText: "Following up on our dental chair servicing offer!",
    status: "awaiting_review", provider: "check", model: "check", request: {}, response: {},
  }).returning();
  let refusal = "";
  try {
    await sendDraft({ draftId: salesDraft!.id, revision: salesDraft!.revision, idempotencyKey: `sales-after-wrong-${stamp}`, requestId: crypto.randomUUID(), actorRef: null }, { send: waSend });
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
  }
  check("a later sales message to the number is refused by the send path", waSends.length === waBefore && /wrong number/i.test(refusal), refusal);
  const dupMessage = await waInbound(1, "Hello?", undefined, phoneOf(0));
  await waClassify(dupMessage.message.id, { complete: standInClassifier });
  check("the duplicate record's chat on that number gets nothing either", waSends.length === waBefore && (await awaitingDrafts(1)).length === 0);

  // ------------------------------------------------------------ Review mode: one draft, sent only on approval
  waBefore = waSends.length;
  const reviewWrong = await waInbound(2, "Wrong number");
  await waClassify(reviewWrong.message.id);
  route = await routeOf(2);
  let drafts = await awaitingDrafts(2);
  check("Review mode: one apology draft and no send", waSends.length === waBefore && drafts.length === 1 && drafts[0]?.aiBodyText === APOLOGY && route?.ackStatus === "drafted" && route.ackDraftId === drafts[0]?.id);
  check("…the record waits in Action required, outreach already stopped", (await recordOf(2))?.workflowState === "action_required" && (await runLead(2))?.status === "stopped");
  const reviewAgain = await waInbound(2, "wrong number, sorry");
  await waClassify(reviewAgain.message.id);
  drafts = await awaitingDrafts(2);
  route = await routeOf(2);
  check("a repeat before approval still leaves exactly one apology draft", waSends.length === waBefore && drafts.length === 1 && route?.ackDraftId === drafts[0]?.id && route?.ackStatus === "drafted");
  await sendDraft({ draftId: drafts[0]!.id, revision: drafts[0]!.revision, idempotencyKey: `approve-${stamp}`, requestId: crypto.randomUUID(), actorRef: null }, { send: waSend });
  route = await routeOf(2);
  check("approving it sends the one apology", sentTo(2) === 1 && route?.ackStatus === "sent" && (await recordOf(2))?.workflowState === "idle", `${sentTo(2)} / ${route?.ackStatus} / ${(await recordOf(2))?.workflowState}`);
  refusal = "";
  try {
    await sendDraft({ draftId: drafts[0]!.id, revision: drafts[0]!.revision, idempotencyKey: `approve-again-${stamp}`, requestId: crypto.randomUUID(), actorRef: null }, { send: waSend });
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
  }
  check("…and approving it again sends nothing", sentTo(2) === 1 && Boolean(refusal), refusal);

  // ------------------------------------------------------------ concurrent workers
  waBefore = waSends.length;
  // W[5] is another record holding W[4]'s number: two chats, one route, three workers at once.
  await db.update(people).set({ phone: phoneOf(4) }).where(eq(people.id, W[5]!));
  const raceA = await waInbound(4, "Wrong number");
  const raceB = await waInbound(5, "Wrong number", undefined, phoneOf(4));
  const racers = await Promise.all([
    closeWrongNumber({ messageId: raceA.message.id, source: "classifier", acknowledgement: null, optOut: false, sendAllowed: true }, { send: waSend }),
    closeWrongNumber({ messageId: raceA.message.id, source: "classifier", acknowledgement: null, optOut: false, sendAllowed: true }, { send: waSend }),
    closeWrongNumber({ messageId: raceB.message.id, source: "classifier", acknowledgement: null, optOut: false, sendAllowed: true }, { send: waSend }),
  ]);
  check("concurrent workers on one number send one apology", waSends.length === waBefore + 1, `${waSends.length - waBefore} sent; ${racers.map((outcome) => outcome?.ackStatus).join(", ")}`);

  // ------------------------------------------------------------ failed and uncertain apologies
  waBefore = waSends.length;
  let attempts = 0;
  const refusing: CrmSendAdapter = async () => { attempts += 1; throw new DefiniteCrmSendError("simulated provider refusal"); };
  const failed = await waInbound(6, "Wrong number");
  await waClassify(failed.message.id, { send: refusing });
  route = await routeOf(6);
  check("a failed apology is recorded as failed", attempts === 1 && route?.ackStatus === "failed" && (await recordOf(6))?.workflowState === "idle", `${route?.ackStatus} / ${(await recordOf(6))?.workflowState}`);
  await closeWrongNumber({ messageId: failed.message.id, source: "classifier", acknowledgement: null, optOut: false, sendAllowed: true }, { send: refusing });
  await closeWrongNumber({ messageId: failed.message.id, source: "classifier", acknowledgement: null, optOut: false, sendAllowed: true }, { send: waSend });
  check("…is never retried, and the number stays stopped", attempts === 1 && waSends.length === waBefore && (await routeOf(6))?.ackStatus === "failed" && (await runLead(6))?.status === "stopped");

  let lost = 0;
  const losing: CrmSendAdapter = async () => { lost += 1; throw new Error("simulated lost response"); };
  const uncertain = await waInbound(7, "Wrong number");
  await waClassify(uncertain.message.id, { send: losing });
  route = await routeOf(7);
  check("an apology whose response was lost is uncertain", lost === 1 && route?.ackStatus === "uncertain", route?.ackStatus ?? "");
  await closeWrongNumber({ messageId: uncertain.message.id, source: "classifier", acknowledgement: null, optOut: false, sendAllowed: true }, { send: waSend });
  check("…is not resent blindly, and the number stays stopped", lost === 1 && waSends.length === waBefore && (await routeOf(7))?.ackStatus === "uncertain" && (await runLead(7))?.status === "stopped");

  // ------------------------------------------------------------ restarts mid-way
  const interrupted = await waInbound(8, "Wrong number");
  // As if the process died after claiming the apology, before sending it.
  const firstPass = await closeWrongNumber({ messageId: interrupted.message.id, source: "classifier", acknowledgement: null, optOut: false, sendAllowed: false }, { send: waSend });
  await db.update(crm.crmWrongRoutes).set({ ackStatus: "reserved" }).where(eq(crm.crmWrongRoutes.id, firstPass!.routeId!));
  waBefore = waSends.length;
  const secondPass = await closeWrongNumber({ messageId: interrupted.message.id, source: "classifier", acknowledgement: null, optOut: false, sendAllowed: true }, { send: waSend });
  const thirdPass = await closeWrongNumber({ messageId: interrupted.message.id, source: "classifier", acknowledgement: null, optOut: false, sendAllowed: true }, { send: waSend });
  check("a restart after the claim sends it once, and only once", firstPass?.ackStatus === "drafted" && secondPass?.ackStatus === "sent" && thirdPass?.ackStatus === "sent" && waSends.length === waBefore + 1, `${firstPass?.ackStatus} → ${secondPass?.ackStatus} → ${thirdPass?.ackStatus}`);
  const midSend = await waInbound(9, "Wrong number");
  const drafted = await closeWrongNumber({ messageId: midSend.message.id, source: "classifier", acknowledgement: null, optOut: false, sendAllowed: false }, { send: waSend });
  // As if the process died after the send began (the claim was consumed).
  await db.update(crm.crmWrongRoutes).set({ ackStatus: "sending" }).where(eq(crm.crmWrongRoutes.id, drafted!.routeId!));
  waBefore = waSends.length;
  const afterCrash = await closeWrongNumber({ messageId: midSend.message.id, source: "classifier", acknowledgement: null, optOut: false, sendAllowed: true }, { send: waSend });
  check("a restart after the send began marks it uncertain and sends nothing", afterCrash?.ackStatus === "uncertain" && waSends.length === waBefore, afterCrash?.ackStatus ?? "");

  // ------------------------------------------------------------ nothing for blocked leads
  waBefore = waSends.length;
  await setPersonDoNotContact({ personId: W[10]!, reason: "asked earlier", source: "human", actorType: "human" });
  const dncWrong = await waInbound(10, "Wrong number");
  await waClassify(dncWrong.message.id, { complete: standInClassifier });
  route = await routeOf(10);
  check("a lead already marked Do Not Contact gets no apology", waSends.length === waBefore && route?.ackStatus === "blocked" && (await awaitingDrafts(10)).length === 0, `${route?.ackStatus}: ${route?.ackReason}`);

  const optOut = await waInbound(11, "Wrong number, stop messaging me");
  await waClassify(optOut.message.id, { complete: standInClassifier });
  route = await routeOf(11);
  check("\"Wrong number, stop messaging me\" is Do Not Contact and nothing is sent", waSends.length === waBefore && await isPersonDoNotContact(db, W[11]!) && route?.ackStatus === "blocked" && (await awaitingDrafts(11)).length === 0, `${route?.ackStatus}: ${route?.ackReason}`);
  // The classifier path's own rule misses this one; the agent reads a wrong
  // number, and the opt-out beside it still wins.
  script.set("I'm not Dr Wrong 13, don't text me again", () => ({ action: "wrong_number", reply: APOLOGY }));
  const optOutAgent = await waInbound(12, "I'm not Dr Wrong 13, don't text me again");
  await waClassify(optOutAgent.message.id);
  check("…as is a wrong number the agent reads beside \"don't text me\"", waSends.length === waBefore && await isPersonDoNotContact(db, W[12]!) && (await routeOf(12))?.ackStatus === "blocked", (await routeOf(12))?.ackStatus ?? "no route");

  const takenWrong = await waInbound(14, "Wrong number");
  await takeOverConversation(takenWrong.conversation.id, null);
  await waClassify(takenWrong.message.id, { complete: standInClassifier });
  check("a chat the owner took over gets no apology, and the number still stops", waSends.length === waBefore && (await routeOf(14))?.ackStatus === "blocked" && (await runLead(14))?.status === "stopped");

  // ------------------------------------------------------------ the classifier path, outside any run
  const outside = await waInbound(13, "Sorry, wrong number");
  await waClassify(outside.message.id, { complete: standInClassifier });
  check("outside any run the classifier path drafts the apology for review and sends nothing", waSends.length === waBefore && (await awaitingDrafts(13)).length === 1 && (await routeOf(13))?.ackStatus === "drafted");

  // ------------------------------------------------------------ the model fails, or writes a bad apology
  script.set("wrong number bro", () => new Error("simulated model outage"));
  const outageWrong = await waInbound(15, "wrong number bro");
  await waClassify(outageWrong.message.id);
  check("when the model is down \"wrong number\" still gets the fixed apology, not a holding line", sentTo(15) === 1 && waSends.at(-1)?.body === APOLOGY, waSends.at(-1)?.body ?? "");
  const badIdx = 3;
  script.set("This isn't Dr Wrong's number", () => ({ action: "wrong_number", reply: "Sorry! Could you share the right number for Dr Wrong? We have a great offer." }));
  const bad = await waInbound(badIdx, "This isn't Dr Wrong's number");
  await waClassify(bad.message.id);
  check("an apology with a question or an offer is replaced by the fixed line", sentTo(badIdx) === 1 && waSends.at(-1)?.body === APOLOGY, waSends.at(-1)?.body ?? "");

  const workspace = await getCrmRecordWorkspace((await recordOf(0))!.id);
  const shownRoute = workspace.wrongRoutes[0];
  check("the CRM record shows \"Wrong number — outreach stopped\" and that the apology was sent", workspace.wrongRoutes.length === 1 && shownRoute?.ackStatus === "sent" && shownRoute.conversationIds.includes(wrong.conversation.id) && wrongRouteAckLabel(shownRoute.ackStatus).label === "Apology sent");
  const reviewWorkspace = await getCrmRecordWorkspace((await recordOf(13))!.id);
  check("…and an apology awaiting review on a record outside any run", reviewWorkspace.wrongRoutes[0]?.ackStatus === "drafted" && reviewWorkspace.wrongRoutes[0]?.ackDraftId === (reviewWorkspace.draft as { id?: string } | null)?.id);
  const actions = await listCrmActions({ recordId: (await recordOf(13))!.id });
  check("…which Action required names as a wrong-number apology", actions.actions[0]?.actionType === "Wrong number: apology review" && actions.actions[0]?.wrongNumberApology === true, actions.actions[0]?.actionType ?? "(no row)");

  isolationPhone = phoneOf(0);

  const wrongReplies = (await runReplies([waAuto!.id], 50))[waAuto!.id] ?? [];
  const wrongShown = wrongReplies.find((item) => item.id === outageWrong.message.id);
  check("the Replies list says wrong number and that the apology went out", Boolean(wrongShown && /Wrong number/.test(wrongShown.state.text) && /apology sent/i.test(wrongShown.state.text)), wrongShown?.state.text ?? "(missing)");

  const routesOfPerson = async (index: number) => db.select().from(crm.crmWrongRoutes).where(and(eq(crm.crmWrongRoutes.organizationId, orgId), eq(crm.crmWrongRoutes.personId, W[index]!)));
  const wrongNumberSubId = (await db.select({ id: crm.crmSubcategories.id }).from(crm.crmSubcategories)
    .where(and(eq(crm.crmSubcategories.pipelineId, (await recordOf(0))!.pipelineId), eq(crm.crmSubcategories.key, "wrong_number"))).limit(1))[0]!.id;

  // ------------------------------------------------------------ a chat addressed by a WhatsApp privacy id (@lid)
  waBefore = waSends.length;
  const lidDigits = phoneOf(16).replace(/\D/g, "");
  const lidWrong = await waInbound(16, "Wrong number", undefined, phoneOf(16), `${String(stamp).slice(-6)}123456789@lid`);
  await waClassify(lidWrong.message.id);
  const lidRoutes = await routesOfPerson(16);
  check("a chat addressed by a privacy id (@lid) records the lead's number as wrong, not the id", lidRoutes.length === 1 && lidRoutes[0]?.route === lidDigits && sentTo(16) === 1, `${lidRoutes.map((item) => item.route).join(",")} for ${lidDigits}; ${sentTo(16)} sent`);
  check("…so a duplicate record holding that number is stopped too", (await runLead(17))?.status === "stopped", (await runLead(17))?.status ?? "");
  check("…and any send to the number by phone (WhatsApp inbox, campaigns) is refused", Boolean(await wrongRouteSendRefusal(db, { channel: "whatsapp", routes: [lidDigits] })));
  const lidDup = await waInbound(17, "Wrong number", undefined, phoneOf(16));
  await waClassify(lidDup.message.id);
  check("…and the same number's chat under its phone id gets no second apology", sentTo(17) === 0 && waSends.length === waBefore + 1 && (await routesOfPerson(17)).length === 0, `${sentTo(17)} sent, ${(await routesOfPerson(17)).length} more routes`);

  // ------------------------------------------------------------ opt-out wording the classifier's own rule misses
  waBefore = waSends.length;
  const strangerStop = await waInbound(18, "This isn't Priya's number anymore, please stop texting me");
  await waClassify(strangerStop.message.id, { complete: standInClassifier });
  route = await routeOf(18);
  check("classifier path: a wrong number read by the model beside \"stop texting me\" is Do Not Contact, nothing drafted or sent", waSends.length === waBefore && await isPersonDoNotContact(db, W[18]!) && route?.ackStatus === "blocked" && (await awaitingDrafts(18)).length === 0, `${route?.ackStatus ?? "no route"}: ${route?.ackReason ?? ""}; ${(await awaitingDrafts(18)).length} awaiting`);
  const reviewFirst = await waInbound(19, "Wrong number");
  await waClassify(reviewFirst.message.id);
  const reviewStop = await waInbound(19, "Stop");
  await waClassify(reviewStop.message.id);
  route = await routeOf(19);
  check("a bare \"Stop\" after \"Wrong number\" is Do Not Contact: the waiting apology is withdrawn, not written again", waSends.length === waBefore && await isPersonDoNotContact(db, W[19]!) && route?.ackStatus === "blocked" && (await awaitingDrafts(19)).length === 0, `${route?.ackStatus ?? "no route"}; ${(await awaitingDrafts(19)).length} awaiting`);

  // ------------------------------------------------------------ a person confirms "Wrong Number"
  const unsureClassifier: ClassificationCompletion = async () => ({
    text: JSON.stringify({ categoryKey: "other", subcategoryKey: "wrong_number", confidence: 0.55, reasoning: "stand-in: maybe a wrong number", suggestedNextActionAt: null }),
    provider: "stand-in", model: "stand-in-classifier", request: {}, response: {},
  });
  const unsure = await waInbound(20, "This is not Rahul's phone");
  await waClassify(unsure.message.id, { complete: unsureClassifier });
  check("an unsure wrong-number reading records nothing and waits for a person", !(await routeOf(20)) && (await recordOf(20))?.workflowState === "action_required", (await recordOf(20))?.workflowState ?? "");
  let confirmed = (await recordOf(20))!;
  await applyHumanClassification({ recordId: confirmed.id, categoryKey: "other", subcategoryId: wrongNumberSubId, expectedContextVersion: confirmed.contextVersion });
  route = await routeOf(20);
  drafts = await awaitingDrafts(20);
  confirmed = (await recordOf(20))!;
  check("a person confirming Wrong Number records the route and stops outreach on it", route?.source === "human" && route.messageId === unsure.message.id, route ? `${route.source} / ${route.messageId}` : "no route");
  check("…leaving one apology for review and no sales draft", waSends.length === waBefore && drafts.length === 1 && route?.ackStatus === "drafted" && route.ackDraftId === drafts[0]?.id && drafts[0]?.expectedContextVersion === confirmed.contextVersion && (await initialDrafts(unsure.message.id)) === 0 && confirmed.workflowState === "action_required", `${drafts.length} awaiting, ${await initialDrafts(unsure.message.id)} draft jobs, ${confirmed.workflowState}`);
  const decided = await waInbound(21, "Sorry, wrong number");
  await waClassify(decided.message.id, { complete: standInClassifier });
  confirmed = (await recordOf(21))!;
  await applyHumanClassification({ recordId: confirmed.id, categoryKey: "other", subcategoryId: wrongNumberSubId, expectedContextVersion: confirmed.contextVersion });
  drafts = await awaitingDrafts(21);
  route = await routeOf(21);
  confirmed = (await recordOf(21))!;
  check("confirming Wrong Number after the apology was drafted keeps exactly one, written for the new context", drafts.length === 1 && route?.ackStatus === "drafted" && route.ackDraftId === drafts[0]?.id && drafts[0]?.expectedContextVersion === confirmed.contextVersion && (await initialDrafts(decided.message.id)) === 0, `${drafts.length} awaiting, route ${route?.ackStatus}`);
  if (drafts[0]) await sendDraft({ draftId: drafts[0].id, revision: drafts[0].revision, idempotencyKey: `confirm-approve-${stamp}`, requestId: crypto.randomUUID(), actorRef: null }, { send: waSend });
  check("…which a person then approves: sent once", sentTo(21) === 1 && (await routeOf(21))?.ackStatus === "sent", `${sentTo(21)} sent, ${(await routeOf(21))?.ackStatus}`);

  // ------------------------------------------------------------ a person discards the apology
  waBefore = waSends.length;
  const toDiscard = await waInbound(22, "Wrong number");
  await waClassify(toDiscard.message.id, { complete: standInClassifier });
  drafts = await awaitingDrafts(22);
  if (drafts[0]) await discardDraft({ draftId: drafts[0].id });
  route = await routeOf(22);
  check("discarding the apology ends it: the record no longer says one awaits review", drafts.length === 1 && route?.ackStatus === "blocked", `${route?.ackStatus}: ${route?.ackReason ?? ""}`);
  // As a route discarded before that was recorded would be: still "drafted".
  await db.update(crm.crmWrongRoutes).set({ ackStatus: "drafted" }).where(eq(crm.crmWrongRoutes.id, route!.id));
  const afterDiscard = await waInbound(22, "??");
  await waClassify(afterDiscard.message.id, { complete: standInClassifier });
  check("…and a later message does not bring it back", waSends.length === waBefore && (await awaitingDrafts(22)).length === 0 && (await routeOf(22))?.ackStatus === "blocked" && (await recordOf(22))?.workflowState !== "action_required", `${(await awaitingDrafts(22)).length} awaiting, route ${(await routeOf(22))?.ackStatus}, ${(await recordOf(22))?.workflowState}`);

  // ------------------------------------------------------------ a requeued job finishes what a crash left
  const jobOf = async (messageId: string) => (await db.select().from(crm.crmJobs).where(and(eq(crm.crmJobs.kind, "classification"), eq(crm.crmJobs.entityId, messageId))).limit(1))[0] as unknown as CrmJob;
  /** As if the worker died right after the job's classification committed. */
  async function classifiedThenCrashed(index: number, messageId: string) {
    const job = await jobOf(messageId);
    const record = (await recordOf(index))!;
    await withCrmTransaction((tx) => recordAiClassificationInTransaction(tx, {
      recordId: record.id, messageId, expectedContextVersion: Number(job.payload.expectedContextVersion ?? record.contextVersion),
      categoryKey: "other", subcategoryId: wrongNumberSubId, confidence: 0.9, reasoning: "stand-in: wrong number",
      provider: "stand-in", model: "stand-in-classifier", request: {}, response: {},
    }));
    return job;
  }
  async function requeued(job: CrmJob): Promise<string> {
    try {
      await handleClassificationJob(job, { replyAgent: waDeps, complete: standInClassifier });
      return "done";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  waBefore = waSends.length;
  const crashedEarly = await waInbound(24, "Wrong number");
  const earlyJob = await classifiedThenCrashed(24, crashedEarly.message.id);
  const earlyResult = await requeued(earlyJob);
  check("a requeued job whose classification committed records the route and sends the one apology", earlyResult === "done" && (await routeOf(24))?.ackStatus === "sent" && sentTo(24) === 1 && (await runLead(24))?.status === "stopped", `${earlyResult}; ${(await routeOf(24))?.ackStatus ?? "no route"}`);
  const crashedSending = await waInbound(25, "Wrong number");
  const sendingJob = await classifiedThenCrashed(25, crashedSending.message.id);
  const sendingRoute = await closeWrongNumber({ messageId: crashedSending.message.id, source: "classifier", acknowledgement: null, optOut: false, sendAllowed: false }, { send: waSend });
  await db.update(crm.crmWrongRoutes).set({ ackStatus: "sending" }).where(eq(crm.crmWrongRoutes.id, sendingRoute!.routeId!));
  const sendingResult = await requeued(sendingJob);
  check("a requeued job after the send began marks the apology uncertain and sends nothing", sendingResult === "done" && (await routeOf(25))?.ackStatus === "uncertain" && sentTo(25) === 0, `${sendingResult}; ${(await routeOf(25))?.ackStatus}`);
  const crashedReserved = await waInbound(26, "Wrong number");
  const reservedJob = await classifiedThenCrashed(26, crashedReserved.message.id);
  const reservedRoute = await closeWrongNumber({ messageId: crashedReserved.message.id, source: "classifier", acknowledgement: null, optOut: false, sendAllowed: false }, { send: waSend });
  await db.update(crm.crmWrongRoutes).set({ ackStatus: "reserved" }).where(eq(crm.crmWrongRoutes.id, reservedRoute!.routeId!));
  const reservedResult = await requeued(reservedJob);
  const reservedAgain = await requeued(reservedJob);
  check("a requeued job after the claim sends the apology once, and a second requeue nothing", reservedResult === "done" && (await routeOf(26))?.ackStatus === "sent" && sentTo(26) === 1 && /stale/i.test(reservedAgain), `${reservedResult} / ${reservedAgain}; ${(await routeOf(26))?.ackStatus}, ${sentTo(26)} sent`);
  check("…and none of them sent anything else", waSends.length === waBefore + 2, `${waSends.length - waBefore} sent`);

  // ------------------------------------------------------------ answered by hand before the job ran
  waBefore = waSends.length;
  const answeredWrong = await waInbound(27, "Wrong number");
  await new Promise((resolve) => setTimeout(resolve, 10));
  await withCrmTransaction((tx) => recordManualOutboundInTransaction(tx, {
    recordId: answeredWrong.record.id, personId: W[27]!, channel: "whatsapp", accountRef: waAccount,
    providerThreadId: `wa-chat-27-${stamp}`, providerContactId: `${phoneOf(27).replace(/\D/g, "")}@s.whatsapp.net`,
    idempotencyKey: `wa-by-hand-27-${stamp}`, bodyText: "Oh, sorry!", sentAt: new Date(), reason: "manual_outbound_whatsapp", actorType: "integration",
  }));
  await waClassify(answeredWrong.message.id);
  route = await routeOf(27);
  check("\"Wrong number\" answered by hand before the job ran: the number is still recorded and stopped, no apology on top", waSends.length === waBefore && route?.ackStatus === "blocked" && (await runLead(27))?.status === "stopped" && (await recordOf(27))?.workflowState === "idle", `${route?.ackStatus ?? "no route"}: ${route?.ackReason ?? ""} / ${(await recordOf(27))?.workflowState}`);

  // ------------------------------------------------------------ the daily limit is reached (last: it holds every automatic reply)
  await db.insert(schema.autopilotReplies).values(Array.from({ length: AUTOPILOT_LIMITS.perDay }, () => ({
    organizationId: orgId, draftId: crypto.randomUUID(), revision: 1, conversationId: crypto.randomUUID(), status: "sent" as const, reason: "limit filler",
  })));
  waBefore = waSends.length;
  const limited = await waInbound(23, "Wrong number");
  await waClassify(limited.message.id);
  route = await routeOf(23);
  check("with the daily limit reached \"Wrong number\" is still recorded: outreach stopped, the apology waits for review", waSends.length === waBefore && route?.ackStatus === "drafted" && /limit/.test(route.ackReason ?? "") && (await runLead(23))?.status === "stopped" && (await awaitingDrafts(23)).length === 1, `${route?.ackStatus ?? "no route"}: ${route?.ackReason ?? ""}`);
  check("…and filed as Wrong Number", (await classification(limited.message.id))?.proposedSubcategoryId === wrongNumberSubId);
  await db.delete(schema.autopilotReplies).where(and(eq(schema.autopilotReplies.organizationId, orgId), eq(schema.autopilotReplies.reason, "limit filler")));

  // ------------------------------------------------------------ the real model (optional)
  const aiSource = process.env.AI_SOURCE_ORGANIZATION_ID?.trim();
  if (aiSource) {
    const { copyAiSettings } = await import("./copyAiSettings");
    await copyAiSettings(aiSource, orgId);
    // REPLY_AGENT_E2E_MODEL tries another model of the same connection (e.g. z-ai/glm-5.3-flash).
    const override = process.env.REPLY_AGENT_E2E_MODEL?.trim();
    if (override) {
      const { gridProviders } = await import("@/lib/grid/schema");
      const [settings] = await db.select().from(gridProviders).where(and(eq(gridProviders.organizationId, orgId), eq(gridProviders.key, "openrouter-byok-settings")));
      const config = settings!.config as { defaultModel: { modelId: string; provider: string }; modelsByProvider?: Record<string, string[]> };
      const provider = config.defaultModel.provider;
      await db.update(gridProviders).set({ config: { ...config, defaultModel: { modelId: override, provider }, modelsByProvider: { ...config.modelsByProvider, [provider]: [...new Set([...(config.modelsByProvider?.[provider] ?? []), override])] } } })
        .where(eq(gridProviders.id, settings!.id));
      console.log(`Model for the real run: ${override}`);
    }
    const messages = ["Hey", "How much is the maintenance plan?", "Can you give a discount for 5 chairs?", "Ok, send someone tomorrow", "ok thanks", "Mujhe price batao"];
    for (const [index, text] of messages.entries()) {
      before = sends.length;
      const message = await inbound(P[9 + (index % 3)]!, text, `real-${index % 3}`);
      const started = Date.now();
      const outcome = await runReplyAgent(message.id, { send, allowNonProduction: true, brief: false });
      const agent = await agentRow(message.id);
      console.log(`REAL  "${text}" → ${outcome?.status} in ${Date.now() - started} ms (turns ${agent?.turns.map((turn) => `${turn.ms}ms${turn.problems.length ? " fixed" : ""}${turn.error ? " error" : ""}`).join(", ")}; model ${agent?.model})`);
      console.log(`      ${sends.length > before ? `sent: ${sends.at(-1)?.body.replace(/\s+/g, " ")}` : `nothing sent: ${outcome?.reason ?? ""}`}`);
      check(`real model: "${text}" gets a decision`, Boolean(outcome && outcome.status !== "failed"), outcome?.reason ?? "");
    }
  }
});

// ------------------------------------------------------------ another organization sees none of the wrong numbers
const [otherOrg] = await db.insert(organizations).values({ name: `Reply agent check other ${stamp}`, slug: `reply-agent-check-other-${stamp}` }).returning();
await runInOrganization(otherOrg!.id, async () => {
  const otherId = currentOrganizationId();
  await ensureCrmDefaults();
  const [stranger] = await db.insert(people).values({ organizationId: otherId, phone: isolationPhone, fullName: "Other org lead", source: "reply-agent-check" }).returning({ id: people.id });
  const digits = isolationPhone.replace(/\D/g, "");
  check("another organization does not see the first one's wrong numbers", Boolean(digits) && (await findWrongRoutes(db, { channel: "whatsapp", routes: [digits] })).length === 0
    && !(await wrongRouteSendRefusal(db, { channel: "whatsapp", routes: [digits] })));
  const theirs = await ingestInboundReply({ personId: stranger!.id, channel: "whatsapp", accountRef: `wa-other-${stamp}`, providerThreadId: `wa-other-chat-${stamp}`, providerContactId: `${digits}@s.whatsapp.net`, idempotencyKey: `wa-other-${stamp}`, bodyText: "Wrong number", sentAt: new Date() });
  const closedThere = await closeWrongNumber({ messageId: theirs.message.id, source: "classifier", acknowledgement: null, optOut: false, sendAllowed: true });
  check("…and records its own, unaffected by the first's", Boolean(closedThere?.created) && closedThere?.ackStatus === "drafted", closedThere?.summary ?? "");
});

console.log(failures ? `\n${failures} check(s) failed` : "\nAll reply agent checks passed");
process.exit(failures ? 1 : 0);

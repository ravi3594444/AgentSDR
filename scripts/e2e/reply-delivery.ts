/**
 * A local sender gap queues the written reply, then the real automatic-send
 * path rechecks it. Fake model and delivery only; no provider is called.
 * Run against a disposable local database: bun --conditions=react-server scripts/e2e/reply-delivery.ts
 */
import { and, eq } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) throw new Error("Use a disposable local database");
globalThis.fetch = (() => { throw new Error("External requests are forbidden in this check"); }) as unknown as typeof fetch;

const { db } = await import("@/lib/db");
const { organizations } = await import("@/lib/auth/schema");
const { people } = await import("@/lib/leads/schema");
const crm = await import("@/lib/crm/schema");
const schema = await import("@/lib/assistant/schema");
const { whatsappAccounts } = await import("@/lib/whatsapp/schema");
const { runInOrganization } = await import("@/lib/tenancy/scope");
const { ensureCrmDefaults } = await import("@/lib/crm/defaults");
const { ingestInboundReply } = await import("@/lib/crm/conversations");
const { handleClassificationJob } = await import("@/lib/crm/handlers");
const { updateBusinessProfile } = await import("@/lib/assistant/profile.server");
const { createAudience } = await import("@/lib/assistant/audiences.server");
const { createThread } = await import("@/lib/assistant/threads.server");
const { DeferredCrmSendError } = await import("@/lib/crm/send");
const { runAutopilotForDraft } = await import("@/lib/assistant/autopilotRun.server");
const { RetryCrmJobLaterError } = await import("@/lib/crm/worker");
const { claimCrmJobs, failCrmJob } = await import("@/lib/crm/queue");
const { setPersonDoNotContact } = await import("@/lib/crm/policies");
const { runReplies } = await import("@/lib/assistant/runReplies.server");

const stamp = Date.now();
let checks = 0;
function check(label: string, ok: boolean) {
  if (!ok) throw new Error(`FAIL ${label}`);
  checks++;
  console.log(`PASS ${label}`);
}
const [org] = await db.insert(organizations).values({ name: `Reply delivery ${stamp}`, slug: `reply-delivery-${stamp}` }).returning();
const [other] = await db.insert(organizations).values({ name: `Other reply delivery ${stamp}`, slug: `other-reply-delivery-${stamp}` }).returning();
let isolationRunId = "";

await runInOrganization(org!.id, async () => {
  await ensureCrmDefaults();
  await updateBusinessProfile({ businessName: "Example Services", offer: "Business automation", senderName: "Ravi" }, null);
  const accountRef = `reply-delivery-${stamp}`;
  await db.insert(whatsappAccounts).values([
    { organizationId: org!.id, unipileAccountId: accountRef, name: "Current sender", phone: "+19990000000", status: "connected" },
    { organizationId: org!.id, unipileAccountId: `${accountRef}-old`, name: "Older sender", phone: "+19990000000", status: "disconnected" },
  ]);
  const audienceId = await createAudience({ name: "Reply delivery", source: "list" });
  const thread = await createThread(null);
  let n = 0;
  const text = "Hi! What would you like to know?";
  let modelCalls = 0;
  let sends = 0;
  const model: import("@/lib/assistant/replyAgent/agent.server").AgentModel = async () => {
    modelCalls++;
    return { text: JSON.stringify({ action: "reply", reply: text, ownerNote: null, category: "other", confidence: 0.9, reasoning: "A greeting" }), provider: "stand-in", model: "stand-in", request: {}, response: {} };
  };
  const successfulSend: import("@/lib/crm/send").CrmSendAdapter = async (input) => {
    check("the queued reply keeps its original text", input.bodyText === text);
    sends++;
    return { provider: "unipile", providerMessageId: `reply-delivery-sent-${stamp}-${sends}`, providerThreadId: input.providerThreadId, rfcMessageId: null, response: {} };
  };
  const checkReply = async () => ({ intent: "greeting", questions: [], claims: [], commitments: [], missing: "", escalate: "" });

  async function fixture(failure: Error | null = null) {
    const index = ++n;
    const [person] = await db.insert(people).values({ organizationId: org!.id, fullName: `Reply lead ${index}`, phone: `+1999000000${index}`, source: "reply-delivery-check" }).returning();
    const plan: import("@/lib/assistant/schema").OutreachPlan = {
      assignments: [], sequences: {}, personalizationKey: "p_00000000", samples: [],
      limits: { maxLeads: 10, emailPerMailboxPerDay: null, whatsappNewChatsPerDay: 30 },
      excluded: [], estimate: { aiCalls: 0, aiCostUsd: null, days: 1 }, autopilot: true, instructions: null,
    };
    const [run] = await db.insert(schema.outreachRuns).values({ organizationId: org!.id, threadId: thread.id, audienceId, name: `Reply run ${index}`, status: "running", channels: ["whatsapp"], plan, autopilot: true, approvedAt: new Date(Date.now() - 60_000) }).returning();
    await db.insert(schema.outreachRunLeads).values({ organizationId: org!.id, runId: run!.id, personId: person!.id, channel: "whatsapp" });
    const inbound = async (bodyText = "hey") => ingestInboundReply({ personId: person!.id, channel: "whatsapp", accountRef, providerThreadId: `reply-thread-${stamp}-${index}`, providerContactId: `${person!.phone!.slice(1)}@s.whatsapp.net`, idempotencyKey: `reply-in-${stamp}-${index}-${Math.random()}`, bodyText, sentAt: new Date() });
    const incoming = await inbound();
    const [job] = await db.select().from(crm.crmJobs).where(and(eq(crm.crmJobs.kind, "classification"), eq(crm.crmJobs.entityId, incoming.message.id)));
    const retryAt = new Date(Date.now() + 25_000);
    await handleClassificationJob(job!, { replyAgent: { model, send: async () => { throw failure ?? new DeferredCrmSendError("Wait between sends", retryAt); }, allowNonProduction: true, brief: false } });
    const [agent] = await db.select().from(schema.replyAgentRuns).where(eq(schema.replyAgentRuns.messageId, incoming.message.id));
    const [draft] = await db.select().from(crm.crmDrafts).where(eq(crm.crmDrafts.id, agent!.draftId!));
    const [pending] = await db.select().from(crm.crmJobs).where(and(eq(crm.crmJobs.kind, "auto_send"), eq(crm.crmJobs.entityId, draft!.id)));
    return { person: person!, run: run!, inbound, incoming, agent: agent!, draft: draft!, pending: pending!, retryAt };
  }

  const first = await fixture();
  isolationRunId = first.run.id;
  check("a gap preserves the written draft", first.draft.status === "awaiting_review" && first.draft.aiBodyText === text && first.draft.error === null);
  check("the agent records a queued draft, not a failure", first.agent.status === "drafted");
  check("a durable send job waits until the gap ends", first.pending.status === "queued" && first.pending.runAfter.getTime() >= first.retryAt.getTime());
  const [held] = await db.select().from(schema.autopilotReplies).where(eq(schema.autopilotReplies.draftId, first.draft.id));
  check("the unsubmitted wait is not counted as a send or failed attempt", held?.status === "held");
  const [attempt] = await db.select().from(crm.crmSendAttempts).where(eq(crm.crmSendAttempts.draftId, first.draft.id));
  check("the local refusal is definite, never delivery-uncertain", attempt?.status === "failed");
  const latest = (await runReplies([first.run.id]))[first.run.id]![0]!;
  check("the reply status names its sender's current connection", latest.senderStatus === "connected" && latest.accountRef === accountRef);
  check("the chat sees the latest actual reply and its timed wait", latest.preview === "hey" && latest.state.tone === "waiting" && Boolean(latest.state.at));
  const beforeModels = modelCalls;
  const outcome = await runAutopilotForDraft(first.draft.id, { revision: first.draft.revision, readyAt: first.draft.createdAt, idempotencyKey: String(first.pending.payload.idempotencyKey), send: successfulSend, check: checkReply, allowNonProduction: true, brief: false });
  check("the queued checked reply sends after the gate opens", outcome.sent && sends === 1);
  check("sending a queued draft does not rewrite it", modelCalls === beforeModels);
  const attempts = await db.select().from(crm.crmSendAttempts).where(eq(crm.crmSendAttempts.draftId, first.draft.id));
  check("the original send attempt is reused and becomes sent, leaving no false failure", attempts.length === 1 && attempts[0]?.status === "sent");
  await runAutopilotForDraft(first.draft.id, { send: successfulSend, check: checkReply, allowNonProduction: true, brief: false });
  check("a repeated send job never sends the reply twice", sends === 1);

  const paused = await fixture();
  await db.update(schema.outreachRuns).set({ status: "paused" }).where(eq(schema.outreachRuns.id, paused.run.id));
  await runAutopilotForDraft(paused.draft.id, { send: successfulSend, check: checkReply, allowNonProduction: true, brief: false });
  check("Pause still holds a reply queued during the sender gap", sends === 1);
  const stopped = await fixture();
  await db.update(schema.outreachRuns).set({ status: "stopped" }).where(eq(schema.outreachRuns.id, stopped.run.id));
  await runAutopilotForDraft(stopped.draft.id, { send: successfulSend, check: checkReply, allowNonProduction: true, brief: false });
  check("Stop still prevents a queued reply", sends === 1);
  const newer = await fixture();
  await newer.inbound("A different question");
  await runAutopilotForDraft(newer.draft.id, { send: successfulSend, check: checkReply, allowNonProduction: true, brief: false });
  check("a newer incoming message makes the old queued answer ineligible", sends === 1);
  const optedOut = await fixture();
  await setPersonDoNotContact({ personId: optedOut.person.id, reason: "Do not contact", source: "inbound_request", actorType: "human" });
  await runAutopilotForDraft(optedOut.draft.id, { send: successfulSend, check: checkReply, allowNonProduction: true, brief: false });
  check("Do Not Contact is rechecked before a queued send", sends === 1);

  const crowded = await fixture();
  await db.update(crm.crmJobs).set({ runAfter: new Date(0) }).where(eq(crm.crmJobs.id, crowded.pending.id));
  // Keep other queued fixtures out of this claim; this check runs one worker connection.
  await db.update(crm.crmJobs).set({ status: "succeeded", completedAt: new Date() }).where(and(eq(crm.crmJobs.kind, "auto_send"), eq(crm.crmJobs.status, "queued")));
  await db.update(crm.crmJobs).set({ status: "queued", completedAt: null }).where(eq(crm.crmJobs.id, crowded.pending.id));
  const [claimed] = await claimCrmJobs(1, "reply-delivery-check", ["auto_send"]);
  const nextGap = new Date(Date.now() + 30_000);
  let deferred: unknown;
  try { await runAutopilotForDraft(crowded.draft.id, { send: async () => { throw new DeferredCrmSendError("Sender used again", nextGap); }, check: checkReply, allowNonProduction: true, brief: false }); } catch (error) { deferred = error; }
  check("a second local gap asks the worker to wait again", deferred instanceof RetryCrmJobLaterError);
  await failCrmJob(claimed!, "Waiting between sends", { retryAt: nextGap });
  const [requeued] = await db.select().from(crm.crmJobs).where(eq(crm.crmJobs.id, crowded.pending.id));
  check("waiting again preserves the job without consuming a failed attempt", requeued?.status === "queued" && requeued.attempts === 0 && requeued.runAfter.getTime() === nextGap.getTime());

  const absent = await fixture();
  const unanswered = await absent.inbound("Please explain the offer");
  await db.update(crm.crmJobs).set({ status: "failed", completedAt: new Date(), failedAt: new Date(), lastError: "The AI provider was unavailable" }).where(and(eq(crm.crmJobs.kind, "classification"), eq(crm.crmJobs.entityId, unanswered.message.id)));
  const read = (await runReplies([absent.run.id]))[absent.run.id]!.find((reply) => reply.id === unanswered.message.id);
  check("a failed incoming-message job is reported with its actual reason", read?.state.tone === "failed" && read.state.text.includes("AI provider was unavailable"));
  const uncertain = await fixture(new Error("The provider connection was lost after submission"));
  check("a send whose delivery is uncertain is never automatically queued again", uncertain.draft.status === "delivery_uncertain" && !uncertain.pending && uncertain.agent.status === "failed");
});

check("another workspace cannot read these reply texts or statuses", Object.keys(await runInOrganization(other!.id, () => runReplies([isolationRunId]))).length === 0);

console.log(`Reply delivery: ${checks} checks passed; all providers were stand-ins.`);
process.exit(0);

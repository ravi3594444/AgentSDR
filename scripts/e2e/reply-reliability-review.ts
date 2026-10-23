/**
 * Review probes for claude/reply-reliability-20261023. These are expected to
 * fail until the ownership gaps are corrected. Every model and send is a
 * stand-in. Run only on a disposable local database.
 */
import { and, eq, sql } from "drizzle-orm";

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
const { replyBudgetForJob } = await import("@/lib/crm/ai/budget.server");
const { REPLY_BUDGET_MAX_CALLS } = await import("@/lib/crm/ai/budget");
const { runReplyAgent } = await import("@/lib/assistant/replyAgent/agent.server");
type AgentModel = import("@/lib/assistant/replyAgent/agent.server").AgentModel;
type CrmSendAdapter = import("@/lib/crm/send").CrmSendAdapter;

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, details = "") {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${details ? ` — ${details}` : ""}`);
}
const stamp = Date.now();
const [org] = await db.insert(organizations).values({ name: `Reliability review ${stamp}`, slug: `reliability-review-${stamp}` }).returning();

await runInOrganization(org!.id, async () => {
  await ensureCrmDefaults();
  await updateBusinessProfile({ businessName: "Example Services", offer: "Business automation", senderName: "Ravi" }, null);

  const accountRef = `reliability-review-${stamp}`;
  await db.insert(whatsappAccounts).values({ organizationId: org!.id, unipileAccountId: accountRef, phone: "+19990000000", name: "Review sender", status: "connected" });
  const audienceId = await createAudience({ name: "Reliability review", source: "list" });
  const thread = await createThread(null);
  let number = 0;
  async function fixture() {
    const index = ++number;
    const [person] = await db.insert(people).values({ organizationId: org!.id, fullName: `Review lead ${index}`, phone: `+1999000010${index}`, source: "reliability-review" }).returning();
    const plan: import("@/lib/assistant/schema").OutreachPlan = {
      assignments: [], sequences: {}, personalizationKey: "p_00000000", samples: [],
      limits: { maxLeads: 10, emailPerMailboxPerDay: null, whatsappNewChatsPerDay: 30 },
      excluded: [], estimate: { aiCalls: 0, aiCostUsd: null, days: 1 }, autopilot: true, instructions: null,
    };
    const [run] = await db.insert(schema.outreachRuns).values({ organizationId: org!.id, threadId: thread.id, audienceId, name: `Review run ${index}`, status: "running", channels: ["whatsapp"], plan, autopilot: true, approvedAt: new Date(Date.now() - 60_000) }).returning();
    await db.insert(schema.outreachRunLeads).values({ organizationId: org!.id, runId: run!.id, personId: person!.id, channel: "whatsapp" });
    const incoming = await ingestInboundReply({ personId: person!.id, channel: "whatsapp", accountRef, providerThreadId: `review-thread-${stamp}-${index}`, providerContactId: `${person!.phone!.slice(1)}@s.whatsapp.net`, idempotencyKey: `review-in-${stamp}-${index}`, bodyText: "hey", sentAt: new Date() });
    const [claimed] = await db.update(crm.crmJobs).set({ status: "running", attempts: 1, lockedBy: `original-${index}`, lockedAt: new Date(), startedAt: new Date() }).where(and(eq(crm.crmJobs.kind, "classification"), eq(crm.crmJobs.entityId, incoming.message.id))).returning();
    return { incoming, job: claimed! };
  }
  // Budget state was persisted by the original owner; a replacement then
  // takes its claim before that owner tries to spend the next request.
  const { job } = await fixture();
  const oldBudget = await replyBudgetForJob(job);
  const [replacement] = await db.update(crm.crmJobs).set({ lockedBy: "replacement", attempts: 2 }).where(eq(crm.crmJobs.id, job.id)).returning();
  let oldAllowed = false;
  try { oldAllowed = await oldBudget.beforeTransportRequest(Date.now()); } catch { /* Correct: a lost claim refuses the request. */ }
  check("a displaced job cannot authorize a model request", !oldAllowed, `old request allowed=${oldAllowed}`);
  const newBudget = await replyBudgetForJob(replacement!);
  let totalAllowed = oldAllowed ? 1 : 0;
  for (let n = 0; n < REPLY_BUDGET_MAX_CALLS + 1; n++) {
    if (await newBudget.beforeTransportRequest(Date.now())) totalAllowed++;
  }
  check("the persisted cap includes every authorized request across owners", totalAllowed <= REPLY_BUDGET_MAX_CALLS, `${totalAllowed} requests allowed against cap ${REPLY_BUDGET_MAX_CALLS}`);
  let sends = 0;
  const send: CrmSendAdapter = async input => {
    sends++;
    return { provider: "unipile", providerMessageId: `review-sent-${stamp}-${sends}`, providerThreadId: input.providerThreadId, rfcMessageId: null, response: {} };
  };
  const answer: Awaited<ReturnType<AgentModel>> = { text: JSON.stringify({ action: "reply", reply: "Hi! What would you like to know?", ownerNote: null, category: "other", confidence: 0.9, reasoning: "A greeting" }), provider: "stand-in", model: "stand-in", request: {}, response: {} };

  const agentTakeover = await fixture();
  const firstModel: AgentModel = async () => {
    // A different execution claims the reply row before this model returns.
    // No heartbeat has run yet: fencing must be checked by the effect itself.
    await db.update(schema.replyAgentRuns).set({ attempts: sql`${schema.replyAgentRuns.attempts} + 1`, updatedAt: new Date() }).where(eq(schema.replyAgentRuns.messageId, agentTakeover.incoming.message.id));
    return answer;
  };
  const oldExecution = async (work: () => Promise<unknown>) => {
    try { await work(); } catch (error) {
      // Refusing a displaced execution is a valid correction; unrelated
      // failures must not make this regression probe pass.
      if (!(error instanceof Error) || !/claim.*lost|claim.*no longer|no longer owned|newer attempt/i.test(`${error.name} ${error.message}`)) throw error;
    }
  };
  let before = sends;
  await oldExecution(() => runReplyAgent(agentTakeover.incoming.message.id, { model: firstModel, send, allowNonProduction: true, brief: false }));
  check("a displaced reply execution cannot send before its next heartbeat", sends === before, `${sends - before} stale sends`);
  const draftRows = await db.select({ id: crm.crmDrafts.id }).from(crm.crmDrafts).where(eq(crm.crmDrafts.replyForMessageId, agentTakeover.incoming.message.id));
  check("a displaced reply execution cannot create a draft", draftRows.length === 0, `${draftRows.length} stale drafts`);

  const jobTakeover = await fixture();
  const secondModel: AgentModel = async () => {
    // CRM ownership changes while its own reply-agent claim remains valid.
    await db.update(crm.crmJobs).set({ attempts: 2, lockedBy: "replacement" }).where(eq(crm.crmJobs.id, jobTakeover.job.id));
    return answer;
  };
  before = sends;
  await oldExecution(() => handleClassificationJob(jobTakeover.job, { replyAgent: { model: secondModel, send, allowNonProduction: true, brief: false } }));
  check("a displaced CRM job cannot send after its model returns", sends === before, `${sends - before} stale sends`);

  const { updateDraft } = await import("@/lib/crm/drafts");
  const manual = await fixture();
  const [failed] = await db.insert(crm.crmDrafts).values({ crmRecordId: manual.incoming.record.id, conversationId: manual.incoming.message.conversationId, expectedContextVersion: manual.incoming.record.contextVersion, channel: "whatsapp", status: "failed", error: "stand-in generation failure" }).returning();
  before = sends;
  const recovered = await updateDraft({ draftId: failed!.id, revision: failed!.revision, bodyText: "The owner wrote this answer.", actorRef: "review-owner" });
  check("saving a failed generation preserves the person's text and sends nothing", recovered.status === "awaiting_review" && recovered.editedBodyText === "The owner wrote this answer." && recovered.error === null && sends === before);
  const autoJobs = await db.select({ id: crm.crmJobs.id }).from(crm.crmJobs).where(and(eq(crm.crmJobs.kind, "auto_send"), eq(crm.crmJobs.entityId, failed!.id)));
  check("manual recovery creates no automatic-send job", autoJobs.length === 0);
  let refused = false;
  try { await updateDraft({ draftId: failed!.id, revision: failed!.revision, bodyText: "An obsolete edit", actorRef: "review-owner" }); } catch { refused = true; }
  check("manual recovery still refuses an obsolete revision", refused);
  const { sendDraft } = await import("@/lib/crm/send");
  await sendDraft({ draftId: recovered.id, revision: recovered.revision, idempotencyKey: `review-manual-${stamp}`, actorRef: "review-owner", requestId: `review-request-${stamp}` }, { send });
  check("the recovered draft can be explicitly sent through the normal guarded path", sends === before + 1);
  const [uncertain] = await db.insert(crm.crmDrafts).values({ crmRecordId: manual.incoming.record.id, conversationId: manual.incoming.message.conversationId, expectedContextVersion: manual.incoming.record.contextVersion, channel: "whatsapp", status: "delivery_uncertain", error: "Provider answer lost after submission" }).returning();
  refused = false;
  try { await updateDraft({ draftId: uncertain!.id, revision: uncertain!.revision, bodyText: "Do not send this again", actorRef: "review-owner" }); } catch { refused = true; }
  check("uncertain delivery cannot be edited back into a send", refused && sends === before + 1);

  // Exercise the actual queue worker. The completion has already decided a
  // 401 is permanent, so the queue must not retry the unchanged credentials.
  // Advance runAfter between synchronous drains instead of sleeping for the
  // queue's backoffs; preserve the payload/budget and attempt counter.
  const permanent = await fixture();
  await db.update(crm.crmJobs).set({ status: "queued", attempts: 0, lockedAt: null, lockedBy: null, runAfter: new Date(0) }).where(eq(crm.crmJobs.id, permanent.job.id));
  const { drainOnce, registerCrmJobHandler } = await import("@/lib/crm/worker");
  let providerCalls = 0;
  const unregister = registerCrmJobHandler("classification", async job => handleClassificationJob(job, {
    complete: async () => { providerCalls++; throw Object.assign(new Error("Stand-in provider rejected the key"), { status: 401 }); },
  }));
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      await drainOnce();
      await db.update(crm.crmJobs).set({ runAfter: new Date(0) }).where(and(eq(crm.crmJobs.id, permanent.job.id), eq(crm.crmJobs.status, "queued")));
    }
  } finally { unregister(); }
  const [terminal] = await db.select().from(crm.crmJobs).where(eq(crm.crmJobs.id, permanent.job.id));
  check("a permanent provider 401 is terminal after one call across queue retries", providerCalls === 1 && terminal?.status === "failed", `${providerCalls} calls, job ${terminal?.status}, attempts ${terminal?.attempts}`);
});

console.log(`Reply reliability review: ${checks - failures} pass, ${failures} fail. Fake providers only.`);
process.exit(failures ? 1 : 0);

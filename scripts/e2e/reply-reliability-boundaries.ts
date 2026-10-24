/** Additional claim-transaction/cancellation checks. Local data and stand-ins only. */
import { and, eq, sql } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) throw new Error("Use a disposable local database");
globalThis.fetch = (() => { throw new Error("External requests are forbidden in this check"); }) as unknown as typeof fetch;

const { db } = await import("@/lib/db");
const { organizations } = await import("@/lib/auth/schema");
const { people } = await import("@/lib/leads/schema");
const crm = await import("@/lib/crm/schema");
const assistant = await import("@/lib/assistant/schema");
const { whatsappAccounts } = await import("@/lib/whatsapp/schema");
const { runInOrganization } = await import("@/lib/tenancy/scope");
const { ensureCrmDefaults } = await import("@/lib/crm/defaults");
const { ingestInboundReply } = await import("@/lib/crm/conversations");
const { handleClassificationJob } = await import("@/lib/crm/handlers");
const { generateFallbackDraft } = await import("@/lib/crm/drafts");
const { crmJobExecutionFor } = await import("@/lib/crm/queue");
const { updateBusinessProfile } = await import("@/lib/assistant/profile.server");
const { createAudience } = await import("@/lib/assistant/audiences.server");
const { createThread } = await import("@/lib/assistant/threads.server");
const { runReplyAgent } = await import("@/lib/assistant/replyAgent/agent.server");
const { runAutopilotForDraft } = await import("@/lib/assistant/autopilotRun.server");
type DraftCompletionResult = import("@/lib/crm/ai/draft").DraftCompletionResult;

const stamp = Date.now();
let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, details = "") {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${details ? ` — ${details}` : ""}`);
}
const [org] = await db.insert(organizations).values({ name: `Reply boundary check ${stamp}`, slug: `reply-boundary-${stamp}` }).returning();

await runInOrganization(org!.id, async () => {
  await ensureCrmDefaults();
  await updateBusinessProfile({ businessName: "Example Services", offer: "Business automation", senderName: "Ravi" }, null);
  const accountRef = `boundary-sender-${stamp}`;
  await db.insert(whatsappAccounts).values({ organizationId: org!.id, unipileAccountId: accountRef, phone: "+19990000000", name: "Boundary sender", status: "connected" });
  const audienceId = await createAudience({ name: "Reply boundary check", source: "list" });
  const thread = await createThread(null);
  let n = 0;
  async function fixture() {
    const index = ++n;
    const [person] = await db.insert(people).values({ organizationId: org!.id, fullName: `Boundary lead ${index}`, phone: `+1999000020${index}`, source: "reply-boundary-check" }).returning();
    const plan: import("@/lib/assistant/schema").OutreachPlan = {
      assignments: [], sequences: {}, personalizationKey: "p_00000000", samples: [],
      limits: { maxLeads: 10, emailPerMailboxPerDay: null, whatsappNewChatsPerDay: 30 },
      excluded: [], estimate: { aiCalls: 0, aiCostUsd: null, days: 1 }, autopilot: true, instructions: null,
    };
    const [run] = await db.insert(assistant.outreachRuns).values({ organizationId: org!.id, threadId: thread.id, audienceId, name: `Boundary run ${index}`, status: "running", channels: ["whatsapp"], plan, autopilot: true, approvedAt: new Date(Date.now() - 60_000) }).returning();
    await db.insert(assistant.outreachRunLeads).values({ organizationId: org!.id, runId: run!.id, personId: person!.id, channel: "whatsapp" });
    const incoming = await ingestInboundReply({ personId: person!.id, channel: "whatsapp", accountRef, providerThreadId: `boundary-thread-${stamp}-${index}`, providerContactId: `${person!.phone!.slice(1)}@s.whatsapp.net`, idempotencyKey: `boundary-in-${stamp}-${index}`, bodyText: "hey", sentAt: new Date() });
    const [job] = await db.update(crm.crmJobs).set({ status: "running", attempts: 1, lockedBy: `boundary-owner-${index}`, lockedAt: new Date(), startedAt: new Date() }).where(and(eq(crm.crmJobs.kind, "classification"), eq(crm.crmJobs.entityId, incoming.message.id))).returning();
    return { incoming, job: job!, execution: crmJobExecutionFor(job!)! };
  }
  const takeover = (jobId: string) => db.update(crm.crmJobs).set({ lockedBy: "replacement", attempts: 2 }).where(eq(crm.crmJobs.id, jobId));
  const draftAnswer: DraftCompletionResult = { text: JSON.stringify({ subject: null, bodyText: "Hi! How can I help?", bodyHtml: null }), provider: "stand-in", model: "stand-in", request: {}, response: {} };

  const lock = await fixture();
  await db.transaction(async tx => {
    await lock.execution.assertOwned(tx);
    const modes = await tx.execute(sql<{ mode: string }>`select mode from pg_locks where pid = pg_backend_pid() and relation = 'crm_jobs'::regclass`);
    check("a transactional ownership check locks the claim row until the effect commits", modes.some(row => row.mode === "RowShareLock"));
  });

  const cancellation = await fixture();
  let signalReceived = false;
  try {
    await generateFallbackDraft(cancellation.incoming.record.id, { execution: cancellation.execution, complete: async input => {
      signalReceived = input.signal === cancellation.execution.signal;
      cancellation.execution.markClaimLost();
      return draftAnswer;
    } });
  } catch { /* Expected: cancellation must not finish a draft. */ }
  check("legacy draft generation receives the owning execution's abort signal", signalReceived);

  const alreadyLost = await fixture();
  await takeover(alreadyLost.job.id);
  let modelCalls = 0;
  try {
    await generateFallbackDraft(alreadyLost.incoming.record.id, { execution: alreadyLost.execution, complete: async () => { modelCalls++; return draftAnswer; } });
  } catch { /* Expected: the old execution cannot prepare a draft. */ }
  const premature = await db.select({ id: crm.crmDrafts.id }).from(crm.crmDrafts).where(eq(crm.crmDrafts.crmRecordId, alreadyLost.incoming.record.id));
  check("an already displaced execution creates no generating draft and makes no model call", premature.length === 0 && modelCalls === 0, `${premature.length} drafts, ${modelCalls} calls`);

  const lateDraftFailure = await fixture();
  try {
    await generateFallbackDraft(lateDraftFailure.incoming.record.id, { execution: lateDraftFailure.execution, complete: async () => {
      await takeover(lateDraftFailure.job.id);
      throw Object.assign(new Error("Stand-in provider unavailable after takeover"), { status: 503 });
    } });
  } catch { /* The replacement owns the failure path too. */ }
  const failedDrafts = await db.select({ id: crm.crmDrafts.id }).from(crm.crmDrafts).where(and(eq(crm.crmDrafts.crmRecordId, lateDraftFailure.incoming.record.id), eq(crm.crmDrafts.status, "failed")));
  const [draftRecord] = await db.select({ state: crm.crmRecords.workflowState }).from(crm.crmRecords).where(eq(crm.crmRecords.id, lateDraftFailure.incoming.record.id));
  check("a displaced draft execution cannot mark the replacement's draft or record failed", failedDrafts.length === 0 && draftRecord?.state !== "error");

  const lateClassifierFailure = await fixture();
  try {
    await handleClassificationJob(lateClassifierFailure.job, { complete: async () => {
      await takeover(lateClassifierFailure.job.id);
      throw Object.assign(new Error("Stand-in provider unavailable after takeover"), { status: 503 });
    } });
  } catch { /* Expected: no old classification failure should be recorded. */ }
  const [classifierRecord] = await db.select({ state: crm.crmRecords.workflowState }).from(crm.crmRecords).where(eq(crm.crmRecords.id, lateClassifierFailure.incoming.record.id));
  check("a displaced classifier cannot overwrite the replacement's record with an error", classifierRecord?.state !== "error");

  const checkCancellation = await fixture();
  const drafted = await runReplyAgent(checkCancellation.incoming.message.id, { model: async () => ({ text: JSON.stringify({ action: "reply", reply: "Hi! How can I help?", category: "other", confidence: 0.9, reasoning: "A greeting", ownerNote: null }), provider: "stand-in", model: "stand-in" }), allowNonProduction: false, brief: false });
  let checkSignal: AbortSignal | undefined;
  try {
    await runAutopilotForDraft((await db.select().from(assistant.replyAgentRuns).where(eq(assistant.replyAgentRuns.messageId, checkCancellation.incoming.message.id)))[0]!.draftId!, {
      execution: checkCancellation.execution, allowNonProduction: true, brief: false,
      check: async input => {
        checkSignal = (input as typeof input & { signal?: AbortSignal }).signal;
        checkCancellation.execution.markClaimLost();
        return { intent: "greeting", questions: [], claims: [], commitments: [], missing: "", escalate: "" };
      },
    });
  } catch { /* Expected: a cancelled automatic-send job cannot send. */ }
  check("the automatic reply check receives its execution's abort signal", Boolean(drafted) && checkSignal === checkCancellation.execution.signal);
});

console.log(`Reply reliability boundaries: ${passed} pass, ${failed} fail. Fake providers only.`);
process.exit(failed ? 1 : 0);

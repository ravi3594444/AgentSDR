/**
 * Activity end to end against the local database: a reply to a plan started
 * from yesterday's chat shows up while the owner works in another chat, with
 * that plan, that chat and where the reply stands; the new-replies count
 * drops once the list is seen and rises for the next reply; a search waiting
 * for a slot says so; a search cancelled mid-step stays cancelled when the
 * step returns; a second organization sees, counts and cancels nothing.
 *
 *   bun run --conditions=react-server scripts/e2e/activity.ts
 *
 * Creates its own organizations ("Activity check …") and leaves them.
 * Refuses a non-local DATABASE_URL.
 */
import { eq } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}

const { db } = await import("@/lib/db");
const { organizations, users, members } = await import("@/lib/auth/schema");
const { people } = await import("@/lib/leads/schema");
const { crmRecords, crmConversations, crmConversationMessages } = await import("@/lib/crm/schema");
const { assistantJobs, assistantThreads, outreachRuns, outreachRunLeads } = await import("@/lib/assistant/schema");
const { runInOrganization } = await import("@/lib/tenancy/scope");
const { ensureCrmDefaults } = await import("@/lib/crm/defaults");
const { createThread } = await import("@/lib/assistant/threads.server");
const { createAudience } = await import("@/lib/assistant/audiences.server");
const { registerAssistantJobHandler, runOneAssistantStep } = await import("@/lib/assistant/worker");
const { cancelJob, listReplies, listWork, markRepliesSeen, newRepliesCount, openWorkCount } = await import("@/lib/activity/activity.server");
const { loadNavBadges } = await import("@/lib/nav/badges.server");
type OutreachPlan = import("@/lib/assistant/schema").OutreachPlan;

const stamp = Date.now();
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function organization(label: string) {
  const [org] = await db.insert(organizations).values({ name: `Activity check ${label} ${stamp}`, slug: `activity-check-${label}-${stamp}` }).returning();
  const [owner] = await db.insert(users).values({ name: `Owner ${label}`, email: `owner-${label}-${stamp}@activity-check.test`, emailVerified: true }).returning();
  await db.insert(members).values({ organizationId: org!.id, userId: owner!.id, role: "owner" });
  return { org: org!, owner: owner! };
}
const a = await organization("a");
const b = await organization("b");
const day = 86_400_000;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs);

// Organization A: yesterday's chat started a plan; Priya replied to it this morning.
const seeded = await runInOrganization(a.org.id, async () => {
  const { pipelineId } = await ensureCrmDefaults();
  const yesterday = await createThread(a.owner.id);
  await db.update(assistantThreads).set({ title: "Pune real estate agents", createdAt: at(-day) }).where(eq(assistantThreads.id, yesterday.id));
  const today = await createThread(a.owner.id);
  const audienceId = await createAudience({ name: "activity check", source: "list" });
  const [person] = await db.insert(people).values({ organizationId: a.org.id, source: "list", fullName: "Priya Shah", email: `priya-${stamp}@shahhomes.in`, phone: "+919800000001" }).returning();
  const [run] = await db.insert(outreachRuns).values({
    organizationId: a.org.id, threadId: yesterday.id, audienceId, name: "Pune agents, WhatsApp", status: "running", channels: ["whatsapp"],
    plan: {} as unknown as OutreachPlan, autopilot: false, createdBy: a.owner.id, createdAt: at(-day),
  }).returning();
  await db.insert(outreachRunLeads).values({ organizationId: a.org.id, runId: run!.id, personId: person!.id, channel: "whatsapp" });
  const [record] = await db.insert(crmRecords).values({ organizationId: a.org.id, personId: person!.id, pipelineId, workflowState: "waiting" }).returning();
  const [conversation] = await db.insert(crmConversations).values({ organizationId: a.org.id, crmRecordId: record!.id, personId: person!.id, channel: "whatsapp", accountRef: "wa-acct-1" }).returning();
  const message = (direction: "inbound" | "outbound", body: string, sentAt: Date) => ({
    conversationId: conversation!.id, personId: person!.id, channel: "whatsapp" as const, accountRef: "wa-acct-1", direction, idempotencyKey: `activity-${stamp}-${direction}-${sentAt.getTime()}`, bodyText: body, sentAt,
  });
  await db.insert(crmConversationMessages).values(message("outbound", "Hi Priya, we automate follow-ups for agencies.", at(-day + 60_000)));
  const [reply] = await db.insert(crmConversationMessages).values(message("inbound", "What does it cost for a team of five?", at(-2 * 3_600_000))).returning();
  return { yesterday, today, person: person!, record: record!, conversation: conversation!, run: run!, reply: reply!, message };
});

await runInOrganization(a.org.id, async () => {
  const { replies } = await listReplies({ userId: a.owner.id });
  const shown = replies.find((reply) => reply.messageId === seeded.reply.id);
  check("the reply shows while the owner is in another chat, with the plan and the chat that started it",
    shown?.runId === seeded.run.id && shown.threadId === seeded.yesterday.id && shown.personName === "Priya Shah" && shown.recordId === seeded.record.id,
    JSON.stringify({ run: shown?.runName, thread: shown?.threadId === seeded.yesterday.id, name: shown?.personName }));
  check("never seen and not yet answered: new, and No answer yet", shown?.isNew === true && shown.state === "waiting", `${shown?.stateLabel}`);
  check("the outbound opening line is not listed as a reply", replies.length === 1);
  check("the navigation badge counts it", (await newRepliesCount(a.owner.id)) === 1 && (await loadNavBadges(a.owner.id)).newReplies === 1);

  await markRepliesSeen(a.owner.id);
  const afterSeen = await listReplies({ userId: a.owner.id });
  check("seen: the count drops to 0 and the row is no longer new", (await newRepliesCount(a.owner.id)) === 0 && afterSeen.replies[0]?.isNew === false);

  await db.insert(crmConversationMessages).values(seeded.message("outbound", "₹4,000 a month for five seats.", at(-3_600_000)));
  check("a later answer in the conversation: Answered", (await listReplies({ userId: a.owner.id })).replies[0]?.state === "answered");
  await db.update(crmRecords).set({ workflowState: "action_required" }).where(eq(crmRecords.id, seeded.record.id));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await db.insert(crmConversationMessages).values(seeded.message("inbound", "Can you do ₹3,000 if we sign for a year?", new Date()));
  const newer = await listReplies({ userId: a.owner.id });
  check("a newer question waiting on the owner: Needs you, and new again", newer.replies[0]?.state === "needs_you" && newer.replies[0].isNew && newer.replies.length === 2, newer.replies.map((reply) => reply.stateLabel).join(","));
  check("the older, answered reply stays Answered and seen", newer.replies[1]?.state === "answered" && !newer.replies[1].isNew);
  check("the badge counts only the reply since the list was seen", (await newRepliesCount(a.owner.id)) === 1);
  check("a channel filter keeps to that channel", (await listReplies({ userId: a.owner.id, channel: "email" })).replies.length === 0 && (await listReplies({ userId: a.owner.id, channel: "whatsapp" })).replies.length === 2);
  check("seen is per person: someone who never opened the list still has both as new", (await newRepliesCount(b.owner.id)) === 2);
});

// Work: a search waiting for a slot, a stalled one, and a cancel mid-step.
const jobs = await runInOrganization(a.org.id, async () => {
  const [waiting] = await db.insert(assistantJobs).values({
    organizationId: a.org.id, kind: "apify_instagram", stage: "waiting_slot", threadId: seeded.yesterday.id, status: "queued", runAfter: at(60_000),
    payload: { phrase: "real estate agents Pune" }, progress: { waiting: { kind: "slot", reason: "both Apify runs are in use; it starts when one finishes" } },
  }).returning();
  const [stalled] = await db.insert(assistantJobs).values({
    organizationId: a.org.id, kind: "web_discovery", stage: "searching", threadId: seeded.today.id, status: "running", lockedBy: "gone-worker", heartbeatAt: at(-10 * 60_000), runAfter: at(-day),
  }).returning();
  const [cancellable] = await db.insert(assistantJobs).values({
    organizationId: a.org.id, kind: "discovery", stage: "searching", threadId: seeded.today.id, status: "queued", runAfter: new Date("2000-01-01T00:00:00Z"), payload: { phrase: "agents in Baner" },
  }).returning();
  return { waiting: waiting!, stalled: stalled!, cancellable: cancellable! };
});

await runInOrganization(a.org.id, async () => {
  const work = await listWork();
  const waiting = work.find((item) => item.id === jobs.waiting.id);
  check("a search waiting for a run slot says so, with the reason and its chat", waiting?.state === "waiting_slot" && /Apify runs are in use/.test(waiting.reason ?? "") && waiting.threadTitle === "Pune real estate agents" && waiting.open, `${waiting?.stateLabel}: ${waiting?.reason}`);
  check("a job whose worker stopped reporting is Stalled, not Working", work.find((item) => item.id === jobs.stalled.id)?.state === "stale");
  const plan = work.find((item) => item.id === seeded.run.id);
  check("the running plan is listed with its chat and the run controls", plan?.type === "plan" && plan.state === "executing" && plan.runId === seeded.run.id && plan.threadId === seeded.yesterday.id && !plan.canCancel);
  check("open work comes first", work.findIndex((item) => !item.open) === -1 || work.slice(0, work.findIndex((item) => !item.open)).every((item) => item.open));
  check("open work counts every queued or running job", (await openWorkCount()) === 3);
});

// A cancel while the step is under way: the step's outcome is discarded.
let release!: () => void;
const gate = new Promise<void>((resolve) => { release = resolve; });
let stepStarted = false;
registerAssistantJobHandler("discovery", async (job) => {
  if (job.id !== jobs.cancellable.id) return { next: "wait", delayMs: 60_000 };
  stepStarted = true;
  await gate;
  return { next: "done", result: { found: 5, eligible: 5 } };
});
const step = runOneAssistantStep();
for (let i = 0; i < 100 && !stepStarted; i++) await new Promise((resolve) => setTimeout(resolve, 50));
check("the worker took the search", stepStarted);
const cancelledByB = await runInOrganization(b.org.id, () => cancelJob(jobs.cancellable.id));
check("another organization cannot cancel it", cancelledByB === false);
const cancelled = await runInOrganization(a.org.id, () => cancelJob(jobs.cancellable.id));
release();
await step;
const [after] = await db.select().from(assistantJobs).where(eq(assistantJobs.id, jobs.cancellable.id));
check("cancelled mid-step, it stays cancelled when the step returns; its result is not recorded", cancelled && after?.status === "cancelled" && after.result === null && after.lockedBy === null, `${after?.status}`);
check("cancelling twice says it has already finished", (await runInOrganization(a.org.id, () => cancelJob(jobs.cancellable.id))) === false);
await runInOrganization(a.org.id, async () => {
  const item = (await listWork()).find((entry) => entry.id === jobs.cancellable.id);
  check("Activity shows it Cancelled, no longer open, with nothing to cancel", item?.state === "cancelled" && !item.open && !item.canCancel);
});

// Organization B sees and counts nothing of A.
await runInOrganization(b.org.id, async () => {
  const [work, replies] = await Promise.all([listWork(), listReplies({ userId: b.owner.id })]);
  check("a second organization lists none of the first's work or replies", work.length === 0 && replies.replies.length === 0);
  check("…and counts none", (await newRepliesCount(b.owner.id)) === 0 && (await openWorkCount()) === 0);
});

// Leave nothing open for another script's worker to pick up.
await db.update(assistantJobs).set({ status: "cancelled", lockedBy: null, heartbeatAt: null, finishedAt: new Date() }).where(eq(assistantJobs.organizationId, a.org.id));

console.log(failures ? `\n${failures} check(s) failed` : "\nActivity checks passed");
process.exit(failures ? 1 : 0);

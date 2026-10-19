/**
 * Activity end to end against the local database: a reply to a plan started
 * from yesterday's chat shows up while the owner works in another chat, with
 * that plan, that chat and where the reply stands; the new-replies count
 * drops once the list is seen and rises for the next reply; a search waiting
 * for a slot says so; a search cancelled mid-step stays cancelled when the
 * step returns, and a plan's start job cannot be cancelled from Activity;
 * Needs you is the CRM's Needs you; a reply is new by when it was recorded,
 * the list and the badge agree, and seen moves only forward and only up to
 * what the unfiltered list showed; a second organization sees, counts and
 * cancels nothing.
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
const { assistantJobs, assistantThreads, outreachRuns, outreachRunLeads, ownerDecisions } = await import("@/lib/assistant/schema");
const { runInOrganization } = await import("@/lib/tenancy/scope");
const { ensureCrmDefaults } = await import("@/lib/crm/defaults");
const { createThread } = await import("@/lib/assistant/threads.server");
const { createAudience } = await import("@/lib/assistant/audiences.server");
const { registerAssistantJobHandler, runOneAssistantStep } = await import("@/lib/assistant/worker");
const { cancelJob, listReplies, listWork, markRepliesSeen, newRepliesCount, openWorkCount } = await import("@/lib/activity/activity.server");
const { loadNavBadges } = await import("@/lib/nav/badges.server");
const { listCrmActions } = await import("@/lib/crm/queries");
const { repliesSeenUntil } = await import("@/lib/activity/status");
const linkedin = await import("@/lib/linkedin/schema");
const { gridProviders, gridProviderCredentials } = await import("@/lib/grid/schema");
const { encryptIntegrationCredentials } = await import("@/lib/integrations/credentials");
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
const c = await organization("c");
const day = 86_400_000;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs);

// Organization A: yesterday's chat started a plan; Priya replied to it this morning.
const seeded = await runInOrganization(a.org.id, async () => {
  // A stand-in Unipile connection, stored before anything reads it (reads are cached); nothing calls it.
  const [provider] = await db.insert(gridProviders).values({ organizationId: a.org.id, key: "platform-unipile", name: "Unipile (activity check)" }).returning();
  await db.insert(gridProviderCredentials).values({ providerId: provider!.id, encryptedPayload: encryptIntegrationCredentials({ apiKey: "activity-check", dsn: "https://unipile.invalid" }) });
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
  const inNeedsYou = async () => (await listCrmActions({ scope: "needs_you", limit: 200 })).actions.some((row) => row.id === seeded.record.id);
  check("a newer question in Action required with no owner decision or draft: Action required, not Needs you, and new again",
    newer.replies[0]?.state === "action_required" && newer.replies[0].stateLabel === "Action required" && newer.replies[0].isNew && newer.replies.length === 2 && !(await inNeedsYou()),
    newer.replies.map((reply) => reply.stateLabel).join(","));
  check("the older, answered reply stays Answered and seen", newer.replies[1]?.state === "answered" && !newer.replies[1].isNew);
  await db.insert(ownerDecisions).values({
    organizationId: a.org.id, kind: "negotiation", reason: "Asked for a discount outside the price rules", decision: "Offer ₹3,000 for a yearly plan?",
    personId: seeded.person.id, crmRecordId: seeded.record.id, conversationId: seeded.conversation.id, runId: seeded.run.id,
  });
  const decided = await listReplies({ userId: a.owner.id });
  check("an open owner decision on it: Needs you in Activity, as in the CRM's Needs you", decided.replies[0]?.state === "needs_you" && decided.replies[0].stateLabel === "Needs you" && (await inNeedsYou()), decided.replies[0]?.stateLabel);
  check("the badge counts only the reply since the list was seen", (await newRepliesCount(a.owner.id)) === 1);
  check("a channel filter keeps to that channel", (await listReplies({ userId: a.owner.id, channel: "email" })).replies.length === 0 && (await listReplies({ userId: a.owner.id, channel: "whatsapp" })).replies.length === 2);
  check("seen is per person: someone who never opened the list still has both as new", (await newRepliesCount(b.owner.id)) === 2);
});

// When a reply counts as new: by when AgentSDR recorded it; the list and the badge agree; seen moves forward only, up to what was shown.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const seenCheck = await runInOrganization(c.org.id, async () => {
  const { pipelineId } = await ensureCrmDefaults();
  const [person] = await db.insert(people).values({ organizationId: c.org.id, source: "list", fullName: "Arjun Mehta", email: `arjun-${stamp}@mehtarealty.in`, phone: "+919800000002" }).returning();
  const [record] = await db.insert(crmRecords).values({ organizationId: c.org.id, personId: person!.id, pipelineId, workflowState: "waiting" }).returning();
  const conversation = async (channel: "whatsapp" | "email", accountRef: string) =>
    (await db.insert(crmConversations).values({ organizationId: c.org.id, crmRecordId: record!.id, personId: person!.id, channel, accountRef }).returning())[0]!;
  return { person: person!, whatsapp: await conversation("whatsapp", "wa-acct-c"), email: await conversation("email", `rep-${stamp}@activity-check.test`) };
});
let said = 0;
async function inbound(conversation: typeof seenCheck.whatsapp, body: string, sentAt: Date, createdAt?: Date) {
  const [row] = await db.insert(crmConversationMessages).values({
    conversationId: conversation.id, personId: seenCheck.person.id, channel: conversation.channel, accountRef: conversation.accountRef, direction: "inbound",
    idempotencyKey: `activity-c-${stamp}-${said++}`, bodyText: body, sentAt, ...(createdAt ? { createdAt } : {}),
  }).returning();
  return row!;
}
await runInOrganization(c.org.id, async () => {
  const months = await inbound(seenCheck.whatsapp, "Still looking for a CRM?", at(-90 * day), at(-90 * day));
  const recent = await inbound(seenCheck.whatsapp, "We have six agents now.", at(-2 * day), at(-2 * day));
  const first = await listReplies({ userId: c.owner.id });
  const marked = first.replies.filter((reply) => reply.isNew).map((reply) => reply.messageId);
  check("before the first visit, the list marks only the last 7 days as new, and the badge counts the same",
    marked.length === 1 && marked[0] === recent.id && first.replies.some((reply) => reply.messageId === months.id && !reply.isNew) && (await newRepliesCount(c.owner.id)) === 1,
    `marked ${marked.length}, badge ${await newRepliesCount(c.owner.id)}`);

  await markRepliesSeen(c.owner.id);
  await sleep(20);
  const late = await inbound(seenCheck.whatsapp, "Did you get my last message?", at(-3_600_000));
  const afterLate = await listReplies({ userId: c.owner.id });
  check("a reply recorded after the list was seen is new, though the provider says it was sent before",
    afterLate.replies.find((reply) => reply.messageId === late.id)?.isNew === true && (await newRepliesCount(c.owner.id)) === 1,
    `badge ${await newRepliesCount(c.owner.id)}`);

  const until = repliesSeenUntil("all", afterLate.replies);
  await sleep(20);
  const email = await inbound(seenCheck.email, "Arrived after the list was shown", new Date());
  const filtered = await listReplies({ userId: c.owner.id, channel: "email" });
  check("an Email-filtered list shows the new email but marks nothing seen", filtered.replies[0]?.messageId === email.id && filtered.replies[0].isNew && repliesSeenUntil("email", filtered.replies) === null);
  check("the unfiltered list marks seen up to the newest reply it showed", until === late.createdAt.toISOString(), `${until} vs ${late.createdAt.toISOString()}`);
  await markRepliesSeen(c.owner.id, new Date(until!));
  const afterSeen = await listReplies({ userId: c.owner.id });
  check("seen up to what was shown: a reply recorded after it stays new, in the list and the badge",
    afterSeen.replies.filter((reply) => reply.isNew).map((reply) => reply.messageId).join() === email.id && (await newRepliesCount(c.owner.id)) === 1);
  await markRepliesSeen(c.owner.id, at(-day));
  check("an earlier seen time never moves the mark back", (await newRepliesCount(c.owner.id)) === 1 && (await listReplies({ userId: c.owner.id })).replies.filter((reply) => reply.isNew).length === 1);
  await markRepliesSeen(c.owner.id, at(day));
  await sleep(20);
  const next = await inbound(seenCheck.whatsapp, "Calling you tomorrow", new Date());
  const ahead = await listReplies({ userId: c.owner.id });
  check("a seen time in the future is held to now: the next reply is still new",
    ahead.replies.filter((reply) => reply.isNew).map((reply) => reply.messageId).join() === next.id && (await newRepliesCount(c.owner.id)) === 1 && new Date(ahead.seenAt!).getTime() <= Date.now());
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

// A plan whose only sender is outside its hours, a plan that launched on one
// channel of two, a search cut short, and each plan's counts.
const hoursCase = await runInOrganization(a.org.id, async () => {
  // Working hours that open two hours from now, so the account is outside them.
  const hour = new Date().getUTCHours();
  const clock = (h: number) => `${String(h % 24).padStart(2, "0")}:00`;
  const end = (hour + 3) % 24 === 0 ? "23:59" : clock(hour + 3);
  const [account] = await db.insert(linkedin.linkedInAccounts).values({ organizationId: a.org.id, linkedinId: `activity-li-${stamp}`, username: `activity-li-${stamp}`, name: "Ravi", status: "CONNECTED", workTimezone: "UTC", workStartTime: clock(hour + 2), workEndTime: end, workDays: "0,1,2,3,4,5,6", updatedAt: new Date() }).returning();
  const [campaign] = await db.insert(linkedin.campaigns).values({ organizationId: a.org.id, name: "Activity hours check", type: "REGULAR", status: "ACTIVE", updatedAt: new Date() }).returning();
  await db.insert(linkedin.campaignAccounts).values({ campaignId: campaign!.id, linkedinAccountId: account!.id });
  const statuses = ["PENDING", "PENDING", "REQUEST_SENT", "REPLIED", "FAILED"] as const;
  const leadPeople = await db.insert(people).values(statuses.map((_, index) => ({ organizationId: a.org.id, source: "list", fullName: `Hours lead ${index}`, linkedinUrl: `https://www.linkedin.com/in/activity-${stamp}-${index}` }))).returning({ id: people.id });
  await db.insert(linkedin.leads).values(leadPeople.map((person, index) => ({ organizationId: a.org.id, personId: person.id, linkedinUrl: `https://www.linkedin.com/in/activity-${stamp}-${index}`, campaignId: campaign!.id, status: statuses[index]!, updatedAt: new Date() })));
  const [hoursRun] = await db.insert(outreachRuns).values({
    organizationId: a.org.id, threadId: seeded.today.id, audienceId: seeded.run.audienceId, name: "Agents on LinkedIn", status: "running", channels: ["linkedin"], campaigns: { linkedin: campaign!.id },
    plan: {} as unknown as OutreachPlan, autopilot: false, createdBy: a.owner.id,
  }).returning();
  await db.insert(outreachRunLeads).values(leadPeople.map((person) => ({ organizationId: a.org.id, runId: hoursRun!.id, personId: person.id, channel: "linkedin" as const })));
  const [partRun] = await db.insert(outreachRuns).values({
    organizationId: a.org.id, threadId: seeded.today.id, audienceId: seeded.run.audienceId, name: "Agents by email and LinkedIn", status: "running", channels: ["email", "linkedin"],
    error: "email: no mailbox is connected", plan: {} as unknown as OutreachPlan, autopilot: false, createdBy: a.owner.id,
  }).returning();
  const [cutShort] = await db.insert(assistantJobs).values({
    organizationId: a.org.id, kind: "discovery", stage: "done", threadId: seeded.today.id, status: "succeeded", finishedAt: new Date(),
    payload: { phrase: "agents in Wakad" }, progress: { stage: "done", partial: true }, result: { found: 6, eligible: 4 },
  }).returning();
  return { hoursRun: hoursRun!, partRun: partRun!, cutShort: cutShort! };
});

await runInOrganization(a.org.id, async () => {
  const work = await listWork();
  const hours = work.find((item) => item.id === hoursCase.hoursRun.id);
  check("a running plan whose every sender is outside its hours says so, with when the next send is allowed, and keeps its controls",
    hours?.state === "outside_hours" && hours.stateLabel === "Outside sending hours" && Boolean(hours.nextAt) && Date.parse(hours.nextAt!) > Date.now() && hours.open && hours.runStatus === "running",
    `${hours?.stateLabel}: ${hours?.reason} ${hours?.nextAt}`);
  check("its counts: 5 leads, 2 contacted (an invitation sent, a reply), 1 replied; a failed send is not contacted",
    hours?.counts?.leads === 5 && hours.counts.contacted === 2 && hours.counts.replied === 1, JSON.stringify(hours?.counts));
  const part = work.find((item) => item.id === hoursCase.partRun.id);
  check("a plan running on one channel of two is Partly done, still open, with what failed", part?.state === "partial" && part.open && /email: no mailbox is connected/.test(part.reason ?? ""), `${part?.stateLabel}: ${part?.reason}`);
  const cut = work.find((item) => item.id === hoursCase.cutShort.id);
  check("a search cut short is Partly done, finished, and keeps what it found", cut?.state === "partial" && !cut.open && cut.found === 6 && /cut short/.test(cut.reason ?? ""), `${cut?.stateLabel}: ${cut?.reason}`);
});
const otherWork = await runInOrganization(b.org.id, () => listWork());
check("another organization's Activity lists none of it", !otherWork.some((item) => [hoursCase.hoursRun.id, hoursCase.partRun.id, hoursCase.cutShort.id, seeded.run.id].includes(item.id)));

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

// A search that waited for a run slot and then started is no longer shown as waiting.
const [resumed] = await db.insert(assistantJobs).values({
  organizationId: a.org.id, kind: "apify_instagram", stage: "queued", threadId: seeded.yesterday.id, status: "queued", runAfter: new Date("1999-01-01T00:00:00Z"),
  payload: { phrase: "real estate agents Pune" },
  progress: { stage: "queued", found: 0, source: "Instagram (Apify)", waiting: { kind: "slot", provider: "apify", reason: "both Apify runs are in use; it starts when one finishes" } },
}).returning();
registerAssistantJobHandler("apify_instagram", async (job) => job.id === resumed!.id
  ? { next: "stage", stage: "apify", progress: { stage: "searching", provider: "Apify", actor: "Instagram search" } }
  : { next: "wait", delayMs: 60_000 });
await runOneAssistantStep();
const [started] = await db.select().from(assistantJobs).where(eq(assistantJobs.id, resumed!.id));
await runInOrganization(a.org.id, async () => {
  const item = (await listWork()).find((entry) => entry.id === resumed!.id);
  check("a search that waited for a slot and then started is no longer shown as waiting", started?.stage === "apify" && !("waiting" in (started?.progress ?? {})) && item?.state === "queued" && item.reason === null, `${item?.state}: ${JSON.stringify(started?.progress)}`);
});

// A step that failed is retried and says so; once a later step completes without an error, the error is gone.
const [flaky] = await db.insert(assistantJobs).values({
  organizationId: a.org.id, kind: "web_discovery", stage: "searching", threadId: seeded.today.id, status: "queued", runAfter: new Date("1998-01-01T00:00:00Z"),
  progress: { stage: "searching", searches: 2, searchesDone: 0 },
}).returning();
let flakyCalls = 0;
registerAssistantJobHandler("web_discovery", async (job) => {
  if (job.id !== flaky!.id) return { next: "wait", delayMs: 60_000 };
  flakyCalls += 1;
  if (flakyCalls === 1) throw new Error("socket hang up");
  // A poll that reports no progress of its own.
  return { next: "wait", delayMs: 60_000 };
});
await runOneAssistantStep();
const [failedStep] = await db.select().from(assistantJobs).where(eq(assistantJobs.id, flaky!.id));
const retrying = await runInOrganization(a.org.id, async () => (await listWork()).find((entry) => entry.id === flaky!.id));
check("a step that failed is retried, its error shown", failedStep?.progress.lastError === "socket hang up" && retrying?.state === "retrying" && retrying.reason === "socket hang up", `${retrying?.state}: ${JSON.stringify(failedStep?.progress)}`);
await db.update(assistantJobs).set({ runAfter: new Date("1998-01-01T00:00:00Z") }).where(eq(assistantJobs.id, flaky!.id));
await runOneAssistantStep();
const [recovered] = await db.select().from(assistantJobs).where(eq(assistantJobs.id, flaky!.id));
const afterRecovery = await runInOrganization(a.org.id, async () => (await listWork()).find((entry) => entry.id === flaky!.id));
check("once a later step completes without an error, the earlier error is dropped", flakyCalls === 2 && !("lastError" in (recovered?.progress ?? {})) && recovered?.progress.searches === 2 && afterRecovery?.state !== "retrying" && afterRecovery?.reason === null, `${afterRecovery?.state}: ${JSON.stringify(recovered?.progress)}`);

// Starting outreach is not a search: Activity offers no Cancel for it; the plan's own Pause and Stop control it.
await runInOrganization(a.org.id, async () => {
  const [starting] = await db.insert(assistantJobs).values({
    organizationId: a.org.id, kind: "outreach_start", stage: "personalizing", threadId: seeded.yesterday.id, runId: seeded.run.id, status: "queued", runAfter: at(60_000),
  }).returning();
  const listed = (await listWork()).find((entry) => entry.id === starting!.id);
  check("a plan's start job is listed without Cancel", listed?.title === "Starting outreach" && listed.open && !listed.canCancel, JSON.stringify({ title: listed?.title, canCancel: listed?.canCancel }));
  const queuedRefused = (await cancelJob(starting!.id)) === false;
  await db.update(assistantJobs).set({ status: "running", lockedBy: "launching-worker", heartbeatAt: new Date() }).where(eq(assistantJobs.id, starting!.id));
  const runningRefused = (await cancelJob(starting!.id)) === false;
  const [still] = await db.select().from(assistantJobs).where(eq(assistantJobs.id, starting!.id));
  check("cancelling it, queued or mid-launch, is refused and changes nothing", queuedRefused && runningRefused && still?.status === "running" && still.lockedBy === "launching-worker", `${still?.status}`);
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

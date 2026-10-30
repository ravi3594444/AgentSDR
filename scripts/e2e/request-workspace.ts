/**
 * Requests and their summaries (navigation rework N2), end to end on the
 * local database with the real read functions. Three kinds of work:
 *
 * - a chat request with an objective, a search and a WhatsApp plan that sent,
 *   failed once and got a reply classified Interested;
 * - an older email plan with no request id (sent once, bounced once);
 * - a WhatsApp campaign made by hand that no run owns (sent once, failed
 *   once, one reply).
 *
 * Checks that each is listed under its key (the manual campaign apart, the
 * runs' own campaigns not); that each summary's contacted, replied,
 * interested and failed equal what the existing reports say for the same
 * scope (results(all_time), reportRun, the campaign's own leads) and still
 * do after Stop; that the next step follows the plan's state — its sender,
 * then a pause, then an open decision (the Inbox first); that the chat lists
 * its request; that with every child finished the request reads researching
 * while its objective runs and, paused, says to resume it (never Done); and
 * that a second organization gets nothing for any key.
 * Nothing is sent and no provider is called.
 *
 *   bun run --conditions=react-server scripts/e2e/request-workspace.ts
 *
 * Creates its own organizations ("Request check …") and leaves them.
 * Refuses a non-local DATABASE_URL.
 */
import { eq } from "drizzle-orm";
import { spawnSync } from "node:child_process";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}

const stamp = Date.now();
const { db } = await import("@/lib/db");
const { organizations, users, members } = await import("@/lib/auth/schema");
const { people } = await import("@/lib/leads/schema");
const { runInOrganization } = await import("@/lib/tenancy/scope");
const { outreachCampaigns, outreachLeads, outreachEmails } = await import("@/lib/outreach/schema");
const { whatsappAccounts, whatsappCampaigns, whatsappCampaignLeads, whatsappCampaignSends } = await import("@/lib/whatsapp/schema");
const { crmRecords, crmConversations, crmConversationMessages, crmClassifications } = await import("@/lib/crm/schema");
const { assistantThreads, assistantMessages, assistantJobs, assistantObjectives, outreachRuns, outreachRunLeads, ownerDecisions } = await import("@/lib/assistant/schema");
const { createAudience } = await import("@/lib/assistant/audiences.server");
const { ensureCrmDefaults } = await import("@/lib/crm/defaults");
const { listRequests, requestSummary, threadRequests } = await import("@/lib/assistant/requests.server");
const { requestScope, runScope, results } = await import("@/lib/assistant/results.server");
const { reportRun, setRunPaused, stopRun } = await import("@/lib/assistant/outreach.server");
const { setObjectiveState } = await import("@/lib/assistant/objective.server");
const { addAudienceMembers } = await import("@/lib/assistant/audiences.server");
const { audienceProspects } = await import("@/lib/assistant/qualification.server");
const { assistantState } = await import("@/lib/assistant/http.server");
const { leadAudienceMembers } = await import("@/lib/assistant/schema");
const { reportAudiences, searchListOf, workCounts } = await import("@/lib/assistant/leadLists");
type OrgContext = import("@/lib/auth/context").OrgContext;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const [a] = await db.insert(organizations).values({ name: `Request check A ${stamp}`, slug: `request-check-a-${stamp}` }).returning();
const [b] = await db.insert(organizations).values({ name: `Request check B ${stamp}`, slug: `request-check-b-${stamp}` }).returning();
const [owner] = await db.insert(users).values({ name: "Owner A", email: `owner-${stamp}@request-check.test`, emailVerified: true }).returning();
await db.insert(members).values({ organizationId: a!.id, userId: owner!.id, role: "owner" });
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
const step = (body: string, delayHours: number) => ({ id: crypto.randomUUID(), body, delayHours });

const seeded = await runInOrganization(a!.id, async () => {
  const org = a!.id;
  const { pipelineId } = await ensureCrmDefaults();
  const tail = String(stamp % 100_000).padStart(5, "0");
  const lead = async (n: number) => (await db.insert(people).values({ organizationId: org, source: "request-check", fullName: `Lead ${n}`, phone: `+1415${n}${tail}`, email: `lead${n}-${stamp}@request-check.test` }).returning())[0]!;
  const [p1, p2, p3, p4, p5, p6, p7] = [await lead(1), await lead(2), await lead(3), await lead(4), await lead(5), await lead(6), await lead(7)];
  const [account] = await db.insert(whatsappAccounts).values({ organizationId: org, unipileAccountId: `request-check-${stamp}`, name: "Sales number", phone: `+1415999${tail}`, status: "connected", connectedAt: minutesAgo(5 * 1440) }).returning();

  // 1. A chat request: objective, one search, one WhatsApp plan.
  const [thread] = await db.insert(assistantThreads).values({ organizationId: org, title: "Chicago dentists", createdBy: owner!.id }).returning();
  const [request] = await db.insert(assistantMessages).values({ organizationId: org, threadId: thread!.id, role: "user", content: "Find 20 dentists in Chicago and message them on WhatsApp" }).returning();
  const [objective] = await db.insert(assistantObjectives).values({ organizationId: org, threadId: thread!.id, requestMessageId: request!.id, leadTarget: 20, controls: { named: { target: true, time: false, spend: false } }, timeLimitMinutes: 240, deadlineAt: new Date(Date.now() + 4 * 3_600_000), spendCapUsd: 5, progress: { waiting: "the assistant is choosing the next source" } }).returning();
  const searchAudience = await createAudience({ name: `Chicago dentists ${stamp}`, source: "discovery" });
  const [search] = await db.insert(assistantJobs).values({ organizationId: org, threadId: thread!.id, kind: "discovery", status: "succeeded", stage: "done", audienceId: searchAudience, payload: { requestMessageId: request!.id, phrase: "dentists in Chicago" }, result: { found: 3, eligible: 3 }, finishedAt: minutesAgo(50) }).returning();
  // The objective's driver job, as ensureObjective creates it: no request id of its own, the objective's id in its payload.
  const [driver] = await db.insert(assistantJobs).values({ organizationId: org, threadId: thread!.id, kind: "objective", status: "queued", stage: "watching", payload: { objectiveId: objective!.id }, progress: { stage: "watching", waiting: { kind: "objective", reason: "the assistant is choosing the next source" } }, runAfter: new Date(Date.now() + 15_000) }).returning();
  const [w1] = await db.insert(whatsappCampaigns).values({ organizationId: org, name: "Chicago dentists, WhatsApp", status: "active", steps: [step("Hi {{firstName}}", 0), step("Following up", 48)] }).returning();
  const [plan] = await db.insert(outreachRuns).values({
    organizationId: org, threadId: thread!.id, audienceId: searchAudience, name: "Chicago dentists, WhatsApp", status: "running", channels: ["whatsapp"],
    campaigns: { whatsapp: w1!.id }, plan: { requestId: request!.id, assignments: [p1, p2, p3].map((p) => ({ personId: p.id, channel: "whatsapp" })) } as never, autopilot: false, createdBy: owner!.id,
  }).returning();
  await db.insert(outreachRunLeads).values([p1, p2, p3].map((p) => ({ organizationId: org, runId: plan!.id, personId: p.id, channel: "whatsapp" as const })));
  const [l1, l2, l3] = await db.insert(whatsappCampaignLeads).values([
    // As the sender leaves them: a sent step advances current_step and stamps last_sent_at.
    { campaignId: w1!.id, personId: p1.id, phone: p1.phone!, status: "replied", currentStep: 1, lastSentAt: minutesAgo(40) },
    { campaignId: w1!.id, personId: p2.id, phone: p2.phone!, status: "failed", lastError: "WhatsApp rejected this recipient" },
    { campaignId: w1!.id, personId: p3.id, phone: p3.phone!, status: "in_sequence", currentStep: 1, lastSentAt: minutesAgo(38), nextSendAt: new Date(Date.now() + 47 * 3_600_000) },
  ]).returning();
  await db.insert(whatsappCampaignSends).values([
    { leadId: l1!.id, step: 0, status: "sent", accountId: account!.id, sentAt: minutesAgo(40), createdAt: minutesAgo(40) },
    { leadId: l2!.id, step: 0, status: "failed", accountId: account!.id, error: "WhatsApp rejected this recipient", createdAt: minutesAgo(39) },
    { leadId: l3!.id, step: 0, status: "sent", accountId: account!.id, sentAt: minutesAgo(38), createdAt: minutesAgo(38) },
  ]);

  // 2. An older email plan with no request id.
  const listAudience = await createAudience({ name: `Old list ${stamp}`, source: "list" });
  const [e0] = await db.insert(outreachCampaigns).values({ organizationId: org, name: "Old email plan", status: "active" }).returning();
  const [oldRun] = await db.insert(outreachRuns).values({
    organizationId: org, audienceId: listAudience, name: "Old email plan", status: "running", channels: ["email"], campaigns: { email: e0!.id },
    plan: { assignments: [p4, p5].map((p) => ({ personId: p.id, channel: "email" })) } as never, autopilot: false, createdBy: owner!.id,
  }).returning();
  await db.insert(outreachRunLeads).values([p4, p5].map((p) => ({ organizationId: org, runId: oldRun!.id, personId: p.id, channel: "email" as const })));
  // The older search that filled its list, from before searches carried a request id.
  const [oldSearch] = await db.insert(assistantJobs).values({ organizationId: org, kind: "discovery", status: "succeeded", stage: "done", audienceId: listAudience, payload: { phrase: "old list search" }, result: { found: 2, eligible: 2 }, finishedAt: minutesAgo(35) }).returning();
  const [e4] = await db.insert(outreachLeads).values({ campaignId: e0!.id, personId: p4.id, sequenceStatus: "initial_sent" }).returning();
  const [e5] = await db.insert(outreachLeads).values({ campaignId: e0!.id, personId: p5.id, sequenceStatus: "bounced" }).returning();
  await db.insert(outreachEmails).values([
    { leadId: e4!.id, stepNumber: 1, status: "sent", sentAt: minutesAgo(30), createdAt: minutesAgo(30) },
    { leadId: e5!.id, stepNumber: 1, status: "failed", error: "mailbox does not exist", createdAt: minutesAgo(29) },
  ]);

  // 3. A WhatsApp campaign made by hand.
  const [w2] = await db.insert(whatsappCampaigns).values({ organizationId: org, name: "Hand-made WhatsApp", status: "paused", steps: [step("Hello", 0)] }).returning();
  const [l6, l7] = await db.insert(whatsappCampaignLeads).values([
    { campaignId: w2!.id, personId: p6.id, phone: p6.phone!, status: "replied", currentStep: 1, lastSentAt: minutesAgo(20) },
    { campaignId: w2!.id, personId: p7.id, phone: p7.phone!, status: "failed", lastError: "not on WhatsApp" },
  ]).returning();
  await db.insert(whatsappCampaignSends).values([
    { leadId: l6!.id, step: 0, status: "sent", accountId: account!.id, sentAt: minutesAgo(20), createdAt: minutesAgo(20) },
    { leadId: l7!.id, step: 0, status: "failed", accountId: account!.id, error: "not on WhatsApp", createdAt: minutesAgo(19) },
  ]);

  // Replies: lead 1 (classified Interested) and lead 6, each after their message; both answered, so nothing waits.
  const reply = async (personId: string, minutes: number) => {
    const [record] = await db.insert(crmRecords).values({ organizationId: org, personId, pipelineId, workflowState: "waiting", nextActionAt: new Date(Date.now() + 86_400_000) }).returning();
    const [conversation] = await db.insert(crmConversations).values({ organizationId: org, crmRecordId: record!.id, personId, channel: "whatsapp", accountRef: account!.unipileAccountId }).returning();
    const [message] = await db.insert(crmConversationMessages).values({ conversationId: conversation!.id, personId, channel: "whatsapp", accountRef: account!.unipileAccountId, direction: "inbound", idempotencyKey: `request-check-${stamp}-${personId}`, bodyText: "Yes, tell me more", sentAt: minutesAgo(minutes) }).returning();
    return { record: record!, message: message! };
  };
  const r1 = await reply(p1.id, 35);
  await reply(p6.id, 15);
  await db.insert(crmClassifications).values({ crmRecordId: r1.record.id, messageId: r1.message.id, expectedContextVersion: 0, appliedCategoryKey: "interested", confidence: "0.9", status: "accepted" });
  return { thread: thread!, request: request!, objective: objective!, driver: driver!, search: search!, plan: plan!, w1: w1!, oldRun: oldRun!, oldSearch: oldSearch!, e0: e0!, w2: w2! };
});

const requestKey = `r:${seeded.request.id}`;
const runKey = `run:${seeded.oldRun.id}`;
const campaignKey = `campaign:whatsapp:${seeded.w2.id}`;
type Numbers = { contacted: number; replied: number; interested: number; failed: number };
const numbersOf = (summary: Awaited<ReturnType<typeof requestSummary>>): Numbers | null => summary ? { contacted: summary.numbers.contacted, replied: summary.numbers.replied, interested: summary.numbers.interested, failed: summary.numbers.failed } : null;

await runInOrganization(a!.id, async () => {
  const listed = await listRequests();
  const keys = listed.requests.map((row) => row.key);
  const chatRow = listed.requests.find((row) => row.key === requestKey);
  check("the chat request is listed under its message, with its search and plan", Boolean(chatRow) && chatRow!.title.startsWith("Find 20 dentists") && chatRow!.plans === 1 && chatRow!.searches === 1 && chatRow!.channels.includes("whatsapp"), JSON.stringify(chatRow));
  check("the older plan with no request id is listed on its own", keys.includes(runKey));
  check("…with the older search that filled its list under it, not listed twice", !keys.includes(`job:${seeded.oldSearch.id}`) && listed.requests.find((row) => row.key === runKey)?.searches === 1);
  const manual = listed.manualCampaigns.map((row) => row.key);
  check("the hand-made campaign is listed apart; the runs' own campaigns are not", manual.includes(campaignKey) && !manual.some((key) => key.endsWith(seeded.w1.id) || key.endsWith(seeded.e0.id)), manual.join(","));
  check("the channel filter keeps the WhatsApp work only", (await listRequests({ channel: "email" })).requests.every((row) => row.channels.includes("email")) && (await listRequests({ channel: "email" })).requests.some((row) => row.key === runKey) && !(await listRequests({ channel: "email" })).requests.some((row) => row.key === requestKey));

  const expected = async (scope: Parameters<typeof results>[2], runIds: string[]) => {
    const report = await results("all_time", new Date(), scope);
    const reports = await Promise.all(runIds.map((id) => reportRun(id)));
    return { contacted: report.outreach.peopleContacted, replied: report.outreach.contactedWhoReplied, interested: report.outreach.interested, failed: reports.reduce((sum, r) => sum + (r?.channels.reduce((n, c) => n + c.failed, 0) ?? 0), 0) };
  };
  const chat = await requestSummary(requestKey);
  const chatExpected = await expected(await requestScope(seeded.request.id), [seeded.plan.id]);
  check("the chat request's figures equal the reports for the same scope", JSON.stringify(numbersOf(chat)) === JSON.stringify(chatExpected), `${JSON.stringify(numbersOf(chat))} vs ${JSON.stringify(chatExpected)}`);
  check("…which are 2 contacted, 1 replied, 1 interested, 1 failed", JSON.stringify(numbersOf(chat)) === JSON.stringify({ contacted: 2, replied: 1, interested: 1, failed: 1 }));
  check("…and the list row says the same as the summary", chatRow?.counts?.contacted === chat!.numbers.contacted && chatRow.counts.replied === chat!.numbers.replied && chatRow.counts.failed === chat!.numbers.failed, JSON.stringify(chatRow?.counts));
  check("…with its objective's target and research, and its search and plan underneath", chat?.target === 20 && chat.objective?.requestMessageId === seeded.request.id && chat.children.searches.some((item) => item.id === seeded.search.id) && chat.children.plans.some((item) => item.runId === seeded.plan.id) && chat.children.campaigns.some((c) => c.id === seeded.w1.id && c.href === `/whatsapp/campaigns/${seeded.w1.id}`), JSON.stringify(chat?.children.campaigns));
  const old = await requestSummary(runKey);
  const oldExpected = await expected((await runScope(seeded.oldRun.id))!, [seeded.oldRun.id]);
  check("…and its summary lists that search", Boolean(old?.children.searches.some((item) => item.id === seeded.oldSearch.id)));
  check("the older plan's figures equal the reports for it", JSON.stringify(numbersOf(old)) === JSON.stringify(oldExpected) && old!.numbers.contacted === 1 && old!.numbers.failed === 1, `${JSON.stringify(numbersOf(old))} vs ${JSON.stringify(oldExpected)}`);
  const hand = await requestSummary(campaignKey);
  check("the hand-made campaign: 1 contacted, 1 replied, 1 failed (its own leads)", JSON.stringify(numbersOf(hand)) === JSON.stringify({ contacted: 1, replied: 1, interested: 0, failed: 1 }) && hand!.numbers.matching === null && hand!.children.campaigns[0]?.href === `/whatsapp/campaigns/${seeded.w2.id}`, JSON.stringify(numbersOf(hand)));

  const planChild = chat!.children.plans.find((item) => item.runId === seeded.plan.id)!;
  const senderStep = ["fix_sender", "wait", "research"].includes(chat!.nextAction.kind);
  check("while it sends, the next step follows the plan's sender state", senderStep && (planChild.state === "waiting_send" ? chat!.blocker === planChild.reason : true), `${chat!.nextAction.kind} / ${planChild.state} / ${chat!.blocker}`);
  await setRunPaused(seeded.plan.id, true);
  const paused = await requestSummary(requestKey);
  check("paused: the next step is to resume it", paused?.nextAction.kind === "paused" && paused.nextAction.label.includes("Chicago dentists"), paused?.nextAction.label);
  await db.insert(ownerDecisions).values({ organizationId: a!.id, kind: "missing_info", reason: "They asked about weekend hours", decision: "Do you open on Saturdays?", runId: seeded.plan.id });
  const decided = await requestSummary(requestKey);
  check("an open decision comes first: answer it in the Inbox", decided?.nextAction.kind === "inbox" && decided.nextAction.label === "Answer 1 in the Inbox" && decided.nextAction.href === "/inbox?view=needs_you", decided?.nextAction.label);

  await stopRun(seeded.plan.id);
  await stopRun(seeded.oldRun.id);
  const afterStop = await requestSummary(requestKey);
  check("after Stop the chat request's figures hold", JSON.stringify(numbersOf(afterStop)) === JSON.stringify(numbersOf(chat)), JSON.stringify(numbersOf(afterStop)));
  check("…and the older plan's too", JSON.stringify(numbersOf(await requestSummary(runKey))) === JSON.stringify(numbersOf(old)));

  // Pilot L03: the plan is stopped and the search done, but the objective still runs (the gap between one search ending and the next starting).
  const between = await requestSummary(requestKey);
  check("with every child finished and the objective active, the request is open and researching, not Done",
    between?.open === true && between.stateLabel === "Researching (the assistant is choosing the next source)" && between.nextAction.kind !== "done" && !between.children.searches.some((item) => item.id === seeded.driver.id),
    JSON.stringify({ open: between?.open, stateLabel: between?.stateLabel, next: between?.nextAction.kind }));
  const chatRequests = await threadRequests(seeded.thread.id);
  check("the chat lists the request it started, open, and never its driver job as a search of its own",
    chatRequests[0]?.key === requestKey && chatRequests[0].open === true && chatRequests[0].title.startsWith("Find 20 dentists") && !chatRequests.some((row) => row.key === `job:${seeded.driver.id}`),
    JSON.stringify(chatRequests));
  const listedBetween = await listRequests();
  const rowBetween = listedBetween.requests.find((row) => row.key === requestKey);
  check("…and the Requests list shows it open and researching, with no row for the driver",
    rowBetween?.open === true && rowBetween.stateLabel.startsWith("Researching") && rowBetween.searches === 1 && !listedBetween.requests.some((row) => row.key === `job:${seeded.driver.id}`),
    JSON.stringify({ open: rowBetween?.open, stateLabel: rowBetween?.stateLabel, searches: rowBetween?.searches, keys: listedBetween.requests.map((row) => row.key) }));
  // Review of L03: paused with every child finished and nothing waiting in the Inbox, it reads paused everywhere and its next step is to resume it, never Done.
  await db.update(ownerDecisions).set({ status: "resolved" }).where(eq(ownerDecisions.runId, seeded.plan.id));
  await setObjectiveState(seeded.objective.id, "pause", { name: null });
  const pausedResearch = await requestSummary(requestKey);
  check("paused research: open, \"Research paused\", and the next step is to resume it in the chat, not Done",
    pausedResearch?.open === true && pausedResearch.stateLabel === "Research paused" && pausedResearch.nextAction.kind === "paused" && /resume/i.test(pausedResearch.nextAction.label) && pausedResearch.nextAction.href === `/assistant?thread=${seeded.thread.id}`,
    JSON.stringify({ open: pausedResearch?.open, stateLabel: pausedResearch?.stateLabel, next: pausedResearch?.nextAction }));
  check("…and it shows no reason it waited for before the pause", pausedResearch?.blocker === null && pausedResearch.objective?.waiting === null, JSON.stringify({ blocker: pausedResearch?.blocker, waiting: pausedResearch?.objective?.waiting }));
  const pausedRow = (await listRequests()).requests.find((row) => row.key === requestKey);
  check("…and the Requests list and the chat agree: open, Research paused",
    pausedRow?.open === true && pausedRow.stateLabel === "Research paused" && (await threadRequests(seeded.thread.id))[0]?.open === true,
    JSON.stringify({ open: pausedRow?.open, stateLabel: pausedRow?.stateLabel }));
  await setObjectiveState(seeded.objective.id, "resume", { name: null });
  const resumedResearch = await requestSummary(requestKey);
  check("resumed: researching again", resumedResearch?.open === true && resumedResearch.stateLabel.startsWith("Researching") && resumedResearch.nextAction.kind === "research",
    JSON.stringify({ stateLabel: resumedResearch?.stateLabel, next: resumedResearch?.nextAction.kind }));
  await setObjectiveState(seeded.objective.id, "cancel", { name: null });
  const stoppedRequest = await requestSummary(requestKey);
  const stoppedRow = (await listRequests()).requests.find((row) => row.key === requestKey);
  check("after Stop it reads done everywhere",
    stoppedRequest?.open === false && !/^Researching|^Working/.test(stoppedRequest.stateLabel) && stoppedRow?.open === false && (await threadRequests(seeded.thread.id))[0]?.open === false,
    JSON.stringify({ open: stoppedRequest?.open, stateLabel: stoppedRequest?.stateLabel, row: stoppedRow?.open }));
  check("keys that are not keys are refused", (await requestSummary("r:not-a-uuid")) === null && (await requestSummary(`run:${crypto.randomUUID()}`)) === null);
});

// Leads polish: each search's own list stays one click away (under its row, its card and the
// report, after a reload too), and a business saved without a person's name is named by the
// business, never by an invented person. Run last: the extra jobs below would otherwise be
// listed as requests of the chat.
const lists = await runInOrganization(a!.id, async () => {
  const org = a!.id;
  const summary = await requestSummary(requestKey);
  const searchItem = summary?.children.searches.find((item) => item.id === seeded.search.id);
  check("a finished search under the request offers its own list, counted by its contactable leads",
    Boolean(searchItem) && JSON.stringify(searchListOf(searchItem!)) === JSON.stringify({ audienceId: seeded.search.audienceId, count: 3 }) && workCounts(searchItem!) === "3 Found · 3 Contactable",
    JSON.stringify(searchItem && { list: searchListOf(searchItem), counts: workCounts(searchItem) }));

  // A long chat: the search its card names and the one only the final report names are both older than its 20 newest jobs.
  const olderAudience = await createAudience({ name: `Older search ${stamp}`, source: "discovery" });
  const [olderSearch] = await db.insert(assistantJobs).values({ organizationId: org, threadId: seeded.thread.id, kind: "web_discovery", status: "succeeded", stage: "done", audienceId: olderAudience, payload: { phrase: "older search" }, progress: { source: "Website and directory search" }, result: { found: 4, eligible: 2 }, createdAt: minutesAgo(600), finishedAt: minutesAgo(590) }).returning();
  await db.update(assistantJobs).set({ createdAt: minutesAgo(560) }).where(eq(assistantJobs.id, seeded.search.id));
  const reportData = { audienceIds: [seeded.search.audienceId, olderAudience], links: [{ label: "Lead lists in this chat", href: `/assistant?thread=${seeded.thread.id}` }, { label: "Saved leads", href: "/leads" }] };
  await db.insert(assistantMessages).values([
    { organizationId: org, threadId: seeded.thread.id, role: "tool", tool: "find_leads", status: "ok", content: "Searching Google Maps for dentists in Chicago", toolResult: { data: { jobId: seeded.search.id, audienceId: seeded.search.audienceId, phrase: "dentists in Chicago" } }, createdAt: minutesAgo(58) },
    { organizationId: org, threadId: seeded.thread.id, role: "event", content: "Research finished.", toolResult: { data: reportData }, createdAt: minutesAgo(2) },
  ]);
  await db.insert(assistantJobs).values(Array.from({ length: 21 }, (_, index) => ({ organizationId: org, threadId: seeded.thread.id, kind: "discovery" as const, status: "succeeded" as const, stage: "done", payload: { phrase: `later search ${index}` }, result: { found: 0, eligible: 0 }, createdAt: minutesAgo(30 - index), finishedAt: minutesAgo(29 - index) })));
  // Among the newest, the job that started a plan from the older search's list: it shares the list, it is not its search.
  await db.insert(assistantJobs).values({ organizationId: org, threadId: seeded.thread.id, kind: "outreach_start", status: "succeeded", stage: "done", audienceId: olderAudience, payload: {}, createdAt: minutesAgo(5), finishedAt: minutesAgo(4) });
  const ctx = { userId: owner!.id, userName: "Owner A", userEmail: owner!.email, organizationId: org, organizationName: a!.name, organizationSlug: a!.slug, roles: ["owner"] } as unknown as OrgContext;
  const state = await assistantState(seeded.thread.id, ctx, false);
  check("reopening a chat with more than 20 searches still loads the search its card names", state.jobs.some((job) => job.id === seeded.search.id), `${state.jobs.length} jobs`);
  check("…and the searches its final report's lists come from, so each list keeps its count and source",
    state.jobs.some((job) => job.id === olderSearch!.id) && JSON.stringify(reportAudiences(reportData, state.jobs)) ===JSON.stringify([{ audienceId: seeded.search.audienceId, count: 3, title: "Lead search" }, { audienceId: olderAudience, count: 2, title: "Website and directory search" }]),
    JSON.stringify(reportAudiences(reportData, state.jobs)));
  check("…without loading another chat's jobs", state.jobs.every((job) => job.id !== seeded.oldSearch.id));

  // A Maps business without a website (kept as raw.company) and a directory contact (only a pseudo-name in raw.businessName).
  const tail = String(stamp % 100_000).padStart(5, "0");
  const [business] = await db.insert(people).values({ organizationId: org, source: "discovery:google-maps", phone: `+9198${tail}01`, raw: { businessName: "Bright Path Dental", company: "Bright Path Dental", companyName: "Bright Path Dental" } }).returning();
  const [listed] = await db.insert(people).values({ organizationId: org, source: "discovery:web-search", phone: `+9198${tail}02`, raw: { businessName: `+9198${tail}02 (listed on guide.example)` } }).returning();
  const fresh = await createAudience({ name: `Naming ${stamp}`, source: "discovery" });
  await addAudienceMembers(fresh, [{ personId: business!.id, source: "google_maps" }, { personId: listed!.id, source: "web_search" }]);
  const freshNames = new Map((await db.select({ personId: leadAudienceMembers.personId, name: leadAudienceMembers.name }).from(leadAudienceMembers).where(eq(leadAudienceMembers.audienceId, fresh))).map((row) => [row.personId, row.name]));
  check("a new list member is named by the business it was saved under, ahead of its phone; a directory contact keeps its phone",
    freshNames.get(business!.id) === "Bright Path Dental" && freshNames.get(listed!.id) === listed!.phone, JSON.stringify([...freshNames.values()]));
  // Members stored before: named by their phone.
  const legacy = await createAudience({ name: `Stored before ${stamp}`, source: "discovery" });
  await db.insert(leadAudienceMembers).values([business!, listed!].map((person) => ({ organizationId: org, audienceId: legacy, personId: person.id, name: person.phone!, status: "eligible" as const, channels: ["whatsapp" as const], source: "google_maps" })));
  const legacyNames = (await audienceProspects(legacy))?.prospects.map((prospect) => prospect.name) ?? [];
  check("a member stored under its phone is shown by its business now; the directory contact still by its phone",
    legacyNames.includes("Bright Path Dental") && legacyNames.includes(listed!.phone!) && !legacyNames.includes(business!.phone!), JSON.stringify(legacyNames));
  const [after] = await db.select({ fullName: people.fullName }).from(people).where(eq(people.id, business!.id));
  const storedNames = (await db.select({ name: leadAudienceMembers.name }).from(leadAudienceMembers).where(eq(leadAudienceMembers.audienceId, legacy))).map((row) => row.name);
  check("…and nothing was written: no person name invented, the stored member names unchanged", after?.fullName === null && storedNames.every((name) => name.startsWith("+9198")), JSON.stringify({ after, storedNames }));
  return { legacy };
});

// The reported screenshot: raw results exist, none match yet, and a social
// provider is between polls. Read the real request, then render both views
// in a separate, normal React process (not the react-server condition).
const statusFixture = await runInOrganization(a!.id, async () => {
  const org = a!.id;
  const [thread] = await db.insert(assistantThreads).values({ organizationId: org, title: "Browser research status", createdBy: owner!.id }).returning();
  const [request] = await db.insert(assistantMessages).values({ organizationId: org, threadId: thread!.id, role: "user", content: "Find business owners. Research only, do not contact anyone." }).returning();
  await db.insert(assistantObjectives).values({ organizationId: org, threadId: thread!.id, requestMessageId: request!.id, leadTarget: 25, controls: { named: { target: false, time: false, spend: false } }, timeLimitMinutes: 240, deadlineAt: new Date(Date.now() + 4 * 3_600_000), progress: { waiting: "1 search is still collecting results" } });
  const audience = await createAudience({ name: `Status leads ${stamp}`, source: "discovery" });
  const duplicate = await createAudience({ name: `Same people, another source ${stamp}`, source: "discovery" });
  const saved = await db.insert(people).values(Array.from({ length: 14 }, (_, i) => ({ organizationId: org, source: "request-status-check", fullName: `Business owner ${i + 1}`, email: i < 6 ? `status-${i}-${stamp}@request-check.test` : null }))).returning();
  const members = saved.map((person, i) => ({ organizationId: org, audienceId: audience, personId: person.id, name: person.fullName!, status: i < 6 ? "eligible" as const : "excluded" as const, channels: i < 6 ? ["email" as const] : [], source: "web_search", fit: i < 6 ? "no_match" as const : null, fitAt: i < 6 ? new Date() : null, fitReason: i < 6 ? "Not a business owner" : null }));
  await db.insert(leadAudienceMembers).values(members);
  await db.insert(leadAudienceMembers).values(members.slice(0, 6).map((member) => ({ ...member, audienceId: duplicate })));
  await db.insert(assistantJobs).values([
    { organizationId: org, threadId: thread!.id, kind: "web_discovery", status: "succeeded", stage: "done", audienceId: audience, payload: { requestMessageId: request!.id, phrase: "Business owners", searchProvider: "tinyfish" }, result: { found: 14, eligible: 6 }, finishedAt: new Date() },
    { organizationId: org, threadId: thread!.id, kind: "web_discovery", status: "succeeded", stage: "done", audienceId: duplicate, payload: { requestMessageId: request!.id, phrase: "Owner profiles", searchProvider: "tavily" }, result: { found: 6, eligible: 6 }, finishedAt: new Date() },
  ]);
  const nextCheck = new Date(Date.now() + 60_000);
  const [poll] = await db.insert(assistantJobs).values({ organizationId: org, threadId: thread!.id, kind: "social_research", status: "queued", stage: "collecting", runAfter: nextCheck, payload: { requestMessageId: request!.id, criteria: { platforms: ["x", "facebook"] } }, progress: { source: "X, Facebook via Bright Data", stage: "collecting", collecting: 1 } }).returning();
  const summary = (await requestSummary(`r:${request!.id}`))!;
  const waiting = summary.children.searches.find((item) => item.id === poll!.id);
  check("research counts are 14 distinct found, 6 contactable, 0 matching, even across overlapping sources", summary.numbers.found === 14 && summary.numbers.contactable === 6 && summary.numbers.matching === 0, JSON.stringify(summary.numbers));
  check("a saved default of 25 is not presented as the owner's requested target", summary.target === null && summary.objective?.leadTarget === 25);
  check("a normal search wait is informational, never a request blocker", summary.blocker === null && summary.nextAction.kind === "research" && summary.nextAction.detail === "1 search is still collecting results");
  check("a provider poll says Waiting for results and keeps the exact next check time", waiting?.state !== "scheduled" && waiting?.stateLabel === "Waiting for provider results" && waiting.nextAt === nextCheck.toISOString(), JSON.stringify(waiting));
  check("reading the summary creates no outreach plans or sends", summary.children.plans.length === 0 && summary.numbers.contacted === 0);
  await db.update(assistantJobs).set({ status: "failed", error: "Bright Data returned an unreadable snapshot", finishedAt: new Date() }).where(eq(assistantJobs.id, poll!.id));
  const failed = (await requestSummary(`r:${request!.id}`))!;
  check("a real search failure remains visible as a blocker", failed.blocker === "Bright Data returned an unreadable snapshot");
  const render = spawnSync(process.execPath, ["scripts/review/request-summary-markup.tsx"], { input: JSON.stringify({ research: summary, failed, outreach: await requestSummary(requestKey) }), encoding: "utf8", timeout: 30_000 });
  check("database request payloads render truthfully in both the chat panel and Requests page", render.status === 0, [render.stdout.trim(), render.stderr.trim()].filter(Boolean).join("\n"));
  return { key: summary.key };
});

await runInOrganization(b!.id, async () => {
  check("another workspace cannot read the new counts or research phase", await requestSummary(statusFixture.key) === null);
  check("another organization gets no lead list of the first one's", (await audienceProspects(lists.legacy)) === null);
  const none = await Promise.all([requestKey, runKey, campaignKey, `job:${seeded.search.id}`].map((key) => requestSummary(key)));
  check("another organization gets nothing for any of the first one's keys", none.every((summary) => summary === null));
  const listed = await listRequests();
  check("…lists none of its work", !listed.requests.some((row) => [requestKey, runKey].includes(row.key)) && !listed.manualCampaigns.some((row) => row.key === campaignKey));
  check("…and nothing for its chat", (await threadRequests(seeded.thread.id)).length === 0);
});
// No worker runs here, and Stop woke the driver: it is finished by hand, as it would end, so no other suite's worker claims it.
await db.update(assistantJobs).set({ status: "succeeded", stage: "done", finishedAt: new Date() }).where(eq(assistantJobs.id, seeded.driver.id));
const [runAfter] = await db.select().from(outreachRuns).where(eq(outreachRuns.id, seeded.plan.id));
check("reading changed nothing the checks did not do themselves", runAfter?.status === "stopped");

if (failures) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("Request workspace checks passed");
process.exit(0);

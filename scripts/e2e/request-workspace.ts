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
 * its request; and that a second organization gets nothing for any key.
 * Nothing is sent and no provider is called.
 *
 *   bun run --conditions=react-server scripts/e2e/request-workspace.ts
 *
 * Creates its own organizations ("Request check …") and leaves them.
 * Refuses a non-local DATABASE_URL.
 */
import { eq } from "drizzle-orm";

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
  await db.insert(assistantObjectives).values({ organizationId: org, threadId: thread!.id, requestMessageId: request!.id, leadTarget: 20, timeLimitMinutes: 240, deadlineAt: new Date(Date.now() + 4 * 3_600_000), spendCapUsd: 5 });
  const searchAudience = await createAudience({ name: `Chicago dentists ${stamp}`, source: "discovery" });
  const [search] = await db.insert(assistantJobs).values({ organizationId: org, threadId: thread!.id, kind: "discovery", status: "succeeded", stage: "done", audienceId: searchAudience, payload: { requestMessageId: request!.id, phrase: "dentists in Chicago" }, result: { found: 3, eligible: 3 }, finishedAt: minutesAgo(50) }).returning();
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
  return { thread: thread!, request: request!, search: search!, plan: plan!, w1: w1!, oldRun: oldRun!, e0: e0!, w2: w2! };
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
  check("the older plan's figures equal the reports for it", JSON.stringify(numbersOf(old)) === JSON.stringify(oldExpected) && old!.numbers.contacted === 1 && old!.numbers.failed === 1, `${JSON.stringify(numbersOf(old))} vs ${JSON.stringify(oldExpected)}`);
  const hand = await requestSummary(campaignKey);
  check("the hand-made campaign: 1 contacted, 1 replied, 1 failed (its own leads)", JSON.stringify(numbersOf(hand)) === JSON.stringify({ contacted: 1, replied: 1, interested: 0, failed: 1 }) && hand!.numbers.matching === null && hand!.children.campaigns[0]?.href === `/whatsapp/campaigns/${seeded.w2.id}`, JSON.stringify(numbersOf(hand)));

  const planChild = chat!.children.plans.find((item) => item.runId === seeded.plan.id)!;
  const senderStep = ["fix_sender", "wait", "research"].includes(chat!.nextAction.kind);
  check("while it sends, the next step follows the plan's sender state", senderStep && (planChild.state === "waiting_send" || planChild.state === "outside_hours" ? chat!.blocker === planChild.reason : true), `${chat!.nextAction.kind} / ${planChild.state} / ${chat!.blocker}`);
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

  const chatRequests = await threadRequests(seeded.thread.id);
  check("the chat lists the request it started", chatRequests[0]?.key === requestKey && chatRequests[0].title.startsWith("Find 20 dentists"), JSON.stringify(chatRequests));
  check("keys that are not keys are refused", (await requestSummary("r:not-a-uuid")) === null && (await requestSummary(`run:${crypto.randomUUID()}`)) === null);
});

await runInOrganization(b!.id, async () => {
  const none = await Promise.all([requestKey, runKey, campaignKey, `job:${seeded.search.id}`].map((key) => requestSummary(key)));
  check("another organization gets nothing for any of the first one's keys", none.every((summary) => summary === null));
  const listed = await listRequests();
  check("…lists none of its work", !listed.requests.some((row) => [requestKey, runKey].includes(row.key)) && !listed.manualCampaigns.some((row) => row.key === campaignKey));
  check("…and nothing for its chat", (await threadRequests(seeded.thread.id)).length === 0);
});
const [runAfter] = await db.select().from(outreachRuns).where(eq(outreachRuns.id, seeded.plan.id));
check("reading changed nothing the checks did not do themselves", runAfter?.status === "stopped");

if (failures) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("Request workspace checks passed");
process.exit(0);

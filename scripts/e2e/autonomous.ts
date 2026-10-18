/**
 * Autonomous mode (src/lib/assistant/autonomy*.ts), end to end against the
 * local database: a chat's switch, plans starting on their own through the
 * same claim and launch job the Start button uses, in the name of the owner
 * who turned it on, and every cap that makes a plan wait for the owner
 * instead: plans a day, leads a day, an approver who is no longer an owner
 * or admin, and the daily search count.
 *
 * Overlaps (src/lib/assistant/overlap*.ts): a 45-lead LinkedIn plan with 2
 * people already in another running plan starts the other 43 on its own;
 * two plans sharing people started at once never both enrol one person; a
 * plan whose every lead is covered is closed with an honest "no new leads"
 * event, not offered for Start; the leads-a-day cap counts only who is
 * left, and a capped plan waits already narrowed; a request approval
 * leaves overlaps out the same way; and a launch job reclaimed after its
 * worker died launches the 43, never the 2.
 *
 * Durable reports (worker.ts, register.server.ts): a job whose report was
 * lost when the listener died is reported exactly once by the worker's
 * reconciliation, never twice on duplicate callbacks; reports before the
 * report key existed are not replayed. And reports scoped to one request
 * exclude other runs' work, counting reply decisions apart from plans
 * waiting for Start.
 *
 * Nothing is sent: the one launch it runs activates a LinkedIn campaign on
 * a fake Unipile connection no engine runs against, paused again at the end.
 *
 *   bun run --conditions=react-server scripts/e2e/autonomous.ts
 *
 * Creates its own organizations ("Autonomous check …", "Overlap check …")
 * and leaves them behind. Refuses a non-local DATABASE_URL.
 */
import { and, count, eq, inArray, sql } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}

const stamp = Date.now();
const { db } = await import("@/lib/db");
const { organizations, users, members } = await import("@/lib/auth/schema");
const { people } = await import("@/lib/leads/schema");
const { mailboxes } = await import("@/lib/outreach/schema");
const { gridProviderCredentials, gridProviders } = await import("@/lib/grid/schema");
const { encryptIntegrationCredentials } = await import("@/lib/integrations/credentials");
const schema = await import("@/lib/assistant/schema");
const { runInOrganization, currentOrganizationId } = await import("@/lib/tenancy/scope");
const { channelRules, saveChannelRules } = await import("@/lib/channels/rules.server");
const { createThread, listMessages } = await import("@/lib/assistant/threads.server");
const { createAudience } = await import("@/lib/assistant/audiences.server");
const { autonomousSearchesToday, autoStartPlan, setThreadAutonomous, userMayAutomate } = await import("@/lib/assistant/autonomy.server");
const { searchCapProblem } = await import("@/lib/assistant/autonomy");
const { startOutreachRun } = await import("@/lib/assistant/outreach.server");
const { applyRequestApproval, recordRequestApproval } = await import("@/lib/assistant/requestApproval.server");
const { claimJobReport, onAssistantJobFinished, reconcileAssistantJobReports, registerAssistantJobHandler, runOneAssistantStep } = await import("@/lib/assistant/worker");
const { registerAssistantJobs, reportFinishedJob } = await import("@/lib/assistant/register.server");
const { requestScope, results } = await import("@/lib/assistant/results.server");
const { runTool } = await import("@/lib/assistant/tools.server");
const linkedin = await import("@/lib/linkedin/schema");
type OutreachPlan = import("@/lib/assistant/schema").OutreachPlan;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const [org] = await db.insert(organizations).values({ name: `Autonomous check ${stamp}`, slug: `autonomous-check-${stamp}` }).returning();
const [owner] = await db.insert(users).values({ name: "Owner Check", email: `owner-${stamp}@autonomous-check.test`, emailVerified: true }).returning();
const [member] = await db.insert(users).values({ name: "Member Check", email: `member-${stamp}@autonomous-check.test`, emailVerified: true }).returning();
await db.insert(members).values([
  { organizationId: org!.id, userId: owner!.id, role: "owner" },
  { organizationId: org!.id, userId: member!.id, role: "member" },
]);
console.log(`Organization ${org!.name} (${org!.id})`);

await runInOrganization(org!.id, async () => {
  const orgId = currentOrganizationId();
  // Email can be started: a (fake) Unipile connection and a connected mailbox. Nothing here sends.
  const [unipile] = await db.insert(gridProviders).values({ organizationId: orgId, key: "platform-unipile", name: "Unipile (autonomous check)" }).returning();
  await db.insert(gridProviderCredentials).values({ providerId: unipile!.id, encryptedPayload: encryptIntegrationCredentials({ baseUrl: "https://unipile-autonomous-check.invalid", apiKey: "autonomous-check", notifySecret: "autonomous-check" }) });
  await db.insert(mailboxes).values({ organizationId: orgId, emailAddress: `owner-${stamp}@mail.autonomous-check.test`, provider: "unipile", unipileAccountId: `autonomous-${stamp}`, displayName: "Owner", status: "connected" });

  const persons = await db.insert(people).values(Array.from({ length: 30 }, (_, index) => ({
    organizationId: orgId,
    email: `lead${index + 1}-${stamp}@clinic-autonomous.test`,
    fullName: `Dr Autonomous ${index + 1}`,
    source: "autonomous-check",
  }))).returning({ id: people.id });
  const P = persons.map((person) => person.id);
  const audienceId = await createAudience({ name: "autonomous check", source: "list" });
  const thread = await createThread(owner!.id);

  const basePlan = (personIds: string[]): OutreachPlan => ({
    assignments: personIds.map((personId) => ({ personId, channel: "email" as const })),
    sequences: { email: [{ subject: "Hello {{company}}", body: "Hi {{company}} team,\nA short question.\n– Owner", waitDays: 0 }] },
    personalizationKey: "p_00000000",
    samples: [],
    limits: { maxLeads: 100, emailPerMailboxPerDay: 30, whatsappNewChatsPerDay: null },
    excluded: [],
    estimate: { aiCalls: 0, aiCostUsd: null, days: 1 },
    autopilot: false,
    instructions: null,
  });
  let n = 0;
  /** A plan the assistant prepared; `requestedBy` wrote the message that asked for it (the owner by default). */
  async function proposed(personIds: string[], requestedBy: string = owner!.id) {
    const [request] = await db.insert(schema.assistantMessages).values({ organizationId: orgId, threadId: thread.id, role: "user", content: "Find clinics and contact them", createdBy: requestedBy }).returning();
    const [run] = await db.insert(schema.outreachRuns).values({
      organizationId: orgId, threadId: thread.id, audienceId, name: `Plan ${(n += 1)}`, status: "proposed", channels: ["email"], plan: { ...basePlan(personIds), requestId: request!.id }, autopilot: false, createdBy: requestedBy,
    }).returning();
    return run!;
  }
  const runRow = async (id: string) => (await db.select().from(schema.outreachRuns).where(eq(schema.outreachRuns.id, id)))[0]!;
  const lastEvent = async () => (await listMessages(thread.id, 200)).filter((message) => message.role === "event").at(-1)?.content ?? "";

  // ------------------------------------------------------------ off: nothing starts
  const first = await proposed(P.slice(0, 5));
  const off = await autoStartPlan(thread.id, first.id);
  check("with Autonomous off a plan waits for the Start button", !off.started && off.reason === null && (await runRow(first.id)).status === "proposed");

  // ------------------------------------------------------------ on: starts in the owner's name, Automatic replies
  check("an owner may turn it on; a member may not approve", await userMayAutomate(owner!.id) && !(await userMayAutomate(member!.id)));
  await setThreadAutonomous(thread.id, true, owner!.id);
  const started = await autoStartPlan(thread.id, first.id);
  const firstRun = await runRow(first.id);
  check("with Autonomous on a prepared plan starts on its own, approved by the owner, Automatic replies",
    started.started && firstRun.status === "starting" && firstRun.approvedBy === owner!.id && firstRun.autopilot && firstRun.plan.autonomous === true,
    `${firstRun.status} approvedBy=${firstRun.approvedBy === owner!.id} autopilot=${firstRun.autopilot}`);
  check("the chat says it started and how to stop it", /started on its own/.test(await lastEvent()) && /Pause or stop/.test(await lastEvent()));
  const [launch] = await db.select({ n: count() }).from(schema.assistantJobs).where(and(eq(schema.assistantJobs.organizationId, orgId), eq(schema.assistantJobs.runId, first.id), eq(schema.assistantJobs.kind, "outreach_start")));
  check("it goes through the same launch job as the Start button", Number(launch?.n) === 1);
  const again = await autoStartPlan(thread.id, first.id);
  check("a plan already started is not started twice", !again.started);

  // ------------------------------------------------------------ leads already in another running plan
  const overlap = await proposed(P.slice(3, 8));
  const busy = await autoStartPlan(thread.id, overlap.id);
  const overlapRun = await runRow(overlap.id);
  check("a plan with 2 of its 5 leads already in a running plan starts with the other 3",
    busy.started && busy.leads === 3 && busy.leftOut === 2 && overlapRun.status === "starting" && overlapRun.plan.assignments.map((a) => a.personId).join() === P.slice(5, 8).join(),
    JSON.stringify(busy));
  check("…and the chat says who was left out, and that they stay where they are", /3 leads/.test(await lastEvent()) && /2 leads are already in other running plans and stay there/.test(await lastEvent()), await lastEvent());

  // ------------------------------------------------------------ the daily caps
  await saveChannelRules("general", { autonomousRunsPerDay: 3, autonomousLeadsPerDay: 15 }, null);
  const second = await proposed(P.slice(10, 15));
  check("within the caps a third plan starts", (await autoStartPlan(thread.id, second.id)).started);
  const third = await proposed(P.slice(15, 17));
  const capped = await autoStartPlan(thread.id, third.id);
  check("past the plans-a-day cap a plan waits", !capped.started && /cap is 3/.test(capped.reason ?? "") && (await runRow(third.id)).status === "proposed", capped.reason ?? "");
  await saveChannelRules("general", { autonomousRunsPerDay: 10, autonomousLeadsPerDay: 15 }, null);
  const big = await proposed(P.slice(17, 20));
  const leadsCapped = await autoStartPlan(thread.id, big.id);
  check("past the leads-a-day cap a plan waits (13 started so far)", !leadsCapped.started && /cap of 15 leads/.test(leadsCapped.reason ?? ""), leadsCapped.reason ?? "");
  const [marked] = await db.select({ n: count() }).from(schema.outreachRuns)
    .where(and(eq(schema.outreachRuns.organizationId, orgId), eq(schema.outreachRuns.status, "proposed"), eq(schema.outreachRuns.id, big.id)));
  check("a plan that waits is not counted toward the caps", Number(marked?.n) === 1 && (await runRow(big.id)).plan.autonomous !== true);

  // ------------------------------------------------------------ the approver lost the role
  await saveChannelRules("general", { autonomousRunsPerDay: 10, autonomousLeadsPerDay: 300 }, null);
  await setThreadAutonomous(thread.id, true, member!.id);
  const demoted = await autoStartPlan(thread.id, big.id);
  check("in the name of someone who is not an owner or admin nothing starts", !demoted.started && /only an owner or admin/.test(demoted.reason ?? ""), demoted.reason ?? "");
  await setThreadAutonomous(thread.id, true, owner!.id);
  check("once an owner turns it on again it starts", (await autoStartPlan(thread.id, big.id)).started);

  // ------------------------------------------------------------ a member asking in an owner's autonomous chat
  const memberAsked = await proposed(P.slice(20, 22), member!.id);
  const memberOutcome = await autoStartPlan(thread.id, memberAsked.id);
  check("a member's request in an owner's Autonomous chat does not start a plan in the owner's name", !memberOutcome.started && /only an owner or admin/.test(memberOutcome.reason ?? "") && (await runRow(memberAsked.id)).status === "proposed", memberOutcome.reason ?? "");

  // ------------------------------------------------------------ searches a day
  await saveChannelRules("general", { autonomousSearchesPerDay: 2 }, null);
  await db.insert(schema.assistantJobs).values([0, 1].map(() => ({ organizationId: orgId, kind: "discovery" as const, stage: "searching", threadId: thread.id, audienceId, payload: {}, progress: {} })));
  const searches = await autonomousSearchesToday();
  check("searches started from an Autonomous chat are counted and capped", searches === 2 && Boolean(searchCapProblem(searches, { runsPerDay: 10, leadsPerDay: 300, searchesPerDay: 2 })), `${searches}`);

  // ------------------------------------------------------------ off again
  await setThreadAutonomous(thread.id, false, member!.id);
  const after = await proposed(P.slice(25, 27));
  check("turned off, plans wait for the Start button again", !(await autoStartPlan(thread.id, after.id)).started && (await runRow(after.id)).status === "proposed");
});

// ==================================================================== overlaps, restarts, durable and scoped reports
const [org2] = await db.insert(organizations).values({ name: `Overlap check ${stamp}`, slug: `overlap-check-${stamp}` }).returning();
const [owner2] = await db.insert(users).values({ name: "Owner Overlap", email: `owner-${stamp}@overlap-check.test`, emailVerified: true }).returning();
await db.insert(members).values({ organizationId: org2!.id, userId: owner2!.id, role: "owner" });
console.log(`\nOrganization ${org2!.name} (${org2!.id})`);

await runInOrganization(org2!.id, async () => {
  const orgId = currentOrganizationId();
  const { crmPersonContactPolicies } = await import("@/lib/crm/schema");
  // LinkedIn and email can be started: a (fake) Unipile connection, a LinkedIn account and a mailbox.
  const [unipile] = await db.insert(gridProviders).values({ organizationId: orgId, key: "platform-unipile", name: "Unipile (overlap check)" }).returning();
  await db.insert(gridProviderCredentials).values({ providerId: unipile!.id, encryptedPayload: encryptIntegrationCredentials({ baseUrl: "https://unipile-overlap-check.invalid", apiKey: "overlap-check", notifySecret: "overlap-check" }) });
  const [mailbox] = await db.insert(mailboxes).values({ organizationId: orgId, emailAddress: `owner-${stamp}@mail.overlap-check.test`, provider: "unipile", unipileAccountId: `overlap-${stamp}`, displayName: "Owner", status: "connected" }).returning();
  const [account] = await db.insert(linkedin.linkedInAccounts).values({ organizationId: orgId, linkedinId: `overlap-${stamp}`, username: `overlap-${stamp}`, name: "Owner", status: "CONNECTED", updatedAt: new Date() }).returning();
  await saveChannelRules("general", { autonomousRunsPerDay: 50, autonomousLeadsPerDay: 1000 }, null);

  const L = (await db.insert(people).values(Array.from({ length: 100 }, (_, index) => ({
    organizationId: orgId,
    email: `lead${index}-${stamp}@overlap-check.test`,
    linkedinUrl: `overlap-${stamp}-${index}`,
    firstName: `Lead${index}`,
    fullName: `Lead ${index} Overlap`,
    source: "overlap-check",
  }))).returning({ id: people.id })).map((row) => row.id);
  const audienceId = await createAudience({ name: "overlap check", source: "list" });
  const thread = await createThread(owner2!.id);
  await setThreadAutonomous(thread.id, true, owner2!.id);

  const steps = [{ subject: null, body: "Hi {{firstName}}, a short question about your clinic.", waitDays: 0 }];
  /** A sorted LinkedIn plan as prepareOutreach writes it: one group, a sample per lead for the first three, the second written to alone. */
  const linkedinPlan = (personIds: string[], requestId: string): OutreachPlan => ({
    assignments: personIds.map((personId) => ({ personId, channel: "linkedin" as const })),
    sequences: { linkedin: steps },
    personalizationKey: "p_overlap0",
    samples: personIds.slice(0, 3).map((personId, index) => ({ personId, name: `Lead ${index}`, channel: "linkedin" as const, groupId: "g1", approach: index === 1 ? "personal" as const : "standard" as const, messages: [{ subject: null, body: "Hi" }] })),
    limits: { maxLeads: 100, emailPerMailboxPerDay: null, whatsappNewChatsPerDay: null },
    excluded: [],
    estimate: { aiCalls: Math.ceil(Math.max(0, personIds.length - 1) / 10), aiCostUsd: 0.05, days: 3, perCallUsd: 0.002 },
    autopilot: true,
    instructions: null,
    ownerRequest: "Find clinics on LinkedIn and contact them",
    requestId,
    groups: [{ id: "g1", label: "Clinics", count: personIds.length, sequences: { linkedin: steps } }],
    leadPlans: Object.fromEntries(personIds.map((personId, index) => [personId, { groupId: "g1", approach: index === 1 ? "personal" as const : "standard" as const, reason: "" }])),
    personal: personIds[1] ? [{ personId: personIds[1], name: "Lead 1", channel: "linkedin" as const, groupId: "g1", subject: null, body: "Just for you", reason: "posted about it" }] : [],
    skipped: [],
  });
  let k = 0;
  /** A plan the assistant prepared in `threadId` for a request (a new owner message unless `requestId` is given). */
  async function propose(personIds: string[], options: { threadId?: string; requestId?: string } = {}) {
    const threadId = options.threadId ?? thread.id;
    const requestId = options.requestId ?? (await db.insert(schema.assistantMessages).values({ organizationId: orgId, threadId, role: "user", content: "Find clinics on LinkedIn and contact them", createdBy: owner2!.id }).returning())[0]!.id;
    const [run] = await db.insert(schema.outreachRuns).values({
      organizationId: orgId, threadId, audienceId, name: `Overlap plan ${(k += 1)}`, status: "proposed", channels: ["linkedin"], plan: linkedinPlan(personIds, requestId), autopilot: false, createdBy: owner2!.id,
    }).returning();
    return run!;
  }
  const runRow = async (id: string) => (await db.select().from(schema.outreachRuns).where(eq(schema.outreachRuns.id, id)))[0]!;
  const leadsOf = async (runId: string) => (await db.select({ personId: schema.outreachRunLeads.personId }).from(schema.outreachRunLeads).where(eq(schema.outreachRunLeads.runId, runId))).map((row) => row.personId);
  const jobsOf = async (runId: string) => db.select().from(schema.assistantJobs).where(and(eq(schema.assistantJobs.runId, runId), eq(schema.assistantJobs.kind, "outreach_start")));
  const events = async (threadId = thread.id) => (await listMessages(threadId, 300)).filter((message) => message.role === "event");
  const lastEvent = async (threadId = thread.id) => (await events(threadId)).at(-1)?.content ?? "";
  /** A plan the owner started by hand, now running, whose launch job never runs here. */
  async function runningPlan(personIds: string[]) {
    const run = await propose(personIds, { threadId: (await createThread(owner2!.id)).id });
    await startOutreachRun(run.id, owner2!.id, { autopilot: false });
    await db.update(schema.outreachRuns).set({ status: "running" }).where(eq(schema.outreachRuns.id, run.id));
    await db.update(schema.assistantJobs).set({ status: "cancelled", finishedAt: new Date() }).where(eq(schema.assistantJobs.runId, run.id));
    return run;
  }

  // ------------------------------------------------------------ 45 → 43
  const existing = await runningPlan(L.slice(0, 2));
  const fortyFive = await propose(L.slice(0, 45));
  const a = await autoStartPlan(thread.id, fortyFive.id);
  const r1 = await runRow(fortyFive.id);
  const kept = r1.plan.assignments.map((assignment) => assignment.personId);
  check("45 → 43: a 45-lead LinkedIn plan with 2 already covered starts on its own with the other 43",
    a.started && a.leads === 43 && a.leftOut === 2 && r1.status === "starting" && kept.length === 43 && !kept.includes(L[0]!) && !kept.includes(L[1]!) && r1.approvedBy === owner2!.id && r1.autopilot && r1.plan.autonomous === true,
    JSON.stringify(a));
  check("45 → 43: counts, groups, samples, single-lead messages and estimate follow the 43",
    r1.plan.groups?.[0]?.count === 43 && !r1.plan.samples.some((sample) => sample.personId === L[0] || sample.personId === L[1]) && (r1.plan.personal ?? []).length === 0
      && r1.plan.leadPlans?.[L[0]!] === undefined && r1.plan.excluded.some((item) => item.reason === "already in another running plan" && item.count === 2)
      && r1.plan.estimate.aiCalls === 5 && r1.plan.estimate.days === Math.ceil(43 / Number((await channelRules("linkedin")).invitesPerDayFree ?? 20)) && r1.channels.join() === "linkedin",
    JSON.stringify({ groups: r1.plan.groups, excluded: r1.plan.excluded, estimate: r1.plan.estimate }));
  const r1Leads = await leadsOf(fortyFive.id);
  check("45 → 43: 43 enrolled, neither of the 2", r1Leads.length === 43 && !r1Leads.includes(L[0]!) && !r1Leads.includes(L[1]!), `${r1Leads.length}`);
  const twoRows = await db.select({ runId: schema.outreachRunLeads.runId }).from(schema.outreachRunLeads).where(inArray(schema.outreachRunLeads.personId, [L[0]!, L[1]!]));
  check("45 → 43: the 2 stay only in the plan that already had them", twoRows.length === 2 && twoRows.every((row) => row.runId === existing.id));
  const [launchJob] = await jobsOf(fortyFive.id);
  check("45 → 43: its launch job is for 43", (launchJob?.progress as { total?: number } | undefined)?.total === 43);
  const started45 = await lastEvent();
  check("45 → 43: the chat says it started with 43 and why 2 were left out, and asks for no Start",
    /started on its own/.test(started45) && /43 leads/.test(started45) && /2 leads are already in other running plans and stay there/.test(started45) && !(await events()).some((event) => /press Start/.test(event.content)), started45);

  // ------------------------------------------------------------ two plans sharing people, started at once
  const left = await propose(L.slice(50, 60));
  const right = await propose(L.slice(55, 65));
  const [lo, ro] = await Promise.all([autoStartPlan(thread.id, left.id), autoStartPlan(thread.id, right.id)]);
  const shared = await db.select({ personId: schema.outreachRunLeads.personId, runId: schema.outreachRunLeads.runId }).from(schema.outreachRunLeads)
    .where(and(inArray(schema.outreachRunLeads.personId, L.slice(55, 60)), eq(schema.outreachRunLeads.status, "active")));
  check("concurrent starts: both plans start", lo.started && ro.started, JSON.stringify([lo, ro]));
  check("concurrent starts: each of the 5 shared people is enrolled once, in one plan", shared.length === 5 && new Set(shared.map((row) => row.personId)).size === 5, `${shared.length} rows`);
  check("concurrent starts: one plan took them, the other left them out", (lo.leftOut === 5) !== (ro.leftOut === 5) && (lo.leads ?? 0) + (ro.leads ?? 0) === 15, `${lo.leads}+${ro.leads}`);

  // ------------------------------------------------------------ everyone already covered
  const allCovered = await propose(L.slice(50, 55));
  const c = await autoStartPlan(thread.id, allCovered.id);
  const r4 = await runRow(allCovered.id);
  check("all-overlap: nothing starts, and the plan is closed with the reason", !c.started && c.closed === true && r4.status === "cancelled" && /^No new leads to contact: all 5 are already in other running plans/.test(r4.error ?? ""), `${r4.status} ${r4.error}`);
  const closedEvent = await lastEvent();
  check("all-overlap: the chat says so honestly, without asking for a Start", /no new leads to contact: all 5 are already in other running plans/.test(closedEvent) && !/press Start/.test(closedEvent), closedEvent);
  check("all-overlap: no one enrolled and no launch job", (await leadsOf(allCovered.id)).length === 0 && (await jobsOf(allCovered.id)).length === 0);

  // ------------------------------------------------------------ Do Not Contact rechecked at the start
  await db.insert(crmPersonContactPolicies).values({ personId: L[66]!, doNotContact: true, reason: "asked not to be contacted", source: "human", setAt: new Date() });
  const withDnc = await propose(L.slice(65, 69));
  const dnc = await autoStartPlan(thread.id, withDnc.id);
  check("Do Not Contact is checked again at the start: the 3 others start, the DNC person is left out", dnc.started && dnc.leads === 3 && !(await leadsOf(withDnc.id)).includes(L[66]!) && /1 marked Do Not Contact/.test(await lastEvent()), await lastEvent());

  // ------------------------------------------------------------ the daily caps count who is left
  // 61 leads started on their own so far (43 + 10 + 5 + 3); one more person is covered by a plan the owner started.
  await runningPlan([L[70]!]);
  await saveChannelRules("general", { autonomousLeadsPerDay: 70 }, null);
  const fits = await propose(L.slice(70, 80));
  const d1 = await autoStartPlan(thread.id, fits.id);
  check("caps: 10 leads with 1 covered count as 9, which fit a cap 9 above today's 61", d1.started && d1.leads === 9, JSON.stringify(d1));
  const over = await propose([...L.slice(80, 85), L[0]!]);
  const d2 = await autoStartPlan(thread.id, over.id);
  const r6 = await runRow(over.id);
  check("exhausted caps: the plan waits for Start and is not counted", !d2.started && /cap of 70 leads/.test(d2.reason ?? "") && r6.status === "proposed" && r6.plan.autonomous !== true && (await jobsOf(over.id)).length === 0, d2.reason ?? "");
  check("exhausted caps: it waits already without the covered person, and the chat says both", r6.plan.assignments.length === 5 && !r6.plan.assignments.some((assignment) => assignment.personId === L[0]) && /cap of 70 leads/.test(await lastEvent()) && /1 lead is already in another running plan/.test(await lastEvent()), await lastEvent());
  await saveChannelRules("general", { autonomousLeadsPerDay: 1000 }, null);
  const d3 = await autoStartPlan(thread.id, over.id);
  const overLeads = await leadsOf(over.id);
  check("once the cap allows, it starts with the 5, never the covered person", d3.started && overLeads.length === 5 && !overLeads.includes(L[0]!), JSON.stringify(d3));

  // ------------------------------------------------------------ a request approval leaves overlaps out the same way
  const approvalThread = await createThread(owner2!.id);
  const [ask] = await db.insert(schema.assistantMessages).values({ organizationId: orgId, threadId: approvalThread.id, role: "user", content: "Find clinics in Pune and Mumbai on LinkedIn and contact them", createdBy: owner2!.id }).returning();
  const approved = await propose(L.slice(95, 97), { threadId: approvalThread.id, requestId: ask!.id });
  const sibling = await propose([...L.slice(97, 100), L[2]!], { threadId: approvalThread.id, requestId: ask!.id });
  await startOutreachRun(approved.id, owner2!.id, { autopilot: true });
  const applied = await recordRequestApproval(approved.id, { autopilot: true, approvedBy: owner2!.id });
  const siblingLeads = await leadsOf(sibling.id);
  check("request approval: the request's other plan starts with the 3 not already covered", applied.started.some((item) => item.runId === sibling.id) && siblingLeads.length === 3 && !siblingLeads.includes(L[2]!), JSON.stringify(applied));
  check("…and the plan records which approval started it, for its card", (await runRow(sibling.id)).plan.startedUnder === approved.id && !(await runRow(approved.id)).plan.startedUnder);
  check("…and the chat says it started under the approval, with who was left out", /started on its own under your approval of this request: 3 leads/.test(await lastEvent(approvalThread.id)) && /1 lead is already in another running plan/.test(await lastEvent(approvalThread.id)), await lastEvent(approvalThread.id));
  const later = await propose([L[95]!], { threadId: approvalThread.id, requestId: ask!.id });
  const laterOutcome = await applyRequestApproval(later.id);
  check("request approval: a later plan whose only lead is covered is closed, not offered for Start", !laterOutcome.started && laterOutcome.closed === true && (await runRow(later.id)).status === "cancelled" && /no new leads to contact/.test(await lastEvent(approvalThread.id)), JSON.stringify(laterOutcome));

  // ------------------------------------------------------------ a worker restart during the launch
  // The 45-lead plan's launch job was being worked on when its worker died: claimed, heartbeat long gone.
  await db.update(schema.assistantJobs).set({
    status: "running", stage: "launching", lockedBy: "assistant-worker-that-died", heartbeatAt: new Date(Date.now() - 10 * 60_000),
    runAfter: new Date("2000-01-01T00:00:00Z"), progress: { stage: "launching", personalized: 43, total: 43 },
  }).where(eq(schema.assistantJobs.id, launchJob!.id));
  registerAssistantJobs();
  await runOneAssistantStep();
  const [relaunched] = await db.select().from(schema.assistantJobs).where(eq(schema.assistantJobs.id, launchJob!.id));
  const r1After = await runRow(fortyFive.id);
  const campaignId = r1After.campaigns.linkedin;
  const campaignLeads = campaignId ? await db.select({ personId: linkedin.leads.personId, id: linkedin.leads.id }).from(linkedin.leads).where(eq(linkedin.leads.campaignId, campaignId)) : [];
  check("restart: another worker takes the launch over and launches the 43, never the 2",
    relaunched?.status === "succeeded" && r1After.status === "running" && campaignLeads.length === 43 && !campaignLeads.some((lead) => lead.personId === L[0] || lead.personId === L[1]),
    `${relaunched?.status} ${r1After.status} ${campaignLeads.length} ${relaunched?.error ?? ""}`);
  const launchReports = (await events()).filter((event) => /Outreach started\. linkedin: started with 43 leads/.test(event.content));
  check("restart: the launch is reported once, under its report key", launchReports.length === 1 && relaunched?.reportKey === `assistant_job:${launchJob!.id}:succeeded` && relaunched?.reportedAt instanceof Date && (launchReports[0]!.toolResult as { reportKey?: string } | null)?.reportKey === relaunched?.reportKey, `${launchReports.length}`);

  // ------------------------------------------------------------ durable reports
  const quiet = await createThread(owner2!.id);
  const quietEvents = async () => events(quiet.id);
  registerAssistantJobHandler("web_discovery", async () => ({ next: "done", result: { found: 0, note: "Durable report check: the search found nothing." } }));
  onAssistantJobFinished(async () => {
    throw new Error("simulated: the process stopped before the report was posted");
  });
  const [lost] = await db.insert(schema.assistantJobs).values({ organizationId: orgId, kind: "web_discovery", stage: "searching", threadId: quiet.id, payload: {}, progress: {}, runAfter: new Date("2000-01-02T00:00:00Z") }).returning();
  await runOneAssistantStep();
  const jobRow = async (id: string) => (await db.select().from(schema.assistantJobs).where(eq(schema.assistantJobs.id, id)))[0]!;
  const crashed = await jobRow(lost!.id);
  check("durable report: the job finished with its report key, but the listener died before posting", crashed.status === "succeeded" && crashed.reportKey === `assistant_job:${lost!.id}:succeeded` && crashed.reportedAt === null && (await quietEvents()).length === 0);
  onAssistantJobFinished(reportFinishedJob);
  const handed = await reconcileAssistantJobReports(0);
  const reported = await jobRow(lost!.id);
  let quietNow = await quietEvents();
  check("durable report: the worker's reconciliation posts it, exactly once", handed >= 1 && quietNow.length === 1 && /Durable report check/.test(quietNow[0]!.content) && reported.reportedAt instanceof Date && (quietNow[0]!.toolResult as { reportKey?: string } | null)?.reportKey === reported.reportKey, `${handed} handed, ${quietNow.length} events`);
  await reconcileAssistantJobReports(0);
  await reportFinishedJob(reported);
  quietNow = await quietEvents();
  check("durable report: reconciling again and a duplicate callback post nothing more", quietNow.length === 1);
  const [twin] = await db.insert(schema.assistantJobs).values({ organizationId: orgId, kind: "web_discovery", status: "succeeded", stage: "done", threadId: quiet.id, payload: {}, progress: {}, result: { found: 0, note: "Twin report check." }, finishedAt: new Date(Date.now() - 1_000), reportKey: `assistant_job:twin-${stamp}:succeeded` }).returning();
  await Promise.all([reportFinishedJob(twin!), reportFinishedJob(twin!), reconcileAssistantJobReports(0)]);
  check("durable report: callbacks at the same moment post one report", (await quietEvents()).filter((event) => /Twin report check/.test(event.content)).length === 1);
  const claimedTwice = await claimJobReport(twin!, async () => undefined);
  check("durable report: a reported job cannot be claimed again", claimedTwice === false);
  await db.insert(schema.assistantJobs).values([
    { organizationId: orgId, kind: "web_discovery", status: "succeeded", stage: "done", threadId: quiet.id, payload: {}, progress: {}, result: { found: 0, note: "Legacy report check." }, finishedAt: new Date(Date.now() - 60 * 60_000) },
    { organizationId: orgId, kind: "web_discovery", status: "failed", stage: "searching", threadId: quiet.id, payload: {}, progress: {}, error: "Stale report check.", finishedAt: new Date(Date.now() - 25 * 60 * 60_000), reportKey: `assistant_job:stale-${stamp}:failed` },
  ]);
  await reconcileAssistantJobReports(0);
  check("durable report: jobs finished before report keys existed, or more than a day ago, are not replayed", !(await quietEvents()).some((event) => /Legacy report check|Stale report check/.test(event.content)));

  // ------------------------------------------------------------ reports scoped to one request
  const [firstLead] = campaignLeads;
  await db.insert(linkedin.messages).values({ organizationId: orgId, type: "INVITATION", text: "Hi", linkedinMessageId: `invitation-${stamp}`, leadId: firstLead!.id });
  await db.insert(schema.ownerDecisions).values([
    { organizationId: orgId, kind: "missing_info", reason: "Asked for the price", decision: "What does it cost?", runId: fortyFive.id },
    { organizationId: orgId, kind: "missing_info", reason: "Asked for the address", decision: "Where are you?", runId: left.id },
  ]);
  const waitingPlan = await propose(L.slice(86, 88));
  const scope45 = await requestScope(r1.plan.requestId!);
  const [scoped45, scopedLeft, scopedWaiting, whole] = await Promise.all([
    results("today", new Date(), scope45),
    results("today", new Date(), await requestScope(left.plan.requestId!)),
    results("today", new Date(), await requestScope(waitingPlan.plan.requestId!)),
    results("today"),
  ]);
  check("scoped report: a request's report covers its own plan only", scope45.runIds.join() === fortyFive.id && scoped45.runs.map((run) => run.id).join() === fortyFive.id && whole.runs.length > 1, `${scoped45.runs.length} vs ${whole.runs.length}`);
  check("scoped report: its LinkedIn invitation and its reply decision, not the other request's", scoped45.outreach.linkedinInvitations === 1 && scoped45.attention.openDecisions === 1 && scopedLeft.outreach.linkedinInvitations === 0 && scopedLeft.attention.openDecisions === 1 && whole.attention.openDecisions === 2);
  check("scoped report: plans waiting for Start are counted apart from reply decisions", scopedWaiting.attention.plansAwaitingStart === 1 && scopedWaiting.attention.openDecisions === 0 && scoped45.attention.plansAwaitingStart === 0 && whole.attention.plansAwaitingStart >= 1);
  const context = { threadId: thread.id, userId: owner2!.id, ownerText: "how is it going today?", outreachRequestId: r1.plan.requestId!, requestMessageId: r1.plan.requestId! };
  const toolReport = await runTool("report", { period: "today" }, context);
  check("the report tool counts the request this turn serves by default, and says so", toolReport.ok && /this request \(1 plan/.test(toolReport.summary) && /1 LinkedIn connection requests/.test(toolReport.summary) && /1 reply decision\b/.test(toolReport.summary) && /0 plans waiting for your Start/.test(toolReport.summary), toolReport.summary.split("\n").slice(0, 7).join(" | "));
  const orgReport = await runTool("report", { period: "today", scope: "organization" }, context);
  check("asked for the whole organization, it counts every request", orgReport.ok && !/ only:/.test(orgReport.summary.split("\n")[0]!) && /2 reply decisions/.test(orgReport.summary) && /plans? waiting for your Start \(/.test(orgReport.summary), orgReport.summary.split("\n").slice(0, 7).join(" | "));

  // Nothing left that could send.
  await db.update(linkedin.campaigns).set({ status: "PAUSED", updatedAt: new Date() }).where(eq(linkedin.campaigns.organizationId, orgId));
  await db.update(linkedin.linkedInAccounts).set({ status: "DISCONNECTED", updatedAt: new Date() }).where(eq(linkedin.linkedInAccounts.id, account!.id));
  await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, mailbox!.id));
  await db.execute(sql`update assistant_jobs set status = 'cancelled', finished_at = now() where organization_id = ${orgId} and status in ('queued', 'running')`);
});

console.log(failures ? `\n${failures} check(s) failed` : "\nAll autonomous mode checks passed");
process.exit(failures ? 1 : 0);

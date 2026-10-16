/**
 * Autonomous mode (src/lib/assistant/autonomy*.ts), end to end against the
 * local database: a chat's switch, plans starting on their own through the
 * same startOutreachRun the Start button calls, in the name of the owner
 * who turned it on, and every cap that makes a plan wait for the owner
 * instead: plans a day, leads a day, leads already in another running plan,
 * an approver who is no longer an owner or admin, and the daily search
 * count. Nothing is sent: starting a plan only queues its launch job, which
 * this script never runs.
 *
 *   bun run --conditions=react-server scripts/e2e/autonomous.ts
 *
 * Creates its own organization ("Autonomous check …") and leaves it behind.
 * Refuses a non-local DATABASE_URL.
 */
import { and, count, eq } from "drizzle-orm";

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
const { saveChannelRules } = await import("@/lib/channels/rules.server");
const { createThread, listMessages } = await import("@/lib/assistant/threads.server");
const { createAudience } = await import("@/lib/assistant/audiences.server");
const { autonomousSearchesToday, autoStartPlan, setThreadAutonomous, userMayAutomate } = await import("@/lib/assistant/autonomy.server");
const { searchCapProblem } = await import("@/lib/assistant/autonomy");
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
  async function proposed(personIds: string[]) {
    const [run] = await db.insert(schema.outreachRuns).values({
      organizationId: orgId, threadId: thread.id, audienceId, name: `Plan ${(n += 1)}`, status: "proposed", channels: ["email"], plan: basePlan(personIds), autopilot: false,
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
  check("a plan whose leads are already in a running plan waits for the owner", !busy.started && /already in another running plan/.test(busy.reason ?? "") && (await runRow(overlap.id)).status === "proposed", busy.reason ?? "");
  check("…and the chat says why", /not started on its own/.test(await lastEvent()));

  // ------------------------------------------------------------ the daily caps
  await saveChannelRules("general", { autonomousRunsPerDay: 2, autonomousLeadsPerDay: 12 }, null);
  const second = await proposed(P.slice(10, 15));
  check("within the caps a second plan starts", (await autoStartPlan(thread.id, second.id)).started);
  const third = await proposed(P.slice(15, 17));
  const capped = await autoStartPlan(thread.id, third.id);
  check("past the plans-a-day cap a plan waits", !capped.started && /cap is 2/.test(capped.reason ?? "") && (await runRow(third.id)).status === "proposed", capped.reason ?? "");
  await saveChannelRules("general", { autonomousRunsPerDay: 10, autonomousLeadsPerDay: 12 }, null);
  const big = await proposed(P.slice(17, 20));
  const leadsCapped = await autoStartPlan(thread.id, big.id);
  check("past the leads-a-day cap a plan waits", !leadsCapped.started && /cap of 12 leads/.test(leadsCapped.reason ?? ""), leadsCapped.reason ?? "");
  const [marked] = await db.select({ n: count() }).from(schema.outreachRuns)
    .where(and(eq(schema.outreachRuns.organizationId, orgId), eq(schema.outreachRuns.status, "proposed"), eq(schema.outreachRuns.id, big.id)));
  check("a plan that waits is not counted toward the caps", Number(marked?.n) === 1 && (await runRow(big.id)).plan.autonomous !== true);

  // ------------------------------------------------------------ the approver lost the role
  await saveChannelRules("general", { autonomousRunsPerDay: 10, autonomousLeadsPerDay: 300 }, null);
  await setThreadAutonomous(thread.id, true, member!.id);
  const demoted = await autoStartPlan(thread.id, big.id);
  check("in the name of someone who is not an owner or admin nothing starts", !demoted.started && /owner or admin/.test(demoted.reason ?? ""), demoted.reason ?? "");
  await setThreadAutonomous(thread.id, true, owner!.id);
  check("once an owner turns it on again it starts", (await autoStartPlan(thread.id, big.id)).started);

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

console.log(failures ? `\n${failures} check(s) failed` : "\nAll autonomous mode checks passed");
process.exit(failures ? 1 : 0);

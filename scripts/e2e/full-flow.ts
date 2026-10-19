/**
 * One owner request from the chat prompt to the final report, end to end on
 * the local database with the real chat turn, tools, worker, discovery
 * stages, qualification, plan writer, Start, request approval and launch.
 * Stand-ins: the model (the structured-completion module answers by schema:
 * the chat's replies are scripted, the plan writer's are fixed), the Google
 * Maps scraper (global fetch is intercepted) and a Unipile connection that
 * nothing calls. Nothing leaves the machine and nothing is sent.
 *
 * - the owner asks for 10 dental clinics in Pune contacted on WhatsApp; the
 *   assistant searches and the request becomes an objective with that target;
 * - the search qualifies its leads (a phone, a WhatsApp route) and a plan
 *   is written for them from the owner's words, waiting for Start;
 * - short of the target, the request continues with no owner message: the
 *   assistant searches again, a second plan is written, the target is
 *   reached and one final report is posted (sources, leads, routes, spend,
 *   stop reason);
 * - the owner presses Start on the first plan and approves the rest of the
 *   request: the second plan starts under that approval;
 * - a launch worker dies after it created and recorded its campaign; the
 *   launch is taken over and enrolls everyone once, in that campaign;
 * - repeating every callback and the reconciliation adds no report, plan,
 *   campaign or enrollment; nothing was sent;
 * - a second organization sees and changes nothing of the first.
 *
 *   bun run --conditions=react-server scripts/e2e/full-flow.ts
 *
 * Creates its own organizations ("Full flow check A/B …") and leaves them.
 * Refuses a non-local DATABASE_URL.
 */
import { mock } from "bun:test";
import { join } from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}

const stamp = Date.now();
const SCRAPER = "http://scraper.full-flow-check.test";
process.env.GMAPS_SCRAPER_URL = SCRAPER;
process.env.GEOCODER_URL = "off";
process.env.DISCOVERY_DNS_CHECK = "off";

// ------------------------------------------------------------ the model, scripted by schema
const root = join(import.meta.dir, "..", "..");
type Input = { userPrompt: string; systemPrompt?: string; schemaName?: string; accept: (text: string) => void };
type Script = (input: Input) => string;
let replies: Script[] = [];
const modelCalls: string[] = [];
const FIRST = "Hi {{company}} team, {{line}} we help Pune clinics fill empty chair hours with patient reminders on WhatsApp. Would a short demo this week be useful?";
const SECOND = "Just checking whether reminders for missed appointments would help your front desk. Happy to share how other clinics set it up.";
/** Fixed answers for the plan writer, by what each lead index and channel it is asked about. */
function writerAnswer(input: Input): string {
  const indexes = [...input.userPrompt.matchAll(/^(\d+): \{/gm)].map((match) => Number(match[1]));
  switch (input.schemaName) {
    case "lead_sorting":
      return JSON.stringify({ leads: indexes.map((index) => ({ index, group: "Dental clinics", approach: "standard", reason: "A dental clinic in Pune, as the owner asked." })) });
    case "outreach_sequences": {
      // The per-lead line's merge field is named per plan; the prompt lists it.
      const key = `${input.systemPrompt ?? ""}\n${input.userPrompt}`.match(/\{\{(p_[0-9a-f]+)\}\}/)?.[1];
      return JSON.stringify({ channels: [{ channel: "whatsapp", messages: [{ subject: "", body: FIRST.replace("{{line}}", key ? `{{${key}}}` : ""), waitDays: 0 }, { subject: "", body: SECOND, waitDays: 3 }] }] });
    }
    case "first_message_review":
      return JSON.stringify({ messages: [{ channel: "whatsapp", wouldReply: 4, reasons: [] }] });
    case "opening_lines":
      return JSON.stringify({ lines: [...input.userPrompt.matchAll(/^(\d+)[:.]/gm)].map((match) => ({ index: Number(match[1]), line: "" })) });
    default:
      throw new Error(`unexpected writer call ${input.schemaName}`);
  }
}
mock.module(join(root, "src/lib/ai/server/structuredCompletion.ts"), () => ({
  completeStructured: async (input: Input) => {
    modelCalls.push(input.schemaName ?? "?");
    let text: string;
    if (input.schemaName === "assistant_reply") {
      const next = replies.shift();
      if (!next) throw new Error(`unexpected chat model call: ${input.userPrompt.slice(-300)}`);
      text = next(input);
    } else {
      text = writerAnswer(input);
    }
    input.accept(text);
    return { text, model: "fixture", provider: "fixture", request: {}, response: {}, usage: {}, attempts: 1 };
  },
}));
const reply = (message: string, actions: { tool: string; args: Record<string, unknown> }[] = []): Script => () =>
  JSON.stringify({ message, actions: actions.map((action) => ({ tool: action.tool, arguments: JSON.stringify(action.args) })), suggestions: [] });
const turn = (message: string, actions: { tool: string; args: Record<string, unknown> }[]) => [reply(message, actions), reply("")];

// ------------------------------------------------------------ the scraper, stood in: 6 clinics per search, each with a mobile number
const MAPS_HEADER = "input_id,link,title,category,address,website,phone,review_count,review_rating,place_id,cid,status,complete_address,emails";
const csv = (values: (string | number)[]) => values.map((value) => `"${String(value).replace(/"/g, "\"\"")}"`).join(",");
const scraper = { jobs: new Map<string, string>(), posts: [] as string[] };
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
let phoneSeq = 0;
function mapsCsv(phrase: string): string {
  const rows = Array.from({ length: 6 }, (_, index) => {
    phoneSeq += 1;
    const key = `${slug(phrase)}-${index + 1}`;
    const phone = `+91 98${String(stamp % 1_000_000).padStart(6, "0").slice(0, 3)}${String(phoneSeq).padStart(5, "0")}`;
    return csv(["1", `https://maps.google.com/?cid=${stamp}${index}${key.length}`, `${["Smile", "Pearl", "Bright", "Care", "Lotus", "Apex"][index]} Dental ${phrase.startsWith("dentists") ? "Studio" : "Clinic"}`, "Dental clinic", "Koregaon Park, Pune", "", phone, 20, 4.6, `pl-${stamp}-${key}`, `${stamp}${index}`, "", JSON.stringify({ city: "Pune", country: "IN" }), ""]);
  });
  return [MAPS_HEADER, ...rows].join("\n");
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.origin === SCRAPER) {
    if (method === "POST" && url.pathname === "/api/v1/jobs") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { keywords?: string[] };
      const phrase = (body.keywords ?? []).join(" ");
      const id = `scrape-${scraper.jobs.size + 1}-${stamp}`;
      scraper.jobs.set(id, phrase);
      scraper.posts.push(phrase);
      return json(201, { id });
    }
    const match = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)(\/download)?$/);
    const phrase = match ? scraper.jobs.get(match[1]!) : undefined;
    if (phrase === undefined) return json(404, { message: "job not found" });
    if (match![2]) return new Response(mapsCsv(phrase), { status: 200, headers: { "content-type": "text/csv" } });
    return json(200, { ID: match![1], Status: "ok" });
  }
  if (url.hostname.endsWith(".test") || url.hostname.endsWith(".invalid")) return new Response("not found", { status: 404 });
  return realFetch(input, init);
}) as typeof fetch;

// ------------------------------------------------------------ app modules
const { db } = await import("@/lib/db");
const { organizations, users, members } = await import("@/lib/auth/schema");
const { runInOrganization } = await import("@/lib/tenancy/scope");
const schema = await import("@/lib/assistant/schema");
const { gridProviderCredentials, gridProviders } = await import("@/lib/grid/schema");
const { encryptIntegrationCredentials } = await import("@/lib/integrations/credentials");
const { whatsappAccounts, whatsappCampaignLeads, whatsappCampaigns, whatsappCampaignSends, whatsappMessages } = await import("@/lib/whatsapp/schema");
const { createWhatsappCampaign } = await import("@/lib/whatsapp/campaigns/campaigns.server");
const { setDiscoveryPageOptions } = await import("@/lib/discovery/discovery.server");
const { runAgentTurn } = await import("@/lib/assistant/agent.server");
const { createThread, listMessages } = await import("@/lib/assistant/threads.server");
const { runOneAssistantStep, reconcileAssistantJobReports } = await import("@/lib/assistant/worker");
const { registerAssistantJobs, reportFinishedJob } = await import("@/lib/assistant/register.server");
const { updateBusinessProfile } = await import("@/lib/assistant/profile.server");
const { startOutreachRun, getRun } = await import("@/lib/assistant/outreach.server");
const { recordRequestApproval } = await import("@/lib/assistant/requestApproval.server");
const objectives = await import("@/lib/assistant/objective.server");
const { listWork } = await import("@/lib/activity/activity.server");
type AssistantJob = typeof schema.assistantJobs.$inferSelect;

setDiscoveryPageOptions({ allowPrivate: true, fetchImpl: (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch });
registerAssistantJobs();

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function organization(name: string) {
  const [org] = await db.insert(organizations).values({ name: `${name} ${stamp}`, slug: `${slug(name)}-${stamp}` }).returning();
  const [owner] = await db.insert(users).values({ name: "Owner Check", email: `owner-${slug(name)}-${stamp}@full-flow-check.test`, emailVerified: true }).returning();
  await db.insert(members).values({ organizationId: org!.id, userId: owner!.id, role: "owner" });
  return { org: org!, owner: owner! };
}
const a = await organization("Full flow check A");
const b = await organization("Full flow check B");

// ------------------------------------------------------------ helpers (inside an organization's scope)
async function jobRow(id: string): Promise<AssistantJob> {
  const [row] = await db.select().from(schema.assistantJobs).where(eq(schema.assistantJobs.id, id));
  return row!;
}
async function step(jobId: string): Promise<AssistantJob> {
  await db.update(schema.assistantJobs).set({ runAfter: new Date(Date.now() - 1_000) }).where(and(eq(schema.assistantJobs.id, jobId), eq(schema.assistantJobs.status, "queued")));
  await runOneAssistantStep({ jobId });
  return jobRow(jobId);
}
async function searches(requestId: string): Promise<AssistantJob[]> {
  return db.select().from(schema.assistantJobs).where(and(
    inArray(schema.assistantJobs.kind, ["discovery", "web_discovery", "linkedin_search", "apify_instagram"]),
    sql`${schema.assistantJobs.payload} ->> 'requestMessageId' = ${requestId}`,
  )).orderBy(schema.assistantJobs.createdAt);
}
/** Runs the request's open searches to their end, then waits for the plans they promised. */
async function finishSearches(requestId: string): Promise<void> {
  for (let round = 0; round < 60; round += 1) {
    const open = (await searches(requestId)).filter((job) => job.status === "queued" || job.status === "running");
    if (!open.length) break;
    for (const job of open) await step(job.id);
  }
  for (let round = 0; round < 200; round += 1) {
    const owed = (await searches(requestId)).some((job) => ["owed", "preparing"].includes(String((job.progress as { followUp?: unknown }).followUp ?? "")));
    if (!owed) break;
    await sleep(100);
  }
}
async function continuationEnded(requestId: string, n: number): Promise<boolean> {
  for (let round = 0; round < 300; round += 1) {
    const state = (((await objectives.objectiveForRequest(requestId))!.progress) as { continuation?: { n?: number; endedAt?: string | null } }).continuation;
    if (state?.n === n && state.endedAt) return true;
    await sleep(50);
  }
  return false;
}
async function plans(threadId: string) {
  return db.select().from(schema.outreachRuns).where(eq(schema.outreachRuns.threadId, threadId)).orderBy(schema.outreachRuns.createdAt);
}
async function events(threadId: string) {
  return (await listMessages(threadId, 500)).filter((row) => row.role === "event");
}
/** Runs a plan's launch job to its end. */
async function launch(runId: string): Promise<AssistantJob | null> {
  for (let round = 0; round < 30; round += 1) {
    const [job] = await db.select().from(schema.assistantJobs).where(and(eq(schema.assistantJobs.runId, runId), eq(schema.assistantJobs.kind, "outreach_start")));
    if (!job) return null;
    if (job.status !== "queued" && job.status !== "running") return job;
    await step(job.id);
  }
  return null;
}

let shared: { threadId: string; requestId: string; objectiveId: string; runIds: string[] } | null = null;

await runInOrganization(a.org.id, async () => {
  // ---------------------------------------------------------- setup: a business profile and a WhatsApp number
  const [provider] = await db.insert(gridProviders).values({ organizationId: a.org.id, key: "platform-unipile", name: "Unipile (full flow check)" }).returning();
  await db.insert(gridProviderCredentials).values({ providerId: provider!.id, encryptedPayload: encryptIntegrationCredentials({ apiKey: "full-flow-check", dsn: "https://unipile.invalid" }) });
  const [account] = await db.insert(whatsappAccounts).values({ organizationId: a.org.id, unipileAccountId: `full-flow-${stamp}`, name: "Clinic sales", phone: "+919800000077", status: "connected", connectedAt: new Date(Date.now() - 5 * 86_400_000) }).returning();
  await updateBusinessProfile({ businessName: "ChairFill", offer: "WhatsApp appointment reminders that fill empty chair hours for dental clinics", senderName: "Ravi" }, a.owner.id);

  // ---------------------------------------------------------- 1. the prompt, the search and the objective
  const thread = await createThread(a.owner.id);
  const ask = "Find 10 dental clinics in Pune and message them on WhatsApp";
  replies = turn("Searching Google Maps for dental clinics in Pune; I will write a WhatsApp plan for the ones with a number.", [{ tool: "find_leads", args: { what: "dental clinics", where: "Pune", contactAfter: true, channels: ["whatsapp"] } }]);
  await runAgentTurn({ threadId: thread.id, userId: a.owner.id, text: ask });
  const requestId = [...(await listMessages(thread.id, 500))].reverse().find((row) => row.role === "user")!.id;
  const objective = await objectives.objectiveForRequest(requestId);
  check("the prompt starts a search for the request, pursued with the target the owner named", Boolean(objective) && objective!.leadTarget === 10 && objective!.controls.named?.target === true && (await searches(requestId)).length === 1,
    JSON.stringify({ target: objective?.leadTarget, searches: (await searches(requestId)).length }));
  const [driver] = await db.select().from(schema.assistantJobs).where(and(eq(schema.assistantJobs.kind, "objective"), sql`${schema.assistantJobs.payload} ->> 'objectiveId' = ${objective!.id}`));

  // ---------------------------------------------------------- 2. research and qualification
  await finishSearches(requestId);
  const [first] = await searches(requestId);
  const firstResult = (first!.result ?? {}) as { found?: number; eligible?: number };
  check("the search ran on the built-in scraper and qualified each clinic with a WhatsApp route", first!.status === "succeeded" && firstResult.found === 6 && firstResult.eligible === 6 && scraper.posts.length === 1,
    JSON.stringify({ status: first!.status, ...firstResult, scraped: scraper.posts }));

  // ---------------------------------------------------------- 3. the plan, written from the owner's words, waiting for Start
  let runs = await plans(thread.id);
  const plan1 = runs[0];
  check("a plan was written for those 6 leads on WhatsApp and waits for the owner's Start", runs.length === 1 && plan1?.status === "proposed" && plan1.channels.join() === "whatsapp" && plan1.plan.assignments.length === 6 && plan1.plan.requestId === requestId,
    JSON.stringify(runs.map((run) => ({ status: run.status, channels: run.channels, leads: run.plan.assignments.length }))));
  check("…with its messages and a sample from the writer", plan1!.plan.samples.length > 0 && (plan1!.plan.groups?.[0]?.sequences.whatsapp?.length ?? 0) === 2 && /chair hours/.test(JSON.stringify(plan1!.plan.samples)),
    JSON.stringify(plan1!.plan.samples).slice(0, 300));
  check("…the sample names the clinic, not its phone number", /^[A-Z][a-z]+ Dental Clinic$/.test(plan1!.plan.samples[0]?.name ?? ""), plan1!.plan.samples[0]?.name);

  // ---------------------------------------------------------- 4. continuation: short of the target, the request goes on by itself
  replies = turn("Searching again with other words.", [{ tool: "find_leads", args: { what: "dentists", where: "Pune", contactAfter: true, channels: ["whatsapp"] } }]);
  await step(driver!.id);
  check("6 of 10: the request continues with no owner message", await continuationEnded(requestId, 1));
  await step(driver!.id);
  await finishSearches(requestId);
  runs = await plans(thread.id);
  check("the second search qualified 6 more and its own plan was written", (await searches(requestId)).length === 2 && runs.length === 2 && runs[1]!.plan.assignments.length === 6 && runs[1]!.status === "proposed",
    JSON.stringify(runs.map((run) => ({ status: run.status, leads: run.plan.assignments.length }))));
  const done = await step(driver!.id);
  const stopped = await objectives.objectiveForRequest(requestId);
  const report = (await events(thread.id)).filter((row) => (row.toolResult as { objectiveId?: string; reportKey?: string } | null)?.objectiveId === objective!.id && (row.toolResult as { reportKey?: string }).reportKey);
  check("target reached: the request stops with that reason", stopped?.status === "stopped" && stopped.stopReason === "target_reached" && done.status === "succeeded", `${stopped?.status} ${stopped?.stopReason} ${done.status}`);
  check("one final report: what was searched by source, leads and routes, spend and the stop reason",
    report.length === 1 && /^Research finished: 12 qualified leads found, the target was 10/.test(report[0]!.content) && /Google Maps through the built-in scraper: 2 searches, 12 found/.test(report[0]!.content) && /Recorded spend: \$0\.00/.test(report[0]!.content),
    report.map((row) => row.content).join(" | ").slice(0, 600));

  // ---------------------------------------------------------- 5. Start, and the approval for the rest of the request
  const started = await startOutreachRun(plan1!.id, a.owner.id, { autopilot: false });
  const approval = await recordRequestApproval(plan1!.id, { autopilot: false, approvedBy: a.owner.id });
  check("Start on the first plan, and its approval starts the request's second plan", Boolean(started.jobId) && approval.started.length === 1 && approval.started[0]!.runId === runs[1]!.id, JSON.stringify(approval));

  // The first launch's worker dies after it created and recorded its campaign, before activating it.
  const [launch1] = await db.select().from(schema.assistantJobs).where(eq(schema.assistantJobs.id, started.jobId));
  await step(launch1!.id); // personalizing
  const halfway = await jobRow(launch1!.id);
  // Created the way the launch creates it (paused until activated), and recorded on the run.
  const precreated = await createWhatsappCampaign({ name: `${plan1!.name} · WhatsApp`, accountIds: [account!.id], steps: [{ id: crypto.randomUUID(), body: "Hi", delayHours: 0 }] });
  await db.update(schema.outreachRuns).set({ campaigns: { whatsapp: precreated.id } }).where(eq(schema.outreachRuns.id, plan1!.id));
  await db.update(schema.assistantJobs).set({ status: "running", lockedBy: "worker-that-died", heartbeatAt: new Date(Date.now() - 10 * 60_000), runAfter: new Date("2000-01-01T00:00:00Z") })
    .where(eq(schema.assistantJobs.id, launch1!.id));
  const relaunched = await launch(plan1!.id);
  const second = await launch(runs[1]!.id);
  const running = await Promise.all([getRun(plan1!.id), getRun(runs[1]!.id)]);
  check("both plans launched: the first taken over from the dead worker, the second under the approval",
    halfway.stage === "launching" && relaunched?.status === "succeeded" && second?.status === "succeeded" && running.every((run) => run?.status === "running"),
    JSON.stringify({ halfway: halfway.stage, first: relaunched?.status, firstError: relaunched?.error, second: second?.status, secondError: second?.error, runs: running.map((run) => run?.status) }));
  check("the taken-over launch used the campaign it had recorded, never a second one", running[0]?.campaigns.whatsapp === precreated.id,
    JSON.stringify({ recorded: precreated.id, now: running[0]?.campaigns }));
  const campaignIds = running.map((run) => run!.campaigns.whatsapp!).filter(Boolean);
  const enrolled = await db.select({ personId: whatsappCampaignLeads.personId, campaignId: whatsappCampaignLeads.campaignId }).from(whatsappCampaignLeads).where(inArray(whatsappCampaignLeads.campaignId, campaignIds));
  check("12 people enrolled, each once, 6 in each plan's campaign", enrolled.length === 12 && new Set(enrolled.map((row) => row.personId)).size === 12 && campaignIds.every((id) => enrolled.filter((row) => row.campaignId === id).length === 6),
    JSON.stringify({ enrolled: enrolled.length, distinct: new Set(enrolled.map((row) => row.personId)).size }));

  // ---------------------------------------------------------- 6. restarts and duplicate callbacks change nothing
  await reportFinishedJob(await jobRow(driver!.id));
  await objectives.postObjectiveReport(objective!.id);
  await reconcileAssistantJobReports(0);
  await step(driver!.id);
  for (const job of await searches(requestId)) await reportFinishedJob(await jobRow(job.id));
  await finishSearches(requestId);
  await launch(plan1!.id);
  await launch(runs[1]!.id);
  const afterReport = (await events(thread.id)).filter((row) => (row.toolResult as { objectiveId?: string; reportKey?: string } | null)?.objectiveId === objective!.id && (row.toolResult as { reportKey?: string }).reportKey);
  const afterEnrolled = await db.select({ n: sql<number>`count(*)::int` }).from(whatsappCampaignLeads).where(inArray(whatsappCampaignLeads.campaignId, campaignIds));
  const allCampaigns = await db.select({ id: whatsappCampaigns.id }).from(whatsappCampaigns).where(eq(whatsappCampaigns.organizationId, a.org.id));
  check("repeated callbacks, the reconciliation and re-run launches add no report, plan, campaign or enrollment",
    afterReport.length === 1 && (await plans(thread.id)).length === 2 && allCampaigns.length === 2 && Number(afterEnrolled[0]?.n) === 12 && scraper.posts.length === 2,
    JSON.stringify({ reports: afterReport.length, plans: (await plans(thread.id)).length, campaigns: allCampaigns.length, enrolled: afterEnrolled[0]?.n, scraped: scraper.posts.length }));
  const sends = await db.select({ n: sql<number>`count(*)::int` }).from(whatsappCampaignSends)
    .where(inArray(whatsappCampaignSends.leadId, db.select({ id: whatsappCampaignLeads.id }).from(whatsappCampaignLeads).where(inArray(whatsappCampaignLeads.campaignId, campaignIds))));
  const messages = await db.select({ n: sql<number>`count(*)::int` }).from(whatsappMessages).where(sql`${whatsappMessages.chatId} in (select c.id from whatsapp_chats c join whatsapp_accounts w on w.id = c.account_id where w.organization_id = ${a.org.id})`);
  check("nothing was sent: no send claim and no WhatsApp message", Number(sends[0]?.n) === 0 && Number(messages[0]?.n) === 0);

  // ---------------------------------------------------------- 7. what the owner sees
  const work = await listWork();
  const requestItem = work.find((item) => item.id === driver!.id);
  const planItems = work.filter((item) => item.type === "plan");
  check("Activity: the lead request is Done with 12 of 10, and both plans run with their 6 leads", requestItem?.state === "completed" && /12 of 10 leads/.test(requestItem.reason ?? "") && planItems.length === 2 && planItems.every((item) => item.counts?.leads === 6 && item.runStatus === "running"),
    JSON.stringify({ request: requestItem && { state: requestItem.state, reason: requestItem.reason }, plans: planItems.map((item) => ({ state: item.state, counts: item.counts })) }));
  check("the chat model was asked twice per turn and the writer wrote each plan", modelCalls.filter((name) => name === "assistant_reply").length === 4 && modelCalls.filter((name) => name === "outreach_sequences").length >= 2,
    modelCalls.join(","));

  shared = { threadId: thread.id, requestId, objectiveId: objective!.id, runIds: runs.map((run) => run.id) };
});

// ------------------------------------------------------------ another organization
await runInOrganization(b.org.id, async () => {
  const seen = {
    objective: await objectives.objectiveForRequest(shared!.requestId),
    view: await objectives.objectiveView(shared!.requestId),
    runs: await Promise.all(shared!.runIds.map((id) => getRun(id))),
    work: (await listWork()).length,
  };
  let changed = true;
  try {
    await startOutreachRun(shared!.runIds[0]!, b.owner.id);
  } catch {
    changed = false;
  }
  check("a second organization sees none of it and cannot start its plans", !seen.objective && !seen.view && seen.runs.every((run) => !run) && seen.work === 0 && !changed, JSON.stringify({ ...seen, changed }));
});

if (failures) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("Full flow checks passed");
process.exit(0);

/**
 * Objectives (src/lib/assistant/objective*.ts), end to end against the local
 * database with the real chat turn, tools, worker, discovery stages and
 * ledgers. Stand-ins: the model (the structured-completion module is
 * replaced by a script), the Google Maps scraper and Apify (global fetch is
 * intercepted), and prepare_outreach's plan writer; nothing leaves the
 * machine and nothing is sent.
 *
 * - the controls a request names are kept (target, time, spend); the rest
 *   are the organization's defaults;
 * - target reached after a continuation: the request's searches end short,
 *   the driver resumes the turn with a note (found vs target, spend and time
 *   left, each source's yield), the model starts another search, and the
 *   request stops with one final report;
 * - spend cap used: an Apify run reserved at most what the request had
 *   left, settled with what it cost, then the request stops, leads kept; a
 *   run whose start lost its answer is never started again and stays counted;
 * - time limit: the request stops, a search that had not begun is not
 *   started, leads kept;
 * - pause holds a queued search, cancel stops new work and keeps leads;
 * - full Apify slots: the search waits, the request waits with it (not a
 *   failure), and finishes once a slot frees;
 * - a restart in the middle of a continuation: the continuation is taken
 *   again without repeating its search, its outreach plan or its note, and
 *   one report is posted however often it is asked for;
 * - a second organization sees and changes nothing of the first.
 *
 *   bun run --conditions=react-server scripts/e2e/objective.ts
 *
 * Creates its own organizations ("Objective check A/B …") and leaves them,
 * with every objective stopped and reported. Refuses a non-local DATABASE_URL.
 */
import { mock } from "bun:test";
import { join } from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}

const stamp = Date.now();
const SCRAPER = "http://scraper.objective-check.test";
const APIFY = "https://apify.objective-check.test/v2";
process.env.GMAPS_SCRAPER_URL = SCRAPER;
process.env.GEOCODER_URL = "off";
process.env.DISCOVERY_DNS_CHECK = "off";

// ------------------------------------------------------------ the model, scripted
const root = join(import.meta.dir, "..", "..");
type Input = { userPrompt: string; schemaName?: string; accept: (text: string) => void };
type Script = (input: Input) => string | Promise<string>;
let replies: Script[] = [];
const prompts: string[] = [];
/** The lead sorter's verdict on one lead's facts (leadFit.ts): every lead fits unless a check says otherwise. */
type Verdict = { requestFit: "fits" | "unconfirmed" | "does_not_fit"; reason: string; noWebsite?: boolean };
let judge: (facts: Record<string, string>) => Verdict = () => ({ requestFit: "fits", reason: "What the owner asked for." });
const judgedLeads: Record<string, string>[] = [];
/** The request each sorting call judged against, as the model read it (pilot L02: the subject, not how the research runs). */
const judgedAgainst: string[] = [];
mock.module(join(root, "src/lib/ai/server/structuredCompletion.ts"), () => ({
  completeStructured: async (input: Input) => {
    if (input.schemaName === "lead_sorting") {
      const leads = [...input.userPrompt.matchAll(/^(\d+)(?: \([^)]*\))?: (\{.*\})$/gm)].map((match) => ({ index: Number(match[1]), facts: JSON.parse(match[2]!) as Record<string, string> }));
      judgedLeads.push(...leads.map((lead) => lead.facts));
      judgedAgainst.push(input.userPrompt.match(/^THE OWNER'S REQUEST: (.*)$/m)?.[1] ?? "");
      const text = JSON.stringify({ leads: leads.map(({ index, facts }) => {
        const verdict = judge(facts);
        return { index, group: "Leads", approach: verdict.requestFit === "does_not_fit" ? "skip" : "standard", reason: verdict.reason, requestFit: verdict.requestFit, noWebsiteRequired: verdict.noWebsite === true };
      }) });
      input.accept(text);
      return { text, model: "fixture", provider: "fixture", request: {}, response: {}, usage: {}, attempts: 1 };
    }
    prompts.push(input.userPrompt);
    const next = replies.shift();
    if (!next) throw new Error(`unexpected model call: ${input.userPrompt.slice(-300)}`);
    const text = await next(input);
    input.accept(text);
    return { text, model: "fixture", provider: "fixture", request: {}, response: {}, usage: {}, attempts: 1 };
  },
}));
const reply = (message: string, actions: { tool: string; args: Record<string, unknown> }[] = []): Script => () =>
  JSON.stringify({ message, actions: actions.map((action) => ({ tool: action.tool, arguments: JSON.stringify(action.args) })), suggestions: [] });
/** A turn that runs these tools, then has nothing more to say. */
const turn = (message: string, actions: { tool: string; args: Record<string, unknown> }[]) => [reply(message, actions), reply("")];

// ------------------------------------------------------------ the scraper and Apify, stood in
const MAPS_HEADER = "input_id,link,title,category,address,website,phone,review_count,review_rating,place_id,cid,status,complete_address,emails";
const csv = (values: (string | number)[]) => values.map((value) => `"${String(value).replace(/"/g, "\"\"")}"`).join(",");
const scraper = { jobs: new Map<string, string>(), posts: [] as string[], perPhrase: 6, website: null as ((index: number) => string) | null };
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
function mapsCsv(phrase: string): string {
  const rows = Array.from({ length: scraper.perPhrase }, (_, index) => {
    const key = `${slug(phrase)}-${index + 1}`;
    return csv(["1", `https://maps.google.com/?cid=${stamp}${index}${key.length}`, `${phrase} business ${index + 1}`, "Business", "Pune", scraper.website?.(index) ?? "", "", 10, 4.5, `pl-${stamp}-${key}`, `${stamp}${index}`, "", JSON.stringify({ city: "Pune", country: "IN" }), `hello@${key}-${stamp}.test`]);
  });
  return [MAPS_HEADER, ...rows].join("\n");
}

type ApifyRun = { id: string; actorId: string; query: Record<string, string>; items: unknown[]; usage: number; datasetId: string };
const apify = { runs: new Map<string, ApifyRun>(), posts: [] as string[], items: [] as unknown[], usage: 1, loseNextStart: false };
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
  if (url.href.startsWith(APIFY)) {
    const path = url.pathname.replace(/^\/v2/, "");
    if (method === "GET" && path === "/users/me") return json(200, { data: { username: "objective-check" } });
    if (method === "GET" && path === "/users/me/limits") return json(200, { data: { limits: { maxMonthlyUsageUsd: 100 }, current: { monthlyUsageUsd: 1 } } });
    const start = path.match(/^\/actors\/([^/]+)\/runs$/);
    if (method === "POST" && start) {
      if (apify.loseNextStart) {
        // Apify takes the start, but its answer never arrives (a timeout or a dropped connection).
        apify.loseNextStart = false;
        apify.posts.push(decodeURIComponent(start[1]!));
        throw new TypeError("The socket connection was closed unexpectedly");
      }
      const id = `run-${apify.runs.size + 1}-${stamp}`;
      apify.posts.push(decodeURIComponent(start[1]!));
      apify.runs.set(id, { id, actorId: decodeURIComponent(start[1]!), query: Object.fromEntries(url.searchParams), items: apify.items, usage: apify.usage, datasetId: `ds-${id}` });
      return json(201, { data: { id, status: "RUNNING", defaultDatasetId: `ds-${id}`, usageTotalUsd: 0 } });
    }
    const runMatch = path.match(/^\/actor-runs\/([^/]+)$/);
    if (method === "GET" && runMatch) {
      const run = apify.runs.get(runMatch[1]!);
      if (!run) return json(404, { error: { type: "record-not-found", message: "Run not found" } });
      return json(200, { data: { id: run.id, status: "SUCCEEDED", defaultDatasetId: run.datasetId, usageTotalUsd: run.usage } });
    }
    const items = path.match(/^\/datasets\/ds-([^/]+)\/items$/);
    if (method === "GET" && items) return json(200, apify.runs.get(items[1]!)?.items ?? []);
    return json(405, { error: { type: "not-in-stand-in", message: `${method} ${path}` } });
  }
  if (url.hostname.endsWith(".test")) return new Response("not found", { status: 404 });
  return realFetch(input, init);
}) as typeof fetch;

// ------------------------------------------------------------ app modules
const { db } = await import("@/lib/db");
const { organizations, users, members } = await import("@/lib/auth/schema");
const { runInOrganization } = await import("@/lib/tenancy/scope");
const schema = await import("@/lib/assistant/schema");
const { apifyRuns } = await import("@/lib/apify/schema");
const { saveApifySettings, startTrackedRun, sweepStaleRuns } = await import("@/lib/apify/apify.server");
const { setApifyApiBase } = await import("@/services/apify");
const { setDiscoveryPageOptions } = await import("@/lib/discovery/discovery.server");
const { setFeature, clearFeatureCache } = await import("@/lib/features/flags.server");
const { continueAfterEvent, runAgentTurn } = await import("@/lib/assistant/agent.server");
const { createThread, listMessages } = await import("@/lib/assistant/threads.server");
const { runOneAssistantStep, reconcileAssistantJobReports } = await import("@/lib/assistant/worker");
const { registerAssistantJobs, reportFinishedJob } = await import("@/lib/assistant/register.server");
const { runTool, TOOLS } = await import("@/lib/assistant/tools.server");
const objectives = await import("@/lib/assistant/objective.server");
const { assessMembers } = await import("@/lib/assistant/qualify.server");
type AssistantJob = typeof schema.assistantJobs.$inferSelect;
type Objective = typeof schema.assistantObjectives.$inferSelect;

setApifyApiBase(APIFY);
setDiscoveryPageOptions({ allowPrivate: true, fetchImpl: (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch });
registerAssistantJobs();

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// prepare_outreach writes plans with the model; here a stand-in records each call (the follow-up path is the real one).
const planCalls: string[] = [];
const realPrepareOutreach = TOOLS.prepare_outreach!.run;
const standInPrepareOutreach: typeof realPrepareOutreach = async (args) => {
  planCalls.push(String(args.audienceId));
  return { ok: true, summary: "The outreach plan is ready (stand-in).", data: { runId: crypto.randomUUID() } };
};
TOOLS.prepare_outreach!.run = standInPrepareOutreach;

// ------------------------------------------------------------ organizations
async function organization(name: string) {
  const [org] = await db.insert(organizations).values({ name: `${name} ${stamp}`, slug: `${slug(name)}-${stamp}` }).returning();
  const [owner] = await db.insert(users).values({ name: "Owner Check", email: `owner-${slug(name)}-${stamp}@objective-check.test`, emailVerified: true }).returning();
  await db.insert(members).values({ organizationId: org!.id, userId: owner!.id, role: "owner" });
  return { org: org!, owner: owner! };
}
const a = await organization("Objective check A");
const b = await organization("Objective check B");

// ------------------------------------------------------------ helpers (inside an organization's scope)
async function jobRow(id: string): Promise<AssistantJob> {
  const [row] = await db.select().from(schema.assistantJobs).where(eq(schema.assistantJobs.id, id));
  return row!;
}
async function objectiveOf(requestId: string): Promise<Objective> {
  const row = await objectives.objectiveForRequest(requestId);
  if (!row) throw new Error(`no objective for ${requestId}`);
  return row;
}
async function driverOf(objectiveId: string): Promise<AssistantJob> {
  const [row] = await db.select().from(schema.assistantJobs)
    .where(and(eq(schema.assistantJobs.kind, "objective"), sql`${schema.assistantJobs.payload} ->> 'objectiveId' = ${objectiveId}`));
  return row!;
}
/** One worker step of this job (made due first), as the worker runs it. */
async function step(jobId: string): Promise<AssistantJob> {
  await db.update(schema.assistantJobs).set({ runAfter: new Date(Date.now() - 1_000) }).where(and(eq(schema.assistantJobs.id, jobId), eq(schema.assistantJobs.status, "queued")));
  await runOneAssistantStep({ jobId });
  return jobRow(jobId);
}
async function children(requestId: string): Promise<AssistantJob[]> {
  return db.select().from(schema.assistantJobs).where(and(
    inArray(schema.assistantJobs.kind, ["discovery", "web_discovery", "linkedin_search", "apify_instagram"]),
    sql`(${schema.assistantJobs.payload} ->> 'requestMessageId' = ${requestId} or ${schema.assistantJobs.payload} -> 'contactAfter' ->> 'requestId' = ${requestId})`,
  )).orderBy(schema.assistantJobs.createdAt);
}
/** Runs the request's open searches to their end (their reports and follow-ups included). */
async function finishSearches(requestId: string, only?: string[]): Promise<void> {
  for (let round = 0; round < 60; round += 1) {
    const open = (await children(requestId)).filter((job) => (job.status === "queued" || job.status === "running") && (!only || only.includes(job.id)));
    if (!open.length) break;
    for (const job of open) await step(job.id);
  }
  // Plans promised by "find and contact" searches are written in the background.
  for (let round = 0; round < 100; round += 1) {
    const owed = (await children(requestId)).some((job) => ["owed", "preparing"].includes(String((job.progress as { followUp?: unknown }).followUp ?? "")));
    if (!owed) break;
    await sleep(100);
  }
}
/** Waits for the continuation turn the driver started to record how it ended. */
async function continuationEnded(requestId: string, n: number): Promise<boolean> {
  for (let round = 0; round < 200; round += 1) {
    const turnState = ((await objectiveOf(requestId)).progress as { continuation?: { n?: number; endedAt?: string | null } }).continuation;
    if (turnState?.n === n && turnState.endedAt) return true;
    await sleep(50);
  }
  return false;
}
async function events(threadId: string) {
  return (await listMessages(threadId, 500)).filter((row) => row.role === "event");
}
const reportsOf = async (threadId: string, objectiveId: string) => (await events(threadId)).filter((row) => (row.toolResult as { objectiveId?: string; reportKey?: string } | null)?.objectiveId === objectiveId && (row.toolResult as { reportKey?: string }).reportKey);
const notesOf = async (threadId: string, objectiveId: string) => (await events(threadId)).filter((row) => typeof (row.toolResult as { objectiveNote?: unknown } | null)?.objectiveNote === "string" && (row.toolResult as { objectiveId?: string }).objectiveId === objectiveId);
async function ask(threadId: string, text: string, script: Script[]): Promise<string> {
  replies = [...script];
  await runAgentTurn({ threadId, userId: a.owner.id, text });
  const rows = await listMessages(threadId, 500);
  return [...rows].reverse().find((row) => row.role === "user")!.id;
}

let crossOrg: { requestId: string; objectiveId: string; threadId: string; driverId: string } | null = null;

await runInOrganization(a.org.id, async () => {
  clearFeatureCache();
  await setFeature("apify_discovery", true, a.owner.id);
  clearFeatureCache();
  await saveApifySettings({ token: "objective-check-token", approvedActors: ["facebook_pages"], monthlyBudgetUsd: 50, maxChargePerRunUsd: 2, maxResultsPerRun: 50 }, a.owner.id);

  // ---------------------------------------------------------- 1. target reached after a continuation
  {
    const thread = await createThread(a.owner.id);
    const requestId = await ask(thread.id, "find 10 dentists in Pune", turn("", [{ tool: "find_leads", args: { what: "dentists", where: "Pune" } }]));
    const objective = await objectiveOf(requestId);
    check("controls: the target named in the request, the organization's defaults for time and spend",
      objective.leadTarget === 10 && objective.timeLimitMinutes === 240 && objective.spendCapUsd === 5 && objective.controls.named?.target === true && objective.controls.named?.time === false,
      JSON.stringify({ target: objective.leadTarget, minutes: objective.timeLimitMinutes, spend: objective.spendCapUsd, named: objective.controls.named }));
    const firstTool = (await listMessages(thread.id)).find((row) => row.tool === "find_leads");
    check("the first search's result tells the model the controls", /until it has 10 qualified leads, for up to 4 h \(default\)/.test(String((firstTool?.toolResult as { summary?: string } | null)?.summary ?? "")), String(firstTool?.toolResult && (firstTool.toolResult as { summary?: string }).summary));
    const driver = await driverOf(objective.id);
    check("one driver job per request, queued in the request's chat", driver.status === "queued" && driver.threadId === thread.id);

    await finishSearches(requestId);
    // The model is asked again only by the driver: the search's report alone ends nothing.
    replies = turn("Looking for dental clinics too.", [{ tool: "find_leads", args: { what: "dental clinics", where: "Pune" } }]);
    await step(driver.id);
    check("searches done short of the target: the request continues with no owner message", await continuationEnded(requestId, 1));
    const notes = await notesOf(thread.id, objective.id);
    check("…with one note: found vs target, spend and time left, and each source's yield",
      notes.length === 1 && /6 of 10 qualified leads/.test(notes[0]!.content) && /Spent \$0\.00 of \$5\.00/.test(notes[0]!.content) && /left/.test(notes[0]!.content) && /Google Maps through the built-in scraper: 1 search, 6 found, 6 can be contacted/.test(notes[0]!.content),
      notes.map((row) => row.content).join(" | "));
    check("…which the model read in its turn", prompts.at(-2)?.includes("Continuing your request “find 10 dentists in Pune”") === true);
    const searches = await children(requestId);
    check("the model chose a second search, carrying the request's id", searches.length === 2 && (searches[1]!.payload as { phrase?: string }).phrase === "dental clinics in Pune", searches.map((job) => (job.payload as { phrase?: string }).phrase).join(", "));
    await step(driver.id);
    await finishSearches(requestId);
    const done = await step(driver.id);
    const stopped = await objectiveOf(requestId);
    const reports = await reportsOf(thread.id, objective.id);
    check("target reached: stopped with that reason, and the driver finished", stopped.status === "stopped" && stopped.stopReason === "target_reached" && done.status === "succeeded", `${stopped.status} ${stopped.stopReason} ${done.status}`);
    check("one final report: sources, leads and contact routes, spend, what is left, and the stop reason",
      reports.length === 1 && /^Research finished: the target of 10 was reached/.test(reports[0]!.content) && /12 qualified leads \(contactable and matching your request\) of the 10 wanted\./.test(reports[0]!.content)
        && /Their contact routes \(one person can have several\): 12 by email/.test(reports[0]!.content) && /Google Maps through the built-in scraper: 2 searches, 12 found, 12 can be contacted/.test(reports[0]!.content) && /Recorded spend: \$0\.00 of the \$5\.00 cap/.test(reports[0]!.content),
      reports.map((row) => row.content).join(" | "));
    const links = ((reports[0]?.toolResult as { data?: { links?: { href: string }[] } } | null)?.data?.links ?? []).map((link) => link.href);
    check("…with links to the saved results", links.includes(`/assistant?thread=${thread.id}`) && links.includes("/leads"), links.join(" "));
    // Duplicate callbacks, the reconciliation and a direct call post nothing more.
    await reportFinishedJob(await jobRow(driver.id));
    await objectives.postObjectiveReport(objective.id);
    await reconcileAssistantJobReports(0);
    await step(driver.id);
    check("a duplicate callback, the reconciliation and a second post add no report", (await reportsOf(thread.id, objective.id)).length === 1);
    const view = await objectives.objectiveView(requestId);
    check("objectiveView: completed, with its leads, routes, sources and spend", view?.outcome === "completed" && view.leads === 12 && view.remaining === 0 && view.routes.email === 12 && view.sources.length === 1 && view.spentUsd === 0 && view.reported, JSON.stringify(view));
    const refused = await runTool("find_leads", { what: "orthodontists", where: "Pune" }, { threadId: thread.id, userId: a.owner.id, ownerText: "find 10 dentists in Pune", requestMessageId: requestId });
    check("a stopped request starts no new search", !refused.ok && /has stopped/.test(refused.summary), refused.summary);
    crossOrg = { requestId, objectiveId: objective.id, threadId: thread.id, driverId: driver.id };
  }

  // ---------------------------------------------------------- 2. spend cap: reserve, settle, stop with the leads kept
  {
    const thread = await createThread(a.owner.id);
    apify.items = [1, 2, 3].map((n) => ({ title: `Iron Gym ${n}`, pageUrl: `https://www.facebook.com/irongym${n}-${stamp}`, email: `hello@irongym${n}-${stamp}.test` }));
    apify.usage = 1;
    const requestId = await ask(thread.id, "find gyms in Mumbai on Facebook, spend up to $1", turn("", [{ tool: "find_social_leads", args: { platform: "facebook", what: "gyms", where: "Mumbai" } }]));
    const objective = await objectiveOf(requestId);
    check("controls: the spend cap named in the request", objective.spendCapUsd === 1 && objective.controls.named?.spend === true, String(objective.spendCapUsd));
    const [search] = await children(requestId);
    const started = await step(search!.id);
    const [run] = await db.select().from(apifyRuns).where(eq(apifyRuns.jobId, search!.id));
    check("the Apify run reserved at most what the request had left ($1, under the $2 run cap), recorded before the call", started.stage === "apify" && run?.maxChargeUsd === 1 && run.requestId === requestId && apify.runs.get(run.apifyRunId!)?.query.maxTotalChargeUsd === "1", JSON.stringify({ stage: started.stage, cap: run?.maxChargeUsd, query: run?.apifyRunId ? apify.runs.get(run.apifyRunId)?.query : null }));
    const open = await objectives.objectiveView(requestId);
    check("while it runs, its whole cap is held (reserved, counted)", open?.reservedUsd === 1 && open.spentUsd === 1, JSON.stringify({ reserved: open?.reservedUsd, spent: open?.spentUsd }));
    const posts = apify.posts.length;
    const second = await startTrackedRun({ actor: "facebook_pages", input: () => ({}), wantedItems: 5, jobId: null, requestId, spendGuard: await objectives.objectiveSpendGuard(requestId) });
    check("other paid work for the request waits while the reservation is open (not refused, not run)", !second.started && second.slotsFull === true && apify.posts.length === posts, second.started ? "started" : second.reason);
    await finishSearches(requestId);
    const driver = await driverOf(objective.id);
    await step(driver.id);
    const stopped = await objectiveOf(requestId);
    const [settled] = await db.select().from(apifyRuns).where(eq(apifyRuns.jobId, search!.id));
    check("settled with what Apify reported, then stopped: spend cap used", settled?.status === "succeeded" && settled.usageUsd === 1 && stopped.stopReason === "budget_spent", `${settled?.status} ${settled?.usageUsd} ${stopped.stopReason}`);
    const reports = await reportsOf(thread.id, objective.id);
    check("the report keeps the leads found and gives the spend and the exact reason",
      reports.length === 1 && /^Research stopped: \$1\.00 of the \$1\.00 spend cap was used/.test(reports[0]!.content) && /3 qualified leads \(contactable and matching your request\) of the 25 wanted; 22 still to find/.test(reports[0]!.content) && /Recorded spend: \$1\.00 of the \$1\.00 cap \(Apify \$1\.00\)/.test(reports[0]!.content) && /Facebook through Apify: 1 search, 3 found, 3 can be contacted/.test(reports[0]!.content),
      reports.map((row) => row.content).join(" | "));
    const members = await db.select().from(schema.leadAudienceMembers).where(and(eq(schema.leadAudienceMembers.audienceId, search!.audienceId!), eq(schema.leadAudienceMembers.status, "eligible")));
    check("the leads are kept", members.length === 3);
    const after = await startTrackedRun({ actor: "facebook_pages", input: () => ({}), wantedItems: 5, jobId: null, requestId, spendGuard: await objectives.objectiveSpendGuard(requestId) });
    check("paid work for a stopped request is refused", !after.started && !after.slotsFull && apify.posts.length === posts, after.started ? "started" : after.reason);
  }

  // ---------------------------------------------------------- 2a. a paid start whose answer never arrives: counted, never retried
  {
    const thread = await createThread(a.owner.id);
    const requestId = await ask(thread.id, "find gyms in Pune on Facebook", turn("", [{ tool: "find_social_leads", args: { platform: "facebook", what: "gyms", where: "Pune" } }]));
    const [search] = await children(requestId);
    apify.loseNextStart = true;
    const posts = apify.posts.length;
    const first = await step(search!.id);
    const [row] = await db.select().from(apifyRuns).where(eq(apifyRuns.jobId, search!.id));
    const view = await objectives.objectiveView(requestId);
    check("Apify's answer to a start never arrives: the run is kept as possibly started, its cap still counted",
      apify.posts.length === posts + 1 && row?.status === "starting" && view?.reservedUsd === row.maxChargeUsd && (view?.reservedUsd ?? 0) > 0,
      JSON.stringify({ posts: apify.posts.length - posts, status: row?.status, error: row?.error, reserved: view?.reservedUsd, job: `${first.status}/${first.stage}` }));
    const again = await step(search!.id);
    check("…and the search is not started again", apify.posts.length === posts + 1 && /lost its answer/.test(String((again.result as { note?: string } | null)?.note ?? again.error ?? "")),
      JSON.stringify({ posts: apify.posts.length - posts, status: again.status, note: (again.result as { note?: string } | null)?.note ?? again.error }));
    // Ten minutes on, the sweeper closes it as spent at its full cap: an unknown charge is never counted as nothing.
    await db.update(apifyRuns).set({ createdAt: new Date(Date.now() - 11 * 60_000) }).where(eq(apifyRuns.id, row!.id));
    await sweepStaleRuns();
    const [swept] = await db.select().from(apifyRuns).where(eq(apifyRuns.id, row!.id));
    const after = await objectives.objectiveView(requestId);
    check("…until the sweeper closes it, counted as spent at its full cap", swept?.status === "failed" && swept.usageUsd === row!.maxChargeUsd && after?.spentUsd === row!.maxChargeUsd && after.reservedUsd === 0,
      JSON.stringify({ status: swept?.status, usage: swept?.usageUsd, spent: after?.spentUsd, reserved: after?.reservedUsd }));
    const objective = await objectiveOf(requestId);
    await objectives.setObjectiveState(objective.id, "cancel", { name: null });
    await finishSearches(requestId);
    await step((await driverOf(objective.id)).id);
  }

  // ---------------------------------------------------------- 2b. a paid start whose answer was lost: kept, never retried
  {
    const thread = await createThread(a.owner.id);
    const requestId = await ask(thread.id, "find spas in Pune on Facebook", turn("", [{ tool: "find_social_leads", args: { platform: "facebook", what: "spas", where: "Pune" } }]));
    const [search] = await children(requestId);
    // The process stopped between reserving the run and hearing back from Apify.
    await db.insert(apifyRuns).values({ organizationId: a.org.id, jobId: search!.id, requestId, actorKey: "facebook_pages", actorId: "apify~facebook-search-scraper", status: "starting", maxChargeUsd: 0.5, maxItems: 5 });
    const posts = apify.posts.length;
    const retried = await step(search!.id);
    const view = await objectives.objectiveView(requestId);
    check("a retried step does not start the run again: not searched, with the reason", retried.status === "succeeded" && (retried.result as { notSearched?: boolean } | null)?.notSearched === true && apify.posts.length === posts && /lost its answer/.test(String((retried.result as { note?: string }).note)), String((retried.result as { note?: string } | null)?.note));
    check("…and its reserved cap stays counted in the request's spend", view?.reservedUsd === 0.5 && view.spentUsd === 0.5, JSON.stringify({ reserved: view?.reservedUsd, spent: view?.spentUsd }));
    const objective = await objectiveOf(requestId);
    await objectives.setObjectiveState(objective.id, "cancel", { name: "Owner Check" });
    await step((await driverOf(objective.id)).id);
    check("…and the report says so", /0\.50 of it held by paid work still open/.test((await reportsOf(thread.id, objective.id))[0]?.content ?? ""), (await reportsOf(thread.id, objective.id))[0]?.content ?? "none");
  }

  // ---------------------------------------------------------- 3. time limit
  {
    const thread = await createThread(a.owner.id);
    const requestId = await ask(thread.id, "find bakeries in Pune and Pimpri within 30 minutes", turn("", [
      { tool: "find_leads", args: { what: "bakeries", where: "Pune" } },
      { tool: "find_leads", args: { what: "bakeries", where: "Pimpri" } },
    ]));
    const objective = await objectiveOf(requestId);
    check("controls: the time named in the request", objective.timeLimitMinutes === 30 && objective.deadlineAt.getTime() - objective.createdAt.getTime() === 30 * 60_000, String(objective.timeLimitMinutes));
    const [first, second] = await children(requestId);
    await finishSearches(requestId, [first!.id]);
    // Thirty minutes pass while the second search still waits to begin.
    await db.update(schema.assistantObjectives).set({ deadlineAt: new Date(Date.now() - 1_000) }).where(eq(schema.assistantObjectives.id, objective.id));
    await step((await driverOf(objective.id)).id);
    const stopped = await objectiveOf(requestId);
    const notBegun = await jobRow(second!.id);
    const reports = await reportsOf(thread.id, objective.id);
    check("time limit: stopped with that reason", stopped.stopReason === "time_limit" && stopped.status === "stopped", String(stopped.stopReason));
    check("the search that had not begun is not started", notBegun.status === "cancelled" && (notBegun.result as { notSearched?: boolean } | null)?.notSearched === true && !scraper.posts.includes("bakeries in Pimpri"), notBegun.status);
    check("the report keeps the first search's leads and says what was not searched",
      reports.length === 1 && /^Research stopped: the time limit passed/.test(reports[0]!.content) && /6 qualified leads \(contactable and matching your request\) of the 25 wanted/.test(reports[0]!.content) && /1 not searched/.test(reports[0]!.content),
      reports.map((row) => row.content).join(" | "));
  }

  // ---------------------------------------------------------- 4. pause and cancel
  {
    const thread = await createThread(a.owner.id);
    const requestId = await ask(thread.id, "find yoga studios in Pune", turn("", [{ tool: "find_leads", args: { what: "yoga studios", where: "Pune" } }]));
    const objective = await objectiveOf(requestId);
    const driver = await driverOf(objective.id);
    await finishSearches(requestId);
    replies = turn("Looking at yoga classes too.", [{ tool: "find_leads", args: { what: "yoga classes", where: "Pune" } }]);
    await step(driver.id);
    await continuationEnded(requestId, 1);
    const context = { threadId: thread.id, userId: a.owner.id, ownerText: "pause the search", requestMessageId: requestId };
    const paused = await runTool("control_research", { action: "pause" }, context);
    const queued = (await children(requestId)).find((job) => job.status === "queued")!;
    const held = await step(queued.id);
    check("paused: a search that has not begun waits, untouched", paused.ok && held.status === "queued" && held.stage === "queued" && (held.progress as { waiting?: { kind?: string } }).waiting?.kind === "paused" && !scraper.posts.includes("yoga classes in Pune"), `${paused.summary} ${held.status}/${held.stage}`);
    const pausedStep = await step(driver.id);
    check("…and the request waits instead of continuing", pausedStep.status === "queued" && (await objectiveOf(requestId)).status === "paused" && (await notesOf(thread.id, objective.id)).length === 1);
    const blocked = await runTool("find_leads", { what: "pilates studios", where: "Pune" }, context);
    check("…and starts no new search", !blocked.ok && /paused/.test(blocked.summary), blocked.summary);
    const webPaused = await runTool("web_search", { query: "pilates studio Pune" }, context);
    check("…nor a web search of its own: the same request, paused for both paths", !webPaused.ok && /^Not run: the owner paused this request's research/.test(webPaused.summary), webPaused.summary);
    const resumed = await runTool("control_research", { action: "resume" }, context);
    check("resume: active again", resumed.ok && (await objectiveOf(requestId)).status === "active");
    await runTool("control_research", { action: "pause" }, context);
    const cancelled = await runTool("control_research", { action: "cancel" }, { ...context, ownerText: "cancel it" });
    const notBegun = await jobRow(queued.id);
    check("cancel: stopped with the owner's reason; the search that had not begun is not started", cancelled.ok && (await objectiveOf(requestId)).stopReason === "cancelled" && notBegun.status === "cancelled", `${cancelled.summary} ${notBegun.status}`);
    await step(driver.id);
    const reports = await reportsOf(thread.id, objective.id);
    check("the report keeps the leads already saved and says it was cancelled",
      reports.length === 1 && /^Research stopped: cancelled by the owner/.test(reports[0]!.content) && /6 qualified leads \(contactable and matching your request\) of the 25 wanted/.test(reports[0]!.content), reports.map((row) => row.content).join(" | "));
    const again = await runTool("control_research", { action: "resume" }, context);
    check("a cancelled request cannot be resumed", !again.ok, again.summary);
  }

  // ---------------------------------------------------------- 4a. a new request after a stopped one, in Autonomous mode
  {
    const thread = await createThread(a.owner.id);
    const first = await ask(thread.id, "find 6 florists in Pune and contact them", turn("", [{ tool: "find_leads", args: { what: "florists", where: "Pune", contactAfter: true } }]));
    const firstObjective = await objectiveOf(first);
    await finishSearches(first);
    await step((await driverOf(firstObjective.id)).id);
    check("a find-and-contact request reaches its target and stops", (await objectiveOf(first)).stopReason === "target_reached", String((await objectiveOf(first)).stopReason));
    // In Autonomous mode that request to contact people stands for what follows; the owner then asks for something new.
    await db.update(schema.assistantThreads).set({ autonomous: true, autonomousBy: a.owner.id, autonomousAt: new Date() }).where(eq(schema.assistantThreads.id, thread.id));
    const second = await ask(thread.id, "now find bakeries in Pune", turn("", [{ tool: "find_leads", args: { what: "bakeries", where: "Pune" } }]));
    const search = (await listMessages(thread.id, 500)).filter((row) => row.tool === "find_leads").at(-1);
    const secondObjective = await objectives.objectiveForRequest(second);
    check("…a new request is its own research, not refused by the stopped one",
      search?.status === "ok" && (await children(second)).length === 1 && secondObjective?.status === "active" && (await objectiveOf(first)).status === "stopped",
      JSON.stringify({ status: search?.status, summary: search?.content.slice(0, 160), searches: (await children(second)).length, objective: secondObjective?.status ?? null }));
    await db.update(schema.assistantThreads).set({ autonomous: false }).where(eq(schema.assistantThreads.id, thread.id));
    await objectives.setObjectiveState(secondObjective!.id, "cancel", { name: null });
    await finishSearches(second);
    await step((await driverOf(secondObjective!.id)).id);
  }

  // ---------------------------------------------------------- 4b. paused while a continuation turn runs
  {
    const thread = await createThread(a.owner.id);
    const requestId = await ask(thread.id, "find salons in Pune", turn("", [{ tool: "find_leads", args: { what: "salons", where: "Pune" } }]));
    const objective = await objectiveOf(requestId);
    const driver = await driverOf(objective.id);
    await finishSearches(requestId);
    // The owner presses Pause while the assistant is choosing the next source: the search it picks is refused for the pause.
    replies = [async () => {
      await objectives.setObjectiveState(objective.id, "pause", { name: null });
      return reply("Looking at beauty parlours too.", [{ tool: "find_leads", args: { what: "beauty parlours", where: "Pune" } }])({} as Input);
    }, reply("")];
    await step(driver.id);
    await continuationEnded(requestId, 1);
    const refused = (await listMessages(thread.id, 500)).filter((row) => row.tool === "find_leads" && row.status === "error");
    check("paused during a continuation: the search the turn picked is refused for the pause", refused.length === 1 && /paused/.test(refused[0]!.content) && (await children(requestId)).length === 1, refused.map((row) => row.content).join(" | "));
    await step(driver.id);
    check("…and the request waits while paused", (await objectiveOf(requestId)).status === "paused");
    await objectives.setObjectiveState(objective.id, "resume", { name: null });
    replies = turn("Trying beauty parlours now.", [{ tool: "find_leads", args: { what: "beauty parlours", where: "Pune" } }]);
    await step(driver.id);
    const afterResume = await objectiveOf(requestId);
    check("…resumed, it continues: the paused turn is not taken for sources exhausted", afterResume.status === "active" && !afterResume.stopReason && await continuationEnded(requestId, 2) && (await children(requestId)).length === 2,
      JSON.stringify({ status: afterResume.status, stop: afterResume.stopReason, detail: afterResume.stopDetail, searches: (await children(requestId)).length }));
    await objectives.setObjectiveState(objective.id, "cancel", { name: null });
    await finishSearches(requestId);
    await step(driver.id);
  }

  // ---------------------------------------------------------- 4c. paused while an Instagram search's posts are in: its profiles wait
  {
    clearFeatureCache();
    await setFeature("instagram", true, a.owner.id);
    clearFeatureCache();
    await saveApifySettings({ approvedActors: ["facebook_pages", "instagram_hashtags", "instagram_profiles"] }, a.owner.id);
    const thread = await createThread(a.owner.id);
    apify.items = [
      { ownerUsername: `pune.yoga.${stamp}`, url: `https://www.instagram.com/p/y1${stamp}/`, caption: "Sunrise yoga in Pune", timestamp: "2026-10-10T10:00:00Z" },
      { ownerUsername: `flow.studio.${stamp}`, url: `https://www.instagram.com/p/y2${stamp}/`, caption: "Flow class tonight", timestamp: "2026-10-09T10:00:00Z" },
    ];
    const requestId = await ask(thread.id, "find yoga teachers on Instagram in Pune", turn("", [{ tool: "find_instagram_prospects", args: { what: "yoga teachers", where: "Pune" } }]));
    const objective = await objectiveOf(requestId);
    const [search] = await children(requestId);
    const running = await step(search!.id);
    check("an Instagram search's hashtag run is under way", running.stage === "apify", `${running.status}/${running.stage} ${running.error ?? ""}`);
    // The owner pauses while it runs; its profiles would be read next.
    await objectives.setObjectiveState(objective.id, "pause", { name: null });
    apify.items = [
      { username: `pune.yoga.${stamp}`, fullName: "Pune Yoga", biography: "Yoga classes in Pune · DM to book", businessEmail: `hello@puneyoga-${stamp}.test` },
      { username: `flow.studio.${stamp}`, fullName: "Flow Studio", biography: "Yoga and pilates in Pune" },
    ];
    const profileRuns = () => apify.posts.filter((actor) => /profile/i.test(actor)).length;
    const before = profileRuns();
    const held = await step(search!.id);
    check("paused when its posts came in: the profile read waits, and no account is saved unread",
      held.status === "queued" && held.stage === "profiles" && profileRuns() === before && held.result === null,
      JSON.stringify({ status: held.status, stage: held.stage, profileRuns: profileRuns() - before, result: held.result }));
    await objectives.setObjectiveState(objective.id, "resume", { name: null });
    await finishSearches(requestId);
    const done = await jobRow(search!.id);
    const result = (done.result ?? {}) as { found?: number; eligible?: number };
    check("…resumed, the profiles are read and the verified account is a lead",
      done.status === "succeeded" && profileRuns() === before + 1 && result.found === 2 && (result.eligible ?? 0) >= 1,
      JSON.stringify({ status: done.status, profileRuns: profileRuns() - before, ...result }));
    await objectives.setObjectiveState(objective.id, "cancel", { name: null });
    await step((await driverOf(objective.id)).id);
  }

  // ---------------------------------------------------------- 5. full Apify slots: a wait, not a failure
  {
    const thread = await createThread(a.owner.id);
    const others = await db.insert(apifyRuns).values([1, 2].map(() => ({ organizationId: a.org.id, jobId: null, requestId: null, actorKey: "facebook_pages" as const, actorId: "apify~facebook-search-scraper", status: "running" as const, maxChargeUsd: 0.1, maxItems: 1 }))).returning({ id: apifyRuns.id });
    apify.items = [1, 2, 3].map((n) => ({ title: `Glow Salon ${n}`, pageUrl: `https://www.facebook.com/glowsalon${n}-${stamp}`, email: `hello@glowsalon${n}-${stamp}.test` }));
    apify.usage = 0.2;
    const requestId = await ask(thread.id, "find 3 salons in Pune on Facebook", turn("", [{ tool: "find_social_leads", args: { platform: "facebook", what: "salons", where: "Pune" } }]));
    const objective = await objectiveOf(requestId);
    const [search] = await children(requestId);
    const waiting = await step(search!.id);
    const driver = await step((await driverOf(objective.id)).id);
    const view = await objectives.objectiveView(requestId);
    check("both Apify slots busy: the search waits for one", waiting.status === "queued" && (waiting.progress as { waiting?: { kind?: string } }).waiting?.kind === "slot", JSON.stringify(waiting.progress));
    check("…and the request waits with it: active, not failed, no continuation", driver.status === "queued" && view?.status === "active" && view.continuations === 0 && /search/.test(view.waiting ?? ""), JSON.stringify({ status: view?.status, waiting: view?.waiting }));
    await db.update(apifyRuns).set({ status: "succeeded", usageUsd: 0.1, finishedAt: new Date() }).where(inArray(apifyRuns.id, others.map((row) => row.id)));
    await finishSearches(requestId);
    await step(driver.id);
    const stopped = await objectiveOf(requestId);
    check("a slot frees: the search runs, and the request reaches its target", stopped.stopReason === "target_reached" && (await reportsOf(thread.id, objective.id)).length === 1, String(stopped.stopReason));
  }

  // ---------------------------------------------------------- 6. a restart in the middle of a continuation
  {
    const thread = await createThread(a.owner.id);
    const plansBefore = planCalls.length;
    const requestId = await ask(thread.id, "find cafes in Kothrud and contact them", turn("", [{ tool: "find_leads", args: { what: "cafes", where: "Kothrud, Pune", contactAfter: true } }]));
    const objective = await objectiveOf(requestId);
    const driver = await driverOf(objective.id);
    await finishSearches(requestId);
    check("the first search's plan is prepared once, by its follow-up", planCalls.length === plansBefore + 1);
    replies = turn("Looking at coffee shops too.", [{ tool: "find_leads", args: { what: "coffee shops", where: "Kothrud, Pune", contactAfter: true } }]);
    await step(driver.id);
    await continuationEnded(requestId, 1);
    // The process stops after the continuation started its search, before it recorded its end:
    // its record says it is still under way, the chat is held by a process that is gone, and so is the driver's claim.
    await db.update(schema.assistantObjectives).set({
      progress: sql`jsonb_set(${schema.assistantObjectives.progress}, '{continuation}', (${schema.assistantObjectives.progress} -> 'continuation') || '{"endedAt": null, "end": null}'::jsonb)`,
    }).where(eq(schema.assistantObjectives.id, objective.id));
    await db.update(schema.assistantThreads).set({ busySince: new Date(Date.now() - 6 * 60_000) }).where(eq(schema.assistantThreads.id, thread.id));
    await db.update(schema.assistantJobs).set({ status: "running", lockedBy: "worker-gone", heartbeatAt: new Date(Date.now() - 4 * 60_000) }).where(eq(schema.assistantJobs.id, driver.id));
    // After the restart the model sees the search its earlier attempt started, and does not start it again.
    replies = [(input) => {
      check("after the restart the model is shown the search the interrupted continuation started", input.userPrompt.includes("TOOL find_leads({\"what\":\"coffee shops\""));
      return JSON.stringify({ message: "The coffee shops search is still running.", actions: [], suggestions: [] });
    }];
    await runOneAssistantStep({ jobId: driver.id });
    check("the driver's stale claim is taken over and the continuation taken again (attempt 2)", await continuationEnded(requestId, 1) && ((await objectiveOf(requestId)).progress as { continuation?: { attempt?: number } }).continuation?.attempt === 2);
    await step(driver.id);
    await finishSearches(requestId);
    const searches = await children(requestId);
    const scraperPosts = scraper.posts.filter((phrase) => phrase === "coffee shops in Kothrud, Pune").length;
    check("no duplicate search: one search per query, and the scraper asked once", searches.length === 2 && scraperPosts === 1, `${searches.map((job) => (job.payload as { phrase?: string }).phrase).join(", ")}; scraper asked ${scraperPosts} time(s)`);
    check("no duplicate outreach: one plan per search", planCalls.length === plansBefore + 2, String(planCalls.length - plansBefore));
    await reportFinishedJob(await jobRow(searches[1]!.id));
    await sleep(300);
    check("a duplicate search callback prepares no second plan", planCalls.length === plansBefore + 2);
    check("no duplicate note: one per continuation", (await notesOf(thread.id, objective.id)).length === 1);
    replies = [reply("Nothing else fits this request in Kothrud.")];
    await step(driver.id);
    await continuationEnded(requestId, 2);
    await step(driver.id);
    const stopped = await objectiveOf(requestId);
    check("a continuation that starts nothing: no source left, stopped with that reason", stopped.stopReason === "sources_exhausted" && /no further source/.test(stopped.stopDetail ?? ""), `${stopped.stopReason}: ${stopped.stopDetail}`);
    // The process stops again, after the report was posted and before the driver finished.
    await db.update(schema.assistantJobs).set({ status: "running", lockedBy: "worker-gone", heartbeatAt: new Date(Date.now() - 4 * 60_000) }).where(eq(schema.assistantJobs.id, driver.id));
    await runOneAssistantStep({ jobId: driver.id });
    await reconcileAssistantJobReports(0);
    await reportFinishedJob(await jobRow(driver.id));
    const reports = await reportsOf(thread.id, objective.id);
    check("one report, however often a restart, the reconciliation or a duplicate callback asks", reports.length === 1 && (await jobRow(driver.id)).status === "succeeded", String(reports.length));
    check("…and it covers both searches and the leads they found", /12 qualified leads \(contactable and matching your request\) of the 25 wanted; 13 still to find/.test(reports[0]?.content ?? ""), reports[0]?.content ?? "");
  }

  // ---------------------------------------------------------- 6a. a turn a finished job started serves that job's request
  {
    const thread = await createThread(a.owner.id);
    const requestId = await ask(thread.id, "find opticians in Pune", turn("", [{ tool: "find_leads", args: { what: "opticians", where: "Pune" } }]));
    const later = await ask(thread.id, "thanks", [reply("You're welcome.")]);
    // A search of the request ended (here, as a finished job's event would): the assistant continues on its own.
    replies = turn("Trying eye clinics too.", [{ tool: "find_leads", args: { what: "eye clinics", where: "Pune" } }]);
    await continueAfterEvent(thread.id, requestId);
    const started = (await db.select().from(schema.assistantJobs).where(and(eq(schema.assistantJobs.organizationId, a.org.id), eq(schema.assistantJobs.threadId, thread.id), eq(schema.assistantJobs.kind, "discovery"))))
      .find((job) => (job.payload as { criteria?: { what?: string } }).criteria?.what === "eye clinics");
    const tool = (await listMessages(thread.id, 500)).filter((row) => row.tool === "find_leads").at(-1);
    check("a turn a finished job started files its search under that job's request, not the owner's later message",
      (started?.payload as { requestMessageId?: string } | undefined)?.requestMessageId === requestId && later !== requestId && (tool?.toolResult as { requestId?: string } | null)?.requestId === requestId && !(await objectives.objectiveForRequest(later)),
      JSON.stringify({ request: (started?.payload as { requestMessageId?: string } | undefined)?.requestMessageId, expected: requestId, later, tool: (tool?.toolResult as { requestId?: string } | null)?.requestId }));
    const objective = await objectives.objectiveForRequest(requestId);
    await objectives.setObjectiveState(objective!.id, "cancel", { name: null });
    await db.update(schema.assistantJobs).set({ status: "cancelled" }).where(and(eq(schema.assistantJobs.organizationId, a.org.id), eq(schema.assistantJobs.threadId, thread.id), inArray(schema.assistantJobs.status, ["queued", "running"])));
  }

  // ---------------------------------------------------------- 6b. only leads that match the request count (pilot F02)
  {
    const thread = await createThread(a.owner.id);
    scraper.perPhrase = 10;
    scraper.website = (index) => (index === 1 ? `https://agency-two-${stamp}.test/` : "");
    judge = (facts) => /business [123]\b/.test(facts.businessName ?? "")
      ? { requestFit: "fits", reason: "A real estate agency in Pune.", noWebsite: true }
      : { requestFit: "does_not_fit", reason: "Not a real estate agency." };
    const before = judgedLeads.length;
    const ask25 = "find 25 real estate agencies in Pune without a website";
    const requestId = await ask(thread.id, ask25, turn("", [{ tool: "find_leads", args: { what: "real estate agencies", where: "Pune" } }]));
    const objective = await objectiveOf(requestId);
    await finishSearches(requestId);
    const [search] = await children(requestId);
    const fit = (search!.result as { fit?: { contactable: number; qualified: number; notMatching: number; unconfirmed: number; pending: number } } | null)?.fit;
    check("the search ends by judging its contactable leads against the request: 10 contactable, 2 match, 7 do not, 1 unconfirmed",
      search!.status === "succeeded" && fit?.contactable === 10 && fit.qualified === 2 && fit.notMatching === 7 && fit.unconfirmed === 1 && fit.pending === 0, JSON.stringify({ status: search!.status, stage: search!.stage, fit }));
    const seen = judgedLeads.slice(before);
    const named = (n: number) => seen.find((facts) => new RegExp(`business ${n}\\b`).test(facts.businessName ?? ""));
    check("…judged on what is known of each website: none listed on Maps, or listed but not checked (never proof of none)",
      seen.length === 10 && /^none listed on its Google Maps listing/.test(named(1)?.websiteStatus ?? "") && /^listed \(https:\/\/agency-two-\d+\.test\/\) but could not be checked/.test(named(2)?.websiteStatus ?? ""),
      JSON.stringify([named(1)?.websiteStatus, named(2)?.websiteStatus, seen.length]));
    const searchReport = (await events(thread.id)).find((row) => /Judged against your request/.test(row.content));
    check("…and its report says how many match, and why the rest do not",
      /Judged against your request: 2 of 10 contactable match your request \(7 do not \(Not a real estate agency\), 1 unconfirmed\)/.test(searchReport?.content ?? ""), searchReport?.content ?? "(none)");
    const facts = await objectives.objectiveFacts(objective);
    check("10 contactable leads of which 2 match are 2 qualified toward the target of 25, not 10",
      facts.leads === 2 && facts.funnel.contactable === 10 && facts.funnel.notMatching === 7 && facts.funnel.unconfirmed === 1 && (await objectives.objectiveStartProblem(requestId)) === null, JSON.stringify(facts.funnel));
    const again = await assessMembers({ audienceIds: facts.audienceIds, request: ask25, requestId, maxBatches: 2 });
    check("judging again judges nobody twice, and the count stays", again.judged === 0 && again.remaining === 0 && judgedLeads.length === before + 10 && (await objectives.objectiveFacts(objective)).leads === 2);
    await objectives.setObjectiveState(objective.id, "cancel", { name: null });
    const context = { threadId: thread.id, userId: a.owner.id, ownerText: ask25, requestMessageId: requestId };
    const web = await runTool("web_search", { query: "real estate agency Pune" }, context);
    const page = await runTool("read_webpage", { url: `https://agency-two-${stamp}.test/` }, context);
    check("a stopped request: web_search and read_webpage refuse with the same reason, as the searches do",
      !web.ok && !page.ok && /^Not run: this request's research has stopped/.test(web.summary) && web.summary === page.summary, `${web.summary} | ${page.summary}`);
    await step((await driverOf(objective.id)).id);
    const reports = await reportsOf(thread.id, objective.id);
    check("the final report keeps found, contactable and matching apart, with the reasons",
      reports.length === 1 && /2 qualified leads \(contactable and matching your request\) of the 25 wanted; 23 still to find/.test(reports[0]!.content)
        && /Found 10 \(10 contactable\): 2 match your request, 7 do not \(7: Not a real estate agency\), 1 unconfirmed/.test(reports[0]!.content)
        && /10 can be contacted, 2 of them match your request/.test(reports[0]!.content),
      reports.map((row) => row.content).join(" | "));
    scraper.perPhrase = 6;
    scraper.website = null;
    judge = () => ({ requestFit: "fits", reason: "What the owner asked for." });
  }

  // ---------------------------------------------------------- 6c. a research-only request never leads to outreach (pilot L01)
  {
    const thread = await createThread(a.owner.id);
    scraper.perPhrase = 2;
    // Before the fix "Spend $0" read as "send" (outreachRequested was true for these words at 652c84d), so this request is the regression check.
    const BUDGET_WORDS = "Research only. Spend $0. Do not contact anyone.";
    const REQUEST = `${BUDGET_WORDS} Find 3 dental clinics in Pune, India, and finish within 5 minutes.`;
    // Every search is seen with the context its tool got: a research-only request hands no outreach request to any turn, the continuation's included.
    const seen: { what: unknown; outreachRequest: string | null | undefined; contactAfter: unknown }[] = [];
    const realFind = TOOLS.find_leads!.run;
    TOOLS.find_leads!.run = async (args, context) => {
      seen.push({ what: args.what, outreachRequest: context.outreachRequest, contactAfter: args.contactAfter });
      return realFind(args, context);
    };
    const plansBefore = planCalls.length;
    const requestId = await ask(thread.id, REQUEST, turn("", [{ tool: "find_leads", args: { what: "dental clinics", where: "Pune, India", maxResults: 3 } }]));
    const objective = await objectiveOf(requestId);
    check("the research-only request: a target of 3, its time and $0 named, and no outreach request in the turn",
      objective.leadTarget === 3 && objective.spendCapUsd === 0 && objective.controls.named?.time === true && seen.length === 1 && seen[0]!.outreachRequest === null && seen[0]!.contactAfter === undefined,
      JSON.stringify({ target: objective.leadTarget, minutes: objective.timeLimitMinutes, spend: objective.spendCapUsd, named: objective.controls.named, seen }));
    const context = { threadId: thread.id, userId: a.owner.id, ownerText: REQUEST, requestMessageId: requestId };
    const refusals = await Promise.all([REQUEST, BUDGET_WORDS].map((ownerText) => runTool("find_leads", { what: "dental clinics", where: "Pune, India", contactAfter: true }, { ...context, ownerText })));
    check("a search that would contact what it finds is refused under “Research only. Spend $0. Do not contact anyone.”: the owner did not ask",
      refusals.every((refused) => !refused.ok && refused.refused === true && /not asked to contact/.test(refused.summary)), refusals.map((refused) => refused.summary).join(" | "));
    const judgedBefore = judgedAgainst.length;
    await finishSearches(requestId);
    // Pilot L02: the leads are judged against what to find, not against "$0", "5 minutes" or "do not contact anyone".
    check("its leads are judged against the request's subject only", judgedAgainst.length > judgedBefore && judgedAgainst.slice(judgedBefore).every((request) => request === "Find 3 dental clinics in Pune, India."), JSON.stringify(judgedAgainst.slice(judgedBefore)));
    // Short of the target (2 of 3) the driver continues the request, now with the chat in Autonomous mode.
    await db.update(schema.assistantThreads).set({ autonomous: true, autonomousBy: a.owner.id, autonomousAt: new Date() }).where(eq(schema.assistantThreads.id, thread.id));
    replies = turn("Trying dentists too.", [{ tool: "find_leads", args: { what: "dentists", where: "Pune, India", maxResults: 3 } }]);
    await step((await driverOf(objective.id)).id);
    const continued = await continuationEnded(requestId, 1);
    check("the continuation carries outreach: false, so its search got no outreach request and asked for no contact-after",
      continued && seen.length === 4 && seen[3]!.what === "dentists" && seen[3]!.outreachRequest === null && seen[3]!.contactAfter === undefined, JSON.stringify({ continued, seen }));
    const audienceId = (await children(requestId))[0]!.audienceId!;
    // The real tool this once: its own check on the owner's words, not the stand-in.
    TOOLS.prepare_outreach!.run = realPrepareOutreach;
    const plan = await runTool("prepare_outreach", { audienceId }, { ...context, autonomous: true });
    TOOLS.prepare_outreach!.run = standInPrepareOutreach;
    check("…and a plan for its leads is refused even in Autonomous mode", !plan.ok && plan.refused === true && /not asked to contact/.test(plan.summary), plan.summary);
    await finishSearches(requestId);
    await step((await driverOf(objective.id)).id);
    const runs = await db.select({ id: schema.outreachRuns.id }).from(schema.outreachRuns).where(and(eq(schema.outreachRuns.organizationId, a.org.id), eq(schema.outreachRuns.threadId, thread.id)));
    const starts = await db.select({ id: schema.assistantJobs.id }).from(schema.assistantJobs).where(and(eq(schema.assistantJobs.organizationId, a.org.id), eq(schema.assistantJobs.threadId, thread.id), eq(schema.assistantJobs.kind, "outreach_start")));
    const searches = await children(requestId);
    check("nothing was prepared, started or enqueued to send: no plan, no run, no launch, no search marked contact-after",
      planCalls.length === plansBefore && runs.length === 0 && starts.length === 0 && searches.length === 2 && searches.every((job) => (job.payload as { contactAfter?: unknown }).contactAfter == null),
      JSON.stringify({ plans: planCalls.length - plansBefore, runs: runs.length, starts: starts.length, searches: searches.map((job) => (job.payload as { contactAfter?: unknown }).contactAfter ?? null) }));
    const ended = await objectiveOf(requestId);
    check("…while the research itself reached its target", ended.status === "stopped" && ended.stopReason === "target_reached", `${ended.status} ${ended.stopReason}`);
    TOOLS.find_leads!.run = realFind;
    await db.update(schema.assistantThreads).set({ autonomous: false }).where(eq(schema.assistantThreads.id, thread.id));
    if (ended.status !== "stopped") await objectives.setObjectiveState(objective.id, "cancel", { name: null });
    scraper.perPhrase = 6;
  }

  // ---------------------------------------------------------- 6d. a later research-only message cancels an earlier request (pilot L01)
  {
    const thread = await createThread(a.owner.id);
    scraper.perPhrase = 2;
    const seen: (string | null | undefined)[] = [];
    const realFind = TOOLS.find_leads!.run;
    TOOLS.find_leads!.run = async (args, context) => {
      seen.push(context.outreachRequest);
      return realFind(args, context);
    };
    await ask(thread.id, "Find dentists in Pune and email them", [reply("Which area of Pune?")]);
    const requestId = await ask(thread.id, "Kothrud. Actually research only, do not contact anyone.", turn("", [{ tool: "find_leads", args: { what: "dentists", where: "Kothrud, Pune", maxResults: 2 } }]));
    TOOLS.find_leads!.run = realFind;
    const searches = await children(requestId);
    check("the earlier “email them” no longer stands: the search after “research only, do not contact anyone” gets no outreach request, and serves the new message",
      seen.length === 1 && seen[0] === null && searches.length === 1 && (searches[0]!.payload as { contactAfter?: unknown }).contactAfter == null, JSON.stringify({ seen, searches: searches.length }));
    // Whichever request the search was filed under, its research is cancelled and run out.
    for (const objective of await objectives.threadObjectives(thread.id)) {
      await objectives.setObjectiveState(objective.id, "cancel", { name: null });
      await finishSearches(objective.requestMessageId);
      await step((await driverOf(objective.id)).id);
    }
    scraper.perPhrase = 6;
  }

  // ---------------------------------------------------------- nothing left open
  const open = await db.select({ id: schema.assistantJobs.id, kind: schema.assistantJobs.kind }).from(schema.assistantJobs)
    .where(and(eq(schema.assistantJobs.organizationId, a.org.id), inArray(schema.assistantJobs.status, ["queued", "running"])));
  check("nothing is left queued or running in the organization", open.length === 0, JSON.stringify(open));
});

// ---------------------------------------------------------- 7. a second organization sees nothing
await runInOrganization(b.org.id, async () => {
  const seen = crossOrg!;
  check("another organization: no view of the request or its objective", (await objectives.objectiveView(seen.requestId)) === null && (await objectives.objectiveViewById(seen.objectiveId)) === null);
  check("…no objective found, no spend guard for it", (await objectives.objectiveForRequest(seen.requestId)) === null && (await objectives.objectiveSpendGuard(seen.requestId)) === undefined);
  check("…none listed for its chat", (await objectives.threadObjectives(seen.threadId)).length === 0);
  const changed = await objectives.setObjectiveState(seen.objectiveId, "cancel", { name: "Intruder" });
  check("…and cannot pause, resume or cancel it", !changed.changed && changed.objective === null);
  const ensured = await objectives.ensureObjective({ requestMessageId: seen.requestId, threadId: seen.threadId, userId: b.owner.id });
  check("…nor start one on another organization's request", ensured === null);
  check("…nor read its line", (await objectives.objectiveLine(seen.requestId)) === null);
});
const [untouched] = await db.select().from(schema.assistantObjectives).where(eq(schema.assistantObjectives.id, crossOrg!.objectiveId));
check("the first organization's objective is unchanged", untouched?.stopReason === "target_reached" && untouched.organizationId === a.org.id);

console.log(failures ? `\n${failures} check(s) failed` : "\nAll objective checks passed");
process.exit(failures ? 1 : 0);

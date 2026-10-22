/**
 * Apify as an optional discovery provider, end to end against the local
 * database, with the real discovery stages and a stand-in for Apify's API
 * (global fetch is intercepted; nothing leaves the machine):
 *
 *   bun run --conditions=react-server scripts/e2e/apify.ts
 *
 * Checks: the built-in scraper is the normal Google Maps backend (no Apify
 * Maps run while it works, even with Apify set up); Apify searches Maps only
 * when asked for (provider "apify") or as the approved fallback when the
 * scraper is missing; a full set of run slots queues the search instead of
 * handing it to website search, and it starts once when a slot frees, never
 * twice after a restart; a run left "starting" by a crash is swept; Apify
 * used only when on, set up, approved and within allowance;
 * the run recorded with its Apify run id and the owner's request id and
 * polled again after a "restart"; a run cut short keeps what it found
 * (partial); exhausted credit (at start, the account's limit, the owner's
 * budget) falls back to the scraper, an empty run too, and with no scraper
 * to website search — always with the same customer type, place and
 * request id; Instagram accounts found are kept apart from accounts that can
 * be contacted; nothing ever tops up or raises a limit; a second
 * organization sees none of it.
 *
 * Creates its own organizations ("Apify check A/B …") and leaves them;
 * removes the AI connection it made. Refuses a non-local DATABASE_URL.
 */
import { and, eq, inArray, sql } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}

const stamp = Date.now();
const SCRAPER = "http://scraper.apify-check.test";
const APIFY = "https://apify.check.test/v2";
process.env.GMAPS_SCRAPER_URL = SCRAPER;
process.env.DISCOVERY_DNS_CHECK = "off";

// ------------------------------------------------------------ Apify stand-in
type RunScript = { pollsUntilDone: number; finalStatus: string; statusMessage?: string; items: unknown[]; usage: number };
type StandInRun = RunScript & { id: string; actorId: string; input: Record<string, unknown>; query: Record<string, string>; polls: number; datasetId: string };
const apify = {
  limits: { maxMonthlyUsageUsd: 50 as number | null, monthlyUsageUsd: 5 as number | null },
  startError: null as { status: number; type: string; message: string } | null,
  next: new Map<string, RunScript[]>(),
  runs: new Map<string, StandInRun>(),
  calls: [] as string[],
};
const scraperJobs: string[] = [];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.href.startsWith(APIFY)) {
    const path = url.pathname.replace(/^\/v2/, "");
    apify.calls.push(`${method} ${path}`);
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== "Bearer apify-check-token") return json(401, { error: { type: "token-not-valid", message: "Authentication token is not valid" } });
    if (method === "GET" && path === "/users/me") return json(200, { data: { username: "check" } });
    if (method === "GET" && path === "/users/me/limits") return json(200, { data: { limits: { maxMonthlyUsageUsd: apify.limits.maxMonthlyUsageUsd }, current: { monthlyUsageUsd: apify.limits.monthlyUsageUsd } } });
    const start = path.match(/^\/actors\/([^/]+)\/runs$/);
    if (method === "POST" && start) {
      if (apify.startError) return json(apify.startError.status, { error: { type: apify.startError.type, message: apify.startError.message } });
      const actorId = decodeURIComponent(start[1]!);
      const script = apify.next.get(actorId)?.shift() ?? { pollsUntilDone: 1, finalStatus: "SUCCEEDED", items: [], usage: 0.01 };
      const id = `run-${apify.runs.size + 1}-${stamp}`;
      apify.runs.set(id, { ...script, id, actorId, input: JSON.parse(String(init?.body ?? "{}")), query: Object.fromEntries(url.searchParams), polls: 0, datasetId: `ds-${id}` });
      return json(201, { data: { id, status: "RUNNING", defaultDatasetId: `ds-${id}`, usageTotalUsd: 0 } });
    }
    const runMatch = path.match(/^\/actor-runs\/([^/]+)$/);
    if (method === "GET" && runMatch) {
      const run = apify.runs.get(runMatch[1]!);
      if (!run) return json(404, { error: { type: "record-not-found", message: "Run not found" } });
      run.polls += 1;
      const done = run.polls >= run.pollsUntilDone;
      return json(200, { data: { id: run.id, status: done ? run.finalStatus : "RUNNING", statusMessage: done ? run.statusMessage ?? null : null, defaultDatasetId: run.datasetId, usageTotalUsd: done ? run.usage : 0 } });
    }
    const items = path.match(/^\/datasets\/ds-([^/]+)\/items$/);
    if (method === "GET" && items) {
      const run = apify.runs.get(items[1]!);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 1000);
      return json(200, (run?.items ?? []).slice(offset, offset + limit));
    }
    return json(405, { error: { type: "not-in-stand-in", message: `${method} ${path}` } });
  }
  if (url.origin === SCRAPER) {
    if (method === "POST" && url.pathname === "/api/v1/jobs") {
      scraperJobs.push(String(init?.body ?? ""));
      return json(201, { id: `scrape-${scraperJobs.length}-${stamp}` });
    }
    return json(200, { ID: "x", Status: "working" });
  }
  // Nothing else may leave the machine (geocoding, websites…): answer "not found".
  if (/nominatim|openstreetmap/.test(url.hostname)) return json(200, []);
  if (url.hostname.endsWith(".test") || url.hostname.endsWith(".example") || url.hostname.endsWith(".example.in")) return new Response("not found", { status: 404 });
  return realFetch(input, init);
}) as typeof fetch;

// ------------------------------------------------------------ app modules
const { db } = await import("@/lib/db");
const { organizations } = await import("@/lib/auth/schema");
const { people } = await import("@/lib/leads/schema");
const { gridProviderCredentials, gridProviders } = await import("@/lib/grid/schema");
const { encryptIntegrationCredentials } = await import("@/lib/integrations/credentials");
const { saveByokSettings } = await import("@/lib/ai/byok");
const { assistantJobs, leadAudienceMembers } = await import("@/lib/assistant/schema");
const { memberInsights } = await import("@/lib/assistant/audiences.server");
const { apifyRuns } = await import("@/lib/apify/schema");
const { apifySettingsView, saveApifySettings, sweepStaleRuns, trackedRun } = await import("@/lib/apify/apify.server");
const { setApifyApiBase } = await import("@/services/apify");
const { DiscoveryUnavailableError, runDiscoveryStep, setDiscoveryPageOptions, startDiscovery, startInstagramProspects, startSocialProspects } = await import("@/lib/discovery/discovery.server");
const { setFeature, clearFeatureCache } = await import("@/lib/features/flags.server");
const { upsertPerson, withLeadTransaction } = await import("@/lib/leads/records");
const { saveChannelRules } = await import("@/lib/channels/rules.server");
const { runInOrganization, currentOrganizationId, inOrg } = await import("@/lib/tenancy/scope");
type AssistantJob = typeof assistantJobs.$inferSelect;

setApifyApiBase(APIFY);
setDiscoveryPageOptions({ fetchImpl: (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch });

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/** One worker step, applied to the job row as the worker applies it. */
async function step(jobId: string): Promise<AssistantJob> {
  const [job] = await db.select().from(assistantJobs).where(eq(assistantJobs.id, jobId)).limit(1);
  const outcome = await runDiscoveryStep(job!, async () => {});
  const merged = "payload" in outcome && outcome.payload ? { ...job!.payload, ...outcome.payload } : job!.payload;
  const update: Partial<AssistantJob> = outcome.next === "wait"
    ? { status: "queued", payload: merged }
    : outcome.next === "stage"
      ? { status: "queued", stage: outcome.stage, payload: merged, ...(outcome.externalId !== undefined ? { externalId: outcome.externalId } : {}) }
      : outcome.next === "done"
        ? { status: "succeeded", stage: "done", result: outcome.result }
        : { status: "failed", error: outcome.error };
  const [updated] = await db.update(assistantJobs).set({ ...update, progress: outcome.progress ?? job!.progress }).where(eq(assistantJobs.id, jobId)).returning();
  return updated!;
}

async function runToEnd(jobId: string, max = 40): Promise<AssistantJob> {
  let job = await step(jobId);
  for (let i = 0; i < max && (job.status === "queued" || job.status === "running") && job.stage !== "searching"; i += 1) job = await step(jobId);
  return job;
}

const payloadOf = (job: AssistantJob) => job.payload as Record<string, unknown> & { contactAfter?: { requestId?: string } | null; providerNotes?: string[]; provider?: string };
const contactAfter = (requestId: string) => ({ channels: null, ownerRequest: "find dentists in Pune and contact them", requestId });
const criteria = (what = "dentists", where = "Pune, India", maxResults = 20) => ({ what, where, maxResults, language: "en" });
const context = { threadId: null, userId: null };

const mapsItems = [
  { title: "Lotus Dental Clinic", placeId: "p1", categoryName: "Dentist", city: "Pune", countryCode: "IN", phone: "020 2553 1234", emails: ["hello@lotusdental.example"], url: "https://maps.google.com/?cid=1" },
  { title: "Lotus Dental Clinic", placeId: "p1", phone: "020 2553 1234" },
  { title: "Smile Care", placeId: "p2", countryCode: "IN", phone: "020 2555 0003", url: "https://maps.google.com/?cid=2" },
  { title: "Smile Care Annexe", placeId: "p3", countryCode: "IN", phone: "020 2555 0003", url: "https://maps.google.com/?cid=3" },
  { title: "Quiet Dental", placeId: "p4", countryCode: "IN", url: "https://maps.google.com/?cid=4" },
];

// ------------------------------------------------------------ organizations
const [orgA] = await db.insert(organizations).values({ name: `Apify check A ${stamp}`, slug: `apify-check-a-${stamp}` }).returning();
const [orgB] = await db.insert(organizations).values({ name: `Apify check B ${stamp}`, slug: `apify-check-b-${stamp}` }).returning();
const createdProviders: string[] = [];
let runOfA = "";
// These checks are about a workspace's own Apify token (My own provider); the Included service is checked in managed-saas.ts.
const { setServiceMode } = await import("@/lib/managed/modes.server");
for (const org of [orgA!, orgB!]) await runInOrganization(org.id, () => setServiceMode("apify", "own", null, "apify e2e: own token"));

await runInOrganization(orgA!.id, async () => {
  clearFeatureCache();
  await saveChannelRules("general", { defaultPhoneCountry: "IN" }, null);

  // ---------------------------------------------------------- off by default
  const off = await startDiscovery(criteria(), context, { contactAfter: contactAfter("req-off") });
  check("off by default: the search runs on the scraper and says nothing about Apify", off.provider === "scraper" && !/Apify/.test(off.note ?? "") && /built-in scraper/.test(off.note ?? ""), `${off.provider} ${off.note}`);
  check("off by default: Apify is never called", apify.calls.length === 0, apify.calls.join(", "));
  const offJob = await step(off.jobId);
  check("off by default: the job starts the scraper search", offJob.stage === "searching" && payloadOf(offJob).provider === "scraper");

  // ---------------------------------------------------------- set up
  await setFeature("apify_discovery", true, null);
  clearFeatureCache();
  const notConnected = await startDiscovery(criteria(), context, {});
  check("feature on but no token: the scraper searches, Apify is not even consulted", notConnected.provider === "scraper" && !/Apify/.test(notConnected.note ?? ""), notConnected.note ?? "");
  const askedNoToken = await startDiscovery(criteria(), context, { provider: "apify" });
  check("Apify asked for but no token: the scraper searches, and the note says why", askedNoToken.provider === "scraper" && /asked for but not used/.test(askedNoToken.note ?? "") && /no Apify token/.test(askedNoToken.note ?? ""), askedNoToken.note ?? "");
  let refusedToken = "";
  try {
    await saveApifySettings({ token: "wrong-token" }, null);
  } catch (error) {
    refusedToken = error instanceof Error ? error.message : String(error);
  }
  check("a token Apify rejects is not saved", /rejected/.test(refusedToken), refusedToken);
  const view = await saveApifySettings({ token: "apify-check-token", approvedActors: ["google_maps"], monthlyBudgetUsd: 10, maxChargePerRunUsd: 2, maxResultsPerRun: 50 }, null);
  check("settings saved: connected, token never returned", view.connected && view.tokenHint === "…oken" && !JSON.stringify(view).includes("apify-check-token"), JSON.stringify(view));

  // ---------------------------------------------------------- an existing lead, to be reused
  const existing = await withLeadTransaction((tx) => upsertPerson(tx, { email: "hello@lotusdental.example", raw: { note: "already a lead" }, source: "e2e:apify" }));

  // ---------------------------------------------------------- the built-in scraper stays the normal backend
  const runsAtStart = apify.runs.size;
  const normal = await startDiscovery(criteria("dentists", "Nagpur, India"), context, {});
  const normalJob = await step(normal.jobId);
  check("Apify set up and approved, scraper healthy: a normal Maps search uses the built-in scraper", normal.provider === "scraper" && normalJob.stage === "searching" && payloadOf(normalJob).provider === "scraper", `${normal.provider} ${normalJob.stage}`);
  check("…and no Apify Maps run is started for it", apify.runs.size === runsAtStart && !apify.calls.some((call) => call.startsWith("POST /actors")));
  await db.update(assistantJobs).set({ status: "cancelled" }).where(eq(assistantJobs.id, normal.jobId));

  // ---------------------------------------------------------- a full Apify run (asked for)
  apify.next.set("compass~crawler-google-places", [{ pollsUntilDone: 2, finalStatus: "SUCCEEDED", items: mapsItems, usage: 0.42 }]);
  const started = await startDiscovery(criteria(), context, { contactAfter: contactAfter("req-apify"), provider: "apify" });
  check("asked for Apify, set up, approved, allowance left: the search runs on Apify and says why", started.provider === "apify" && /owner asked for Apify/.test(started.note ?? ""), `${started.provider} ${started.note}`);
  let job = await step(started.jobId);
  const opened = (payloadOf(job).apify ?? null) as { runRowId: string } | null;
  const row = opened ? await trackedRun(opened.runRowId) : null;
  runOfA = row?.id ?? "";
  const run = row?.apifyRunId ? apify.runs.get(row.apifyRunId) : undefined;
  check("the run is recorded with Apify's run id, its dataset and the owner's request id", Boolean(row?.apifyRunId && row.datasetId && row.status === "running" && row.requestId === "req-apify" && row.jobId === started.jobId), JSON.stringify(row));
  check("the run is started with hard limits: spending cap, item cap, timeout, memory", run?.query.maxTotalChargeUsd === "2" && run?.query.maxItems === "20" && Boolean(run?.query.timeout) && Boolean(run?.query.memory), JSON.stringify(run?.query));
  check("the Actor gets the requested customer type and place", run?.input.locationQuery === "Pune, India" && (run?.input.searchStringsArray as string[])?.[0] === "dentists" && run?.input.maxCrawledPlacesPerSearch === 20);
  check("while the run is open its cap is reserved against the budget", (await apifySettingsView()).reservedUsd === 2);

  // A restart: the job is read back from the database and polls the same run.
  const pollsBefore = apify.calls.filter((call) => call === `GET /actor-runs/${row?.apifyRunId}`).length;
  job = await step(started.jobId);
  check("after a restart the job polls the same recorded Apify run", job.stage === "apify" && apify.calls.filter((call) => call === `GET /actor-runs/${row?.apifyRunId}`).length === pollsBefore + 1);
  job = await runToEnd(started.jobId);
  const result = (job.result ?? {}) as Record<string, unknown>;
  check("the run's businesses are saved: duplicates in the dataset collapse, same-phone businesses are one contact", job.status === "succeeded" && result.found === 4 && result.provider === "apify" && Number(result.duplicates) === 1, JSON.stringify(result));
  const members = await db.select().from(leadAudienceMembers).where(eq(leadAudienceMembers.audienceId, started.audienceId));
  check("an existing lead is reused, not duplicated", members.some((member) => member.personId === existing.id));
  const lotus = await db.select().from(people).where(and(inOrg(people), eq(people.email, "hello@lotusdental.example")));
  check("no second person for the same email", lotus.length === 1);
  check("a business with no contact stays excluded with the reason", members.some((member) => member.personId === null && /no email or phone/.test(member.reason ?? "")));
  const finished = await trackedRun(runOfA);
  check("the run's row records Apify's reported cost and the items read", finished?.status === "succeeded" && finished.usageUsd === 0.42 && finished.itemsRead === 5 && !finished.partial, JSON.stringify(finished));

  // ---------------------------------------------------------- partial result
  apify.next.set("compass~crawler-google-places", [{ pollsUntilDone: 1, finalStatus: "ABORTED", statusMessage: "The run reached its maximum total charge (maxTotalChargeUsd)", items: mapsItems.slice(2, 4), usage: 0.3 }]);
  const partialStart = await startDiscovery(criteria("dentists", "Pune, India", 30), context, { contactAfter: contactAfter("req-partial"), provider: "apify" });
  const partialJob = await runToEnd(partialStart.jobId);
  const partialResult = (partialJob.result ?? {}) as Record<string, unknown>;
  check("a run cut short by its cap keeps what it found", partialJob.status === "succeeded" && partialResult.found === 2, JSON.stringify(partialResult));
  check("…and says so: ended early, and AgentSDR never tops up", /ended early/.test(String(partialResult.providerNote)) && /never tops up/.test(String(partialResult.providerNote)), String(partialResult.providerNote));
  const partialRow = (await db.select().from(apifyRuns).where(and(inOrg(apifyRuns), eq(apifyRuns.jobId, partialStart.jobId))))[0];
  check("…and the row is marked partial", partialRow?.status === "partial" && partialRow.partial === true && partialRow.itemsRead === 2);

  // ---------------------------------------------------------- an empty run falls back in place
  apify.next.set("compass~crawler-google-places", [{ pollsUntilDone: 1, finalStatus: "SUCCEEDED", items: [], usage: 0.01 }]);
  const emptyStart = await startDiscovery(criteria("orthodontists"), context, { contactAfter: contactAfter("req-empty"), provider: "apify" });
  const emptyJob = await runToEnd(emptyStart.jobId);
  check("an Apify run with nothing hands the same job to the scraper, keeping the request id", emptyJob.stage === "searching" && payloadOf(emptyJob).provider === "scraper" && payloadOf(emptyJob).contactAfter?.requestId === "req-empty" && /no businesses/.test((payloadOf(emptyJob).providerNotes ?? []).join(" ")));
  // The scraper that took over then fails: Apify already searched, so it is not paid for again.
  await db.update(assistantJobs).set({ payload: { ...emptyJob.payload, deadline: new Date(Date.now() - 60_000).toISOString() } }).where(eq(assistantJobs.id, emptyStart.jobId));
  const emptyAfterScraper = await step(emptyStart.jobId);
  const emptyRuns = await db.select().from(apifyRuns).where(and(inOrg(apifyRuns), eq(apifyRuns.jobId, emptyStart.jobId)));
  check("…and when that scraper search fails, Apify (which already searched) is not run a second time", emptyAfterScraper.status === "failed" && emptyRuns.length === 1 && payloadOf(emptyAfterScraper).provider === "scraper", `${emptyAfterScraper.status} ${emptyRuns.length} run(s) ${payloadOf(emptyAfterScraper).provider}`);

  // ---------------------------------------------------------- credits exhausted at start
  apify.startError = { status: 402, type: "not-enough-usage-to-run-paid-actor", message: "You have exceeded your monthly usage limit" };
  const exhaustedStart = await startDiscovery(criteria("dental labs"), context, { contactAfter: contactAfter("req-402"), provider: "apify" });
  const exhaustedJob = await step(exhaustedStart.jobId);
  check("credits exhausted at start: the same job falls back to the scraper", exhaustedJob.stage === "searching" && payloadOf(exhaustedJob).provider === "scraper");
  check("…keeping the customer type, the place and the request id", payloadOf(exhaustedJob).contactAfter?.requestId === "req-402" && (payloadOf(exhaustedJob).criteria as { what: string; where: string }).what === "dental labs" && scraperJobs.at(-1)?.includes("dental labs") === true);
  check("…and explaining it: not started, never topped up", /did not start/.test((payloadOf(exhaustedJob).providerNotes ?? []).join(" ")) && /never tops up/.test((payloadOf(exhaustedJob).providerNotes ?? []).join(" ")), (payloadOf(exhaustedJob).providerNotes ?? []).join(" "));
  const refusedRow = (await db.select().from(apifyRuns).where(and(inOrg(apifyRuns), eq(apifyRuns.jobId, exhaustedStart.jobId))))[0];
  check("…and the refused run is recorded with the reason and no cost", refusedRow?.status === "refused" && refusedRow.usageUsd === 0 && /exceeded/.test(refusedRow.error ?? ""));
  apify.startError = null;

  // ---------------------------------------------------------- the account's own limit reached
  apify.limits = { maxMonthlyUsageUsd: 50, monthlyUsageUsd: 50 };
  const runsBefore = apify.runs.size;
  const accountFull = await startDiscovery(criteria("pediatric dentists"), context, { contactAfter: contactAfter("req-account"), provider: "apify" });
  const accountJob = await step(accountFull.jobId);
  check("the Apify account's limit reached: scraper, with the reason", accountFull.provider === "scraper" && /usage limit is reached/.test(accountFull.note ?? "") && /never tops up/.test(accountFull.note ?? ""), accountFull.note ?? "");
  check("…no run is started at Apify", apify.runs.size === runsBefore && accountJob.stage === "searching");
  apify.limits = { maxMonthlyUsageUsd: 50, monthlyUsageUsd: 5 };

  // ---------------------------------------------------------- the owner's budget used
  await saveApifySettings({ monthlyBudgetUsd: 0.5 }, null);
  const overBudget = await startDiscovery(criteria("cosmetic dentists"), context, { provider: "apify" });
  check("this month's spend ($0.72) over the owner's budget ($0.50): scraper, with the reason", overBudget.provider === "scraper" && /budget/.test(overBudget.note ?? ""), overBudget.note ?? "");
  await saveApifySettings({ monthlyBudgetUsd: 10 }, null);

  // ---------------------------------------------------------- no scraper either: website search takes the request
  delete process.env.GMAPS_SCRAPER_URL;
  const approvedFallback = await startDiscovery(criteria("dentists", "Mumbai, India", 10), context, {});
  check("no scraper, Maps Actor approved: Apify searches as the approved fallback, with the reason", approvedFallback.provider === "apify" && /not set up on this server/.test(approvedFallback.note ?? "") && /approved/.test(approvedFallback.note ?? ""), approvedFallback.note ?? "");
  apify.next.set("compass~crawler-google-places", [{ pollsUntilDone: 1, finalStatus: "SUCCEEDED", items: [], usage: 0.01 }]);
  const fallbackEmpty = await runToEnd(approvedFallback.jobId);
  const fallbackRuns = await db.select().from(apifyRuns).where(and(inOrg(apifyRuns), eq(apifyRuns.jobId, approvedFallback.jobId)));
  check("…an empty fallback run is not started and paid for a second time, and the job does not claim Apify searched \"instead\"", fallbackRuns.length === 1 && fallbackEmpty.status === "failed" && !/through Apify instead/.test(`${fallbackEmpty.error} ${(payloadOf(fallbackEmpty).providerNotes ?? []).join(" ")}`), `${fallbackRuns.length} run(s), ${fallbackEmpty.status}: ${fallbackEmpty.error}`);
  await db.update(assistantJobs).set({ status: "cancelled" }).where(eq(assistantJobs.id, approvedFallback.jobId));
  apify.startError = { status: 402, type: "not-enough-usage-to-run-paid-actor", message: "Not enough usage" };
  apify.limits = { maxMonthlyUsageUsd: 50, monthlyUsageUsd: 50 };
  let unavailable = "";
  try {
    await startDiscovery(criteria("dentists"), context, { contactAfter: contactAfter("req-none") });
  } catch (error) {
    unavailable = error instanceof DiscoveryUnavailableError ? error.message : String(error);
  }
  check("nothing available at all: it says so instead of pretending", /GMAPS_SCRAPER_URL/.test(unavailable) && /Apify was not used/.test(unavailable), unavailable);
  await setFeature("web_discovery", true, null);
  clearFeatureCache();
  const [connection] = await db.insert(gridProviders).values({
    organizationId: currentOrganizationId(),
    key: `ai-openrouter-apify-check-${stamp}`,
    name: "openrouter (apify check)",
    config: { aiProviderKey: "openrouter", verification: { status: "verified", verifiedAt: new Date().toISOString() } },
    enabled: true,
  }).returning();
  await db.insert(gridProviderCredentials).values({ providerId: connection!.id, encryptedPayload: encryptIntegrationCredentials({ apiKey: "sk-or-check", managementKey: "sk-or-mgmt-check" }) });
  createdProviders.push(connection!.id);
  await saveByokSettings({ connectionId: connection!.id, providers: ["openai"], modelsByProvider: { openai: ["openai/gpt-5-mini"] }, defaultModel: { provider: "openai", modelId: "openai/gpt-5-mini" }, transcriptionModel: null, researchModel: null, researchDailyLimit: 25, byokOnlyConfirmed: true });
  const website = await startDiscovery(criteria("dentists", "Pune, India", 20), context, { contactAfter: contactAfter("req-web") });
  const [webJob] = await db.select().from(assistantJobs).where(eq(assistantJobs.id, website.jobId));
  const webPayload = (webJob?.payload ?? {}) as { criteria?: { customers?: string; where?: string }; contactAfter?: { requestId?: string } };
  check("no scraper and Apify exhausted: website search takes the request", website.provider === "website" && webJob?.kind === "web_discovery", `${website.provider} ${webJob?.kind}`);
  check("…with the same customer type, place and request id (its plan inherits the request's approval)", webPayload.contactAfter?.requestId === "req-web" && webPayload.criteria?.customers === "dentists" && webPayload.criteria?.where === "Pune, India", JSON.stringify(webPayload));
  check("…and explains the coverage difference", /fewer than a Maps search/.test(website.note ?? "") && /Apify was not used/.test(website.note ?? ""), website.note ?? "");
  await db.update(assistantJobs).set({ status: "cancelled" }).where(eq(assistantJobs.id, website.jobId));
  // A search job that hands its request to website search, run again because its result could not be saved: one website search, not two.
  const [handing] = await db.insert(assistantJobs).values({
    organizationId: currentOrganizationId(), kind: "discovery", stage: "queued",
    payload: { criteria: criteria("dentists", "Nashik, India", 10), phrase: "dentists in Nashik, India", provider: "apify", contactAfter: contactAfter("req-handoff"), requestMessageId: "req-handoff" },
    progress: { stage: "queued" },
  }).returning();
  const handedTo = (outcome: Awaited<ReturnType<typeof runDiscoveryStep>>) => (outcome.next === "done" ? outcome.result.handedToJobId : null);
  const firstHandOff = await runDiscoveryStep(handing!, async () => {});
  const againHandOff = await runDiscoveryStep(handing!, async () => {});
  const handedJobs = await db.select().from(assistantJobs).where(and(inOrg(assistantJobs), sql`${assistantJobs.payload} ->> 'handedOffFrom' = ${handing!.id}`));
  check("a search job that hands its request to website search and runs again finds the search it started: one website search, not two",
    handedJobs.length === 1 && handedTo(firstHandOff) === handedJobs[0]!.id && handedTo(againHandOff) === handedJobs[0]!.id,
    JSON.stringify({ created: handedJobs.length, first: handedTo(firstHandOff), again: handedTo(againHandOff), error: againHandOff.next === "failed" ? againHandOff.error : null }));
  for (const job of handedJobs) await db.update(assistantJobs).set({ status: "cancelled" }).where(eq(assistantJobs.id, job.id));
  process.env.GMAPS_SCRAPER_URL = SCRAPER;
  apify.startError = null;
  apify.limits = { maxMonthlyUsageUsd: 50, monthlyUsageUsd: 5 };

  // ---------------------------------------------------------- Instagram: found is not contactable
  await setFeature("web_discovery", false, null);
  clearFeatureCache();
  let noInstagram = "";
  try {
    await startInstagramProspects({ what: "home bakers", where: "Pune", maxResults: 10, language: "en" }, context, {});
  } catch (error) {
    noInstagram = error instanceof DiscoveryUnavailableError ? error.message : String(error);
  }
  check("Instagram Actor not approved and no website search: nothing is searched, and it says why", /not approved/.test(noInstagram) && /nothing was searched/.test(noInstagram), noInstagram);
  await saveApifySettings({ approvedActors: ["google_maps", "instagram_hashtags", "instagram_profiles"] }, null);
  apify.next.set("apify~instagram-hashtag-scraper", [{
    pollsUntilDone: 1,
    finalStatus: "SUCCEEDED",
    usage: 0.05,
    items: [
      { ownerUsername: "sweet.treats", url: "https://www.instagram.com/p/a1/", caption: "Custom birthday cakes, delivered across Pune", timestamp: "2026-10-10T10:00:00Z", inputUrl: "https://www.instagram.com/explore/tags/punehomebaker/" },
      { ownerUsername: "sweet.treats", url: "https://www.instagram.com/p/a2/", caption: "Another cake", timestamp: "2026-10-09T10:00:00Z" },
      { ownerUsername: "crumbs.and.co", url: "https://www.instagram.com/p/b1/", caption: "Weekend bake sale! 🍰", timestamp: "2026-10-08T10:00:00Z" },
    ],
  }]);
  apify.next.set("apify~instagram-profile-scraper", [{
    pollsUntilDone: 1,
    finalStatus: "SUCCEEDED",
    usage: 0.04,
    items: [
      { username: "sweet.treats", fullName: "Sweet Treats", biography: "Home bakery · Pune", businessEmail: "orders@sweettreats.example", businessCategoryName: "Bakery" },
      { username: "crumbs.and.co", fullName: "Crumbs & Co", biography: "Cakes and cookies" },
    ],
  }]);
  const ig = await startInstagramProspects({ what: "home bakers", where: "Pune", hashtags: ["PuneHomeBaker"], maxResults: 10, language: "en" }, context, { contactAfter: contactAfter("req-ig") });
  check("Instagram prospect search runs on Apify, and says that finding is not contacting: a DM needs a connected sender and an approved plan", ig.provider === "apify" && /Instagram DMs require a connected Instagram sender and an approved outreach plan/.test(ig.note ?? ""), ig.note ?? "");
  const igJob = await runToEnd(ig.jobId);
  const igResult = (igJob.result ?? {}) as Record<string, unknown>;
  const hashtagRun = [...apify.runs.values()].find((entry) => entry.actorId === "apify~instagram-hashtag-scraper");
  const profileRun = [...apify.runs.values()].find((entry) => entry.actorId === "apify~instagram-profile-scraper");
  check("hashtags keep the owner's own and the customer type in the place", (hashtagRun?.input.hashtags as string[] | undefined)?.join(",") === "punehomebaker,punehomebaker,homebakerpune,homebaker".split(",").filter((tag, index, all) => all.indexOf(tag) === index).join(","), JSON.stringify(hashtagRun?.input.hashtags));
  check("profiles are read once per account (posts deduplicated)", JSON.stringify(profileRun?.input.usernames) === JSON.stringify(["sweet.treats", "crumbs.and.co"]), JSON.stringify(profileRun?.input.usernames));
  check("two accounts found; the one naming Pune is a lead (with the email its profile publishes); the other, Instagram-only and not naming Pune, is kept for research", igJob.status === "succeeded" && igResult.found === 2 && igResult.eligible === 1 && igResult.withEmail === 1 && igResult.instagramOnly === 1, JSON.stringify(igResult));
  const igMembers = await memberInsightsOf(ig.audienceId);
  const contactable = igMembers.find((member) => member.personId);
  const unreachable = igMembers.find((member) => !member.personId);
  check("the contactable one's email is sourced to the Instagram profile it was published on", JSON.stringify(contactable?.evidence ?? []).includes("\"source\":\"Instagram profile\"") && JSON.stringify(contactable?.evidence ?? []).includes("instagram.com/sweet.treats"), JSON.stringify(contactable?.evidence));
  check("the other is kept for research because its location is not verified (a hashtag does not place it), never called uncontactable", /location is not verified/.test(unreachable?.reason ?? "") && /kept for research/.test(unreachable?.reason ?? "") && !/cannot|no supported channel/.test(unreachable?.reason ?? "") && JSON.stringify(unreachable?.evidence ?? []).includes("instagram.com/crumbs.and.co"), unreachable?.reason ?? "");
  check("a post is a potential match, not interest; the place is unknown when not named", /potential match, not interest/.test(contactable?.matchReason ?? "") && /Unknown/.test((unreachable?.facts as Record<string, string> | undefined)?.location ?? ""), `${contactable?.matchReason} | ${JSON.stringify(unreachable?.facts)}`);
  check("a generic post caption is engagement, not a need", (unreachable?.signals ?? []).every((signal) => signal.kind === "engagement"));
  check("both Instagram runs carry the request id", [...(await db.select().from(apifyRuns).where(and(inOrg(apifyRuns), eq(apifyRuns.jobId, ig.jobId))))].every((entry) => entry.requestId === "req-ig"));

  // ---------------------------------------------------------- a step that runs again does not pay for the profiles twice
  // The worker runs a step again when its result could not be saved: here the hashtag step's outcome (profiles started) is lost.
  apify.next.set("apify~instagram-hashtag-scraper", [{ pollsUntilDone: 1, finalStatus: "SUCCEEDED", usage: 0.05, items: [{ ownerUsername: "again.bakes", url: "https://www.instagram.com/p/c1/", caption: "Cakes across Pune", timestamp: "2026-10-10T10:00:00Z" }] }]);
  const again = await startInstagramProspects({ what: "cake shops", where: "Pune", maxResults: 5, language: "en" }, context, { contactAfter: contactAfter("req-again") });
  const atHashtags = await step(again.jobId);
  const profileRuns = () => [...apify.runs.values()].filter((entry) => entry.actorId === "apify~instagram-profile-scraper").length;
  await runDiscoveryStep(atHashtags, async () => {});
  const startedOnce = profileRuns();
  const [profilesRow] = await db.select().from(apifyRuns).where(and(inOrg(apifyRuns), eq(apifyRuns.jobId, again.jobId), eq(apifyRuns.actorKey, "instagram_profiles")));
  await db.update(apifyRuns).set({ status: "succeeded", usageUsd: 0.04, finishedAt: new Date() }).where(eq(apifyRuns.id, profilesRow!.id));
  const reread = await runDiscoveryStep(atHashtags, async () => {});
  check("a hashtag step that runs again after its profiles run finished reads that run (free), it does not start another",
    profileRuns() === startedOnce && reread.next === "stage" && (reread.payload?.apify as { runRowId?: string } | undefined)?.runRowId === profilesRow!.id, `${profileRuns()} vs ${startedOnce} ${JSON.stringify(reread).slice(0, 200)}`);
  await db.update(apifyRuns).set({ status: "failed", error: "no answer from Apify for 2 hours (swept)" }).where(eq(apifyRuns.id, profilesRow!.id));
  const notRepaid = await runDiscoveryStep(atHashtags, async () => {});
  check("…and once that run was swept as failed, the profiles are not paid for again: the accounts go on unread, with the reason",
    profileRuns() === startedOnce && /Profiles were not read \(an earlier attempt's run failed .*not paid for again\)/.test(JSON.stringify(notRepaid)), `${profileRuns()} vs ${startedOnce} ${JSON.stringify(notRepaid).slice(0, 300)}`);

  // ---------------------------------------------------------- social platforms (find_social_leads)
  let socialRefused = "";
  try {
    await startSocialProspects("facebook", { what: "kitchen contractors", where: "Langley, BC", maxResults: 10, language: "en" }, context, {});
  } catch (error) {
    socialRefused = error instanceof DiscoveryUnavailableError ? error.message : String(error);
  }
  check("Facebook Actor not approved: nothing is searched, and it says where to approve it", /not approved/.test(socialRefused) && /Settings → Providers & features → Apify/.test(socialRefused), socialRefused);
  await saveApifySettings({ approvedActors: ["google_maps", "instagram_hashtags", "instagram_profiles", "instagram_search", "facebook_pages", "linkedin_companies"] }, null);
  // A company website that publishes its contacts (LinkedIn shows none).
  setDiscoveryPageOptions({
    allowPrivate: true,
    fetchImpl: (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      return url.startsWith("https://acmerobotics.example")
        ? new Response("<html><body><h1>Acme Robotics</h1><p>Sales: sales@acmerobotics.example</p><p>Call +1 512 555 0100</p></body></html>", { status: 200, headers: { "content-type": "text/html" } })
        : new Response("not found", { status: 404 });
    }) as unknown as typeof fetch,
  });

  apify.next.set("apify~facebook-search-scraper", [{
    pollsUntilDone: 1,
    finalStatus: "SUCCEEDED",
    usage: 0.03,
    items: [
      { facebookUrl: "https://www.facebook.com/MKDCLangley", pageUrl: "https://www.facebook.com/MKDCLangley", pageId: "100063562495135", title: "Merit Kitchens Design Centre Langley", categories: ["Page", "Kitchen & bathroom contractor"], address: "19888 Langley Bypass, Langley, BC", phone: "+1 604-532-7197", email: "langley@merit-kitchens.com", website: "meritdesignlangley.com" },
      { pageUrl: "https://www.facebook.com/quietkitchens", pageId: "200", title: "Quiet Kitchens", categories: ["Page", "Contractor"] },
    ],
  }]);
  const fb = await startSocialProspects("facebook", { what: "kitchen contractors", where: "Langley, BC", maxResults: 10, language: "en" }, context, { contactAfter: contactAfter("req-fb") });
  const fbJob = await runToEnd(fb.jobId);
  const fbRun = [...apify.runs.values()].find((entry) => entry.actorId === "apify~facebook-search-scraper");
  const fbResult = (fbJob.result ?? {}) as Record<string, unknown>;
  check("Facebook search asks the Actor for the kind of business in the place", JSON.stringify(fbRun?.input.categories) === "[\"kitchen contractors\"]" && JSON.stringify(fbRun?.input.locations) === "[\"Langley, BC\"]" && typeof fbRun?.input.resultsLimit === "number", JSON.stringify(fbRun?.input));
  check("two pages found; the one publishing an email and phone is contactable, the other is excluded with the reason", fbJob.status === "succeeded" && fbResult.found === 2 && fbResult.eligible === 1, JSON.stringify(fbResult));
  const fbMembers = await memberInsightsOf(fb.audienceId);
  const fbContact = fbMembers.find((member) => member.personId);
  const fbExcluded = fbMembers.find((member) => !member.personId);
  check("…its contacts are sourced to the Facebook page, and the lead's source says Facebook", JSON.stringify(fbContact?.evidence ?? []).includes("\"source\":\"Facebook page\"") && fbContact?.source === "apify_facebook", `${fbContact?.source} ${JSON.stringify(fbContact?.evidence)}`);
  check("…the other: no email or phone on its Facebook page", /no email or phone on its Facebook page/.test(fbExcluded?.reason ?? ""), fbExcluded?.reason ?? "");

  apify.next.set("harvestapi~linkedin-company-search", [{
    pollsUntilDone: 1,
    finalStatus: "SUCCEEDED",
    usage: 0.06,
    items: [{ id: "213520", name: "Acme Robotics", linkedinUrl: "https://www.linkedin.com/company/acme-robotics/", website: "https://acmerobotics.example", industries: [{ name: "Industrial Automation" }], headquarter: { city: "Austin", country: "US" } }],
  }]);
  const li = await startSocialProspects("linkedin", { what: "robotics companies", where: "Austin, Texas", maxResults: 10, language: "en" }, context, {});
  check("LinkedIn search says it reads LinkedIn without logging in, against LinkedIn's terms", /User Agreement does not allow scraping/.test(li.note ?? ""), li.note ?? "");
  const liJob = await runToEnd(li.jobId);
  const liRun = [...apify.runs.values()].find((entry) => entry.actorId === "harvestapi~linkedin-company-search");
  check("LinkedIn search asks for full company profiles (with websites) by keyword and place", liRun?.input.searchQuery === "robotics companies" && JSON.stringify(liRun?.input.locations) === "[\"Austin, Texas\"]" && liRun?.input.scraperMode === "full", JSON.stringify(liRun?.input));
  const liMembers = await memberInsightsOf(li.audienceId);
  check("a LinkedIn company is contacted by the email its own website publishes, and keeps its LinkedIn page", liJob.status === "succeeded" && Boolean(liMembers[0]?.personId) && JSON.stringify(liMembers[0]?.evidence ?? []).includes("sales@acmerobotics.example") && JSON.stringify(liMembers[0]?.evidence ?? []).includes("linkedin.com/company/acme-robotics"), JSON.stringify(liMembers[0]?.evidence));

  apify.next.set("apify~instagram-search-scraper", [{ pollsUntilDone: 1, finalStatus: "SUCCEEDED", usage: 0.01, items: [{ username: "glow.salon.la" }, { username: "nails.by.kim" }, { username: "brows.la" }] }]);
  apify.next.set("apify~instagram-profile-scraper", [{
    pollsUntilDone: 1,
    finalStatus: "SUCCEEDED",
    usage: 0.02,
    items: [
      { username: "glow.salon.la", fullName: "Glow Salon", biography: "Beauty salon in Los Angeles", businessEmail: "hi@glowsalon.example", businessCategoryName: "Beauty salon" },
      { username: "nails.by.kim", fullName: "Nails by Kim", biography: "Nail art" },
      { username: "brows.la", fullName: "Brow Bar", biography: "Brow studio in Los Angeles · DM to book" },
    ],
  }]);
  const igSearch = await startSocialProspects("instagram", { what: "beauty salons", where: "Los Angeles", maxResults: 10, language: "en" }, context, {});
  const igSearchJob = await runToEnd(igSearch.jobId);
  const searchRun = [...apify.runs.values()].find((entry) => entry.actorId === "apify~instagram-search-scraper");
  const igSearchResult = (igSearchJob.result ?? {}) as Record<string, unknown>;
  check("Instagram account search asks for accounts matching the kind of business and place, then reads their profiles", searchRun?.input.search === "beauty salons Los Angeles" && searchRun?.input.searchType === "user" && igSearchJob.status === "succeeded" && igSearchResult.found === 3 && igSearchResult.eligible === 2, `${JSON.stringify(searchRun?.input)} ${JSON.stringify(igSearchResult)}`);
  const igSearchMembers = await memberInsightsOf(igSearch.audienceId);
  const brows = igSearchMembers.find((member) => JSON.stringify(member.evidence).includes("instagram.com/brows.la"));
  const browsPerson = brows?.personId ? (await db.select().from(people).where(eq(people.id, brows.personId)))[0] : null;
  check("an Instagram-only account whose profile names the place is a qualified lead: saved with its Instagram username and no email or phone (decision 16)",
    Boolean(brows?.personId) && !brows?.reason && !browsPerson?.email && !browsPerson?.phone && (browsPerson?.raw as { instagram?: { username?: string } } | null)?.instagram?.username === "brows.la",
    JSON.stringify({ reason: brows?.reason ?? null, email: browsPerson?.email ?? null, raw: browsPerson?.raw ?? null }));
  const nails = igSearchMembers.find((member) => JSON.stringify(member.evidence).includes("instagram.com/nails.by.kim"));
  check("…while the one that does not name Los Angeles is kept for research", !nails?.personId && /location is not verified/.test(nails?.reason ?? ""), nails?.reason ?? "missing");
  check("…an account found by search is a potential match from Instagram's account search", igSearchMembers.some((member) => /Instagram's account search/.test(member.matchReason ?? "")), igSearchMembers.map((member) => member.matchReason).join(" | "));

  // ---------------------------------------------------------- every run slot busy: wait, never hand off
  const fillers = await db.insert(apifyRuns).values([0, 1].map(() => ({
    organizationId: currentOrganizationId(), jobId: null, requestId: null, actorKey: "google_maps" as const, actorId: "compass~crawler-google-places", status: "running" as const, maxChargeUsd: 0.1, maxItems: 1,
  }))).returning({ id: apifyRuns.id });
  const runsBeforeWait = apify.runs.size;
  const queued = await startInstagramProspects({ what: "home bakers", where: "Nashik", maxResults: 10, language: "en" }, context, { contactAfter: contactAfter("req-wait") });
  check("two runs open: the Instagram search is queued, not handed to website search", queued.provider === "apify" && queued.waiting === true && /starts as soon as/.test(queued.note ?? ""), `${queued.provider} ${queued.note}`);
  let waitJob = await step(queued.jobId);
  const waitProgress = waitJob.progress as { waiting?: { kind?: string } };
  check("…its job waits for a slot without calling Apify", waitJob.status === "queued" && waitJob.stage === "queued" && waitProgress.waiting?.kind === "slot" && apify.runs.size === runsBeforeWait, JSON.stringify(waitJob.progress));
  await db.update(apifyRuns).set({ status: "succeeded", usageUsd: 0.05, finishedAt: new Date() }).where(inArray(apifyRuns.id, fillers.map((filler) => filler.id)));
  apify.next.set("apify~instagram-hashtag-scraper", [{ pollsUntilDone: 3, finalStatus: "SUCCEEDED", usage: 0.02, items: [] }]);
  waitJob = await step(queued.jobId);
  check("…and starts once a slot is free", waitJob.stage === "apify" && apify.runs.size === runsBeforeWait + 1, `${waitJob.stage} ${apify.runs.size - runsBeforeWait}`);
  // A restart that replays the start (its outcome was lost) must not pay for a second run.
  await db.update(assistantJobs).set({ stage: "queued" }).where(eq(assistantJobs.id, queued.jobId));
  waitJob = await step(queued.jobId);
  check("…replaying its start after a restart reuses the open run instead of starting another", waitJob.stage === "apify" && apify.runs.size === runsBeforeWait + 1);
  await db.update(assistantJobs).set({ status: "cancelled" }).where(eq(assistantJobs.id, queued.jobId));
  await db.update(apifyRuns).set({ status: "succeeded", usageUsd: 0.02, finishedAt: new Date() }).where(and(inOrg(apifyRuns), eq(apifyRuns.jobId, queued.jobId)));

  // ---------------------------------------------------------- a run left "starting" by a crash
  const [stale] = await db.insert(apifyRuns).values({
    organizationId: currentOrganizationId(), jobId: null, requestId: null, actorKey: "google_maps", actorId: "compass~crawler-google-places", status: "starting", maxChargeUsd: 0.5, maxItems: 1, createdAt: new Date(Date.now() - 20 * 60_000),
  }).returning();
  const swept = await sweepStaleRuns();
  const [sweptRow] = await db.select().from(apifyRuns).where(eq(apifyRuns.id, stale!.id));
  check("a run left starting for 20 minutes is closed, its cap kept as spent", swept >= 1 && sweptRow?.status === "failed" && sweptRow.usageUsd === 0.5, JSON.stringify(sweptRow));

  // ---------------------------------------------------------- never tops up
  check("nothing ever changed the Apify account: only reads, runs and dataset reads", apify.calls.every((call) => /^(GET \/users\/me(\/limits)?|POST \/actors\/[^/]+\/runs|GET \/actor-runs\/[^/]+|GET \/datasets\/[^/]+\/items)$/.test(call)), apify.calls.filter((call) => !/^(GET|POST \/actors)/.test(call)).join(", "));
});

async function memberInsightsOf(audienceId: string) {
  const rows = await db.select().from(leadAudienceMembers).where(eq(leadAudienceMembers.audienceId, audienceId));
  const insights = await memberInsights(rows.map((row) => row.id));
  return rows.map((row) => ({ ...row, ...(insights.get(row.id) ?? {}) })) as (typeof rows[number] & { matchReason?: string | null; signals?: { kind: string }[] })[];
}

// ------------------------------------------------------------ organization B sees nothing of A
await runInOrganization(orgB!.id, async () => {
  clearFeatureCache();
  const view = await apifySettingsView();
  check("isolation: B has no Apify connection and no spend", !view.connected && view.spentThisMonthUsd === 0 && view.reservedUsd === 0);
  check("isolation: B cannot read A's run", (await trackedRun(runOfA)) === null);
  const bRuns = await db.select().from(apifyRuns).where(inOrg(apifyRuns));
  check("isolation: B counts no Apify runs", bRuns.length === 0);
  const b = await startDiscovery({ what: "dentists", where: "Pune, India", maxResults: 10, language: "en" }, { threadId: null, userId: null }, {});
  check("isolation: B's search uses its own (off) settings", b.provider === "scraper" && !/Apify/.test(b.note ?? ""), b.note ?? "");
  await db.update(assistantJobs).set({ status: "cancelled" }).where(and(eq(assistantJobs.organizationId, orgB!.id)));
});

// Leave nothing claimable for another script's worker, and no connection pointing at the stand-ins.
await db.update(assistantJobs).set({ status: "cancelled", error: "apify check: not run" }).where(eq(assistantJobs.organizationId, orgA!.id));
for (const id of createdProviders) {
  await db.delete(gridProviderCredentials).where(eq(gridProviderCredentials.providerId, id));
  await db.delete(gridProviders).where(eq(gridProviders.id, id));
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);

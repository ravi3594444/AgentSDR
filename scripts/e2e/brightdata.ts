/**
 * Bright Data social research (src/lib/brightdata/, src/lib/discovery/
 * socialResearch.server.ts), end to end against the local database: the
 * real assistant tool (research_social_sources), the real worker stages,
 * the usage ledger, saving, de-duplication and audiences, with every
 * outside service stood in (global fetch is intercepted; nothing leaves
 * the machine):
 *
 * - Bright Data's Scraper API (trigger, progress, snapshot, cancel, the
 *   free key check) and SERP API answer from fixtures: Reddit posts with
 *   comments by keyword, Reddit, X and Instagram profiles, Facebook pages,
 *   an X post, and one input Bright Data cannot read (billed as an error);
 * - Tavily (the web search that finds X, Instagram and Facebook URLs);
 * - the websites profiles list, through the discovery page reader;
 * - the mail-server check (setWebDiscoveryMailCheck).
 *
 *   bun run --conditions=react-server scripts/e2e/brightdata.ts
 *
 * What it proves: the feature, the key and Reddit's own switch gate it; a
 * full run keeps every finding with its link, words, author and read time,
 * contacts only from what a profile, page or website publishes, and
 * discussions whose authors publish none as excluded with the reason;
 * URLs Bright Data cannot read are never sent; the ledger reserves before
 * the call and settles from what Bright Data reported (failed inputs
 * billed); the same inputs are never paid for twice (a retried step polls
 * its collection, the same collection within 7 days is downloaded again
 * free); a trigger whose answer was lost stays counted and is never sent
 * again; a rate limit waits and a used-up account stops; the monthly
 * limit, the open-collections cap and the request's spend cap refuse; a
 * paused request holds a search and a stopped one ends it unsearched; a
 * stale collection is swept as uncertain; a SERP zone finds URLs when no
 * web search is set up; a second organization sees and reuses nothing.
 *
 * Creates its own organizations ("Bright Data check A/B/C …") and removes
 * the Bright Data and Tavily settings rows it made. Refuses a non-local
 * DATABASE_URL.
 */
import { and, eq, inArray, sql } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}
process.env.DISCOVERY_DNS_CHECK = "off";

const stamp = Date.now();
const tag = stamp.toString(36);
const BD = "https://brightdata.check.test";
const KEY = `bd-check-${tag}`;
const KEY_B = `bd-other-${tag}`;
const TAVILY = "https://tavily.brightdata-check.invalid";
const TAVILY_KEY = `tvly-bd-${tag}`;
const host = (slug: string) => `${slug}-${tag}.test`;
const site = (slug: string) => `https://${host(slug)}/`;
const FRAN = `fran_frontdesk_${tag}`;
const SAM = `smallclinic_sam_${tag}`;
const VIC = `vendor_vic_${tag}`;
const X_HANDLE = `Lotus${tag.slice(-6)}`;
const X_POST = `https://x.com/${X_HANDLE}/status/17${String(stamp).slice(-13)}`;
const GLOW_IG = `glow.dental_${tag}`;
const DEAD_IG = `deadpage_${tag}`;
const FB_BRIGHT = `https://www.facebook.com/brightsmile-${tag}`;
const FB_QUIET = `https://www.facebook.com/quietpage-${tag}`;
const POST1 = `https://www.reddit.com/r/Dentists/comments/a1${tag}/missed_calls/`;
const POST2 = `https://www.reddit.com/r/Dentists/comments/b2${tag}/ai_front_desk/`;

const DATASETS: Record<string, string> = {
  gd_lvz8ah06191smkebj4: "reddit_posts", gd_mgnh0p8w16o65lmhp: "reddit_profiles", gd_lwxkxvnf1cynvib9co: "x_posts", gd_lwxmeb2u1cniijd7t4: "x_profiles",
  gd_l1vikfch901nx3by4: "instagram_profiles", gd_lk5ns7kz21pck8jpis: "instagram_posts", gd_mf124a0511bauquyow: "facebook_pages", gd_lyclm1571iy3mv57zw: "facebook_posts",
};

// ------------------------------------------------------------ Bright Data, stood in
type Trigger = { id: string; dataset: string; type: string | null; discoverBy: string | null; body: { input: Record<string, unknown>[]; limit_per_input?: number }; auth: string | null; polls: number; pollsUntilReady: number; fail: boolean };
const bd = {
  triggers: [] as Trigger[],
  calls: [] as string[],
  cancels: [] as string[],
  serp: [] as Record<string, unknown>[],
  /** The next trigger: "ok", "drop" (no answer at all), or an HTTP refusal. */
  mode: "ok" as "ok" | "drop" | { status: number; body: unknown; retryAfter?: string },
  /** With `once`, the trigger mode goes back to "ok" after one use (the provider recovered). */
  once: false,
  /** Every progress read: "ok", "drop" (no answer), or an HTTP refusal. */
  progressMode: "ok" as "ok" | "drop" | { status: number; body: unknown; retryAfter?: string },
  pollsUntilReady: 1,
  failNext: false,
};
const triggerCalls = () => bd.calls.filter((call) => call === "POST /datasets/v3/trigger").length;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const NOW = new Date().toISOString();

const comment = (user: string, text: string, url: string) => ({ comment: text, url, user_commenting: user, user_url: "https://www.reddit.com/svc/shreddit/comments/r/Dentists/undefined", date_of_comment: "2026-10-13T13:19:55.908Z", num_upvotes: 1, num_replies: 0, replies: [] });
const redditPost = (url: string, user: string, title: string, body: string, comments: unknown[], keyword: string) => ({
  post_id: `t3_${url.split("/")[6]}`, url, user_posted: user, title, description: body, num_comments: comments.length, date_posted: "2026-10-12T10:30:02.133Z",
  community_name: "Dentists", community_url: "https://www.reddit.com/r/Dentists/", num_upvotes: 3, comments, timestamp: NOW, input: { url }, discovery_input: { keyword, date: "Past year", num_of_posts: 3, sort_by: "" },
});

/** Each dataset's records for the inputs sent: real field names, fixture content. */
function recordsFor(trigger: Trigger): unknown[] {
  const inputs = trigger.body.input;
  switch (DATASETS[trigger.dataset]) {
    case "reddit_posts": {
      if (trigger.discoverBy === "keyword") {
        const keyword = String(inputs[0]?.keyword ?? "");
        return [
          redditPost(POST1, FRAN, "How do dental clinics handle missed calls when the front desk is busy?", "We lose bookings every week. Looking for a service that answers calls for us.", [
            comment(VIC, "We built an AI receptionist for exactly this, DM me.", `${POST1}comment/c1/`),
            comment(SAM, "Same problem here, any recommendations?", `${POST1}comment/c2/`),
          ], keyword),
          redditPost(POST2, VIC, "Launching our AI front desk for clinics", "Happy to answer questions about it.", [], keyword),
        ];
      }
      return inputs.map((input) => redditPost(String(input.url), FRAN, "A post read by URL", "Nothing to see.", [], ""));
    }
    case "reddit_profiles":
      return inputs.map((input) => {
        const name = String(input.url).split("/user/")[1]?.replace(/\/$/, "") ?? "";
        return { url: String(input.url), profile_id: `t2_${name}`, name, followers: 3, social_links: name === FRAN ? [{ url: site("pune-smiles") }] : [], karma: 10, description: name === FRAN ? "Front desk lead at a Pune clinic" : "Just a dentist", timestamp: NOW, input };
      });
    case "x_posts":
      return inputs.map((input) => ({ id: String(input.url).split("/status/")[1], user_posted: X_HANDLE, name: "Lotus Dental", description: "Our front desk misses too many calls. Looking for a service that answers them.", date_posted: "2026-10-10T09:00:00.000Z", url: String(input.url), replies: 2, likes: 5, timestamp: NOW, input }));
    case "x_profiles":
      return inputs.map((input) => ({ x_id: "607080773", url: String(input.url), id: X_HANDLE, profile_name: "Lotus Dental", biography: `Family dentistry in Pune. Bookings: hello@${host("lotus-x")}`, is_verified: false, external_link: site("lotus-x"), location: "Pune", is_business_account: true, category_name: [], posts: [], timestamp: NOW, input }));
    case "instagram_profiles":
      return inputs.map((input) => (String(input.url).includes(DEAD_IG)
        ? { timestamp: NOW, input, error: "Profile isn't available", error_code: "dead_page" }
        : { account: GLOW_IG, full_name: "Glow Dental", biography: "Smiles in Pune", email_address: `hello@${host("glow")}`, external_url: null, profile_url: `https://www.instagram.com/${GLOW_IG}/`, followers: 900, timestamp: NOW, input }));
    case "facebook_pages":
      return inputs.map((input) => (String(input.url) === FB_BRIGHT
        ? { id: "100063504326716", url: FB_BRIGHT, page_name: "Bright Smile Dental", username: `brightsmile-${tag}`, primary_category: "Dentist & Dental Office", contact_and_basic_info: { categories: ["Dentist & Dental Office"], contact_info: { phones: ["+912025550003"], emails: [], websites: [] } }, followers: 198, timestamp: NOW, input }
        : { id: "100063504326717", url: FB_QUIET, page_name: "Quiet Page", username: `quietpage-${tag}`, primary_category: "Dentist & Dental Office", contact_and_basic_info: { categories: [], contact_info: { phones: [], emails: [], websites: [] } }, followers: 5, timestamp: NOW, input }));
    default:
      return [];
  }
}

function brightdataAnswer(method: string, url: URL, init?: RequestInit): Response {
  const path = url.pathname;
  bd.calls.push(`${method} ${path}`);
  const auth = new Headers(init?.headers).get("authorization");
  if (auth !== `Bearer ${KEY}` && auth !== `Bearer ${KEY_B}`) return new Response("Unauthorized", { status: 401 });
  if (method === "GET" && path === "/datasets/v3/scrapers") return json(200, [{ id: "gd_lvz8ah06191smkebj4", name: "Reddit - Posts", domain: "reddit.com" }, { id: "gd_mgnh0p8w16o65lmhp", name: "Reddit - Profiles", domain: "reddit.com" }]);
  if (method === "POST" && path === "/datasets/v3/trigger") {
    const mode = bd.mode;
    if (bd.once) {
      bd.mode = "ok";
      bd.once = false;
    }
    if (mode === "drop") throw new TypeError("fetch failed: connection reset");
    if (mode !== "ok") return json(mode.status, mode.body, mode.retryAfter ? { "retry-after": mode.retryAfter } : {});
    const id = `sd_check${bd.triggers.length + 1}${tag}`;
    bd.triggers.push({ id, dataset: url.searchParams.get("dataset_id") ?? "", type: url.searchParams.get("type"), discoverBy: url.searchParams.get("discover_by"), body: JSON.parse(String(init?.body ?? "{}")), auth, polls: 0, pollsUntilReady: bd.pollsUntilReady, fail: bd.failNext });
    bd.failNext = false;
    return json(200, { snapshot_id: id });
  }
  const progress = path.match(/^\/datasets\/v3\/progress\/(.+)$/);
  if (method === "GET" && progress) {
    if (bd.progressMode === "drop") throw new TypeError("fetch failed: connection reset");
    if (bd.progressMode !== "ok") return json(bd.progressMode.status, bd.progressMode.body, bd.progressMode.retryAfter ? { "retry-after": bd.progressMode.retryAfter } : {});
    const trigger = bd.triggers.find((item) => item.id === progress[1]);
    if (!trigger) return json(404, { error: "snapshot not found" });
    trigger.polls += 1;
    if (trigger.polls < trigger.pollsUntilReady) return json(200, { status: "running", snapshot_id: trigger.id, dataset_id: trigger.dataset, running_time: 12 });
    if (trigger.fail) return json(200, { status: "failed", snapshot_id: trigger.id, dataset_id: trigger.dataset, records: 0, errors: 2, error_codes: { dead_page: 2 } });
    const records = recordsFor(trigger);
    const errors = records.filter((record) => (record as { error?: unknown }).error).length;
    return json(200, { status: "ready", snapshot_id: trigger.id, dataset_id: trigger.dataset, records: records.length - errors, errors, collection_duration: 3350, ...(errors ? { error_codes: { dead_page: errors } } : {}) });
  }
  const snapshot = path.match(/^\/datasets\/v3\/snapshot\/([^/]+)(\/cancel)?$/);
  if (snapshot) {
    const trigger = bd.triggers.find((item) => item.id === snapshot[1]);
    if (!trigger) return json(404, { error: "snapshot not found" });
    if (method === "POST" && snapshot[2]) {
      bd.cancels.push(trigger.id);
      return json(200, { ok: true });
    }
    if (method === "GET") return json(200, trigger.fail ? [] : recordsFor(trigger));
  }
  if (method === "POST" && path === "/request") {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    bd.serp.push(body);
    return json(200, { organic: [{ link: FB_BRIGHT, title: "Bright Smile Dental | Facebook", description: "Dentist in Pune" }, { link: "https://www.facebook.com/groups/12345", title: "A group" }, { link: FB_QUIET, title: "Quiet Page" }] });
  }
  return json(405, { error: `not in the stand-in: ${method} ${path}` });
}

// ------------------------------------------------------------ Tavily and the websites, stood in
const tavilyCalls: string[] = [];
function tavilyAnswer(method: string, url: URL, init?: RequestInit): Response {
  const auth = new Headers(init?.headers).get("authorization");
  if (auth !== `Bearer ${TAVILY_KEY}`) return json(401, { detail: { error: "Unauthorized: missing or invalid API key." } });
  if (method === "GET" && url.pathname === "/usage") return json(200, { key: { usage: 3 }, account: { current_plan: "Researcher", plan_usage: 3, plan_limit: 1000 } });
  if (method === "POST" && url.pathname === "/search") {
    const query = String((JSON.parse(String(init?.body ?? "{}")) as { query?: string }).query ?? "");
    tavilyCalls.push(query);
    const results = /site:x\.com/.test(query)
      ? [{ title: "Lotus Dental on X", url: X_POST, content: "Our front desk misses too many calls" }, { title: "Search", url: "https://x.com/search?q=dentist%20pune" }, { title: "Login", url: "https://x.com/i/flow/login" }]
      : /site:instagram\.com/.test(query)
        ? [{ title: "Glow Dental (@glow) • Instagram", url: `https://www.instagram.com/${GLOW_IG}/` }, { title: "Dead page", url: `https://www.instagram.com/${DEAD_IG}/` }, { title: "#dentist", url: "https://www.instagram.com/explore/tags/dentist/" }]
        : /site:facebook\.com/.test(query)
          ? [{ title: "Bright Smile Dental | Facebook", url: FB_BRIGHT, content: "Dentist in Pune" }, { title: "Quiet Page", url: FB_QUIET }, { title: "Group", url: "https://www.facebook.com/groups/12345" }]
          : [];
    return json(200, { query, results, usage: { credits: 1 } });
  }
  return json(404, {});
}
const PAGES: Record<string, string> = {
  [site("pune-smiles")]: `<html><head><title>Pune Smiles Dental</title></head><body><h1>Pune Smiles</h1><a href="mailto:hello@${host("pune-smiles")}">hello@${host("pune-smiles")}</a> <a href="tel:+912025531234">+91 20 2553 1234</a></body></html>`,
  [site("lotus-x")]: `<html><head><title>Lotus Dental</title></head><body><a href="mailto:info@${host("lotus-x")}">info@${host("lotus-x")}</a></body></html>`,
};
const pageReads: string[] = [];
const blocked: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.origin === BD) return brightdataAnswer(method, url, init);
  if (url.origin === TAVILY) return tavilyAnswer(method, url, init);
  if (url.hostname.endsWith(".test") || url.hostname.endsWith(".invalid")) return new Response("not found", { status: 404 });
  blocked.push(`${method} ${url.href}`);
  return new Response("blocked by the Bright Data check", { status: 599 });
}) as typeof fetch;

// ------------------------------------------------------------ app modules
const { db } = await import("@/lib/db");
const { organizations } = await import("@/lib/auth/schema");
const { people } = await import("@/lib/leads/schema");
const { providerUsage } = await import("@/lib/quota/schema");
const { brightdataSettings } = await import("@/lib/brightdata/schema");
const { tavilySettings } = await import("@/lib/tavily/schema");
const { assistantJobs, assistantObjectives, leadAudienceMembers, leadAudiences } = await import("@/lib/assistant/schema");
const { memberInsights } = await import("@/lib/assistant/audiences.server");
const { runTool } = await import("@/lib/assistant/tools.server");
const { runOneAssistantStep } = await import("@/lib/assistant/worker");
const { registerAssistantJobs, reportFinishedJob } = await import("@/lib/assistant/register.server");
const { createThread, addMessage, listMessages } = await import("@/lib/assistant/threads.server");
const objectives = await import("@/lib/assistant/objective.server");
const { setDiscoveryPageOptions } = await import("@/lib/discovery/discovery.server");
const { setWebDiscoveryMailCheck } = await import("@/lib/discovery/webDiscovery.server");
const { setBrightdataApiBase } = await import("@/services/brightdata");
const { setTavilyApiBase } = await import("@/services/tavily");
const { saveTavilySettings } = await import("@/lib/tavily/tavily.server");
const { brightdataSettingsView, saveBrightdataSettings, BrightdataSettingsError, startCollection, pollCollection, sweepStaleCollections, brightdataReadiness } = await import("@/lib/brightdata/brightdata.server");
const { setFeature } = await import("@/lib/features/flags.server");
const { runInOrganization, currentOrganizationId, inOrg } = await import("@/lib/tenancy/scope");
type AssistantJob = typeof assistantJobs.$inferSelect;

setBrightdataApiBase(BD);
setTavilyApiBase(TAVILY);
setDiscoveryPageOptions({
  allowPrivate: true,
  fetchImpl: (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    pageReads.push(url);
    const html = PAGES[url];
    return html ? new Response(html, { status: 200, headers: { "content-type": "text/html" } }) : new Response("not found", { status: 404 });
  }) as typeof fetch,
});
setWebDiscoveryMailCheck(async (domain) => (domain.includes("nomail") ? "rejects" : "mx"));
registerAssistantJobs();

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures += 1;
}
const checkOrganizations: string[] = [];

/** Runs the real worker on this job until it finishes, fencing every other organization's claimable jobs (row locks, no writes). */
async function runJob(jobId: string, options: { stopAtStage?: string; maxSteps?: number } = {}): Promise<{ job: AssistantJob; stages: string[] }> {
  const stages: string[] = [];
  let job: AssistantJob | undefined;
  await db.transaction(async (tx) => {
    const fence = () => tx.execute(sql`
      select id from assistant_jobs
      where organization_id not in (${sql.join(checkOrganizations.map((id) => sql`${id}::uuid`), sql`, `)})
        and (status = 'queued' or status = 'running')
      for update skip locked`);
    for (let step = 0; step < (options.maxSteps ?? 120); step += 1) {
      [job] = await db.select().from(assistantJobs).where(eq(assistantJobs.id, jobId));
      if (!job) throw new Error(`job ${jobId} disappeared`);
      if (stages.at(-1) !== job.stage) stages.push(job.stage);
      if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled" || (options.stopAtStage && job.stage === options.stopAtStage)) break;
      // Polls wait 20 s between them: the check moves the clock instead of waiting.
      if (job.runAfter.getTime() > Date.now()) await db.update(assistantJobs).set({ runAfter: new Date(Date.now() - 1_000) }).where(eq(assistantJobs.id, jobId));
      await fence();
      await runOneAssistantStep({ jobId });
    }
  });
  return { job: job!, stages };
}
async function step(jobId: string): Promise<AssistantJob> {
  await db.update(assistantJobs).set({ runAfter: new Date(Date.now() - 1_000) }).where(and(eq(assistantJobs.id, jobId), eq(assistantJobs.status, "queued")));
  await runOneAssistantStep({ jobId });
  const [job] = await db.select().from(assistantJobs).where(eq(assistantJobs.id, jobId));
  return job!;
}
async function members(audienceId: string) {
  const rows = await db.select().from(leadAudienceMembers).where(and(inOrg(leadAudienceMembers), eq(leadAudienceMembers.audienceId, audienceId)));
  const insights = await memberInsights(rows.map((row) => row.id));
  return rows.map((row) => ({ ...row, insight: insights.get(row.id) ?? null }));
}
/** The chat's event messages once the job's report is posted (posting again is a no-op). */
async function reports(threadId: string, jobId: string) {
  const [job] = await db.select().from(assistantJobs).where(eq(assistantJobs.id, jobId));
  await reportFinishedJob(job!);
  return (await listMessages(threadId, 100)).filter((row) => row.role === "event").map((row) => row.content ?? "");
}
async function usageDetail(usageId: string): Promise<Record<string, unknown>> {
  const [row] = await db.select({ detail: providerUsage.detail }).from(providerUsage).where(and(inOrg(providerUsage), eq(providerUsage.id, usageId)));
  return row?.detail ?? {};
}
async function ledger(jobId?: string) {
  return db.select().from(providerUsage).where(and(inOrg(providerUsage), eq(providerUsage.provider, "brightdata"), jobId ? eq(providerUsage.jobId, jobId) : undefined)).orderBy(providerUsage.createdAt);
}
const triggersOf = (dataset: string) => bd.triggers.filter((item) => DATASETS[item.dataset] === dataset);
const ctx = (threadId: string, extra: Record<string, unknown> = {}) => ({ threadId, userId: null, ownerText: "Research dental clinics complaining about missed calls", ...extra });
const ARGS = { platforms: ["reddit", "x", "instagram", "facebook"], customers: "dental clinics", need: "missed calls at the front desk", where: "Pune" };

const orgs: Record<"A" | "B" | "C", string> = { A: "", B: "", C: "" };
for (const name of ["A", "B", "C"] as const) {
  const [org] = await db.insert(organizations).values({ name: `Bright Data check ${name} ${stamp}`, slug: `brightdata-${name.toLowerCase()}-${stamp}` }).returning();
  orgs[name] = org!.id;
  checkOrganizations.push(org!.id);
}
console.log(`Organizations A ${orgs.A}, B ${orgs.B}, C ${orgs.C}`);

let audienceA = "";
let usageA = "";
let specA: Parameters<typeof startCollection>[0]["spec"] | null = null;
try {
  // ------------------------------------------------------------ A: gates, then a full run
  await runInOrganization(orgs.A, async () => {
    const thread = await createThread(null);
    const off = await runTool("research_social_sources", ARGS, ctx(thread.id));
    check("feature off: the tool refuses with the feature's message", !off.ok && /Bright Data research \(metered\) is off for this organization/.test(off.summary), off.summary);
    await setFeature("brightdata", true, null);
    const noKey = await runTool("research_social_sources", ARGS, ctx(thread.id));
    check("no key: the tool says so and starts nothing", !noKey.ok && /no Bright Data key is saved/.test(noKey.summary) && (await db.select({ id: assistantJobs.id }).from(assistantJobs).where(inOrg(assistantJobs))).length === 0, noKey.summary);
    let rejected = "";
    try {
      await saveBrightdataSettings({ key: "bad-key" }, null);
    } catch (error) {
      rejected = error instanceof BrightdataSettingsError ? error.message : `unexpected: ${String(error)}`;
    }
    check("a bad key is refused by the free scrapers check and never saved", /rejected this key/.test(rejected) && !(await brightdataSettingsView()).connected, rejected);
    const view = await saveBrightdataSettings({ key: KEY, monthlyCredits: 1000, maxRecordsPerSearch: 60, redditEnabled: true }, null);
    check("a good key is saved as a hint only, Reddit on, nothing used yet", view.connected && view.keyHint === `…${KEY.slice(-4)}` && view.redditEnabled && view.usedThisMonth === 0 && !JSON.stringify(view).includes(KEY) && view.datasets.every((item) => item.state === "unused"), JSON.stringify(view));
    const noFinder = await runTool("research_social_sources", { ...ARGS, platforms: ["x", "facebook"] }, ctx(thread.id));
    check("X and Facebook without a web search or SERP zone: not started, with the reason", !noFinder.ok && /needs a web search .* or a SERP API zone/.test(noFinder.summary), noFinder.summary);
    await saveTavilySettings({ key: TAVILY_KEY, dailySearches: 100 }, null);

    const started = await runTool("research_social_sources", ARGS, ctx(thread.id));
    const data = started.data as { jobId: string; audienceId: string; sources: { platform: string; state: string }[]; urlFinder: string | null } | undefined;
    check("the tool starts one job for all four platforms, URLs found with Tavily", started.ok && Boolean(data?.jobId) && data!.sources.every((source) => source.state === "pending") && data!.urlFinder === "tavily" && /Reddit: searching for “missed calls at the front desk”/.test(started.summary), started.summary);
    audienceA = data!.audienceId;
    const run = await runJob(data!.jobId);
    const result = (run.job.result ?? {}) as Record<string, unknown> & { sources?: { platform: string; state: string; found: number; credits: number; reason: string | null }[] };
    check("the job runs every stage and succeeds", run.job.status === "succeeded" && ["queued", "searching", "collecting", "reading", "saving"].every((stage) => run.stages.includes(stage)), `${run.job.status} ${run.job.error ?? ""} ${run.stages.join(">")}`);
    check("every platform was searched: 7 people or businesses from 5 discussions, 4 contactable, 3 kept as research", result.found === 7 && result.discussions === 5 && result.eligible === 4 && result.excluded === 3 && result.sources?.every((source) => source.state === "searched") === true, JSON.stringify({ found: result.found, discussions: result.discussions, eligible: result.eligible, excluded: result.excluded, sources: result.sources, note: result.note }));
    check("by route: 3 by email, 1 by phone only, 1 with an Instagram profile; 3 asked for something in their own words", result.withEmail === 3 && result.withPhoneOnly === 1 && result.withInstagram === 1 && result.needSignals === 3, JSON.stringify(result));

    // What Bright Data was asked
    const reddit = triggersOf("reddit_posts");
    check("Reddit was discovered by keyword, natively, with the limit per input, never collected by URL", reddit.length === 1 && reddit[0]!.type === "discover_new" && reddit[0]!.discoverBy === "keyword" && reddit[0]!.body.input.length === 2 && reddit[0]!.body.input.every((input) => input.date === "Past year" && input.num_of_posts === 3) && reddit[0]!.body.limit_per_input === 3, JSON.stringify(reddit[0]));
    const sent = bd.triggers.flatMap((item) => item.body.input.map((input) => String(input.url ?? input.keyword)));
    check("only canonical post, profile and page URLs were sent: a search page, a login, a hashtag and a group were not", sent.includes(X_POST) && sent.includes(`https://www.instagram.com/${GLOW_IG}/`) && sent.includes(FB_BRIGHT) && !sent.some((url) => /search\?|\/i\/flow|explore\/tags|\/groups\//.test(url)), sent.join(", "));
    check("the authors' profiles were read once each: the two Reddit authors who asked for something and the X poster, not the vendor", triggersOf("reddit_profiles").length === 1 && triggersOf("reddit_profiles")[0]!.body.input.map((input) => input.url).sort().join() === [`https://www.reddit.com/user/${FRAN}/`, `https://www.reddit.com/user/${SAM}/`].sort().join() && triggersOf("x_profiles").length === 1 && triggersOf("x_profiles")[0]!.body.input[0]!.url === `https://x.com/${X_HANDLE}`, JSON.stringify(bd.triggers.map((item) => [DATASETS[item.dataset], item.body.input])));
    check("every call carried the key as a Bearer header; 6 collections in all; nothing else left the machine", bd.triggers.length === 6 && bd.triggers.every((item) => item.auth === `Bearer ${KEY}`) && blocked.length === 0, `${bd.triggers.length} triggers, blocked: ${blocked.join(", ")}`);
    check("the websites profiles list were read, the Instagram profile's missing one was not", pageReads.some((url) => url.startsWith(site("pune-smiles"))) && pageReads.some((url) => url.startsWith(site("lotus-x"))) && pageReads.every((url) => /pune-smiles|lotus-x/.test(url)), pageReads.join(", "));

    // What was saved, with its evidence
    const saved = await members(audienceA);
    // A lead's member row is named after its person (an eligible one) or the lead (an excluded one): found by where it was read.
    const byName = (needle: RegExp) => saved.find((row) => needle.test(row.name ?? ""));
    const bySource = (url: string) => saved.find((row) => row.sourceUrl === url);
    const fran = bySource(`https://www.reddit.com/user/${FRAN}/`);
    check("the Reddit poster who asked for a service: a lead by the email her profile's website publishes, each contact with its page", fran?.status === "eligible" && fran.evidence.some((item) => item.kind === "email" && item.value === `hello@${host("pune-smiles")}` && item.sourceUrl === site("pune-smiles") && /website their profile lists.*MX/.test(item.source)) && fran.evidence.some((item) => item.kind === "phone" && item.value === "+912025531234") && fran.evidence.some((item) => item.kind === "website" && item.sourceUrl === `https://www.reddit.com/user/${FRAN}/`), JSON.stringify(fran?.evidence));
    check("…with her words quoted as a need, the post's link and when it was read", fran?.insight?.signals.some((signal) => signal.kind === "need" && /Looking for a service/.test(signal.text) && signal.sourceUrl === POST1 && signal.source === "Reddit post" && signal.at === "2026-10-12T10:30:02.133Z" && signal.observedAt === NOW) === true && fran.facts.retrievedAt === NOW && fran.facts.community === "r/Dentists" && fran.facts.foundVia === "Bright Data" && /Posted in r\/Dentists on Reddit: “How do dental clinics handle missed calls/.test(fran.insight?.matchReason ?? ""), JSON.stringify({ signals: fran?.insight?.signals, facts: fran?.facts, why: fran?.insight?.matchReason }));
    const sam = byName(new RegExp(SAM));
    check("the commenter who asked too, whose profile publishes nothing: kept as excluded, with why, and that Reddit cannot be messaged", sam?.status === "excluded" && /publish no email or phone; AgentSDR cannot message anyone on Reddit/.test(sam.reason ?? "") && sam.insight?.signals[0]?.source === "Reddit comment", JSON.stringify({ status: sam?.status, reason: sam?.reason }));
    const vic = byName(new RegExp(VIC));
    check("the vendor who commented and posted without asking for anything: research only, profile never read", vic?.status === "excluded" && /kept as research: their words do not ask for anything, so their profile was not read/.test(vic.reason ?? "") && vic.insight?.signals.length === 2 && vic.insight.signals.every((signal) => signal.kind === "engagement"), JSON.stringify({ status: vic?.status, reason: vic?.reason, signals: vic?.insight?.signals.length }));
    const lotus = bySource(`https://x.com/${X_HANDLE}`);
    check("the X poster: a lead by the email written in their profile's bio and the one their website publishes, never by X", lotus?.status === "eligible" && lotus.evidence.some((item) => item.kind === "email" && item.value === `hello@${host("lotus-x")}` && item.sourceUrl === `https://x.com/${X_HANDLE}`) && lotus.evidence.some((item) => item.kind === "email" && item.value === `info@${host("lotus-x")}`) && !lotus.channels.includes("linkedin") && lotus.sourceUrl === `https://x.com/${X_HANDLE}` && lotus.insight?.signals[0]?.source === "X post", JSON.stringify({ evidence: lotus?.evidence, channels: lotus?.channels }));
    const glow = bySource(`https://www.instagram.com/${GLOW_IG}/`);
    check("the Instagram profile: contactable by its published email and by DM (its username), the place named in its bio", glow?.status === "eligible" && glow.evidence.some((item) => item.kind === "email" && item.value === `hello@${host("glow")}`) && glow.evidence.some((item) => item.kind === "instagram" && item.value === `https://www.instagram.com/${GLOW_IG}/`), JSON.stringify(glow?.evidence));
    const bright = bySource(FB_BRIGHT);
    check("the Facebook page: contactable by the phone it publishes only", bright?.status === "eligible" && bright.evidence.some((item) => item.kind === "phone" && item.value === "+912025550003" && item.sourceUrl === FB_BRIGHT) && !bright.evidence.some((item) => item.kind === "email"), JSON.stringify(bright?.evidence));
    const quiet = bySource(FB_QUIET);
    check("a Facebook page publishing nothing: excluded, and the owner is told Facebook cannot be messaged", quiet?.status === "excluded" && /publish no email or phone; AgentSDR cannot message anyone on Facebook/.test(quiet.reason ?? ""), quiet?.reason ?? "");
    const persons = await db.select({ id: people.id, email: people.email, phone: people.phone, source: people.source }).from(people).where(inOrg(people));
    check("4 people were created, from the published contacts only, none invented", persons.length === 4 && persons.every((person) => person.source === "discovery:social-research") && persons.some((person) => person.phone === "+912025550003" && !person.email), JSON.stringify(persons));

    // The ledger
    const rows = await ledger(data!.jobId);
    const settled = rows.filter((row) => row.status === "settled");
    check("six collections reserved before the call and settled from what Bright Data reported, failed inputs billed: 10 credits", rows.length === 6 && settled.length === 6 && rows.reduce((sum, row) => sum + (row.usedUnits ?? 0), 0) === 10 && rows.every((row) => typeof row.detail?.snapshotId === "string" && typeof row.detail?.collectionKey === "string"), JSON.stringify(rows.map((row) => [row.detail?.dataset, row.status, row.units, row.usedUnits])));
    const instagram = rows.find((row) => row.detail?.dataset === "instagram_profiles");
    check("the Instagram collection: 2 inputs reserved, 1 record and 1 unreadable input, 2 credits used", instagram?.units === 2 && instagram.usedUnits === 2 && instagram.detail?.records === 1 && instagram.detail?.errors === 1, JSON.stringify(instagram?.detail));
    check("the report counts the credits as estimated, and the cost at the list price", result.creditsUsed === 10 && result.creditsEstimated === true && Math.abs(Number(result.costUsd) - 10 * 0.0015) < 1e-9 && result.provider === "brightdata", JSON.stringify({ credits: result.creditsUsed, cost: result.costUsd }));
    const after = await brightdataSettingsView();
    check("the settings card shows the month's estimated use and, per dataset, only what this organization's collections returned", after.usedThisMonth === 10 && after.reservedThisMonth === 0 && after.datasets.find((item) => item.key === "reddit_posts")?.state === "verified" && after.datasets.find((item) => item.key === "instagram_profiles")?.state === "verified" && after.datasets.find((item) => item.key === "facebook_posts")?.state === "unused", JSON.stringify(after.datasets.filter((item) => item.state !== "unused")));
    const failuresKept = (result.failures as { input: string | null; reason: string }[] | undefined) ?? [];
    check("the unreadable Instagram input is recorded with Bright Data's reason", failuresKept.some((item) => item.input === `https://www.instagram.com/${DEAD_IG}/` && /isn't available/.test(item.reason)), JSON.stringify(failuresKept));

    // ---------------------------------------------------------- the same research again: nothing paid for twice
    const triggersBefore = bd.triggers.length;
    const again = await runTool("research_social_sources", ARGS, ctx(thread.id));
    const againData = again.data as { jobId: string; audienceId: string };
    const rerun = await runJob(againData.jobId);
    const reused = await ledger(againData.jobId);
    const rerunResult = (rerun.job.result ?? {}) as Record<string, unknown>;
    check("the same inputs within 7 days: every collection is downloaded again for free, no new Bright Data collection, the people reused", rerun.job.status === "succeeded" && bd.triggers.length === triggersBefore && reused.length === 6 && reused.every((row) => row.units === 0 && row.usedUnits === 0 && typeof row.detail?.reusedFrom === "string") && rerunResult.found === 7 && rerunResult.creditsUsed === 0 && rerunResult.alreadyKnown === 4 && (await db.select({ id: people.id }).from(people).where(inOrg(people))).length === 4, JSON.stringify({ status: rerun.job.status, triggers: bd.triggers.length - triggersBefore, rows: reused.length, result: { found: rerunResult.found, credits: rerunResult.creditsUsed, known: rerunResult.alreadyKnown } }));

    // ---------------------------------------------------------- a retried step, a lost answer, a rate limit, a used-up account
    specA = { dataset: "reddit_posts", discoverBy: null, inputs: [{ url: POST2 }], limitPerInput: null };
    const requestId = null;
    const one = await startCollection({ spec: specA, jobId: data!.jobId, requestId });
    const two = await startCollection({ spec: specA, jobId: data!.jobId, requestId });
    check("a step that runs again finds the collection its first attempt started and polls it, paying nothing more", one.started && two.started && two.usageId === one.usageId && !two.reused && bd.triggers.length === triggersBefore + 1, JSON.stringify({ one, two }));
    usageA = one.started ? one.usageId : "";
    if (!usageA) throw new Error("the retried-step collection did not start");
    const polled = await pollCollection(usageA);
    const pollTwice = await pollCollection(usageA);
    check("polling it settles the row once at the records delivered; polling a settled row downloads again and charges nothing", polled.state === "finished" && polled.ok && polled.creditsUsed === 1 && pollTwice.state === "finished" && pollTwice.ok && pollTwice.creditsUsed === 0 && (await ledger()).filter((row) => row.id === usageA)[0]?.usedUnits === 1, JSON.stringify({ polled, pollTwice }));

    const lostSpec = { dataset: "reddit_posts" as const, discoverBy: null, inputs: [{ url: `${POST2}?lost=1`.replace("?lost=1", "") }], limitPerInput: null };
    lostSpec.inputs = [{ url: `https://www.reddit.com/r/Dentists/comments/c3${tag}/lost/` }];
    bd.mode = "drop";
    const lost = await startCollection({ spec: lostSpec, jobId: data!.jobId, requestId });
    bd.mode = "ok";
    const lostRow = (await ledger()).find((row) => row.detail?.collectionKey && row.status === "uncertain");
    const lostAgain = await startCollection({ spec: lostSpec, jobId: data!.jobId, requestId });
    check("a trigger whose answer was lost stays counted as uncertain and is never sent again", !lost.started && /lost its answer/.test(lost.reason) && lostRow?.usedUnits === 1 && !lostAgain.started && /may have run/.test(lostAgain.reason) && bd.triggers.length === triggersBefore + 1, JSON.stringify({ lost, lostAgain, row: lostRow && [lostRow.status, lostRow.usedUnits] }));

    bd.mode = { status: 429, body: { error: "Too many requests" }, retryAfter: "7" };
    const limited = await startCollection({ spec: { ...lostSpec, inputs: [{ url: `https://www.reddit.com/r/Dentists/comments/d4${tag}/limited/` }] }, jobId: data!.jobId, requestId });
    bd.mode = { status: 403, body: { error: "Insufficient balance" } };
    const broke = await startCollection({ spec: { ...lostSpec, inputs: [{ url: `https://www.reddit.com/r/Dentists/comments/e5${tag}/broke/` }] }, jobId: data!.jobId, requestId });
    bd.mode = "ok";
    const refused = (await ledger()).filter((row) => row.status === "failed");
    check("a rate limit is a wait with the time Bright Data asked; a used-up account stops; both refusals cost nothing", !limited.started && limited.wait && /wait 7 s/.test(limited.reason) && !broke.started && broke.exhausted && refused.length === 2 && refused.every((row) => row.usedUnits === 0), JSON.stringify({ limited, broke, refused: refused.map((row) => [row.status, row.usedUnits]) }));

    // ---------------------------------------------------------- limits: the month, open collections, the request's cap, a stale collection
    const usedSoFar = (await ledger()).reduce((sum, row) => sum + (row.status === "reserved" ? row.units : row.usedUnits ?? 0), 0);
    await saveBrightdataSettings({ monthlyCredits: 5 }, null);
    const exhausted = await brightdataReadiness();
    const capped = await runTool("research_social_sources", ARGS, ctx(thread.id));
    check("the monthly limit, counted from delivered and uncertain records, refuses new research with the reason", usedSoFar === 12 && !exhausted.usable && exhausted.exhausted && !capped.ok && /this month's Bright Data limit \(5 credits/.test(capped.summary), `${usedSoFar} used; ${capped.summary}`);
    await saveBrightdataSettings({ monthlyCredits: 1000 }, null);
    const stale: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const [row] = await db.insert(providerUsage).values({ organizationId: currentOrganizationId(), provider: "brightdata", product: "records", scopeKey: null, units: 5, status: "reserved", detail: { dataset: "x_posts", collectionKey: `open-${index}`, snapshotId: `sd_open${index}` } }).returning({ id: providerUsage.id });
      stale.push(row!.id);
    }
    const full = await startCollection({ spec: { ...lostSpec, inputs: [{ url: `https://www.reddit.com/r/Dentists/comments/f6${tag}/full/` }] }, jobId: data!.jobId, requestId });
    check("three open collections: the next waits rather than starting, and nothing is sent", !full.started && full.wait && /3 Bright Data collections are still open/.test(full.reason) && bd.triggers.length === triggersBefore + 1, JSON.stringify(full));
    // One of them stops being polled: an hour on, it is swept.
    await db.update(providerUsage).set({ createdAt: new Date(Date.now() - 60 * 60_000) }).where(eq(providerUsage.id, stale[0]!));
    const swept = await sweepStaleCollections();
    const [sweptRow] = await db.select().from(providerUsage).where(eq(providerUsage.id, stale[0]!));
    check("a collection nothing polled for too long is swept as uncertain, its reserved credits kept", swept === 1 && sweptRow?.status === "uncertain" && sweptRow.usedUnits === 5, JSON.stringify(sweptRow && [sweptRow.status, sweptRow.usedUnits]));
    await db.delete(providerUsage).where(inArray(providerUsage.id, stale));
    const budget = await startCollection({ spec: { ...lostSpec, inputs: [{ url: `https://www.reddit.com/r/Dentists/comments/g7${tag}/budget/` }] }, jobId: data!.jobId, requestId, spendGuard: async () => ({ ok: false, wait: false, reason: "this request's spend cap is used" }) });
    check("the request's spend guard refuses inside the reservation: nothing reserved, nothing sent", !budget.started && Boolean(budget.budget) && /spend cap/.test(budget.reason) && bd.triggers.length === triggersBefore + 1, JSON.stringify(budget));

    // ---------------------------------------------------------- a failed snapshot and a cancelled one
    bd.failNext = true;
    const failing = await startCollection({ spec: { ...lostSpec, inputs: [{ url: `https://www.reddit.com/r/Dentists/comments/h8${tag}/fail/` }, { url: `https://www.reddit.com/r/Dentists/comments/i9${tag}/fail2/` }] }, jobId: data!.jobId, requestId });
    const failed = failing.started ? await pollCollection(failing.usageId) : null;
    const failedRow = failing.started ? (await ledger()).find((row) => row.id === failing.usageId) : null;
    check("a failed snapshot settles the inputs Bright Data billed as errors, and reports why", failed?.state === "finished" && !failed.ok && failed.creditsUsed === 2 && failedRow?.status === "failed" && failedRow.usedUnits === 2 && /reported the collection failed/.test(failed.note ?? ""), JSON.stringify({ failed, row: failedRow && [failedRow.status, failedRow.usedUnits] }));
    bd.pollsUntilReady = 99;
    const slow = await startCollection({ spec: { ...lostSpec, inputs: [{ url: `https://www.reddit.com/r/Dentists/comments/j0${tag}/slow/` }] }, jobId: data!.jobId, requestId });
    bd.pollsUntilReady = 1;
    const running = slow.started ? await pollCollection(slow.usageId) : null;
    const cancelled = slow.started ? await pollCollection(slow.usageId, { stopWaiting: true }) : null;
    check("a collection still running is polled; one that took too long is cancelled and stays counted as uncertain", running?.state === "running" && cancelled?.state === "finished" && !cancelled.ok && bd.cancels.length === 1 && (await ledger()).find((row) => slow.started && row.id === slow.usageId)?.status === "uncertain", JSON.stringify({ running, cancelled, cancels: bd.cancels }));

    // ---------------------------------------------------------- review B01: a rate-limited trigger is tried again after the wait, a bounded number of times
    const post = (slug: string) => ({ dataset: "reddit_posts" as const, discoverBy: null, inputs: [{ url: `https://www.reddit.com/r/Dentists/comments/${slug}${tag}/${slug}/` }], limitPerInput: null });
    const reasonOf = (outcome: Awaited<ReturnType<typeof startCollection>>) => (outcome.started ? "" : outcome.reason);
    bd.mode = { status: 429, body: { error: "Too many requests" }, retryAfter: "120" };
    bd.once = true;
    let calls = triggerCalls();
    const firstTry = await startCollection({ spec: post("k1"), jobId: data!.jobId, requestId });
    const tooEarly = await startCollection({ spec: post("k1"), jobId: data!.jobId, requestId });
    check("B01: a rate-limited trigger waits for the time Bright Data asked; asked again before it passes, nothing is sent", !firstTry.started && firstTry.wait && firstTry.rateLimited === true && (firstTry.retryAfterMs ?? 0) > 100_000 && !tooEarly.started && tooEarly.wait && tooEarly.rateLimited === true && triggerCalls() === calls + 1, JSON.stringify({ firstTry, tooEarly, calls: triggerCalls() - calls }));
    bd.mode = { status: 429, body: { error: "Too many requests" }, retryAfter: "1" };
    bd.once = true;
    calls = triggerCalls();
    const limitedOnce = await startCollection({ spec: post("k2"), jobId: data!.jobId, requestId });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const resumed = await startCollection({ spec: post("k2"), jobId: data!.jobId, requestId });
    const polledResumed = resumed.started ? await pollCollection(resumed.usageId) : null;
    const resumedKey = resumed.started ? (await usageDetail(resumed.usageId)).collectionKey : "";
    const resumedRows = (await ledger(data!.jobId)).filter((row) => row.detail?.collectionKey === resumedKey);
    check("B01: once the wait has passed and the provider recovered, the same collection is sent once and accepted; the refusal cost nothing", !limitedOnce.started && limitedOnce.wait && resumed.started && !resumed.reused && triggerCalls() === calls + 2 && resumedRows.length === 2 && resumedRows[0]!.status === "failed" && resumedRows[0]!.usedUnits === 0 && resumedRows[0]!.detail?.retryable === true && resumedRows[1]!.status === "settled" && polledResumed?.state === "finished" && polledResumed.ok, JSON.stringify({ limitedOnce, resumed, rows: resumedRows.map((row) => [row.status, row.usedUnits, row.detail?.attempt]) }));
    bd.mode = { status: 429, body: { error: "Too many requests" }, retryAfter: "0" };
    calls = triggerCalls();
    const tries = [];
    for (let attempt = 0; attempt < 4; attempt += 1) tries.push(await startCollection({ spec: post("k3"), jobId: data!.jobId, requestId }));
    bd.mode = "ok";
    check("B01: a provider that keeps refusing is asked at most 3 times; the 4th asks nothing and says so", tries.slice(0, 3).every((item) => !item.started && item.wait) && !tries[3]!.started && !tries[3]!.wait && /3 times/.test(reasonOf(tries[3]!)) && triggerCalls() === calls + 3, JSON.stringify({ tries, calls: triggerCalls() - calls }));
    const lostStill = await startCollection({ spec: lostSpec, jobId: data!.jobId, requestId });
    check("B01: a trigger whose answer was lost is still never sent again", !lostStill.started && !lostStill.wait && /may have run/.test(lostStill.reason) && triggerCalls() === calls + 3, reasonOf(lostStill));

    // ---------------------------------------------------------- review B02: removing the key keeps an open collection's credits counted
    const usedBefore = (await brightdataSettingsView()).usedThisMonth;
    const keyed = await startCollection({ spec: post("k4"), jobId: data!.jobId, requestId });
    await saveBrightdataSettings({ key: "" }, null);
    const keyGone = keyed.started ? await pollCollection(keyed.usageId) : null;
    const noKeyRow = keyed.started ? (await ledger()).find((row) => row.id === keyed.usageId) : null;
    await saveBrightdataSettings({ key: KEY }, null);
    check("B02: polling with the key removed keeps the reserved credits counted as uncertain, never released; the month's use shows them once the key is back", keyed.started && keyGone?.state === "finished" && !keyGone.ok && keyGone.creditsUsed === 1 && noKeyRow?.status === "uncertain" && noKeyRow.usedUnits === 1 && /key was removed/.test(keyGone.note ?? "") && (await brightdataSettingsView()).usedThisMonth === usedBefore + 1, JSON.stringify({ keyGone, row: noKeyRow && [noKeyRow.status, noKeyRow.usedUnits], used: [usedBefore, (await brightdataSettingsView()).usedThisMonth] }));

    // ---------------------------------------------------------- review B03: the deadline holds when the progress read itself fails
    for (const [label, mode] of [["a rate limit", { status: 429, body: { error: "Too many requests" } }], ["a server error", { status: 503, body: "unavailable" }], ["no answer", "drop"]] as const) {
      bd.pollsUntilReady = 99;
      const stuck = await startCollection({ spec: post(`k5${label.length}`), jobId: data!.jobId, requestId });
      bd.pollsUntilReady = 1;
      bd.progressMode = mode;
      const stillWaiting = stuck.started ? await pollCollection(stuck.usageId) : null;
      const cancelsBefore = bd.cancels.length;
      const gaveUp = stuck.started ? await pollCollection(stuck.usageId, { stopWaiting: true }) : null;
      bd.progressMode = "ok";
      const stuckRow = stuck.started ? (await ledger()).find((row) => row.id === stuck.usageId) : null;
      check(`B03: ${label} on the progress read keeps waiting before the deadline, and past it stops with the credits counted and a cancel attempted`, stuck.started && stillWaiting?.state === "running" && gaveUp?.state === "finished" && !gaveUp.ok && gaveUp.creditsUsed === 1 && stuckRow?.status === "uncertain" && stuckRow.usedUnits === 1 && bd.cancels.length === cancelsBefore + 1, JSON.stringify({ stillWaiting, gaveUp, row: stuckRow && [stuckRow.status, stuckRow.usedUnits] }));
    }
    bd.pollsUntilReady = 99;
    const unknown = await startCollection({ spec: post("k6"), jobId: data!.jobId, requestId });
    bd.pollsUntilReady = 1;
    bd.progressMode = { status: 404, body: { error: "snapshot not found" } };
    const gone = unknown.started ? await pollCollection(unknown.usageId) : null;
    bd.progressMode = "ok";
    check("B03: a progress answer that will not improve (the snapshot unknown) stops at once, counted as uncertain", unknown.started && gone?.state === "finished" && !gone.ok && gone.creditsUsed === 1 && (await ledger()).find((row) => row.id === unknown.usageId)?.status === "uncertain", JSON.stringify(gone));

    // ---------------------------------------------------------- the same three through the job
    bd.mode = { status: 429, body: { error: "Too many requests" }, retryAfter: "120" };
    bd.once = true;
    calls = triggerCalls();
    const limitedJob = await runTool("research_social_sources", { ...ARGS, platforms: ["reddit"], need: "no-shows and cancellations" }, ctx(thread.id));
    const limitedData = limitedJob.data as { jobId: string; audienceId: string };
    let waitingJob: AssistantJob | null = null;
    for (let round = 0; round < 6 && !waitingJob; round += 1) {
      const job = await step(limitedData.jobId);
      if ((job.progress as { waiting?: unknown }).waiting) waitingJob = job;
    }
    const waitingFor = (waitingJob?.progress as { waiting?: { kind?: string; reason?: string } } | undefined)?.waiting;
    check("B01 job: the rate-limited search waits for the time Bright Data asked (not a fixed minute), saying so", waitingJob?.status === "queued" && waitingJob.stage === "searching" && waitingFor?.kind === "quota" && /rate limit/.test(waitingFor.reason ?? "") && waitingJob.runAfter.getTime() - Date.now() > 90_000 && triggerCalls() === calls + 1, JSON.stringify({ status: waitingJob?.status, stage: waitingJob?.stage, waiting: waitingFor, inMs: waitingJob ? waitingJob.runAfter.getTime() - Date.now() : null }));
    // The wait passes (the ledger row's retry time is moved into the past) and the provider is healthy.
    await db.update(providerUsage).set({ detail: sql`${providerUsage.detail} || '{"retryAt": "2000-01-01T00:00:00.000Z"}'::jsonb` }).where(and(inOrg(providerUsage), eq(providerUsage.jobId, limitedData.jobId), eq(providerUsage.status, "failed")));
    const limitedRun = await runJob(limitedData.jobId);
    const limitedResult = (limitedRun.job.result ?? {}) as Record<string, unknown> & { sources?: { platform: string; state: string; credits: number }[] };
    check("B01 job: after the wait the collection is sent once, accepted, and the research finishes with Reddit searched", limitedRun.job.status === "succeeded" && triggerCalls() === calls + 2 && limitedResult.sources?.[0]?.state === "searched" && limitedResult.found === 3 && limitedResult.eligible === 1 && limitedResult.creditsUsed === 2, JSON.stringify({ status: limitedRun.job.status, error: limitedRun.job.error, calls: triggerCalls() - calls, sources: limitedResult.sources, found: limitedResult.found, eligible: limitedResult.eligible, credits: limitedResult.creditsUsed }));

    bd.mode = { status: 429, body: { error: "Too many requests" }, retryAfter: "120" };
    const foreverJob = await runTool("research_social_sources", { ...ARGS, platforms: ["reddit"], need: "after-hours calls nobody answers" }, ctx(thread.id));
    const foreverData = foreverJob.data as { jobId: string };
    let foreverWaiting: AssistantJob | null = null;
    for (let round = 0; round < 6 && !foreverWaiting; round += 1) {
      const job = await step(foreverData.jobId);
      if ((job.progress as { waiting?: unknown }).waiting) foreverWaiting = job;
    }
    // Half an hour of waiting has passed.
    await db.update(assistantJobs).set({ payload: sql`${assistantJobs.payload} || jsonb_build_object('waits', jsonb_build_object('0', ${new Date(Date.now() - 30 * 60_000).toISOString()}::text))` }).where(eq(assistantJobs.id, foreverData.jobId));
    const foreverRun = await runJob(foreverData.jobId);
    bd.mode = "ok";
    const foreverResult = (foreverRun.job.result ?? {}) as Record<string, unknown> & { sources?: { platform: string; state: string; reason: string | null }[] };
    check("B01 job: a provider that keeps asking to wait is given up after the time a collection may take, the source failed with the reason, the job finished", Boolean(foreverWaiting) && foreverRun.job.status === "succeeded" && foreverResult.sources?.[0]?.state === "failed" && /kept asking to wait/.test(foreverResult.sources[0].reason ?? "") && foreverResult.found === 0, JSON.stringify({ status: foreverRun.job.status, error: foreverRun.job.error, sources: foreverResult.sources }));

    // A long Retry-After is a not-before time, not permission to retry after 15 minutes.
    bd.mode = { status: 429, body: { error: "Too many requests" }, retryAfter: "1800" };
    bd.once = true;
    const longWaitJob = await runTool("research_social_sources", { ...ARGS, platforms: ["reddit"], need: "booking enquiries unanswered after closing" }, ctx(thread.id));
    const longWaitData = longWaitJob.data as { jobId: string };
    let longWaiting: AssistantJob | null = null;
    for (let round = 0; round < 6 && !longWaiting; round += 1) {
      const job = await step(longWaitData.jobId);
      if ((job.progress as { waiting?: unknown }).waiting) longWaiting = job;
    }
    const longRow = (await ledger(longWaitData.jobId)).find((row) => row.detail?.retryable === true);
    const retryAt = typeof longRow?.detail?.retryAt === "string" ? Date.parse(longRow.detail.retryAt) : 0;
    check("a 30-minute Retry-After stays intact in the ledger; the job wakes at its 20-minute deadline to stop", Boolean(longWaiting) && retryAt - Date.now() > 29 * 60_000 && longWaiting!.runAfter.getTime() - Date.now() > 19 * 60_000, JSON.stringify({ retryAt: longRow?.detail?.retryAt, runAfter: longWaiting?.runAfter }));
    await db.update(assistantJobs).set({ payload: sql`${assistantJobs.payload} || jsonb_build_object('waits', jsonb_build_object('0', ${new Date(Date.now() - 21 * 60_000).toISOString()}::text))` }).where(eq(assistantJobs.id, longWaitData.jobId));
    bd.mode = "ok";
    const callsBeforeDeadline = triggerCalls();
    const longWaitRun = await runJob(longWaitData.jobId);
    const longWaitResult = (longWaitRun.job.result ?? {}) as { found?: number; sources?: { state: string }[] };
    check("an expired wait ends before a trigger even when the provider has recovered", longWaitRun.job.status === "succeeded" && triggerCalls() === callsBeforeDeadline && longWaitResult.found === 0 && longWaitResult.sources?.[0]?.state === "failed", JSON.stringify({ status: longWaitRun.job.status, calls: triggerCalls() - callsBeforeDeadline, result: longWaitResult }));

    bd.pollsUntilReady = 99;
    const stuckJob = await runTool("research_social_sources", { ...ARGS, platforms: ["reddit"], need: "voicemail that never gets returned" }, ctx(thread.id));
    const stuckData = stuckJob.data as { jobId: string };
    const toCollecting = await runJob(stuckData.jobId, { stopAtStage: "collecting" });
    bd.pollsUntilReady = 1;
    const stuckPayload = toCollecting.job.payload as { collections?: { startedAt: string; usageId: string; snapshotId: string }[] };
    // Its collection started half an hour ago, and every progress read since fails.
    for (const item of stuckPayload.collections ?? []) item.startedAt = new Date(Date.now() - 30 * 60_000).toISOString();
    await db.update(assistantJobs).set({ payload: stuckPayload as Record<string, unknown> }).where(eq(assistantJobs.id, stuckData.jobId));
    bd.progressMode = { status: 503, body: "unavailable" };
    const stuckRun = await runJob(stuckData.jobId);
    bd.progressMode = "ok";
    const stuckResult = (stuckRun.job.result ?? {}) as Record<string, unknown> & { sources?: { platform: string; state: string; reason: string | null; credits: number }[] };
    const stuckLedger = stuckPayload.collections?.[0] ? (await ledger()).find((row) => row.id === stuckPayload.collections![0]!.usageId) : null;
    check("B03 job: past the deadline with the progress read failing, the job ends (not stuck), the source failed with the reason, the credits counted as uncertain, a cancel attempted", toCollecting.job.stage === "collecting" && stuckRun.job.status === "succeeded" && stuckResult.sources?.[0]?.state === "failed" && /could not be read/.test(stuckResult.sources[0].reason ?? "") && stuckLedger?.status === "uncertain" && stuckLedger.usedUnits === stuckLedger.units && stuckLedger.units > 0 && stuckResult.creditsUsed === stuckLedger.units && bd.cancels.includes(stuckPayload.collections![0]!.snapshotId), JSON.stringify({ stage: toCollecting.job.stage, status: stuckRun.job.status, error: stuckRun.job.error, sources: stuckResult.sources, credits: stuckResult.creditsUsed, row: stuckLedger && [stuckLedger.status, stuckLedger.usedUnits] }));

    // ---------------------------------------------------------- the request's controls: paused holds, stopped ends unsearched
    const chat = await createThread(null);
    const message = await addMessage({ threadId: chat.id, role: "user", content: "Research dental clinics complaining about missed calls on Reddit" });
    const ensured = await objectives.ensureObjective({ requestMessageId: message.id, threadId: chat.id, userId: null });
    await objectives.setObjectiveState(ensured!.objective.id, "pause", { name: null });
    const paused = await runTool("research_social_sources", { ...ARGS, platforms: ["reddit"] }, ctx(chat.id, { requestMessageId: message.id }));
    check("a paused request starts no research", !paused.ok && /paused/.test(paused.summary), paused.summary);
    await objectives.setObjectiveState(ensured!.objective.id, "resume", { name: null });
    const underRequest = await runTool("research_social_sources", { ...ARGS, platforms: ["reddit"], need: "no-shows and cancellations" }, ctx(chat.id, { requestMessageId: message.id }));
    const underData = underRequest.data as { jobId: string } | undefined;
    await objectives.setObjectiveState(ensured!.objective.id, "pause", { name: null });
    const held = await step(underData!.jobId);
    const holdReason = (held.progress as { waiting?: { kind?: string; reason?: string } }).waiting;
    check("a search of a paused request waits before its first stage, saying why", underRequest.ok && held.status === "queued" && held.stage === "queued" && holdReason?.kind === "paused" && /paused/.test(holdReason.reason ?? ""), JSON.stringify({ status: held.status, stage: held.stage, waiting: holdReason }));
    const triggersHeld = bd.triggers.length;
    await objectives.setObjectiveState(ensured!.objective.id, "cancel", { name: null });
    const ended = await runJob(underData!.jobId);
    const endedResult = (ended.job.result ?? {}) as { notSearched?: boolean; note?: string };
    // Stopping cancels the searches that had not begun (objective.server.ts cancelUnstarted): the job ends cancelled, unsearched.
    check("once the request is stopped the search is cancelled unsearched, and Bright Data was never called for it", ended.job.status === "cancelled" && endedResult.notSearched === true && /research stopped/.test(endedResult.note ?? "") && bd.triggers.length === triggersHeld, JSON.stringify({ status: ended.job.status, error: ended.job.error, result: endedResult, triggers: bd.triggers.length - triggersHeld }));
    const chatEvents = (await listMessages(chat.id, 100)).filter((row) => row.role === "event").map((row) => row.content ?? "");
    check("the chat shows the owner's pause, and the request is stopped", chatEvents.some((content) => /paused the research/.test(content)) && (await objectives.objectiveForRequest(message.id))?.status === "stopped", chatEvents.join(" | ").slice(0, 400));
  });

  // ------------------------------------------------------------ C: Reddit off, a SERP zone instead of a web search
  await runInOrganization(orgs.C, async () => {
    await setFeature("brightdata", true, null);
    await saveBrightdataSettings({ key: KEY, serpZone: `serp_check_${tag}` }, null);
    const thread = await createThread(null);
    const serpBefore = bd.serp.length;
    const started = await runTool("research_social_sources", { ...ARGS, platforms: ["reddit", "facebook"] }, ctx(thread.id));
    const data = started.data as { jobId: string; audienceId: string; urlFinder: string | null };
    check("Reddit off: the tool says Reddit is NOT searched and why; Facebook pages are found through the SERP zone", started.ok && /Reddit: NOT searched \(Reddit research is off/.test(started.summary) && /found with Bright Data SERP/.test(started.summary) && data.urlFinder === "brightdata_serp", started.summary);
    const redditBefore = triggersOf("reddit_posts").length;
    const run = await runJob(data.jobId);
    const result = (run.job.result ?? {}) as Record<string, unknown> & { sources?: { platform: string; state: string; reason: string | null; credits: number }[] };
    const serpRows = (await ledger(data.jobId)).filter((row) => row.product === "serp");
    check("the job searched Facebook only: two SERP requests (one credit each, settled), the pages read, Reddit never triggered", run.job.status === "succeeded" && bd.serp.length === serpBefore + 2 && bd.serp.every((body) => body.zone === `serp_check_${tag}` && body.data_format === "parsed_light") && serpRows.length === 2 && serpRows.every((row) => row.status === "settled" && row.usedUnits === 1) && triggersOf("reddit_posts").length === redditBefore && result.sources?.find((item) => item.platform === "reddit")?.state === "not_searched" && result.sources?.find((item) => item.platform === "facebook")?.state === "searched" && result.eligible === 1, JSON.stringify({ status: run.job.status, error: run.job.error, serp: bd.serp.length - serpBefore, rows: serpRows.length, sources: result.sources }));
    const chatEvents = await reports(thread.id, data.jobId);
    check("the report tells the owner Reddit was not searched, with the reason, beside what Facebook returned and the credits used", chatEvents.some((content) => /Reddit \(Bright Data\): not searched \(Reddit research is off/.test(content) && /Facebook \(Bright Data\): 2 findings, 2 credits/.test(content) && /Bright Data credits used: 2 \(estimated/.test(content)), chatEvents.join(" | ").slice(0, 600));
  });

  // ------------------------------------------------------------ B: another organization sees and reuses nothing
  await runInOrganization(orgs.B, async () => {
    const before = await brightdataSettingsView();
    const rows = await ledger();
    const audiences = await db.select({ id: leadAudiences.id }).from(leadAudiences).where(inOrg(leadAudiences));
    const persons = await db.select({ id: people.id }).from(people).where(inOrg(people));
    check("B sees no connection, no usage, no audience and no person of A", !before.connected && before.usedThisMonth === 0 && rows.length === 0 && audiences.length === 0 && persons.length === 0);
    let thrown = "";
    try {
      await pollCollection(usageA);
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }
    check("B cannot poll A's collection", /not recorded/.test(thrown), thrown);
    await setFeature("brightdata", true, null);
    await saveBrightdataSettings({ key: KEY_B, redditEnabled: true }, null);
    const triggersBefore = bd.triggers.length;
    const own = await startCollection({ spec: specA!, jobId: crypto.randomUUID(), requestId: null });
    check("the same inputs A settled are not reused across organizations: B pays for its own collection, with its own key", own.started && !own.reused && bd.triggers.length === triggersBefore + 1 && bd.triggers.at(-1)!.auth === `Bearer ${KEY_B}`, JSON.stringify(own));
    const [membersOfA] = await db.select({ n: sql<number>`count(*)::int` }).from(leadAudienceMembers).where(and(inOrg(leadAudienceMembers), eq(leadAudienceMembers.audienceId, audienceA)));
    check("A's audience members are not visible from B", Number(membersOfA?.n) === 0);
  });

  check("every outside call went to a stand-in", blocked.length === 0, blocked.join(", "));
} finally {
  await db.delete(brightdataSettings).where(inArray(brightdataSettings.organizationId, checkOrganizations));
  await db.delete(tavilySettings).where(inArray(tavilySettings.organizationId, checkOrganizations));
  await db.delete(assistantObjectives).where(inArray(assistantObjectives.organizationId, checkOrganizations));
}

if (failures) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("All Bright Data checks passed");
process.exit(0);

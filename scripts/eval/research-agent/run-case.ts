/**
 * One evaluation case of the research agent, end to end on a local
 * disposable database (agentsdr_eval…/agentsdr_audit): the real chat turn
 * (runAgentTurn), the real tools, worker stages, judging, objective driver,
 * continuation and final report. Every outside provider is a stand-in (fetch
 * intercepted): the Google Maps scraper, Apify, TinyFish Search/Fetch,
 * Unipile (Instagram profile reads), business websites and directories;
 * LinkedIn people search is stood in at the search-batch module. Nothing is
 * sent and no plan is started (plans may be prepared; they wait for Start).
 *
 *   EVAL_MODE=scripted|real EVAL_CASE=c1..c8 EVAL_RUN=1 EVAL_AGENT=v1|v2 \
 *   EVAL_MODEL=deepseek/deepseek-chat AIML_API_KEY=… DATABASE_URL=…/agentsdr_eval \
 *     bun run --conditions=react-server scripts/eval/research-agent/run-case.ts
 *
 * scripted: the structured-completion module answers by schema from a script
 *   (the chat replies) and keyword rules (the lead judge): wiring only.
 * real: the chat (assistant_reply) and the lead judge (lead_sorting) go to the
 *   organization's AI connection, AI/ML API with EVAL_MODEL (key from
 *   AIML_API_KEY, saved encrypted, deleted at the end, never printed); the
 *   plan writer's schemas are answered by fixed text in both modes so the
 *   model budget is spent on research decisions. At most EVAL_MODEL_CAP model
 *   calls per run.
 *
 * The result (tools called, leads with their ground truth, plans, spend,
 * model calls and tokens) is written to EVAL_OUT (default
 * .data/eval/research-agent) as <mode>-<agent>-<model>-<case>-r<run>.json;
 * score.ts grades it.
 */
import { mock } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { CASES, truthOf, type CaseFixture, type IgPost } from "./fixtures";

const WT = join(import.meta.dir, "../../..");
const OUT = process.env.EVAL_OUT ?? join(WT, ".data/eval/research-agent");
const MODE = (process.env.EVAL_MODE ?? "scripted") as "scripted" | "real";
const CASE_ID = process.env.EVAL_CASE ?? "c1";
const RUN = process.env.EVAL_RUN ?? "1";
const AGENT = (process.env.EVAL_AGENT ?? "v1") as "v1" | "v2";
const CONT_CAP = Number(process.env.EVAL_CONT_CAP ?? 3);
const MODEL_CAP = Number(process.env.EVAL_MODEL_CAP ?? 24);
const MAX_MS = Number(process.env.EVAL_MAX_MS ?? 10 * 60_000);
const MODEL = process.env.EVAL_MODEL ?? "deepseek/deepseek-chat";
/** The rules each case's scripted judge uses (wiring only, never the ground truth). */
const RULE_CASE: Record<string, string> = { c1: "c1", c2: "c2", c3: "c3", c4: "c4", c5: "c5", c5b: "c5", c6: "c1", c7: "c7", c8: "c1" };

const dbUrl = process.env.DATABASE_URL ?? "";
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl) || !/\/agentsdr_(audit|eval\w*)(\?|$)/.test(dbUrl)) {
  console.error("Refusing to run: DATABASE_URL must be a local agentsdr_eval… or agentsdr_audit database.");
  process.exit(2);
}
const fixture: CaseFixture = CASES[CASE_ID]!;
if (!fixture) throw new Error(`unknown case ${CASE_ID}`);
const aimlKey = (process.env.AIML_API_KEY ?? "").trim();
if (MODE === "real" && !aimlKey) throw new Error("AIML_API_KEY is not set");
const redact = (text: string) => (aimlKey ? text.split(aimlKey).join("[key]") : text);

// Unique per run even when several start in the same millisecond.
const stamp = Date.now() * 1000 + (process.pid % 1000);
const SCRAPER = `http://scraper-${stamp}.audit.invalid`;
const APIFY = `https://apify-${stamp}.audit.invalid/v2`;
const UNIPILE = `https://unipile-${stamp}.audit.invalid`;
const TF = { search: `https://search-${stamp}.tf.invalid`, fetch: `https://fetch-${stamp}.tf.invalid`, browser: `https://browser-${stamp}.tf.invalid` };
const TINYFISH_KEY = `sk-tinyfish-audit-${stamp}`;
const APIFY_TOKEN = `apify-audit-${stamp}`;
const IG_ACCOUNT = `ig-audit-${stamp}`;
process.env.GMAPS_SCRAPER_URL = SCRAPER;
process.env.GEOCODER_URL = "off";
process.env.DISCOVERY_DNS_CHECK = "off";

// ── What every stand-in saw ─────────────────────────────────────────────────
const calls = {
  scraper: [] as string[],
  apify: [] as { actor: string; input: Record<string, unknown>; usage: number }[],
  tinyfishSearch: [] as string[],
  tinyfishFetch: [] as string[],
  unipile: [] as string[],
  linkedin: [] as string[],
  pages: [] as string[],
  aiml: [] as { path: string; status: number; ms: number }[],
  blocked: [] as string[],
};
const model = { bySchema: {} as Record<string, number>, real: 0, stubbed: 0, scripted: 0, capHit: false, inputTokens: 0, outputTokens: 0 };

// ── Websites and directories (both readers) ─────────────────────────────────
const html = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
function pageFor(url: string): string | null {
  const clean = url.replace(/#.*$/, "");
  return fixture.sites[clean] ?? fixture.sites[clean.replace(/\/$/, "")] ?? fixture.sites[`${clean}/`] ?? null;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ── Google Maps scraper ─────────────────────────────────────────────────────
const MAPS_HEADER = "input_id,link,title,category,address,website,phone,review_count,review_rating,place_id,cid,status,complete_address,emails";
const csv = (values: (string | number)[]) => values.map((value) => `"${String(value).replace(/"/g, "\"\"")}"`).join(",");
const scraperJobs = new Map<string, { phrase: string; nth: number }>();
function mapsCsv(job: { phrase: string; nth: number }): string {
  const rows = fixture.maps(job.phrase, job.nth).map((row, index) => csv([
    "1", `https://maps.google.com/?cid=${stamp}${job.nth}${index}`, row.title, row.category, row.address, row.website ?? "", row.phone ?? "", 25, row.rating ?? 4.5,
    `pl-${stamp}-${job.nth}-${index}`, `${stamp}${job.nth}${index}`, "", JSON.stringify({ city: row.city, country: "US" }), "",
  ]));
  return [MAPS_HEADER, ...rows].join("\n");
}

// ── Apify ───────────────────────────────────────────────────────────────────
type Run = { id: string; actor: string; items: unknown[]; usage: number };
const apifyRuns = new Map<string, Run>();
function igProfileItem(username: string) {
  const profile = fixture.igProfiles[username];
  if (!profile) return null;
  return { username, url: `https://www.instagram.com/${username}/`, fullName: profile.fullName, biography: profile.biography, externalUrl: profile.externalUrl ?? null, businessEmail: profile.businessEmail ?? null, businessCategoryName: profile.businessCategoryName ?? null, private: false, isBusinessAccount: true, followersCount: 1200, latestPosts: profile.latestPosts ?? [] };
}
function postItem(post: IgPost, tag: string) {
  return { ownerUsername: post.ownerUsername, url: `https://www.instagram.com/p/${post.shortcode}${stamp % 1000}/`, caption: post.caption, timestamp: "2026-10-12T15:00:00.000Z", locationName: post.locationName ?? null, inputUrl: `https://www.instagram.com/explore/tags/${tag}/` };
}
function apifyItems(actor: string, input: Record<string, unknown>): { items: unknown[]; usage: number } {
  if (actor === "apify~instagram-hashtag-scraper") {
    const tags = (input.hashtags as string[] | undefined) ?? ["hairsalon"];
    return { items: fixture.igHashtagPosts.map((post, index) => postItem(post, tags[index % tags.length]!)), usage: 0.05 };
  }
  if (actor === "apify~instagram-profile-scraper") {
    const names = (input.usernames as string[] | undefined) ?? [];
    return { items: names.map(igProfileItem).filter(Boolean), usage: 0.03 };
  }
  if (actor === "apify~instagram-search-scraper") return { items: fixture.igSearch.map((username) => ({ username })), usage: 0.02 };
  if (actor === "apify~facebook-search-scraper") return { items: fixture.facebookPages, usage: 0.03 };
  if (actor === "harvestapi~linkedin-company-search") return { items: fixture.linkedinCompanies, usage: 0.06 };
  return { items: [], usage: 0.01 };
}
function apifyAnswer(method: string, url: URL, init?: RequestInit): Response {
  const path = url.pathname.replace(/^\/v2/, "");
  if (new Headers(init?.headers).get("authorization") !== `Bearer ${APIFY_TOKEN}`) return json(401, { error: { type: "token-not-valid", message: "Authentication token is not valid" } });
  if (method === "GET" && path === "/users/me") return json(200, { data: { username: "audit" } });
  if (method === "GET" && path === "/users/me/limits") return json(200, { data: { limits: { maxMonthlyUsageUsd: 50 }, current: { monthlyUsageUsd: 2 } } });
  const start = path.match(/^\/actors\/([^/]+)\/runs$/);
  if (method === "POST" && start) {
    const actor = decodeURIComponent(start[1]!);
    const input = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const { items, usage } = apifyItems(actor, input);
    const id = `run-${apifyRuns.size + 1}-${stamp}`;
    apifyRuns.set(id, { id, actor, items, usage });
    calls.apify.push({ actor, input, usage });
    return json(201, { data: { id, status: "RUNNING", defaultDatasetId: `ds-${id}`, usageTotalUsd: 0 } });
  }
  const runMatch = path.match(/^\/actor-runs\/([^/]+)$/);
  if (method === "GET" && runMatch) {
    const run = apifyRuns.get(runMatch[1]!);
    if (!run) return json(404, { error: { type: "record-not-found", message: "Run not found" } });
    return json(200, { data: { id: run.id, status: "SUCCEEDED", statusMessage: null, defaultDatasetId: `ds-${run.id}`, usageTotalUsd: run.usage } });
  }
  const items = path.match(/^\/datasets\/ds-([^/]+)\/items$/);
  if (method === "GET" && items) {
    const run = apifyRuns.get(items[1]!);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 1000);
    return json(200, (run?.items ?? []).slice(offset, offset + limit));
  }
  return json(405, { error: { type: "not-in-stand-in", message: `${method} ${path}` } });
}

// ── Unipile (Instagram profile reads only) ──────────────────────────────────
function unipileAnswer(method: string, url: URL): Response {
  const path = url.pathname.replace(/^\/api\/v1/, "");
  calls.unipile.push(`${method} ${path}`);
  if (method !== "GET") return json(405, { title: "The audit allows reads only", status: 405 });
  const user = path.match(/^\/users\/([^/]+)$/);
  if (user) {
    const username = decodeURIComponent(user[1]!).toLowerCase();
    const profile = fixture.igProfiles[username];
    if (!profile) return json(404, { title: "Not found", status: 404 });
    return json(200, { object: "UserProfile", provider: "INSTAGRAM", provider_id: `pk-${username}`, username, full_name: profile.fullName, biography: profile.biography, external_url: profile.externalUrl ?? null, public_email: profile.businessEmail ?? null, is_business: true, is_private: false });
  }
  return json(404, { title: `No stand-in for ${method} ${path}`, status: 404 });
}

// ── TinyFish ────────────────────────────────────────────────────────────────
function tinyfishAnswer(method: string, url: URL, init?: RequestInit): Response {
  if (url.origin === new URL(TF.search).origin) {
    const query = url.searchParams.get("query") ?? "";
    calls.tinyfishSearch.push(query);
    const hits = fixture.tinyfish(query);
    return json(200, { query, results: hits.map((hit, index) => ({ position: index + 1, site_name: new URL(hit.url).hostname, title: hit.title, snippet: hit.snippet, url: hit.url })), total_results: hits.length, page: 0 });
  }
  if (url.origin === new URL(TF.fetch).origin && method === "POST") {
    const urls = (JSON.parse(String(init?.body ?? "{}")) as { urls?: string[] }).urls ?? [];
    calls.tinyfishFetch.push(...urls);
    const results: unknown[] = [];
    const errors: unknown[] = [];
    for (const link of urls) {
      const body = pageFor(link);
      if (!body) {
        errors.push({ url: link, error: "page_not_found", status: 404 });
        continue;
      }
      const text = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const links = [...body.matchAll(/href="([^"]+)"/g)].map((match) => match[1]!);
      results.push({ url: link, final_url: link, title: body.match(/<title>([^<]*)<\/title>/)?.[1] ?? null, text, links });
    }
    return json(200, { results, errors });
  }
  return json(404, {});
}

// ── The interception ────────────────────────────────────────────────────────
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (url.hostname === "api.aimlapi.com") {
    if (MODE !== "real") {
      calls.blocked.push(`${method} ${url.href}`);
      return json(500, { error: "AI/ML API is not reachable in scripted mode" });
    }
    const started = Date.now();
    const response = await realFetch(input, init);
    calls.aiml.push({ path: url.pathname, status: response.status, ms: Date.now() - started });
    return response;
  }
  if (url.origin === SCRAPER) {
    if (method === "POST" && url.pathname === "/api/v1/jobs") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { keywords?: string[] };
      const phrase = (body.keywords ?? []).join(" ");
      const id = `scrape-${scraperJobs.size + 1}-${stamp}`;
      scraperJobs.set(id, { phrase, nth: scraperJobs.size });
      calls.scraper.push(phrase);
      return json(201, { id });
    }
    const match = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)(\/download)?$/);
    const job = match ? scraperJobs.get(match[1]!) : undefined;
    if (!job) return json(404, { message: "job not found" });
    if (match![2]) return new Response(mapsCsv(job), { status: 200, headers: { "content-type": "text/csv" } });
    return json(200, { ID: match![1], Status: "ok" });
  }
  if (url.href.startsWith(APIFY)) return apifyAnswer(method, url, init);
  if (url.origin === UNIPILE) return unipileAnswer(method, url);
  if (url.hostname.endsWith(".tf.invalid")) return tinyfishAnswer(method, url, init);
  // A website or directory read directly (read_webpage's direct reader).
  const body = pageFor(url.href);
  if (body) {
    calls.pages.push(url.href);
    return html(body);
  }
  calls.blocked.push(`${method} ${url.href}`);
  return new Response("not found (audit stand-in)", { status: 404 });
}) as typeof fetch;

// ── The model: scripted, or real for the chat and the judge ─────────────────
type Input = { userPrompt: string; systemPrompt?: string; schemaName?: string; accept: (text: string) => void };
const scPath = join(WT, "src/lib/ai/server/structuredCompletion.ts");
const realComplete = MODE === "real" ? ((await import(scPath)) as { completeStructured: (input: Input) => Promise<unknown> }).completeStructured : null;

function leadsAsked(prompt: string): { index: number; facts: Record<string, string> }[] {
  return [...prompt.matchAll(/^(\d+)(?: \([^)]*\))?: (\{.*\})$/gm)].map((match) => ({ index: Number(match[1]), facts: JSON.parse(match[2]!) as Record<string, string> }));
}

/** The plan writer's schemas: fixed, valid text, so a plan can be prepared without spending the model budget. */
function writerStub(input: Input): string | null {
  switch (input.schemaName) {
    case "outreach_sequences": {
      const key = `${input.systemPrompt ?? ""}\n${input.userPrompt}`.match(/\{\{(p_[0-9a-f]+)\}\}/)?.[1];
      const line = key ? `{{${key}}}\n` : "";
      const channels = (input.userPrompt.match(/Write the messages for: ([^.\n]+)\./)?.[1] ?? "email").split(/,\s*/);
      const opening = "Do missed appointments cost you bookings each week? We send automatic reminders so clients turn up. Would a short demo be useful?";
      return JSON.stringify({ channels: channels.map((channel) => ({
        channel,
        messages: channel === "instagram"
          ? [{ subject: "", body: `Hi {{company}} team,\n${line}${opening}`, waitDays: 0 }]
          : channel === "email"
            ? [{ subject: "Fewer no-shows", body: `Hi {{company}} team,\n${line}${opening}\nBest regards,\nRavi`, waitDays: 0 }, { subject: "", body: "Happy to share how others set it up. Worth a look?\nRavi", waitDays: 3 }]
            : [{ subject: "", body: `Hi {{company}} team, ${opening}`.slice(0, 270), waitDays: 0 }, { subject: "", body: "Happy to share how others set it up. Worth a look?", waitDays: 3 }],
      })) });
    }
    case "first_message_review":
      return JSON.stringify({ messages: (input.userPrompt.match(/\b(email|whatsapp|linkedin|instagram)\b/g) ?? ["email"]).filter((value, index, all) => all.indexOf(value) === index).map((channel) => ({ channel, wouldReply: 4, reasons: [] })) });
    case "opening_lines":
      return JSON.stringify({ lines: leadsAsked(input.userPrompt).map(({ index }) => ({ index, line: "" })) });
    case "personal_messages":
      return JSON.stringify({ messages: [] });
    default:
      return null;
  }
}

/** The scripted lead judge: keyword rules per case (wiring only; not the ground truth). */
function scriptedJudge(input: Input): string {
  const rules: Record<string, { fits: RegExp; place: RegExp | null; not: RegExp }> = {
    c1: { fits: /hair|salon|blowout|curl|blonde|balayage/i, place: /miami/i, not: /nail|products|brand|supply|los angeles|fort lauderdale/i },
    c2: { fits: /\bcto\b|chief technology/i, place: null, not: /healthtech|vp engineering|fractional|bank|atm|kiosk/i },
    c3: { fits: /wedding photo|elopement/i, place: /austin/i, not: /houston|round rock|booth|camera store|portrait|bridal/i },
    c4: { fits: /dent/i, place: /austin/i, not: /$^/ },
    c5: { fits: /yoga/i, place: /denver/i, not: /boulder|store|outlet|mats/i },
    c7: { fits: /dent/i, place: /new york|brooklyn|astoria|NY 1\d{4}/i, not: /supply|jersey|pizza|legal/i },
  };
  const rule = rules[RULE_CASE[CASE_ID] ?? "c1"]!;
  return JSON.stringify({ leads: leadsAsked(input.userPrompt).map(({ index, facts }) => {
    const text = JSON.stringify(facts);
    const requestFit = rule.not.test(text) ? "does_not_fit" : rule.fits.test(text) && (!rule.place || rule.place.test(text)) ? "fits" : "unconfirmed";
    return { index, group: fixture.profile.targetCustomers ?? "Leads", approach: requestFit === "does_not_fit" ? "skip" : "standard", reason: `scripted rule: ${requestFit}`, requestFit, noWebsiteRequired: false };
  }) });
}

type Action = { tool: string; args: Record<string, unknown> };
const SCRIPTS: Record<string, Record<string, { message: string; actions: Action[] }>> = {
  c1: {
    owner1: { message: "Searching Instagram for hair salons in Miami; the DM plan follows for the ones whose profile places them in Miami.", actions: [{ tool: "find_instagram_prospects", args: { what: "hair salons", where: "Miami, FL", maxResults: 30, contactAfter: true } }] },
    cont1: { message: "Trying Instagram's own account search next.", actions: [{ tool: "find_social_leads", args: { platform: "instagram", what: "hair salons", where: "Miami, FL", maxResults: 30, contactAfter: true } }] },
    cont2: { message: "No other Instagram source fits this request.", actions: [] },
  },
  c2: {
    owner1: { message: "Searching LinkedIn for CTOs at fintech startups.", actions: [{ tool: "find_linkedin_leads", args: { keywords: "CTO fintech startup", maxResults: 25, contactAfter: true } }] },
    cont1: { message: "LinkedIn gives no email addresses, and no other source fits without a place.", actions: [] },
  },
  c3: {
    owner1: { message: "Searching Google Maps for wedding photographers in Austin; the email plan follows.", actions: [{ tool: "find_leads", args: { what: "wedding photographers", where: "Austin, TX", contactAfter: true, channels: ["email"] } }] },
    cont1: { message: "Most Maps results were not wedding photographers; searching the web for their own sites and directories.", actions: [{ tool: "find_customers_on_web", args: { customers: "wedding photographers", where: "Austin, TX", contactAfter: true, channels: ["email"] } }] },
    cont2: { message: "Trying a more specific Maps query.", actions: [{ tool: "find_leads", args: { what: "wedding photography studios", where: "Austin, TX", contactAfter: true, channels: ["email"] } }] },
  },
  c4: {
    owner1: { message: "Running the two tests: Google Maps and the web search, 5 results each, for dentists in Austin.", actions: [{ tool: "find_leads", args: { what: "dentists", where: "Austin, TX", maxResults: 5 } }, { tool: "find_customers_on_web", args: { customers: "dentists", where: "Austin, TX", maxResults: 5 } }] },
    cont1: { message: "Both tests have finished; nothing else was asked.", actions: [] },
  },
  c5: {
    owner1: { message: "Searching Google Maps (free) for yoga studios in Denver.", actions: [{ tool: "find_leads", args: { what: "yoga studios", where: "Denver, CO", maxResults: 20 } }] },
    cont1: { message: "Trying Instagram and the web next.", actions: [{ tool: "find_social_leads", args: { platform: "instagram", what: "yoga studios", where: "Denver, CO" } }, { tool: "find_customers_on_web", args: { customers: "yoga studios", where: "Denver, CO" } }] },
    cont2: { message: "Nothing else free fits.", actions: [] },
  },
};

/** Which turn the transcript is in, and whether it already acted. */
function scriptedReply(input: Input): string {
  const transcript = input.userPrompt.split("CONVERSATION (newest last):")[1] ?? input.userPrompt;
  const lines = transcript.split("\n");
  const owners = lines.filter((line) => line.startsWith("OWNER:")).length;
  const conts = lines.filter((line) => line.startsWith("EVENT: Continuing your request")).length;
  let lastStart = -1;
  lines.forEach((line, index) => { if (line.startsWith("OWNER:") || line.startsWith("EVENT: Continuing your request")) lastStart = index; });
  const acted = lines.slice(lastStart + 1).some((line) => line.startsWith("TOOL "));
  const lastIsCont = lastStart >= 0 && lines[lastStart]!.startsWith("EVENT: Continuing");
  const key = lastIsCont ? `cont${conts}` : `owner${owners}`;
  const script = SCRIPTS[CASE_ID]?.[key] ?? SCRIPTS[RULE_CASE[CASE_ID] ?? ""]?.[key] ?? { message: "Nothing else fits this request.", actions: [] };
  if (acted) return JSON.stringify({ message: "", actions: [], suggestions: [] });
  return JSON.stringify({ message: script.message, actions: script.actions.map((action) => ({ tool: action.tool, arguments: JSON.stringify(action.args) })), suggestions: [] });
}

const prompts: { schema: string; chars: number; userPromptTail: string }[] = [];
mock.module(scPath, () => ({
  completeStructured: async (input: Input) => {
    const schema = input.schemaName ?? "?";
    model.bySchema[schema] = (model.bySchema[schema] ?? 0) + 1;
    const stub = writerStub(input);
    if (stub !== null) {
      model.stubbed += 1;
      input.accept(stub);
      return { text: stub, model: "stub", provider: "stub", request: {}, response: {}, usage: {}, attempts: 1 };
    }
    if (MODE === "real") {
      if (model.real >= MODEL_CAP) {
        model.capHit = true;
        throw new Error(`eval model budget of ${MODEL_CAP} calls used (Connect an AI provider stand-in)`);
      }
      model.real += 1;
      prompts.push({ schema, chars: (input.systemPrompt?.length ?? 0) + input.userPrompt.length, userPromptTail: input.userPrompt.slice(-2500) });
      const completion = (await realComplete!(input)) as { usage?: { inputTokens?: number; outputTokens?: number } };
      model.inputTokens += completion.usage?.inputTokens ?? 0;
      model.outputTokens += completion.usage?.outputTokens ?? 0;
      return completion;
    }
    model.scripted += 1;
    const text = schema === "assistant_reply" ? scriptedReply(input) : schema === "lead_sorting" ? scriptedJudge(input) : (() => { throw new Error(`unexpected scripted call ${schema}`); })();
    prompts.push({ schema, chars: (input.systemPrompt?.length ?? 0) + input.userPrompt.length, userPromptTail: input.userPrompt.slice(-1500) });
    input.accept(text);
    return { text, model: "scripted", provider: "scripted", request: {}, response: {}, usage: {}, attempts: 1 };
  },
}));

// ── LinkedIn people search, stood in at its search-batch module ─────────────
const sbPath = join(WT, "src/lib/linkedin/searchBatches.ts");
const searchBatchesReal = { ...(await import(sbPath)) } as Record<string, unknown>;
const realCreateSearchBatch = searchBatchesReal.createSearchBatch as (input: { name: string; kind: string; accountIds: string[]; rows: { url: string; companyName: string | null }[] }) => Promise<{ id: string; queryCount: number }>;
const batchKeywords = new Map<string, string>();
mock.module(sbPath, () => ({
  ...searchBatchesReal,
  createSearchBatch: async (input: { name: string; kind: string; accountIds: string[]; rows: { url: string; companyName: string | null }[] }) => {
    const created = await realCreateSearchBatch(input);
    const keywords = new URL(input.rows[0]!.url).searchParams.get("keywords") ?? "";
    batchKeywords.set(created.id, keywords);
    calls.linkedin.push(keywords);
    return created;
  },
  startSearchBatchRun: async () => ({ started: true, runId: `audit-run-${stamp}` }),
  getSearchBatchDetail: async (id: string) => ({
    batch: { id, name: "audit", kind: "SINGLE", accountIds: [], createdAt: new Date().toISOString() },
    queries: [{ status: "COMPLETED", totalCount: fixture.linkedinPeople.length, lastError: null }],
    leads: /cto|chief tech/i.test(batchKeywords.get(id) ?? "") ? fixture.linkedinPeople : fixture.linkedinPeople.slice(0, 2),
  }),
}));

// ── App modules ─────────────────────────────────────────────────────────────
const { and, eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/lib/db");
const { organizations, users, members } = await import("@/lib/auth/schema");
const { gridProviderCredentials, gridProviders } = await import("@/lib/grid/schema");
const { encryptIntegrationCredentials } = await import("@/lib/integrations/credentials");
const { saveByokSettings } = await import("@/lib/ai/byok");
const { saveTinyfishSettings } = await import("@/lib/tinyfish/tinyfish.server");
const { setTinyfishApiBase } = await import("@/services/tinyfish");
const { setApifyApiBase } = await import("@/services/apify");
const { saveApifySettings } = await import("@/lib/apify/apify.server");
const { setFeature, clearFeatureCache } = await import("@/lib/features/flags.server");
const { isFeatureKey } = await import("@/lib/features/catalog");
const V2_FEATURE = "research_agent_v2";
const { saveChannelRules } = await import("@/lib/channels/rules.server");
const { runInOrganization } = await import("@/lib/tenancy/scope");
const { updateBusinessProfile } = await import("@/lib/assistant/profile.server");
const { createThread, listMessages, threadBusy } = await import("@/lib/assistant/threads.server");
const { runAgentTurn } = await import("@/lib/assistant/agent.server");
const { runOneAssistantStep, reconcileAssistantJobReports } = await import("@/lib/assistant/worker");
const { registerAssistantJobs } = await import("@/lib/assistant/register.server");
const { setDiscoveryPageOptions } = await import("@/lib/discovery/discovery.server");
const objectives = await import("@/lib/assistant/objective.server");
const schema = await import("@/lib/assistant/schema");
const { instagramAccounts } = await import("@/lib/instagram/schema");
const { mailboxes } = await import("@/lib/outreach/schema");
const { linkedInAccounts } = await import("@/lib/linkedin/schema");
const { MAX_DRY_CONTINUATIONS } = await import("@/lib/assistant/objective");

setTinyfishApiBase(TF);
setApifyApiBase(APIFY);
setDiscoveryPageOptions({
  allowPrivate: true,
  fetchImpl: (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = pageFor(url);
    calls.pages.push(`${body ? "" : "404 "}${url}`);
    return body ? html(body) : new Response("not found", { status: 404 });
  }) as typeof fetch,
});
registerAssistantJobs();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const timeline: string[] = [];
const t0 = Date.now();
const mark = (text: string) => { const line = `${String(Math.round((Date.now() - t0) / 100) / 10).padStart(6)}s ${text}`; timeline.push(line); console.log(line); };

const [org] = await db.insert(organizations).values({ name: `Eval ${MODE} ${AGENT} ${CASE_ID} r${RUN} ${stamp}`, slug: `eval-${MODE}-${AGENT}-${CASE_ID}-r${RUN}-${stamp}` }).returning();
const [owner] = await db.insert(users).values({ name: "Audit Owner", email: `owner-${stamp}@audit.invalid`, emailVerified: true }).returning();
await db.insert(members).values({ organizationId: org!.id, userId: owner!.id, role: "owner" });
const createdProviders: string[] = [];
let result: Record<string, unknown> = {};

try {
  await runInOrganization(org!.id, async () => {
    // ── Setup: the owner's connections (all stand-ins), features and profile ──
    clearFeatureCache();
    await saveChannelRules("general", { defaultPhoneCountry: "US" }, null);
    for (const key of ["web_discovery", "apify_discovery", "instagram"] as const) await setFeature(key, true, owner!.id);
    if (AGENT === "v2") {
      if (!isFeatureKey(V2_FEATURE)) throw new Error("This build has no research agent v2");
      await setFeature(V2_FEATURE, true, owner!.id);
    }
    clearFeatureCache();
    if (MODE === "real") {
      const [row] = await db.insert(gridProviders).values({ organizationId: org!.id, key: `ai-aimlapi-audit-${stamp}`, name: "AI/ML API (audit)", config: { aiProviderKey: "aimlapi", verification: { status: "verified", verifiedAt: new Date().toISOString() } }, enabled: true }).returning();
      createdProviders.push(row!.id);
      await db.insert(gridProviderCredentials).values({ providerId: row!.id, encryptedPayload: encryptIntegrationCredentials({ apiKey: aimlKey }) });
      await saveByokSettings({ connectionId: row!.id, providers: ["aimlapi"], modelsByProvider: { aimlapi: [MODEL] }, defaultModel: { provider: "aimlapi", modelId: MODEL }, transcriptionModel: null, researchModel: null, researchDailyLimit: 25, byokOnlyConfirmed: true });
    } else {
      const [row] = await db.insert(gridProviders).values({ organizationId: org!.id, key: `ai-stub-audit-${stamp}`, name: "AI (scripted audit)", config: { aiProviderKey: "aimlapi", verification: { status: "verified", verifiedAt: new Date().toISOString() } }, enabled: true }).returning();
      createdProviders.push(row!.id);
      await db.insert(gridProviderCredentials).values({ providerId: row!.id, encryptedPayload: encryptIntegrationCredentials({ apiKey: "scripted-no-key" }) });
      await saveByokSettings({ connectionId: row!.id, providers: ["aimlapi"], modelsByProvider: { aimlapi: [MODEL] }, defaultModel: { provider: "aimlapi", modelId: MODEL }, transcriptionModel: null, researchModel: null, researchDailyLimit: 25, byokOnlyConfirmed: true });
    }
    const [unipile] = await db.insert(gridProviders).values({ organizationId: org!.id, key: "platform-unipile", name: "Unipile (audit stand-in)" }).returning();
    createdProviders.push(unipile!.id);
    await db.insert(gridProviderCredentials).values({ providerId: unipile!.id, encryptedPayload: encryptIntegrationCredentials({ baseUrl: UNIPILE, dsn: UNIPILE, apiKey: "audit", notifySecret: "audit-secret" }) });
    await saveTinyfishSettings({ key: TINYFISH_KEY, useForWebSearch: true }, owner!.id);
    await saveApifySettings({ token: APIFY_TOKEN, approvedActors: ["google_maps", "instagram_hashtags", "instagram_profiles", "instagram_search", "facebook_pages", "linkedin_companies"], monthlyBudgetUsd: 20, maxChargePerRunUsd: 2, maxResultsPerRun: 50 }, owner!.id);
    if (fixture.senders.instagram) await db.insert(instagramAccounts).values({ organizationId: org!.id, unipileAccountId: IG_ACCOUNT, username: `salonflow_${stamp % 100000}`, name: "SalonFlow", status: "connected", connectedAt: new Date(Date.now() - 10 * 86_400_000), historyCutoffAt: new Date() });
    if (fixture.senders.email) await db.insert(mailboxes).values({ organizationId: org!.id, emailAddress: `ravi-${stamp}@sender.audit.invalid`, provider: "unipile", unipileAccountId: `mail-${stamp}`, displayName: "Ravi", status: "connected" });
    if (fixture.senders.linkedin) await db.insert(linkedInAccounts).values({ organizationId: org!.id, linkedinId: `audit-li-${stamp}`, username: `audit-li-${stamp}`, name: "Ravi", status: "CONNECTED", workTimezone: "UTC", workStartTime: "00:00", workEndTime: "23:59", workDays: "0,1,2,3,4,5,6", updatedAt: new Date() });
    await updateBusinessProfile(fixture.profile, owner!.id);
    calls.tinyfishSearch.length = 0; // the key check's own search is not part of the case
    calls.apify.length = 0;
    calls.blocked.length = 0;

    // ── The owner's request ──
    const thread = await createThread(owner!.id);
    mark(`OWNER: ${fixture.prompt}`);
    await runAgentTurn({ threadId: thread.id, userId: owner!.id, text: fixture.prompt });
    let followUpSent = false;
    let objective = (await objectives.threadObjectives(thread.id, 5))[0] ?? null;
    // The assistant asked instead of searching (v2 may already have written the brief): the owner answers once.
    const searchesStarted = await db.select({ id: schema.assistantJobs.id }).from(schema.assistantJobs)
      .where(and(eq(schema.assistantJobs.organizationId, org!.id), inArray(schema.assistantJobs.kind, ["discovery", "web_discovery", "linkedin_search", "apify_instagram", "social_research"]))).limit(1);
    if (!searchesStarted.length && fixture.followUp) {
      const last = [...(await listMessages(thread.id, 200))].reverse().find((row) => row.role === "assistant");
      mark(`no search after turn 1; assistant said: ${String(last?.content ?? "").slice(0, 200)}`);
      if (last && /\?/.test(last.content)) {
        followUpSent = true;
        mark(`OWNER (follow-up): ${fixture.followUp}`);
        await runAgentTurn({ threadId: thread.id, userId: owner!.id, text: fixture.followUp });
        objective = (await objectives.threadObjectives(thread.id, 5))[0] ?? null;
      }
    }

    // ── Drive the request's jobs to the end (this organization's jobs only) ──
    let harnessCap: string | null = null;
    let lastLine = "";
    while (objective && Date.now() - t0 < MAX_MS) {
      objective = (await objectives.getObjective(objective.id))!;
      if (objective.status === "stopped" && objective.reportedAt) break;
      const progress = objective.progress as { continuation?: { n: number; endedAt: string | null; judged: string | null; leadsAtStart: number }; dry?: number; waiting?: string };
      const cont = progress.continuation;
      if (!harnessCap && objective.status === "active" && (model.capHit || (cont && cont.n >= CONT_CAP && cont.endedAt && cont.judged))) {
        const facts = await objectives.objectiveFacts(objective);
        const busy = await threadBusy(thread.id);
        const dryStop = cont ? facts.leads === cont.leadsAtStart && (progress.dry ?? 0) + 1 >= MAX_DRY_CONTINUATIONS : false;
        if (model.capHit || (facts.openChildren === 0 && facts.followUpsPending === 0 && !busy && facts.leads < objective.leadTarget && !dryStop)) {
          harnessCap = model.capHit ? `model budget of ${MODEL_CAP} calls` : `continuation cap of ${CONT_CAP}`;
          mark(`harness cancels the research (${harnessCap})`);
          await objectives.setObjectiveState(objective.id, "cancel", { name: `audit harness (${harnessCap})` });
          continue;
        }
      }
      const due = await db.select({ id: schema.assistantJobs.id, kind: schema.assistantJobs.kind, stage: schema.assistantJobs.stage }).from(schema.assistantJobs)
        .where(and(eq(schema.assistantJobs.organizationId, org!.id), eq(schema.assistantJobs.status, "queued")));
      for (const job of due) {
        await db.update(schema.assistantJobs).set({ runAfter: new Date(Date.now() - 1_000) }).where(and(eq(schema.assistantJobs.id, job.id), eq(schema.assistantJobs.status, "queued")));
        await runOneAssistantStep({ jobId: job.id });
      }
      await reconcileAssistantJobReports(0).catch(() => 0);
      const jobs = await db.select({ kind: schema.assistantJobs.kind, status: schema.assistantJobs.status, stage: schema.assistantJobs.stage }).from(schema.assistantJobs).where(eq(schema.assistantJobs.organizationId, org!.id));
      const line = `objective ${objective.status} waiting=${progress.waiting ?? "-"} cont=${cont?.n ?? 0}${cont?.endedAt ? "(ended)" : ""} jobs=${jobs.map((job) => `${job.kind}:${job.status}/${job.stage}`).join(",")}`;
      if (line !== lastLine) { mark(line); lastLine = line; }
      await sleep(300);
    }
    // Plans being written in the background, a turn still running: let them end.
    for (let i = 0; i < 200 && (await threadBusy(thread.id)); i += 1) await sleep(300);

    // ── What happened ──
    const messages = await listMessages(thread.id, 500);
    const toolRows = messages.filter((row) => row.role === "tool").map((row) => ({
      tool: row.tool, args: row.toolInput, status: row.status, hidden: Boolean((row.toolResult as { hidden?: boolean } | null)?.hidden),
      summary: redact(String((row.toolResult as { summary?: string } | null)?.summary ?? row.content)).slice(0, 700),
    }));
    const said = messages.filter((row) => row.role === "assistant").map((row) => redact(row.content));
    const events = messages.filter((row) => row.role === "event").map((row) => redact(row.content));
    const owners = messages.filter((row) => row.role === "user").map((row) => row.content);
    const objectiveRows = await objectives.threadObjectives(thread.id, 5);
    const finalObjective = objectiveRows[0] ?? null;
    const facts = finalObjective ? await objectives.objectiveFacts(finalObjective) : null;
    const requestText = finalObjective ? await objectives.objectiveRequest(finalObjective) : null;
    const audiences = await db.select({ id: schema.leadAudiences.id, name: schema.leadAudiences.name }).from(schema.leadAudiences).where(and(eq(schema.leadAudiences.organizationId, org!.id), eq(schema.leadAudiences.threadId, thread.id)));
    const memberRows = audiences.length
      ? await db.select().from(schema.leadAudienceMembers).where(and(eq(schema.leadAudienceMembers.organizationId, org!.id), inArray(schema.leadAudienceMembers.audienceId, audiences.map((a) => a.id))))
      : [];
    const audienceName = new Map(audiences.map((a) => [a.id, a.name]));
    const judgedMembers = memberRows.map((member) => {
      const text = `${member.name ?? ""} ${JSON.stringify(member.facts ?? {})} ${JSON.stringify(member.evidence ?? [])}`;
      const truth = truthOf(fixture, text);
      return {
        list: audienceName.get(member.audienceId) ?? member.audienceId,
        personId: member.personId,
        name: member.name ?? (member.facts as Record<string, string> | null)?.businessName ?? (member.facts as Record<string, string> | null)?.instagram ?? null,
        instagram: (member.facts as Record<string, string> | null)?.instagram ?? null,
        status: member.status, reason: member.reason, channels: member.channels,
        fit: member.fit, fitReason: member.fitReason,
        location: (member.facts as Record<string, string> | null)?.location ?? (member.facts as Record<string, string> | null)?.city ?? null,
        truth: truth?.label ?? "unlabelled", truthWhy: truth?.why ?? null,
      };
    });
    const runs = await db.select({ id: schema.outreachRuns.id, status: schema.outreachRuns.status, channels: schema.outreachRuns.channels, plan: schema.outreachRuns.plan }).from(schema.outreachRuns).where(eq(schema.outreachRuns.organizationId, org!.id));
    const plans = runs.map((run) => {
      const plan = (run.plan ?? {}) as { assignments?: { channel: string; name?: string }[]; excluded?: { reason?: string }[]; summary?: string };
      const byChannel: Record<string, number> = {};
      for (const assignment of plan.assignments ?? []) byChannel[assignment.channel] = (byChannel[assignment.channel] ?? 0) + 1;
      return { status: run.status, channels: run.channels, assignments: (plan.assignments ?? []) as unknown as { personId: string; channel: string }[], assigned: plan.assignments?.length ?? 0, byChannel, excluded: (plan.excluded ?? []).length, excludedReasons: [...new Set((plan.excluded ?? []).map((item) => String(item.reason ?? "").slice(0, 140)))].slice(0, 4) };
    });
    const sends = [...(await db.execute(sql`select
      (select count(*) from outreach_run_leads where organization_id = ${org!.id}) as run_leads,
      (select count(*) from instagram_outreach_queue where organization_id = ${org!.id}) as instagram_queue,
      (select count(*) from outreach_campaigns where organization_id = ${org!.id}) as email_campaigns,
      (select count(*) from assistant_jobs where organization_id = ${org!.id} and kind = 'outreach_start') as start_jobs`))][0];
    const searchJobs = await db.select().from(schema.assistantJobs).where(and(eq(schema.assistantJobs.organizationId, org!.id), inArray(schema.assistantJobs.kind, ["discovery", "web_discovery", "linkedin_search", "apify_instagram", "social_research"]))).orderBy(schema.assistantJobs.createdAt);
    const report = finalObjective ? messages.find((row) => row.role === "event" && (row.toolResult as { objectiveId?: string; reportKey?: string } | null)?.objectiveId === finalObjective.id && (row.toolResult as { reportKey?: string }).reportKey) : null;

    result = {
      mode: MODE, agent: AGENT, case: CASE_ID, run: RUN, model: MODE === "real" ? MODEL : "scripted",
      organizationId: org!.id, threadId: thread.id, seconds: Math.round((Date.now() - t0) / 1000),
      owners, followUpSent, harnessCap,
      objective: finalObjective ? {
        request: requestText, leadTarget: finalObjective.leadTarget, timeLimitMinutes: finalObjective.timeLimitMinutes, spendCapUsd: finalObjective.spendCapUsd,
        named: (finalObjective.controls as { named?: unknown }).named, status: finalObjective.status, stopReason: finalObjective.stopReason, stopDetail: finalObjective.stopDetail,
        continuations: (finalObjective.progress as { continuation?: { n?: number } }).continuation?.n ?? 0, objectives: objectiveRows.length,
      } : null,
      facts: facts ? { leads: facts.leads, funnel: facts.funnel, spend: facts.spend, sources: facts.sources, web: facts.web, routes: facts.routes } : null,
      toolCalls: toolRows,
      said, events,
      finalReport: report ? redact(report.content) : null,
      searchJobs: searchJobs.map((job) => ({ kind: job.kind, status: job.status, criteria: (job.payload as { criteria?: unknown; keywords?: unknown; phrase?: unknown }).criteria ?? (job.payload as { keywords?: unknown }).keywords, phrase: (job.payload as { phrase?: unknown }).phrase, contactAfter: Boolean((job.payload as { contactAfter?: unknown }).contactAfter), result: job.result ? { found: (job.result as Record<string, unknown>).found, eligible: (job.result as Record<string, unknown>).eligible, excluded: (job.result as Record<string, unknown>).excluded, duplicates: (job.result as Record<string, unknown>).duplicates, note: String((job.result as Record<string, unknown>).note ?? "").slice(0, 300), providerNote: String((job.result as Record<string, unknown>).providerNote ?? "").slice(0, 300), fit: (job.result as Record<string, unknown>).fit } : null, error: job.error })),
      members: judgedMembers,
      plans, sends,
      providerCalls: calls,
      modelCalls: { ...model, aimlHttp: calls.aiml.length, aimlHttpStatuses: calls.aiml.map((call) => call.status) },
      promptSizes: prompts.map((item) => ({ schema: item.schema, chars: item.chars })),
      lastPrompts: prompts.filter((item) => item.schema === "assistant_reply").map((item) => redact(item.userPromptTail)),
      timeline,
    };
  });
} catch (error) {
  result = { ...result, error: redact(error instanceof Error ? `${error.message}\n${error.stack}` : String(error)), timeline };
  console.error(redact(String(error instanceof Error ? error.stack : error)));
} finally {
  // The key leaves the database with its connection; the organization stays for inspection.
  for (const id of createdProviders) await db.delete(gridProviders).where(eq(gridProviders.id, id)).catch(() => undefined);
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `${MODE}-${AGENT}-${(MODE === "real" ? MODEL : "scripted").replace(/[^a-z0-9.-]+/gi, "_")}-${CASE_ID}-r${RUN}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(`\nwrote ${file}; AI and provider rows deleted; organization ${org!.id}`);
  process.exit(0);
}

export {};

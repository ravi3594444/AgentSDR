/**
 * Website and directory discovery, end to end against the local database:
 * the real assistant tool (find_customers_on_web), the real worker stages,
 * website reading, saving, de-duplication and audiences, with every outside
 * service stood in (global fetch is intercepted; nothing leaves the machine):
 *
 * - the AI providers' web search: openrouter.ai (web plugin, url_citation
 *   annotations) and api.aimlapi.com (a research model's citations and
 *   search_results) answer from fixtures, and every answer's text names a
 *   URL that is NOT among its sources;
 * - Unipile (Instagram profile, post and comments, API v1) is a recording
 *   fake host;
 * - the businesses' websites and a directory page are served by a local
 *   Bun.serve: requests to *.test hosts are routed to it, and website reads
 *   run with setDiscoveryPageOptions({ allowPrivate: true }) so the address
 *   guard lets the loopback server through;
 * - DNS: DISCOVERY_DNS_CHECK=off, and the mail-server check is stubbed
 *   (setWebDiscoveryMailCheck): domains containing "nomail" have no mail
 *   servers, "lotus" and "glow" have them, anything else is unknown.
 *
 *   bun run --conditions=react-server scripts/e2e/web-discovery.ts
 *
 * It creates its own organizations ("Web discovery check A/B/C …") and AI,
 * Unipile and Instagram rows for them (credentials encrypted like any
 * integration), and removes the AI and Unipile rows at the end so nothing
 * points at the stand-ins. Refuses a non-local DATABASE_URL.
 *
 * The real worker claims any due job in the database, and a disposable
 * database may be shared with other checks running at the same time. While
 * it drives the worker, this script holds row locks (FOR UPDATE SKIP LOCKED,
 * no writes) on every other organization's claimable job, so the worker's
 * SKIP LOCKED claim only ever takes this script's own jobs.
 */
import { and, eq, inArray, sql } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}
process.env.DISCOVERY_DNS_CHECK = "off";

const stamp = Date.now();
const tag = stamp.toString(36);
const host = (slug: string) => `${slug}-${tag}.test`;
const site = (slug: string) => `https://${host(slug)}/`;
const UNIPILE = "https://unipile-web-check.invalid";
const IG_ACCOUNT = `ig-acc-${tag}`;
const SHORTCODE = `Cw${tag}Post`;
const POST_PROVIDER_ID = `3170_${tag}`;
const igProfile = (username: string) => `https://www.instagram.com/${username}/`;
const GLOW_IG = `glow.dental_${tag}`;
const QUIET_IG = `quiet.studio_${tag}`;
const POST_URL = `https://www.instagram.com/p/${SHORTCODE}/`;
const DIRECTORY = `${site("pune-guide")}top-10-dentists-in-pune/`;

// ------------------------------------------------------------ fixture websites (Bun.serve)
const PAGES: Record<string, { status: number; html: string }> = {
  [site("lotus")]: { status: 200, html: `<html><head><title>Home | Lotus Dental Care</title></head><body><h1>Lotus Dental Care</h1><a href="/contact">Contact us</a><a href="https://www.linkedin.com/company/lotus-dental-${tag}">LinkedIn</a></body></html>` },
  [`${site("lotus")}contact`]: { status: 200, html: `<p>Appointments: <a href="mailto:hello@${host("lotus")}">hello@${host("lotus")}</a></p><a href="tel:020 2553 1234">020 2553 1234</a>` },
  [site("smile")]: { status: 200, html: `<h1>Smile Care</h1><p>Write to HELLO@${host("smile")} for appointments.</p>` },
  [site("bright")]: { status: 200, html: `<h1>Bright Dental</h1><a href="tel:+912025550003">Call us</a>` },
  [site("pearl")]: { status: 200, html: `<h1>Pearl Dental</h1><p>Visit us in Aundh. We love smiles.</p>` },
  [site("nomail")]: { status: 200, html: `<h1>No Mail Dental</h1><a href="mailto:info@${host("nomail")}">Email</a>` },
  [site("broken")]: { status: 503, html: "unavailable" },
  [site("orchid")]: { status: 200, html: `<h1>Orchid Dental Studio</h1><a href="/about-us">About</a>` },
  [`${site("orchid")}about-us`]: { status: 200, html: `<p>Reach us: care@${host("orchid")}</p>` },
  [site("glow")]: { status: 200, html: `<h1>Glow Dental</h1><a href="mailto:hello@${host("glow")}">hello@${host("glow")}</a>` },
  [DIRECTORY]: {
    status: 200,
    html: `<html><head><title>Top 10 dentists in Pune</title></head><body><ol>
      <li><a href="${site("orchid")}">Orchid Dental Studio</a></li>
      <li><a href="${site("lotus")}">Lotus Dental Care</a> — call <a href="tel:+912025531234">+91 20 2553 1234</a></li>
      <li>Care Clinic — <a href="mailto:frontdesk@${host("careclinic")}">frontdesk@${host("careclinic")}</a></li>
      <li><a href="https://www.facebook.com/brightsmile-${tag}">Bright Smile on Facebook</a></li>
      <li><a href="https://www.justdial.com/Pune/Bright-Smile-${tag}">Bright Smile on Justdial</a></li>
    </ol><footer>Corrections: <a href="mailto:editor@${host("pune-guide")}">editor@${host("pune-guide")}</a></footer></body></html>`,
  },
  [site("invented-clinic")]: { status: 200, html: `<a href="mailto:boss@${host("invented-clinic")}">boss</a>` },
  [site("made-up")]: { status: 200, html: `<a href="mailto:boss@${host("made-up")}">boss</a>` },
};
const pageRequests: string[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    const target = `https://${request.headers.get("x-fixture-host")}${url.pathname}`;
    pageRequests.push(target);
    const page = PAGES[target];
    return new Response(page?.html ?? "not found", { status: page?.status ?? 404, headers: { "content-type": "text/html; charset=utf-8" } });
  },
});

// ------------------------------------------------------------ AI providers and Unipile, stood in
type AiCall = { provider: "openrouter" | "aimlapi"; body: Record<string, unknown> };
const aiCalls: AiCall[] = [];
let directoryAttempts = 0;
const unipileRequests: { method: string; path: string; query: Record<string, string> }[] = [];
const blocked: string[] = [];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const citation = (url: string, title: string, content?: string) => ({ type: "url_citation", url_citation: { url, title, ...(content ? { content } : {}), start_index: 0, end_index: 5 } });

function openRouterAnswer(query: string): Response {
  if (/Instagram/.test(query)) {
    return json(200, {
      id: "gen-ig",
      choices: [{ message: { role: "assistant", content: `Glow Dental on Instagram, and ${site("invented-clinic")}`, annotations: [
        citation(igProfile(GLOW_IG), "Glow Dental (@glow) • Instagram"),
        citation(igProfile(QUIET_IG), "Quiet Studio • Instagram"),
        citation(POST_URL, "Glow Dental on Instagram: “New clinic in Baner”"),
        citation(`https://www.facebook.com/glow-${tag}`, "Glow Dental | Facebook"),
      ] } }],
      usage: { prompt_tokens: 800, completion_tokens: 40, cost: 0.011 },
    });
  }
  if (/directories/.test(query)) {
    directoryAttempts += 1;
    if (directoryAttempts === 1) return json(429, { error: { message: "Rate limit exceeded", code: 429 } });
    return json(200, {
      id: "gen-dir",
      choices: [{ message: { role: "assistant", content: `The best list is ${site("invented-clinic")}directory`, annotations: [citation(DIRECTORY, "Top 10 dentists in Pune", "Our pick of the best dental clinics in Pune.")] } }],
      usage: { cost: 0.012 },
    });
  }
  return json(200, {
    id: "gen-sites",
    choices: [{ message: { role: "assistant", content: `Lotus Dental Care, Smile Care… also ${site("invented-clinic")} which I remember.`, annotations: [
      citation(site("lotus"), "Home | Lotus Dental Care", "Family dental clinic in Baner, Pune since 2004."),
      citation(site("smile"), "Smile Care"),
      citation(site("bright"), "Bright Dental – Baner"),
      citation(site("pearl"), "Pearl Dental"),
      citation(site("nomail"), "No Mail Dental"),
      citation(site("broken"), "Broken Dental"),
    ] } }],
    usage: { cost: 0.013 },
  });
}

function aimlAnswer(): Response {
  return json(200, {
    choices: [{ message: { role: "assistant", content: `See ${site("made-up")} [1][2][3]` } }],
    citations: [site("lotus"), igProfile(GLOW_IG), POST_URL],
    search_results: [{ title: "Lotus Dental Care", url: site("lotus"), snippet: "Dentist in Baner" }],
    meta: { usage: { usd_spent: 0.006 } },
  });
}

function unipileAnswer(method: string, url: URL): Response {
  const path = url.pathname.replace(/^\/api\/v1/, "");
  unipileRequests.push({ method, path, query: Object.fromEntries(url.searchParams) });
  if (method !== "GET") return json(405, { title: "This check only allows reads", status: 405 });
  if (url.searchParams.get("account_id") !== IG_ACCOUNT) return json(400, { title: "Wrong account", status: 400 });
  if (path === `/users/${GLOW_IG}`) {
    return json(200, { object: "UserProfile", provider: "INSTAGRAM", pk: 4211, username: GLOW_IG, full_name: "Glow Dental", biography: "Smiles in Baner", is_business: true, is_private: false, follower_count: 900, following_count: 10, is_verified: false, profile_pic_url: "https://x", external_url: site("glow") });
  }
  if (path === `/users/${QUIET_IG}`) {
    return json(200, { object: "UserProfile", provider: "INSTAGRAM", pk: 4212, username: QUIET_IG, full_name: "Quiet Studio", biography: "DM for bookings", is_business: true, is_private: false });
  }
  if (path === `/posts/${SHORTCODE}`) {
    return json(200, { object: "Post", provider: "INSTAGRAM", id: SHORTCODE, provider_id: POST_PROVIDER_ID, text: "New clinic in Baner", author: { username: GLOW_IG } });
  }
  if (path === `/posts/${POST_PROVIDER_ID}/comments`) {
    const comment = (id: string, text: string, name: string, username: string, date: string) => ({ object: "Comment", id, text, date, author: name, reaction_counter: 0, reply_counter: 0, author_details: { id: `u-${id}`, headline: null, profile_url: igProfile(username), network_distance: null } });
    return json(200, {
      object: "CommentList",
      items: [
        comment("c1", "need a dentist near Baner, any recommendation?", "Priya K", `priya.k_${tag}`, "2026-10-14T10:00:00.000Z"),
        comment("c2", "😍🔥", "Rohit S", `rohit.s_${tag}`, "2026-10-14T10:05:00.000Z"),
        comment("c3", "nice post", "Meera", `meera_${tag}`, "2026-10-14T10:06:00.000Z"),
        comment("c4", "follow back", "Sam", `sam_${tag}`, "2026-10-14T10:07:00.000Z"),
        comment("c5", "Thank you all!", "Glow Dental", GLOW_IG, "2026-10-14T11:00:00.000Z"),
        comment("c6", "and how much for a cleaning?", "Priya K", `priya.k_${tag}`, "2026-10-14T10:10:00.000Z"),
      ],
      cursor: null,
      total_items: 6,
    });
  }
  return json(404, { title: `No fake for ${method} ${path}`, status: 404 });
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (url.hostname.endsWith(".test")) {
    const headers = new Headers(init?.headers);
    headers.set("x-fixture-host", url.hostname);
    return realFetch(`http://127.0.0.1:${server.port}${url.pathname}${url.search}`, { ...init, headers });
  }
  if (url.origin === "https://openrouter.ai" && url.pathname === "/api/v1/chat/completions") {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    aiCalls.push({ provider: "openrouter", body });
    const query = String((body.messages as { content: string }[])[1]?.content ?? "");
    return openRouterAnswer(query);
  }
  if (url.origin === "https://api.aimlapi.com" && url.pathname === "/v1/chat/completions") {
    aiCalls.push({ provider: "aimlapi", body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return aimlAnswer();
  }
  if (url.origin === UNIPILE) return unipileAnswer(method, url);
  // Anything else would leave the machine: refused and reported.
  blocked.push(`${method} ${url.href}`);
  return new Response("blocked by the web discovery check", { status: 599 });
}) as typeof fetch;

// ------------------------------------------------------------ app modules
const { db } = await import("@/lib/db");
const { organizations } = await import("@/lib/auth/schema");
const { people } = await import("@/lib/leads/schema");
const { gridProviderCredentials, gridProviders } = await import("@/lib/grid/schema");
const { encryptIntegrationCredentials } = await import("@/lib/integrations/credentials");
const { saveByokSettings } = await import("@/lib/ai/byok");
const { saveChannelRules } = await import("@/lib/channels/rules.server");
const { setFeature } = await import("@/lib/features/flags.server");
const { instagramAccounts } = await import("@/lib/instagram/schema");
const { runInOrganization, currentOrganizationId, inOrg } = await import("@/lib/tenancy/scope");
const { assistantJobs, assistantMessages, leadAudienceMembers, leadAudiences } = await import("@/lib/assistant/schema");
const { memberInsights } = await import("@/lib/assistant/audiences.server");
const { runTool } = await import("@/lib/assistant/tools.server");
const { runOneAssistantStep } = await import("@/lib/assistant/worker");
const { registerAssistantJobs } = await import("@/lib/assistant/register.server");
const { createThread, claimThread, releaseThread } = await import("@/lib/assistant/threads.server");
const { listAudiences, summarizeAudience } = await import("@/lib/assistant/audiences.server");
const { setDiscoveryPageOptions } = await import("@/lib/discovery/discovery.server");
const { setWebDiscoveryMailCheck, startWebDiscovery, normalizeWebCriteria, WebDiscoveryUnavailableError, INSTAGRAM_ONLY_REASON, INSTAGRAM_PROFILE_ONLY_REASON } = await import("@/lib/discovery/webDiscovery.server");

setDiscoveryPageOptions({ allowPrivate: true });
setWebDiscoveryMailCheck(async (domain) => (domain.includes("nomail") ? "rejects" : /lotus|glow/.test(domain) ? "accepts" : "unknown"));
registerAssistantJobs();

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures += 1;
}

const createdProviders: string[] = [];
async function aiConnection(providerKey: "openrouter" | "aimlapi"): Promise<string> {
  const [row] = await db.insert(gridProviders).values({
    organizationId: currentOrganizationId(),
    key: `ai-${providerKey}-check-${tag}-${Math.random().toString(36).slice(2, 8)}`,
    name: `${providerKey} (web discovery check)`,
    config: { aiProviderKey: providerKey, verification: { status: "verified", verifiedAt: new Date().toISOString() } },
    enabled: true,
  }).returning();
  await db.insert(gridProviderCredentials).values({ providerId: row!.id, encryptedPayload: encryptIntegrationCredentials(providerKey === "openrouter" ? { apiKey: "sk-or-check", managementKey: "sk-or-mgmt-check" } : { apiKey: "aiml-check" }) });
  createdProviders.push(row!.id);
  return row!.id;
}

const checkOrganizations: string[] = [];

/**
 * Runs the real worker until the job finishes, holding (in one open
 * transaction) row locks on every claimable job of other organizations, so
 * the worker never takes another check's job. Nothing of theirs is written.
 */
async function runJob(jobId: string): Promise<{ job: typeof assistantJobs.$inferSelect; stages: string[] }> {
  const stages: string[] = [];
  let job: typeof assistantJobs.$inferSelect | undefined;
  await db.transaction(async (tx) => {
    const fence = () => tx.execute(sql`
      select id from assistant_jobs
      where organization_id not in (${sql.join(checkOrganizations.map((id) => sql`${id}::uuid`), sql`, `)})
        and (status = 'queued' or status = 'running')
      for update skip locked`);
    for (let step = 0; step < 80; step += 1) {
      [job] = await db.select().from(assistantJobs).where(eq(assistantJobs.id, jobId));
      if (!job) throw new Error(`job ${jobId} disappeared`);
      if (stages.at(-1) !== job.stage) stages.push(job.stage);
      if (job.status === "succeeded" || job.status === "failed") break;
      if (job.runAfter.getTime() > Date.now()) await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, job!.runAfter.getTime() - Date.now())));
      await fence();
      await runOneAssistantStep();
    }
  });
  return { job: job!, stages };
}

const orgs: Record<"A" | "B" | "C", string> = { A: "", B: "", C: "" };
for (const name of ["A", "B", "C"] as const) {
  const [org] = await db.insert(organizations).values({ name: `Web discovery check ${name} ${stamp}`, slug: `web-discovery-${name.toLowerCase()}-${stamp}` }).returning();
  orgs[name] = org!.id;
  checkOrganizations.push(org!.id);
}
console.log(`Organizations A ${orgs.A}, B ${orgs.B}, C ${orgs.C}`);
const ctx = (threadId: string) => ({ threadId, userId: null, ownerText: "Find dental clinics in Baner, Pune" });

let audienceA = "";
let jobA = "";
try {
  // ------------------------------------------------------------ C: feature off, then no provider
  await runInOrganization(orgs.C, async () => {
    const thread = await createThread(null);
    const off = await runTool("find_customers_on_web", { customers: "dental clinics", where: "Baner, Pune" }, ctx(thread.id));
    check("feature off: the tool refuses with the feature's message", !off.ok && /Website and directory search is off for this organization/.test(off.summary), off.summary);
    let thrown = "";
    try {
      const criteria = normalizeWebCriteria({ customers: "dental clinics", where: "Pune" });
      if ("error" in criteria) throw new Error(criteria.error);
      await startWebDiscovery(criteria, { threadId: null, userId: null });
    } catch (error) {
      thrown = error instanceof WebDiscoveryUnavailableError ? error.message : `unexpected: ${String(error)}`;
    }
    check("feature off: startWebDiscovery refuses too", /is off for this organization/.test(thrown), thrown);
    const jobs = await db.select({ id: assistantJobs.id }).from(assistantJobs).where(inOrg(assistantJobs));
    const audiences = await db.select({ id: leadAudiences.id }).from(leadAudiences).where(inOrg(leadAudiences));
    check("feature off: no job and no audience were created", jobs.length === 0 && audiences.length === 0, `${jobs.length} jobs, ${audiences.length} audiences`);

    await setFeature("web_discovery", true, null);
    const noProvider = await runTool("find_customers_on_web", { customers: "dental clinics", where: "Baner, Pune" }, ctx(thread.id));
    check("no AI provider: the tool says web search is unavailable and why", !noProvider.ok && /needs an AI provider that searches the web/.test(noProvider.summary), noProvider.summary);
    const setup = await runTool("check_setup", {}, ctx(thread.id));
    check("check_setup reports website and directory search as not ready", /Website and directory search: not ready — .*needs an AI provider/.test(setup.summary), setup.summary);
    const after = await db.select({ id: assistantJobs.id }).from(assistantJobs).where(inOrg(assistantJobs));
    check("no provider: still no job", after.length === 0);
  });

  // ------------------------------------------------------------ B: AI/ML API without, then with, a research model; Instagram off
  const orchidB = { audienceId: "", jobId: "" };
  await runInOrganization(orgs.B, async () => {
    await setFeature("web_discovery", true, null);
    const connectionId = await aiConnection("aimlapi");
    const settings = {
      connectionId,
      providers: ["aimlapi"],
      modelsByProvider: { aimlapi: ["openai/gpt-4o-mini", "perplexity/sonar"] },
      defaultModel: { provider: "aimlapi", modelId: "openai/gpt-4o-mini" },
      transcriptionModel: null,
      researchModel: null,
      researchDailyLimit: 25,
      byokOnlyConfirmed: false,
    };
    await saveByokSettings(settings);
    const thread = await createThread(null);
    const without = await runTool("find_customers_on_web", { customers: "dental clinics", where: "Baner, Pune" }, ctx(thread.id));
    check("AI/ML API without a research model: unavailable, with the step to fix it", !without.ok && /web research model/.test(without.summary), without.summary);
    check("…and no job was created", (await db.select({ id: assistantJobs.id }).from(assistantJobs).where(inOrg(assistantJobs))).length === 0);

    await saveByokSettings({ ...settings, researchModel: { provider: "aimlapi", modelId: "perplexity/sonar" } });
    const started = await runTool("find_customers_on_web", { customers: "dental clinics", where: "Baner, Pune", maxResults: 10 }, ctx(thread.id));
    check("with a research model the tool starts a search and says Instagram is skipped", started.ok && /AI\/ML API web research/.test(started.summary) && /Instagram pages are skipped \(Instagram is off/.test(started.summary), started.summary);
    orchidB.jobId = String(started.data?.jobId ?? "");
    orchidB.audienceId = String(started.data?.audienceId ?? "");
  });
  // Detach B's chat so its finish does not start an agent turn (that needs a real model).
  await db.update(assistantJobs).set({ threadId: null }).where(eq(assistantJobs.id, orchidB.jobId));

  // ------------------------------------------------------------ A: OpenRouter, Instagram connected
  const existing = { emailPerson: "", phonePerson: "" };
  let threadA = "";
  await runInOrganization(orgs.A, async () => {
    await setFeature("web_discovery", true, null);
    await setFeature("instagram", true, null);
    await saveChannelRules("general", { defaultPhoneCountry: "IN" }, null);
    const connectionId = await aiConnection("openrouter");
    await saveByokSettings({
      connectionId,
      providers: ["openai"],
      modelsByProvider: { openai: ["openai/gpt-5-mini"] },
      defaultModel: { provider: "openai", modelId: "openai/gpt-5-mini" },
      transcriptionModel: null,
      researchModel: null,
      researchDailyLimit: 25,
      byokOnlyConfirmed: true,
    });
    const [unipile] = await db.insert(gridProviders).values({ organizationId: currentOrganizationId(), key: "platform-unipile", name: "Unipile (web discovery check)" }).returning();
    await db.insert(gridProviderCredentials).values({ providerId: unipile!.id, encryptedPayload: encryptIntegrationCredentials({ baseUrl: UNIPILE, apiKey: "web-check", notifySecret: "web-check-secret" }) });
    createdProviders.push(unipile!.id);
    await db.insert(instagramAccounts).values({ organizationId: currentOrganizationId(), unipileAccountId: IG_ACCOUNT, username: `owner_${tag}`, name: "Owner", status: "connected" });

    // People the owner already has: one by email (written in another case), one by phone only.
    const [byEmail] = await db.insert(people).values({ organizationId: currentOrganizationId(), email: `Hello@Smile-${tag}.test`, fullName: "Dr. Smile (already a lead)", source: "manual" }).returning();
    const [byPhone] = await db.insert(people).values({ organizationId: currentOrganizationId(), phone: "+912025550003", fullName: "Bright Dental front desk", source: "manual" }).returning();
    existing.emailPerson = byEmail!.id;
    existing.phonePerson = byPhone!.id;

    const setup = await runTool("check_setup", {}, ctx("00000000-0000-0000-0000-000000000000"));
    check("check_setup reports website and directory search as ready with OpenRouter", /Website and directory search: ready \(OpenRouter web search, openai\/gpt-5-mini\)/.test(setup.summary), setup.summary);

    const thread = await createThread(null);
    threadA = thread.id;
    const started = await runTool("find_customers_on_web", { customers: "dental clinics", where: "Baner, Pune", maxResults: 20 }, ctx(thread.id));
    check("the tool starts a search with OpenRouter, Instagram included", started.ok && /OpenRouter web search/.test(started.summary) && /Instagram profiles and posts it returns are read too/.test(started.summary), started.summary);
    jobA = String(started.data?.jobId ?? "");
    audienceA = String(started.data?.audienceId ?? "");
    const [audience] = await db.select().from(leadAudiences).where(and(inOrg(leadAudiences), eq(leadAudiences.id, audienceA)));
    const criteria = audience?.criteria as { source?: string; queries?: string[]; where?: string; customers?: string } | undefined;
    check("the audience is a discovery with the web search criteria", audience?.source === "discovery" && criteria?.source === "web_search" && criteria.queries?.length === 3 && criteria.where === "Baner, Pune" && criteria.customers === "dental clinics", JSON.stringify(audience?.criteria));
    // Hold the chat while the job runs, so the finished search's follow-up turn (which would need a real model) is refused as busy.
    await claimThread(thread.id);
  });

  const runA = await runJob(jobA);
  const runB = await runJob(orchidB.jobId);
  check("A ran through queued → searching → reading → saving → done", runA.job.status === "succeeded" && ["queued", "searching", "reading", "saving", "done"].every((stage) => runA.stages.includes(stage)), `${runA.job.status} ${runA.stages.join(" → ")} ${runA.job.error ?? ""}`);
  check("B succeeded", runB.job.status === "succeeded", `${runB.job.status} ${runB.job.error ?? ""}`);

  // ------------------------------------------------------------ provider requests
  const openRouter = aiCalls.filter((call) => call.provider === "openrouter");
  check("A sent 3 searches to OpenRouter with its web plugin, one retried once after a 429", openRouter.length === 4 && directoryAttempts === 2 && openRouter.every((call) => JSON.stringify(call.body.plugins) === JSON.stringify([{ id: "web", max_results: 10 }])), `${openRouter.length} calls, ${directoryAttempts} directory attempts`);
  check("OpenRouter calls are pinned to the selected provider", openRouter.every((call) => JSON.stringify(call.body.provider) === JSON.stringify({ only: ["openai"], order: ["openai"], allow_fallbacks: false, require_parameters: true })));
  const aiml = aiCalls.filter((call) => call.provider === "aimlapi");
  check("B searched with the AI/ML research model and web_search_options (2 searches, no Instagram query)", aiml.length === 2 && aiml.every((call) => call.body.model === "perplexity/sonar" && JSON.stringify(call.body.web_search_options) === JSON.stringify({ search_context_size: "low" })) && aiml.every((call) => !/Instagram/.test((call.body.messages as { role: string; content: string }[])[1]?.content ?? "")), `${aiml.length} calls`);
  check("a URL written only in the model's answer text is never read", !pageRequests.some((url) => url.includes(host("invented-clinic")) || url.includes(host("made-up"))), pageRequests.filter((url) => /invented|made-up/.test(url)).join(", "));
  check("nothing else left the machine", blocked.length === 0, blocked.join(", "));

  // ------------------------------------------------------------ A's audience
  const members = await runInOrganization(orgs.A, async () => {
    const rows = await db.select().from(leadAudienceMembers).where(and(inOrg(leadAudienceMembers), eq(leadAudienceMembers.audienceId, audienceA)));
    const insights = await memberInsights(rows.map((row) => row.id));
    return rows.map((row) => ({ ...row, matchReason: insights.get(row.id)?.matchReason ?? null, signals: insights.get(row.id)?.signals ?? [] }));
  });
  const personRows = await runInOrganization(orgs.A, () => db.select().from(people).where(inOrg(people)));
  const personOf = (id: string | null) => personRows.find((person) => person.id === id);
  const byEmail = (email: string) => members.find((member) => personOf(member.personId)?.email?.toLowerCase() === email.toLowerCase());
  const named = (needle: string) => members.find((member) => member.name.includes(needle) || JSON.stringify(member.facts).includes(needle));
  const result = runA.job.result as Record<string, unknown>;
  console.log(`A result: ${JSON.stringify({ ...result, searches: undefined, skipped: undefined })}`);

  const lotus = byEmail(`hello@${host("lotus")}`);
  const lotusEmail = lotus?.evidence.find((item) => item.kind === "email");
  const lotusPhone = lotus?.evidence.find((item) => item.kind === "phone");
  check("Lotus: a new person, eligible, with the email and the page it was on", lotus?.status === "eligible" && lotusEmail?.sourceUrl === `${site("lotus")}contact` && personOf(lotus.personId)?.source === "discovery:web-search", JSON.stringify(lotus?.evidence));
  check("Lotus: the email's evidence states the mail-server check and claims no delivery", lotusEmail?.source === "the business's website · domain has mail servers (MX); mailbox not verified", lotusEmail?.source ?? "");
  check("Lotus: the local phone number read with the organization's country (IN) and its page", lotusPhone?.value === "+912025531234" && lotusPhone.sourceUrl === `${site("lotus")}contact` && personOf(lotus!.personId)?.phone === "+912025531234", JSON.stringify(lotusPhone));
  check("Lotus: the match reason quotes the provider's title, snippet and the query", Boolean(lotus?.matchReason?.includes("“Home | Lotus Dental Care”") && lotus.matchReason.includes("“Family dental clinic in Baner, Pune since 2004.”") && lotus.matchReason.includes("dental clinics in Baner, Pune")), lotus?.matchReason ?? "");

  const smile = members.find((member) => member.personId === existing.emailPerson);
  const smileCount = personRows.filter((person) => person.email?.toLowerCase() === `hello@${host("smile")}`).length;
  check("an existing person with the same email (other case) is reused, not duplicated", Boolean(smile) && smileCount === 1, `member ${Boolean(smile)}, ${smileCount} people`);
  const bright = members.find((member) => member.personId === existing.phonePerson);
  const brightCount = personRows.filter((person) => person.phone === "+912025550003").length;
  check("an existing phone-only person with the same phone is reused, not duplicated", Boolean(bright) && brightCount === 1, `member ${Boolean(bright)}, ${brightCount} people`);
  check("both count as already known", Number(result.alreadyKnown) === 2, String(result.alreadyKnown));

  const pearl = members.find((member) => member.facts.website === site("pearl"));
  check("a site without contacts is excluded with the reason", pearl?.status === "excluded" && pearl.personId === null && pearl.reason === "no email or phone published on its website", pearl?.reason ?? "missing");
  const nomail = members.find((member) => member.facts.website === site("nomail"));
  check("a site whose email domain has no mail servers: the email is dropped and the site excluded", nomail?.status === "excluded" && nomail.reason === "its published email's domain does not receive mail, and it lists no phone" && !nomail.evidence.some((item) => item.kind === "email"), nomail?.reason ?? "missing");
  const broken = members.find((member) => member.facts.website === site("broken"));
  check("an unreadable site is excluded with its error", broken?.status === "excluded" && /could not be read .*HTTP 503/.test(broken.reason ?? ""), broken?.reason ?? "missing");

  const careClinic = byEmail(`frontdesk@${host("careclinic")}`);
  check("a directory page's own contact carries the directory page's URL", careClinic?.status === "eligible" && careClinic.sourceUrl === DIRECTORY && careClinic.evidence.some((item) => item.kind === "email" && item.sourceUrl === DIRECTORY), JSON.stringify(careClinic?.evidence));
  check("the directory operator's own address is not a lead", !personRows.some((person) => person.email === `editor@${host("pune-guide")}`));
  const orchid = byEmail(`care@${host("orchid")}`);
  check("a business linked from the directory is read, found through it", orchid?.status === "eligible" && orchid.sourceUrl === DIRECTORY && orchid.evidence.some((item) => item.kind === "email" && item.sourceUrl === `${site("orchid")}about-us`) && Boolean(orchid.matchReason?.startsWith("Linked from “Top 10 dentists in Pune”")), JSON.stringify({ sourceUrl: orchid?.sourceUrl, reason: orchid?.matchReason }));
  check("the directory's phone for Lotus is a duplicate within the run, not a second person", personRows.filter((person) => person.phone === "+912025531234").length === 1 && Number(result.duplicates) >= 1, `duplicates ${String(result.duplicates)}`);

  const glow = byEmail(`hello@${host("glow")}`);
  check("an Instagram profile's listed website is read; the lead keeps the profile as evidence", glow?.status === "eligible" && glow.evidence.some((item) => item.kind === "instagram" && item.value === igProfile(GLOW_IG)) && glow.sourceUrl === igProfile(GLOW_IG), JSON.stringify(glow?.evidence));
  const quiet = named("Quiet Studio");
  check("an Instagram profile with no website or contact is excluded as Instagram-only", quiet?.status === "excluded" && quiet.reason === INSTAGRAM_PROFILE_ONLY_REASON && quiet.evidence.some((item) => item.kind === "instagram"), quiet?.reason ?? "missing");

  const commenters = members.filter((member) => member.sourceUrl === POST_URL);
  const priya = commenters.find((member) => member.name === "Priya K");
  const others = commenters.filter((member) => member.name !== "Priya K");
  check("each commenter is a candidate (the post author's own reply is not)", commenters.length === 4 && !commenters.some((member) => member.name === "Glow Dental"), commenters.map((member) => member.name).join(", "));
  check("every Instagram-only commenter is excluded with the reason and Instagram evidence", commenters.every((member) => member.status === "excluded" && member.personId === null && member.reason === INSTAGRAM_ONLY_REASON && member.evidence.some((item) => item.kind === "instagram" && item.sourceUrl === POST_URL)), commenters.map((member) => member.reason).join(" | "));
  check("the explicit ask is a need, quoted, with the post and the comment's date", priya?.signals.length === 2 && priya.signals.every((signal) => signal.kind === "need" && signal.sourceUrl === POST_URL && signal.source === "Instagram comment") && priya.signals[0]!.text === "need a dentist near Baner, any recommendation?" && priya.signals[0]!.at === "2026-10-14T10:00:00.000Z", JSON.stringify(priya?.signals));
  check("emoji, “nice post” and “follow back” are engagement, never a need", others.length === 3 && others.every((member) => member.signals.length === 1 && member.signals[0]!.kind === "engagement"), others.map((member) => `${member.name}: ${member.signals.map((signal) => `${signal.kind} “${signal.text}”`).join()}`).join("; "));
  check("Instagram-only and need tallies", Number(result.instagramOnly) === 5 && Number(result.needSignals) === 1, `${String(result.instagramOnly)} / ${String(result.needSignals)}`);
  check("every member has a match reason", members.every((member) => Boolean(member.matchReason)), members.filter((member) => !member.matchReason).map((member) => member.name).join(", "));
  check("website leads carry no signals (no evidence of need is invented)", members.filter((member) => member.sourceUrl !== POST_URL).every((member) => member.signals.length === 0));

  const unipilePaths = unipileRequests.map((request) => `${request.method} ${request.path}`).sort();
  check("Unipile was only read: profile, post, comments, with the linked account", unipileRequests.every((request) => request.method === "GET" && request.query.account_id === IG_ACCOUNT)
    && JSON.stringify(unipilePaths) === JSON.stringify([`GET /posts/${POST_PROVIDER_ID}/comments`, `GET /posts/${SHORTCODE}`, `GET /users/${GLOW_IG}`, `GET /users/${QUIET_IG}`].sort())
    && unipileRequests.find((request) => request.path.endsWith("/comments"))?.query.limit === "50", unipilePaths.join(", "));
  const skipped = (result.skipped ?? []) as { url: string; reason: string }[];
  check("a Facebook page the search returned is skipped with the reason", skipped.some((item) => item.url.includes("facebook.com/glow") && /needs a login/.test(item.reason)), JSON.stringify(skipped));
  check("A's result reads like the Maps discovery's, with the searches and their cost", ["found", "eligible", "excluded", "duplicates", "alreadyKnown", "withEmail", "withPhoneOnly", "note"].every((key) => key in result)
    && (result.searches as unknown[]).length === 3 && result.costUsd === 0.036 && Number(result.withEmail) >= 4 && Number(result.withPhoneOnly) >= 1, JSON.stringify({ costUsd: result.costUsd, withEmail: result.withEmail, withPhoneOnly: result.withPhoneOnly }));
  check("eligible + excluded = members in the audience", Number(result.eligible) + Number(result.excluded) === members.length, `${String(result.eligible)} + ${String(result.excluded)} vs ${members.length}`);

  await runInOrganization(orgs.A, async () => {
    const [event] = await db.select().from(assistantMessages).where(and(inOrg(assistantMessages), eq(assistantMessages.threadId, threadA), eq(assistantMessages.role, "event")));
    check("the finished search is announced in the chat from its result", Boolean(event?.content.startsWith("The web search for “dental clinics in Baner, Pune” finished:")) && /reachable only on Instagram/.test(event!.content), event?.content ?? "no event");
    await releaseThread(threadA);
    const status = await runTool("lead_search_status", {}, ctx(threadA));
    check("lead_search_status reports the web search", status.ok && status.data?.kind === "web_discovery" && /^Finished: \d+ found/.test(status.display ?? ""), status.display ?? status.summary);
  });

  // ------------------------------------------------------------ B: Instagram off, tenancy
  const resultB = runB.job.result as Record<string, unknown>;
  const skippedB = (resultB.skipped ?? []) as { url: string; reason: string }[];
  check("Instagram off: the Instagram URLs the search returned are skipped with the reason", skippedB.filter((item) => /instagram\.com/.test(item.url) && /^Instagram (profile|post) not read: Instagram is off for this organization/.test(item.reason)).length === 2 && /Instagram pages were not read/.test(String(resultB.note)), JSON.stringify({ skippedB, note: resultB.note }));
  await runInOrganization(orgs.B, async () => {
    const membersB = await db.select().from(leadAudienceMembers).where(and(inOrg(leadAudienceMembers), eq(leadAudienceMembers.audienceId, orchidB.audienceId)));
    const lotusB = membersB.find((member) => member.facts.website === site("lotus"));
    const [personB] = lotusB?.personId ? await db.select().from(people).where(and(inOrg(people), eq(people.id, lotusB.personId))) : [];
    check("B finds the same business on its own: its own person, not A's", lotusB?.status === "eligible" && personB?.email === `hello@${host("lotus")}` && personB.id !== lotus?.personId && Number(resultB.alreadyKnown) === 0, JSON.stringify({ status: lotusB?.status, person: personB?.id }));
    const audiences = await listAudiences(50);
    check("B's audience list does not include A's", !audiences.some((audience) => audience.id === audienceA) && audiences.some((audience) => audience.id === orchidB.audienceId));
    check("B cannot open A's audience", (await summarizeAudience(audienceA)) === null);
    const visible = await db.select({ id: leadAudienceMembers.id }).from(leadAudienceMembers).where(and(inOrg(leadAudienceMembers), eq(leadAudienceMembers.audienceId, audienceA)));
    check("B sees none of A's audience members", visible.length === 0, `${visible.length}`);
    const thread = await createThread(null);
    const status = await runTool("lead_search_status", { jobId: jobA }, ctx(thread.id));
    check("B cannot read A's search", !status.ok && status.summary === "No lead search found.", status.summary);
    const describe = await runTool("describe_audience", { audienceId: audienceA }, ctx(thread.id));
    check("describe_audience of A's list from B: no such list", !describe.ok, describe.summary);
    const peopleB = await db.select({ n: sql<number>`count(*)::int` }).from(people).where(and(inOrg(people), inArray(people.id, personRows.map((person) => person.id))));
    check("B counts none of A's people", Number(peopleB[0]?.n ?? 0) === 0);
  });
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  if (createdProviders.length) await db.delete(gridProviders).where(inArray(gridProviders.id, createdProviders));
  server.stop(true);
}

console.log(`\n${failures ? `${failures} check(s) FAILED` : "All web discovery checks passed"}. Fixture pages read: ${new Set(pageRequests).size}; AI calls: ${aiCalls.length}; Unipile calls: ${unipileRequests.length}.`);
process.exit(failures ? 1 : 0);

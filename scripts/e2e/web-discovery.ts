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
 *   servers, "lotus" has MX records, "glow" only an address record,
 *   anything else is unknown.
 *
 *   bun run --conditions=react-server scripts/e2e/web-discovery.ts
 *
 * It creates its own organizations ("Web discovery check A/B/C/D …") and AI,
 * Unipile, Instagram, mailbox and WhatsApp rows for them (credentials
 * encrypted like any integration), and removes the AI and Unipile rows, the
 * mailbox, and the placeholder jobs used for the limits at the end, so
 * nothing points at the stand-ins. Refuses a non-local DATABASE_URL.
 *
 * Beyond A's full run (websites, a directory, a redirected directory with
 * helplines and the owner's own listing, Instagram), it checks the bounds
 * per organization (D): an interrupted paid search is never bought again,
 * switching the feature off stops a run before its next search, and the
 * open, daily and AI/ML research limits refuse a new search with a reason.
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
const TAVILY = "https://tavily-web-check.invalid";
const TAVILY_KEY = `tvly-check-${tag}`;
const tavilyCalls: { path: string; auth: string | null; body: Record<string, unknown> }[] = [];
const IG_ACCOUNT = `ig-acc-${tag}`;
const SHORTCODE = `Cw${tag}Post`;
const POST_PROVIDER_ID = `3170_${tag}`;
const igProfile = (username: string) => `https://www.instagram.com/${username}/`;
const GLOW_IG = `glow.dental_${tag}`;
const QUIET_IG = `quiet.studio_${tag}`;
const POST_URL = `https://www.instagram.com/p/${SHORTCODE}/`;
const DIRECTORY = `${site("pune-guide")}top-10-dentists-in-pune/`;
/** A directory URL the search returns that redirects to the page actually read. */
const REDIRECTING_DIRECTORY = `${site("city-mag")}best-10-dentists/`;
const REDIRECTED_DIRECTORY = `${site("city-mag")}list-of-dentists-2026/`;
const OWNER_IG = `owner_${tag}`;
const OWNER_IG_OLD = `owner2_${tag}`;
const OWNER_SITE = `https://www.${host("owner")}/`;
const OWNER_MAILBOX = `ravi@ownermail-${tag}.in`;
const OWNER_WHATSAPP = "+912025556666";

// ------------------------------------------------------------ fixture websites (Bun.serve)
const PAGES: Record<string, { status: number; html: string; location?: string }> = {
  [site("lotus")]: { status: 200, html: `<html><head><title>Home | Lotus Dental Care</title></head><body><h1>Lotus Dental Care</h1><a href="/contact">Contact us</a><a href="https://www.linkedin.com/company/lotus-dental-${tag}">LinkedIn</a></body></html>` },
  [`${site("lotus")}contact`]: { status: 200, html: `<p>Appointments: <a href="mailto:hello@${host("lotus")}">hello@${host("lotus")}</a></p><a href="tel:020 2553 1234">020 2553 1234</a>` },
  [site("smile")]: { status: 200, html: `<h1>Smile Care</h1><p>Write to HELLO@${host("smile")} for appointments.</p>` },
  [site("bright")]: { status: 200, html: `<h1>Bright Dental</h1><a href="tel:+912025550003">Call us</a>` },
  // Sentences that look like hidden addresses are not decoded into any.
  [site("pearl")]: { status: 200, html: `<h1>Pearl Dental</h1><p>Visit us in Aundh. We love smiles. Join our team (at) Pune. Com… Visit us (at) Mumbai. In 2024 we moved.</p>` },
  [site("nomail")]: { status: 200, html: `<h1>No Mail Dental</h1><a href="mailto:info@${host("nomail")}">Email</a>` },
  [site("broken")]: { status: 503, html: "unavailable" },
  [site("orchid")]: { status: 200, html: `<h1>Orchid Dental Studio</h1><a href="/about-us">About</a>` },
  [`${site("orchid")}about-us`]: { status: 200, html: `<p>Reach us: care@${host("orchid")}</p><p>Owner: dr.mehta [at] orchid-${tag} [dot] in</p><a href="https://www.linkedin.com/company/orchid-${tag}">LinkedIn</a>` },
  [site("sunrise")]: { status: 200, html: `<h1>Sunrise Dental</h1><a href="mailto:hello@${host("sunrise")}">Email</a>` },
  [REDIRECTING_DIRECTORY]: { status: 301, html: "", location: "/list-of-dentists-2026/" },
  [REDIRECTED_DIRECTORY]: {
    status: 200,
    html: `<html><head><title>Best dentists in Pune 2026</title></head><body>
      <header><a href="tel:+912040000000">City Mag helpline</a></header>
      <ol>
        <li><a href="${site("sunrise")}">Sunrise Dental</a> — <a href="tel:+912025557777">020 2555 7777</a> · book via <a href="tel:+912040001111">our desk</a></li>
        <li>Moon Dental — <a href="tel:+912025557778">020 2555 7778</a> · book via <a href="tel:+912040001111">our desk</a></li>
        <li>Star Dental — <a href="mailto:hi@star-${tag}.in">hi@star-${tag}.in</a> · book via <a href="tel:+912040001111">our desk</a></li>
        <li>Your clinic — <a href="mailto:frontdesk@${host("owner")}">frontdesk@${host("owner")}</a> · <a href="tel:${OWNER_WHATSAPP}">020 2555 6666</a> · <a href="mailto:${OWNER_MAILBOX}">${OWNER_MAILBOX}</a></li>
      </ol>
      <footer>Toll free <a href="tel:1800-123-4567">1800 123 4567</a> · <a href="mailto:care@citymag-help.in">care@citymag-help.in</a></footer></body></html>`,
  },
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
  // F: what a business's own website shows (websiteProfile.ts), read from the pages the contact reader fetches.
  [site("aurora")]: {
    status: 200,
    html: `<html><head><title>Aurora Dental | Baner</title><meta name="description" content="Aurora Dental is a family dental clinic in Baner, Pune.">
      <script src="https://embed.tawk.to/aurora/default"></script></head><body>
      <nav><a href="/">Home</a><a href="/blog">Blog</a><a href="/team">Our team</a><a href="/careers">Careers</a><a href="/contact">Contact</a></nav>
      <a href="https://calendly.com/aurora-${tag}/checkup">Book an appointment</a> <a href="https://wa.me/919822044044">WhatsApp us</a>
      <footer><a href="mailto:hello@${host("aurora")}">hello@${host("aurora")}</a></footer></body></html>`,
  },
  [`${site("aurora")}contact`]: { status: 200, html: `<form action="/send"><input type="email" name="email"><textarea name="message"></textarea></form><p>We are seeking a vendor for after-hours call answering.</p><a href="tel:+912025559999">020 2555 9999</a>` },
  [`${site("aurora")}team`]: {
    status: 200,
    html: `<h2>Our Team</h2>
      <div class="card"><h3>Dr. Nisha Rao</h3><p>Founder</p><a href="mailto:nisha@${host("aurora")}">nisha@${host("aurora")}</a> <a href="https://www.linkedin.com/in/nisha-rao-${tag}/">LinkedIn</a></div>
      <div class="card"><h3>Kunal Shah</h3><p>Practice Manager</p><a href="mailto:info@${host("aurora")}">info@${host("aurora")}</a></div>`,
  },
  [`${site("aurora")}careers`]: { status: 200, html: `<h1>Careers</h1><p>We're hiring!</p><ul><li>Front Desk Receptionist (full time)</li><li>Dental Hygienist</li></ul>` },
  [`${site("aurora")}blog`]: { status: 200, html: `<p>Not read: the blog is not one of the pages a website check reads.</p>` },
  [site("maple")]: { status: 200, html: `<h1>Maple Smiles</h1><div><h3>Dr. Leela Iyer</h3><p>Owner</p><a href="mailto:leela@${host("maple")}">Write to Dr. Iyer</a></div>` },
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
    return new Response(page?.html ?? "not found", { status: page?.status ?? 404, headers: { "content-type": "text/html; charset=utf-8", ...(page?.location ? { location: page.location } : {}) } });
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
        citation(igProfile(OWNER_IG), "Owner Clinic • Instagram"),
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
      choices: [{ message: { role: "assistant", content: `The best list is ${site("invented-clinic")}directory`, annotations: [
        citation(DIRECTORY, "Top 10 dentists in Pune", "Our pick of the best dental clinics in Pune."),
        citation(REDIRECTING_DIRECTORY, "Best dentists in Pune", "City Mag's list."),
      ] } }],
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
        // The owner's own accounts (the connected one, and an older one): never leads.
        comment("c7", "Thanks for visiting!", "Owner Clinic", OWNER_IG, "2026-10-14T11:05:00.000Z"),
        comment("c8", "Come see us too", "Owner Clinic (old)", OWNER_IG_OLD, "2026-10-14T11:06:00.000Z"),
      ],
      cursor: null,
      total_items: 8,
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
  if (url.origin === TAVILY) {
    const auth = new Headers(init?.headers).get("authorization");
    const body = method === "POST" ? JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> : {};
    tavilyCalls.push({ path: url.pathname, auth, body });
    if (auth !== `Bearer ${TAVILY_KEY}`) return new Response(JSON.stringify({ detail: { error: "Unauthorized: missing or invalid API key." } }), { status: 401 });
    if (method === "GET" && url.pathname === "/usage") return new Response(JSON.stringify({ key: { usage: 3 }, account: { current_plan: "Researcher", plan_usage: 3, plan_limit: 1000 } }), { status: 200 });
    if (method === "POST" && url.pathname === "/search") {
      return new Response(JSON.stringify({
        query: body.query,
        results: [
          { title: "Lotus Dental Care", url: site("lotus"), content: "Dentist in Baner, Pune" },
          { title: "Top 10 dentists in Pune", url: DIRECTORY, content: "A list of dentists" },
          { title: "Lotus Dental Care", url: site("lotus"), content: "the same page again" },
        ],
        usage: { credits: 1 },
      }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }
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
const { getByokSettings, saveByokSettings } = await import("@/lib/ai/byok");
const { saveChannelRules } = await import("@/lib/channels/rules.server");
const { setFeature } = await import("@/lib/features/flags.server");
const { instagramAccounts } = await import("@/lib/instagram/schema");
const { runInOrganization, currentOrganizationId, inOrg } = await import("@/lib/tenancy/scope");
const { assistantJobs, assistantMessages, assistantProfiles, leadAudienceMembers, leadAudiences } = await import("@/lib/assistant/schema");
const { mailboxes } = await import("@/lib/outreach/schema");
const { whatsappAccounts } = await import("@/lib/whatsapp/schema");
const { memberInsights } = await import("@/lib/assistant/audiences.server");
const { runTool } = await import("@/lib/assistant/tools.server");
const { runOneAssistantStep } = await import("@/lib/assistant/worker");
const { registerAssistantJobs } = await import("@/lib/assistant/register.server");
const { createThread, claimThread, releaseThread } = await import("@/lib/assistant/threads.server");
const { listAudiences, summarizeAudience } = await import("@/lib/assistant/audiences.server");
const { setDiscoveryPageOptions } = await import("@/lib/discovery/discovery.server");
const { setTavilyApiBase } = await import("@/services/tavily");
const { saveTavilySettings, tavilySettingsView, TavilySettingsError } = await import("@/lib/tavily/tavily.server");
const { webSearchAvailability } = await import("@/lib/discovery/webSearch.server");
const { setWebDiscoveryMailCheck, startWebDiscovery, normalizeWebCriteria, WebDiscoveryUnavailableError, INSTAGRAM_PROFILE_ONLY_REASON, MAX_OPEN_WEB_DISCOVERIES, MAX_WEB_DISCOVERIES_PER_DAY } = await import("@/lib/discovery/webDiscovery.server");
const { instagramCommenterHold } = await import("@/lib/discovery/instagramEligibility");
const { audienceProspects } = await import("@/lib/assistant/qualification.server");

setDiscoveryPageOptions({ allowPrivate: true });
setTavilyApiBase(TAVILY);
setWebDiscoveryMailCheck(async (domain) => (domain.includes("nomail") ? "rejects" : domain.includes("lotus") ? "mx" : domain.includes("glow") ? "address" : "unknown"));
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
async function runJob(jobId: string, stopAtStage?: string): Promise<{ job: typeof assistantJobs.$inferSelect; stages: string[] }> {
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
      if (job.status === "succeeded" || job.status === "failed" || (stopAtStage && job.stage === stopAtStage)) break;
      if (job.runAfter.getTime() > Date.now()) await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, job!.runAfter.getTime() - Date.now())));
      await fence();
      await runOneAssistantStep();
    }
  });
  return { job: job!, stages };
}

const orgs: Record<"A" | "B" | "C" | "D", string> = { A: "", B: "", C: "", D: "" };
for (const name of ["A", "B", "C", "D"] as const) {
  const [org] = await db.insert(organizations).values({ name: `Web discovery check ${name} ${stamp}`, slug: `web-discovery-${name.toLowerCase()}-${stamp}` }).returning();
  orgs[name] = org!.id;
  checkOrganizations.push(org!.id);
}
console.log(`Organizations A ${orgs.A}, B ${orgs.B}, C ${orgs.C}, D ${orgs.D}`);
const createdMailboxes: string[] = [];
const placeholderJobs: string[] = [];
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
    check("no AI provider: the tool says web search is unavailable and why", !noProvider.ok && /needs a web search: save a TinyFish key .* a Tavily key .* or connect an AI provider that searches the web/.test(noProvider.summary), noProvider.summary);
    const setup = await runTool("check_setup", {}, ctx(thread.id));
    check("check_setup reports website and directory search as not ready", /Website and directory search: not ready — .*needs a web search/.test(setup.summary), setup.summary);
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
    await db.insert(instagramAccounts).values({ organizationId: currentOrganizationId(), unipileAccountId: IG_ACCOUNT, username: OWNER_IG, name: "Owner", status: "connected" });
    // The owner's own business: an older Instagram account, a mailbox, a WhatsApp number, the website in the business profile.
    await db.insert(instagramAccounts).values({ organizationId: currentOrganizationId(), unipileAccountId: `${IG_ACCOUNT}-old`, username: OWNER_IG_OLD, name: "Owner (old)", status: "disconnected" });
    const [mailbox] = await db.insert(mailboxes).values({ organizationId: currentOrganizationId(), emailAddress: OWNER_MAILBOX, status: "connecting" }).returning({ id: mailboxes.id });
    createdMailboxes.push(mailbox!.id);
    await db.insert(whatsappAccounts).values({ organizationId: currentOrganizationId(), unipileAccountId: `wa-acc-${tag}`, phone: OWNER_WHATSAPP, status: "disconnected" });
    await db.insert(assistantProfiles).values({ organizationId: currentOrganizationId(), profile: { website: OWNER_SITE } });

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
  const orchidHidden = orchid?.evidence.find((item) => item.kind === "email" && item.value === `dr.mehta@orchid-${tag}.in`);
  check("an address written as “name [at] domain [dot] in” is decoded, with the page it was on", orchidHidden?.sourceUrl === `${site("orchid")}about-us`, JSON.stringify(orchid?.evidence));
  const orchidLinkedin = orchid?.evidence.find((item) => item.kind === "linkedin");
  check("a LinkedIn link keeps the page it was on (the about page), not just the website", orchidLinkedin?.value === `https://www.linkedin.com/company/orchid-${tag}` && orchidLinkedin.sourceUrl === `${site("orchid")}about-us`, JSON.stringify(orchidLinkedin));
  const everything = JSON.stringify({ members: members.map((member) => member.evidence), people: personRows.map((person) => [person.email, person.phone]) }).toLowerCase();
  check("sentences like “team (at) Pune. Com” are never decoded into addresses", !/pune\.com|mumbai\.in/.test(everything));

  const moon = members.find((member) => personOf(member.personId)?.phone === "+912025557778");
  const moonPhone = moon?.evidence.find((item) => item.kind === "phone");
  check("a redirected directory: the lead keeps the page read, with the search's own URL beside it", moon?.status === "eligible" && moon.sourceUrl === REDIRECTED_DIRECTORY && moonPhone?.sourceUrl === REDIRECTED_DIRECTORY && moon.facts.directoryPage === REDIRECTED_DIRECTORY && moon.facts.searchResult === REDIRECTING_DIRECTORY, JSON.stringify({ sourceUrl: moon?.sourceUrl, facts: moon?.facts }));
  check("…and its match reason names the URL the search returned, and the redirect apart", Boolean(moon?.matchReason?.startsWith(`Listed on “Best dentists in Pune” (${REDIRECTING_DIRECTORY}), a page the web search for`) && moon.matchReason.endsWith(`which redirected to ${REDIRECTED_DIRECTORY}, where it was read.`)), moon?.matchReason ?? "missing");
  const sunrise = byEmail(`hello@${host("sunrise")}`);
  check("a business linked from a redirected directory: found on the page read, the search's URL kept", sunrise?.status === "eligible" && sunrise.sourceUrl === REDIRECTED_DIRECTORY && sunrise.facts.searchResult === REDIRECTING_DIRECTORY && Boolean(sunrise.matchReason?.includes(`(${REDIRECTING_DIRECTORY}), a page the web search for`)), JSON.stringify({ sourceUrl: sunrise?.sourceUrl, reason: sunrise?.matchReason }));
  check("a listing's own email on a directory page is a lead", byEmail(`hi@star-${tag}.in`)?.status === "eligible");
  const phones = personRows.map((person) => person.phone ?? "");
  const emails = personRows.map((person) => (person.email ?? "").toLowerCase());
  check("the directory's header, footer and a helpline beside every listing are not leads", !phones.some((phone) => ["+912040000000", "+912040001111"].includes(phone) || phone.endsWith("1234567")) && !emails.includes("care@citymag-help.in"), phones.join(", "));
  check("the owner's own email (website domain, mailbox) and WhatsApp number listed on a directory are not leads", !emails.includes(`frontdesk@${host("owner")}`) && !emails.includes(OWNER_MAILBOX) && !phones.includes(OWNER_WHATSAPP));
  check("the directory's phone for Lotus is a duplicate within the run, not a second person", personRows.filter((person) => person.phone === "+912025531234").length === 1 && Number(result.duplicates) >= 1, `duplicates ${String(result.duplicates)}`);

  const glow = byEmail(`hello@${host("glow")}`);
  check("an Instagram profile's listed website is read; the lead keeps the profile as evidence", glow?.status === "eligible" && glow.evidence.some((item) => item.kind === "instagram" && item.value === igProfile(GLOW_IG)) && glow.sourceUrl === igProfile(GLOW_IG), JSON.stringify(glow?.evidence));
  const glowEmail = glow?.evidence.find((item) => item.kind === "email");
  check("a domain that passed only by its address record: “can receive mail”, never “MX”", glowEmail?.source === "the business's website · domain can receive mail; mailbox not verified", glowEmail?.source ?? "");
  const quiet = named("Quiet Studio");
  check("an Instagram-only profile that does not name Pune is kept for research, never called uncontactable (decision 16: a verified one would be a lead)", quiet?.status === "excluded" && /location is not verified/.test(quiet.reason ?? "") && /kept for research/.test(quiet.reason ?? "") && quiet.reason !== INSTAGRAM_PROFILE_ONLY_REASON && quiet.evidence.some((item) => item.kind === "instagram"), quiet?.reason ?? "missing");

  const commenters = members.filter((member) => member.sourceUrl === POST_URL);
  const priya = commenters.find((member) => member.name === "Priya K");
  const others = commenters.filter((member) => member.name !== "Priya K");
  check("each commenter is a candidate (the post author's own reply is not)", commenters.length === 4 && !commenters.some((member) => member.name === "Glow Dental"), commenters.map((member) => member.name).join(", "));
  check("every Instagram-only commenter is kept for research (its profile and place unchecked) with the reason and Instagram evidence", commenters.every((member) => member.status === "excluded" && member.personId === null && member.reason === instagramCommenterHold(POST_URL) && member.evidence.some((item) => item.kind === "instagram" && item.sourceUrl === POST_URL)), commenters.map((member) => member.reason).join(" | "));
  check("the explicit ask is a need, quoted, with the post and the comment's date", priya?.signals.length === 2 && priya.signals.every((signal) => signal.kind === "need" && signal.sourceUrl === POST_URL && signal.source === "Instagram comment") && priya.signals[0]!.text === "need a dentist near Baner, any recommendation?" && priya.signals[0]!.at === "2026-10-14T10:00:00.000Z", JSON.stringify(priya?.signals));
  check("emoji, “nice post” and “follow back” are engagement, never a need", others.length === 3 && others.every((member) => member.signals.length === 1 && member.signals[0]!.kind === "engagement"), others.map((member) => `${member.name}: ${member.signals.map((signal) => `${signal.kind} “${signal.text}”`).join()}`).join("; "));
  check("the owner's own Instagram accounts are not commenters to find", !members.some((member) => /Owner Clinic/.test(member.name) || [OWNER_IG, OWNER_IG_OLD].includes(member.facts.instagramUsername ?? "")));
  check("the owner's own Instagram profile the search returned is skipped, not read", ((result.skipped ?? []) as { url: string; reason: string }[]).some((item) => item.url === igProfile(OWNER_IG) && item.reason === "the owner's own Instagram profile") && !unipileRequests.some((request) => request.path.includes(OWNER_IG)), JSON.stringify(result.skipped));
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

  // ------------------------------------------------------------ D: bounds per organization
  const criteriaD = normalizeWebCriteria({ customers: "dental clinics", where: "Baner, Pune", maxResults: 5 });
  if ("error" in criteriaD) throw new Error(criteriaD.error);
  const jobsD = { interrupted: "", switchedOff: "" };
  await runInOrganization(orgs.D, async () => {
    await setFeature("web_discovery", true, null);
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
    jobsD.interrupted = (await startWebDiscovery(criteriaD, { threadId: null, userId: null })).jobId;
  });
  // A paid search a step started but never saved (the process died after the provider answered): never bought again.
  await runJob(jobsD.interrupted, "searching");
  await db.update(assistantJobs).set({ payload: sql`${assistantJobs.payload} || '{"searchStarted":0}'::jsonb` }).where(eq(assistantJobs.id, jobsD.interrupted));
  const callsBeforeD = aiCalls.length;
  const runD = await runJob(jobsD.interrupted);
  const searchesD = ((runD.job.result ?? {}) as { searches?: { error: string | null; provider: string | null }[] }).searches ?? [];
  check("an interrupted paid search is recorded as such and not bought again; the next one runs", runD.job.status === "succeeded" && aiCalls.length - callsBeforeD === 1 && /never paid for twice/.test(searchesD[0]?.error ?? "") && searchesD[1]?.provider === "openrouter", JSON.stringify({ status: runD.job.status, calls: aiCalls.length - callsBeforeD, searchesD }));

  await runInOrganization(orgs.D, async () => {
    jobsD.switchedOff = (await startWebDiscovery(criteriaD, { threadId: null, userId: null })).jobId;
  });
  await runJob(jobsD.switchedOff, "searching");
  await runInOrganization(orgs.D, () => setFeature("web_discovery", false, null));
  const callsBeforeOff = aiCalls.length;
  const runOff = await runJob(jobsD.switchedOff);
  check("switching the feature off stops a run before its next paid search", runOff.job.status === "failed" && /is off for this organization.*stopped before its remaining paid searches/.test(runOff.job.error ?? "") && aiCalls.length === callsBeforeOff, `${runOff.job.status}: ${runOff.job.error ?? ""}; ${aiCalls.length - callsBeforeOff} calls`);

  await runInOrganization(orgs.D, async () => {
    await setFeature("web_discovery", true, null);
    const thread = await createThread(null);
    const counts = async () => ({
      jobs: (await db.select({ id: assistantJobs.id }).from(assistantJobs).where(inOrg(assistantJobs))).length,
      audiences: (await db.select({ id: leadAudiences.id }).from(leadAudiences).where(inOrg(leadAudiences))).length,
    });
    // Placeholders, never due, so the worker leaves them alone; removed at the end.
    const placeholder = (status: "queued" | "succeeded") => ({ organizationId: currentOrganizationId(), kind: "web_discovery" as const, status, runAfter: new Date(Date.now() + 7 * 86_400_000), payload: {}, progress: {} });
    const open = await db.insert(assistantJobs).values(Array.from({ length: MAX_OPEN_WEB_DISCOVERIES }, () => placeholder("queued"))).returning({ id: assistantJobs.id });
    placeholderJobs.push(...open.map((row) => row.id));
    const before = await counts();
    const refusedOpen = await runTool("find_customers_on_web", { customers: "dental clinics", where: "Baner, Pune" }, ctx(thread.id));
    check(`open limit: with ${MAX_OPEN_WEB_DISCOVERIES} searches running a new one is refused, with the reason`, !refusedOpen.ok && new RegExp(`already running for this organization \\(at most ${MAX_OPEN_WEB_DISCOVERIES} at a time\\)`).test(refusedOpen.summary), refusedOpen.summary);
    await db.update(assistantJobs).set({ status: "succeeded" }).where(inArray(assistantJobs.id, placeholderJobs));
    const started = before.jobs;
    if (started < MAX_WEB_DISCOVERIES_PER_DAY) {
      const more = await db.insert(assistantJobs).values(Array.from({ length: MAX_WEB_DISCOVERIES_PER_DAY - started }, () => placeholder("succeeded"))).returning({ id: assistantJobs.id });
      placeholderJobs.push(...more.map((row) => row.id));
    }
    const refusedDaily = await runTool("find_customers_on_web", { customers: "dental clinics", where: "Baner, Pune" }, ctx(thread.id));
    check(`daily limit: after ${MAX_WEB_DISCOVERIES_PER_DAY} searches in 24 hours a new one is refused, with the reason`, !refusedDaily.ok && new RegExp(`started ${MAX_WEB_DISCOVERIES_PER_DAY} website searches in the last 24 hours`).test(refusedDaily.summary), refusedDaily.summary);
    const after = await counts();
    check("a refused start creates no job and no audience", after.jobs === before.jobs + Math.max(0, MAX_WEB_DISCOVERIES_PER_DAY - started) && after.audiences === before.audiences, JSON.stringify({ before, after }));
  });

  await runInOrganization(orgs.B, async () => {
    // B's finished search planned 2 AI/ML API searches today; with a limit of 3, another 2 do not fit.
    await saveByokSettings({ ...(await getByokSettings()), researchDailyLimit: 3 });
    const thread = await createThread(null);
    const refused = await runTool("find_customers_on_web", { customers: "dental clinics", where: "Baner, Pune" }, ctx(thread.id));
    check("AI/ML API: website searches count toward the daily research limit", !refused.ok && /web research limit on AI\/ML API \(3, Settings → AI provider\) leaves 1 search; this request needs 2/.test(refused.summary), refused.summary);
  });

  // ------------------------------------------------------------ E: Tavily as the web search
  const [orgE] = await db.insert(organizations).values({ name: `Web discovery check E ${stamp}`, slug: `web-discovery-e-${stamp}` }).returning();
  checkOrganizations.push(orgE!.id);
  let tavilyJob = "";
  await runInOrganization(orgE!.id, async () => {
    await setFeature("web_discovery", true, null);
    check("Tavily: without a key or an AI provider, website search says what it needs", !(await webSearchAvailability()).available && /Tavily key/.test((await webSearchAvailability()).reason ?? ""));
    let refusedKey = "";
    try {
      await saveTavilySettings({ key: "tvly-wrong" }, null);
    } catch (error) {
      refusedKey = error instanceof TavilySettingsError ? error.message : String(error);
    }
    check("Tavily: a key Tavily rejects is not saved", refusedKey === "Tavily rejected this key." && !(await tavilySettingsView()).connected, refusedKey);
    const view = await saveTavilySettings({ key: TAVILY_KEY, dailySearches: 3 }, null);
    check("Tavily: a good key is saved (hint only) with the plan's credits read from Tavily", view.connected && view.keyHint === `…${TAVILY_KEY.slice(-4)}` && view.plan?.used === 3 && view.plan.limit === 1000 && !JSON.stringify(view).includes(TAVILY_KEY), JSON.stringify(view));
    const availability = await webSearchAvailability();
    check("Tavily: with a key saved, website searches use Tavily", availability.available && availability.provider === "tavily", JSON.stringify(availability));
    const thread = await createThread(null);
    const started = await runTool("find_customers_on_web", { customers: "dental clinics", where: "Baner, Pune" }, ctx(thread.id));
    tavilyJob = String((started.data as { jobId?: string } | undefined)?.jobId ?? "");
    check("Tavily: the assistant's website search starts on Tavily", started.ok && Boolean(tavilyJob), started.summary);
  });
  const searchCallsBefore = tavilyCalls.filter((call) => call.path === "/search").length;
  const aiBefore = aiCalls.length;
  const runE = await runJob(tavilyJob);
  const searchesE = ((runE.job.result ?? {}) as { searches?: { provider: string | null; sources: number }[] }).searches ?? [];
  const sent = tavilyCalls.filter((call) => call.path === "/search").slice(searchCallsBefore);
  check("Tavily: each planned search is one basic Tavily search of 20 results with the key as a Bearer header, and no AI search", runE.job.status === "succeeded" && sent.length === searchesE.length && sent.length >= 2 && sent.every((call) => call.auth === `Bearer ${TAVILY_KEY}` && call.body.search_depth === "basic" && call.body.max_results === 20) && aiCalls.length === aiBefore, JSON.stringify({ status: runE.job.status, error: runE.job.error, sent: sent.length, searchesE }));
  check("Tavily: the searches are recorded as Tavily's, with the pages it returned (each page once)", searchesE.every((search) => search.provider === "tavily" && search.sources === 2), JSON.stringify(searchesE));
  await runInOrganization(orgE!.id, async () => {
    const saved = await db.select({ email: people.email }).from(people).where(inOrg(people));
    const emails = saved.map((person) => person.email);
    check("Tavily: businesses from Tavily's pages are read and saved with the contacts their own websites publish", emails.includes(`hello@${host("lotus")}`) && emails.includes(`care@${host("orchid")}`), JSON.stringify(emails));
    const thread = await createThread(null);
    const refused = await runTool("find_customers_on_web", { customers: "dental clinics", where: "Baner, Pune" }, ctx(thread.id));
    check("Tavily: past the owner's daily cap a new website search is refused with the reason", !refused.ok && /daily Tavily cap \(3 searches/.test(refused.summary), refused.summary);
    check("Tavily: the settings count the day's searches", (await tavilySettingsView()).searchesToday === sent.length);
  });
  await runInOrganization(orgs.A, async () => {
    check("Tavily: another organization's key is never used (A keeps its own AI search)", (await webSearchAvailability()).provider === "openrouter");
  });

  // ------------------------------------------------------------ F: what a business's own website shows, saved and retried
  const [orgF] = await db.insert(organizations).values({ name: `Web discovery check F ${stamp}`, slug: `web-discovery-f-${stamp}` }).returning();
  checkOrganizations.push(orgF!.id);
  let jobF = "";
  let audienceF = "";
  await runInOrganization(orgF!.id, async () => {
    await setFeature("web_discovery", true, null);
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
    // F's own saved business information: what the website findings are matched against.
    await db.insert(assistantProfiles).values({ organizationId: currentOrganizationId(), profile: { businessName: "Front Desk AI", offer: "An AI receptionist that answers every call and books appointments", problemsSolved: "Missed calls after hours", targetCustomers: "Dental clinics in Pune" } });
    const criteria = normalizeWebCriteria({ customers: "dental clinics", where: "Baner, Pune", maxResults: 5 });
    if ("error" in criteria) throw new Error(criteria.error);
    ({ jobId: jobF, audienceId: audienceF } = await startWebDiscovery(criteria, { threadId: null, userId: null }));
  });
  // The search is the fixtures' own; before reading, its candidates become two websites to profile.
  await runJob(jobF, "reading");
  const origin = (slug: string, title: string) => ({ query: "dental clinics in Baner, Pune", url: site(slug), title, snippet: "Family dental clinic in Baner" });
  const candidatesF = [
    { kind: "own_site", url: site("aurora"), origin: origin("aurora", "Aurora Dental | Baner") },
    { kind: "own_site", url: site("maple"), origin: origin("maple", "Maple Smiles") },
  ];
  await db.update(assistantJobs).set({ payload: sql`${assistantJobs.payload} || ${JSON.stringify({ candidates: candidatesF, readIndex: 0, leads: [], skipped: [], skippedCount: 0 })}::jsonb` }).where(eq(assistantJobs.id, jobF));
  const requestsBeforeF = pageRequests.length;
  await runJob(jobF, "saving");
  const readF = pageRequests.slice(requestsBeforeF);
  const auroraPages = [site("aurora"), `${site("aurora")}contact`, `${site("aurora")}team`, `${site("aurora")}careers`];
  check("F: each page of a website is fetched once, and its observations come from those same responses", JSON.stringify([...readF].sort()) === JSON.stringify([...auroraPages, site("maple")].sort()), readF.join(", "));
  check("F: within the same budget (home + 3 pages); a blog page and outside links (booking, WhatsApp, LinkedIn) are never fetched", !readF.includes(`${site("aurora")}blog`) && !blocked.some((request) => /calendly|wa\.me|linkedin|tawk/.test(request)), blocked.join(", "));
  const [readJob] = await db.select().from(assistantJobs).where(eq(assistantJobs.id, jobF));
  const payloadLeads = ((readJob!.payload as { leads?: { website: string | null; profile?: { checkedAt: string; observations: unknown[] } | null }[] }).leads ?? []);
  const readAt = payloadLeads.find((lead) => lead.website === site("aurora"))?.profile?.checkedAt ?? "";
  check("F: what the website showed is kept in the job's payload with the time it was read", Boolean(readAt) && (payloadLeads.find((lead) => lead.website === site("aurora"))?.profile?.observations.length ?? 0) > 0, JSON.stringify(payloadLeads.map((lead) => lead.profile?.checkedAt)));
  // The worker that read the websites dies before saving; another takes its stale claim over.
  await db.update(assistantJobs).set({ status: "running", lockedBy: "worker-that-died", heartbeatAt: new Date(Date.now() - 10 * 60_000), runAfter: new Date() }).where(eq(assistantJobs.id, jobF));
  const requestsBeforeSave = pageRequests.length;
  const runF = await runJob(jobF);
  check("F: the stale claim is taken over; saving reads no page again", runF.job.status === "succeeded" && pageRequests.length === requestsBeforeSave, `${runF.job.status} ${runF.job.error ?? ""}; ${pageRequests.length - requestsBeforeSave} page reads`);

  const loadF = () => runInOrganization(orgF!.id, async () => {
    const rows = await db.select().from(leadAudienceMembers).where(and(inOrg(leadAudienceMembers), eq(leadAudienceMembers.audienceId, audienceF)));
    const insights = await memberInsights(rows.map((row) => row.id));
    const persons = await db.select().from(people).where(inOrg(people));
    return { rows: rows.map((row) => ({ ...row, signals: insights.get(row.id)?.signals ?? [] })), persons };
  });
  const savedF = await loadF();
  const personF = (email: string) => savedF.persons.find((person) => person.email === email);
  const aurora = savedF.rows.find((row) => row.personId === personF(`hello@${host("aurora")}`)?.id);
  const auroraPerson = personF(`hello@${host("aurora")}`);
  const topics = (topic: string) => aurora?.signals.filter((signal) => signal.topic === topic) ?? [];
  check("F: a general address leaves the lead the business: no person's name or title on it", aurora?.status === "eligible" && auroraPerson?.fullName === null && auroraPerson.title === null, JSON.stringify({ name: auroraPerson?.fullName, title: auroraPerson?.title }));
  const nisha = topics("person").find((signal) => signal.person?.name === "Dr. Nisha Rao");
  const kunal = topics("person").find((signal) => signal.person?.name === "Kunal Shah");
  check("F: named people keep only the contacts in their own card; the general inbox beside a name is not theirs", nisha?.person?.role === "Founder" && nisha.person.email === `nisha@${host("aurora")}` && nisha.person.linkedin === `https://www.linkedin.com/in/nisha-rao-${tag}` && kunal?.person?.role === "Practice Manager" && kunal.person.email === null, JSON.stringify(topics("person").map((signal) => signal.person)));
  check("F: the people are facts for the writers, never the address's owner", aurora?.facts.decisionMakers === "Dr. Nisha Rao (Founder); Kunal Shah (Practice Manager)", aurora?.facts.decisionMakers ?? "missing");
  check("F: relevant hiring, booking and contact options, each with its page", topics("hiring")[0]?.text === "Front Desk Receptionist (full time)" && topics("hiring")[0]?.sourceUrl === `${site("aurora")}careers` && topics("booking")[0]?.text === "Online booking link (Calendly)"
    && ["WhatsApp chat link (+919822044044)", "Live chat on the website (tawk.to)", "Contact form"].every((text) => topics("contact").some((signal) => signal.text === text)), JSON.stringify(aurora?.signals.map((signal) => [signal.topic, signal.text])));
  check("F: an explicit request for a supplier is the only need; every other finding is an observation", topics("need").length === 1 && topics("need")[0]!.kind === "need" && (aurora?.signals ?? []).filter((signal) => signal.topic !== "need").every((signal) => signal.kind === "observation") && Number((runF.job.result as Record<string, unknown>).needSignals) === 1, JSON.stringify(aurora?.signals.map((signal) => [signal.kind, signal.topic])));
  const website = aurora?.evidence.find((item) => item.kind === "website");
  check("F: every finding keeps the read time and how sure it is; the website evidence names the pages read", Boolean(aurora?.signals.length) && aurora!.signals.every((signal) => signal.observedAt === readAt && signal.at === null && (signal.uncertainty?.length ?? 0) > 10 && signal.sourceUrl?.startsWith(site("aurora")))
    && website?.checkedAt === readAt && JSON.stringify(website.pagesRead) === JSON.stringify(auroraPages), JSON.stringify({ readAt, website }));
  check("F: the facts the writers see state what was found, never that something is missing", Object.values(aurora?.facts ?? {}).every((value) => !/\b(?:no|not found|without|lacks?|missing)\b/i.test(value)), JSON.stringify(aurora?.facts));
  const maplePerson = personF(`leela@${host("maple")}`);
  const maple = savedF.rows.find((row) => row.personId === maplePerson?.id);
  check("F: a person's own address makes the lead that person, named and titled, linked to the business", maplePerson?.fullName === "Dr. Leela Iyer" && maplePerson.title === "Owner" && Boolean(maplePerson.companyId) && maple?.status === "eligible" && maple.facts.decisionMakers === undefined, JSON.stringify({ name: maplePerson?.fullName, title: maplePerson?.title, company: maplePerson?.companyId, facts: maple?.facts }));

  // The saving step runs again (a retry after a crash past its writes): nothing is added twice and the evidence is unchanged.
  await db.update(assistantJobs).set({ status: "queued", stage: "saving", runAfter: new Date(), lockedBy: null, heartbeatAt: null, finishedAt: null, payload: sql`${assistantJobs.payload} || ${JSON.stringify({ saveIndex: 0, createdIds: [], memberIds: [] })}::jsonb` }).where(eq(assistantJobs.id, jobF));
  const rerun = await runJob(jobF);
  const againF = await loadF();
  const auroraAgain = againF.rows.find((row) => row.id === aurora?.id);
  check("F: a retried save adds no member, person or insight, and keeps the first read's evidence", rerun.job.status === "succeeded" && againF.rows.length === savedF.rows.length && againF.persons.length === savedF.persons.length
    && JSON.stringify(auroraAgain?.signals) === JSON.stringify(aurora?.signals) && JSON.stringify(auroraAgain?.evidence) === JSON.stringify(aurora?.evidence), JSON.stringify({ status: rerun.job.status, members: [savedF.rows.length, againF.rows.length], persons: [savedF.persons.length, againF.persons.length] }));

  await runInOrganization(orgF!.id, async () => {
    const view = await audienceProspects(audienceF);
    const auroraView = view?.prospects.find((prospect) => prospect.personId === auroraPerson?.id);
    const mapleView = view?.prospects.find((prospect) => prospect.personId === maplePerson?.id);
    check("F: qualification shows the findings apart from need evidence, and the lead stays a potential match", auroraView?.status === "potential_match" && auroraView.needEvidence.length === 1 && auroraView.observations.length >= 5 && auroraView.people.length === 2 && auroraView.website?.notFound.length === 0, JSON.stringify({ status: auroraView?.status, need: auroraView?.needEvidence.length, observations: auroraView?.observations.length, website: auroraView?.website }));
    check("F: what the pages read did not show is 'not found on the pages read', only for a site that was read", JSON.stringify(mapleView?.website?.notFound) === JSON.stringify(["an online booking link", "hiring that matches your offer"]) && mapleView?.website?.pages.length === 1, JSON.stringify(mapleView?.website));
  });
  await runInOrganization(orgs.A, async () => {
    check("F: another organization sees none of F's findings", (await audienceProspects(audienceF)) === null);
  });
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  if (createdProviders.length) await db.delete(gridProviders).where(inArray(gridProviders.id, createdProviders));
  if (createdMailboxes.length) await db.delete(mailboxes).where(inArray(mailboxes.id, createdMailboxes));
  if (placeholderJobs.length) await db.delete(assistantJobs).where(inArray(assistantJobs.id, placeholderJobs));
  server.stop(true);
  setTavilyApiBase(null);
}

console.log(`\n${failures ? `${failures} check(s) FAILED` : "All web discovery checks passed"}. Fixture pages read: ${new Set(pageRequests).size}; AI calls: ${aiCalls.length}; Unipile calls: ${unipileRequests.length}.`);
process.exit(failures ? 1 : 0);

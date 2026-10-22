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
 *   assistant writes the brief and searches in one step (which ends its
 *   turn), and the request becomes an objective with that target;
 * - the search qualifies its leads (a phone, a WhatsApp route) and prepares
 *   no plan by itself: the assistant decides that;
 * - short of the target, the request continues with no owner message: the
 *   assistant prepares a plan of the 6 matches (on the brief's channel,
 *   waiting for Start), then searches again; at the target the request gets
 *   one last turn, in which the assistant prepares the second search's plan,
 *   and then it stops and one final report is posted (sources, leads,
 *   routes, spend, stop reason);
 * - the owner presses Start on the first plan and approves the rest of the
 *   request: the second plan starts under that approval;
 * - a launch worker dies after it created and recorded its campaign; the
 *   launch is taken over and enrolls everyone once, in that campaign;
 * - repeating every callback and the reconciliation adds no report, plan,
 *   campaign or enrollment; nothing was sent;
 * - one clinic's own website is read once per page: what it shows (an
 *   opening that matches the offer, a named founder) reaches the plan's
 *   sample as a possible fit, never interest; the founder's own address is a
 *   contact the owner already named, who keeps that name and title; a line
 *   its facts back is kept,
 *   and a line claiming what they do not (hiring, missing online booking, a
 *   price) never reaches a plan or the texts written at Start;
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
const BRIGHTDATA = "https://brightdata.full-flow-check.test";
const BRIGHTDATA_KEY = `bd-full-flow-${stamp}`;
const REDDIT_POSTER = `clinic_owner_${stamp}`;
const REDDIT_VENDOR = `vendor_${stamp}`;
const REDDIT_POST = `https://www.reddit.com/r/Dentists/comments/ff${stamp.toString(36)}/missed_calls/`;
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
/** A line the lead's facts back (its own website's opening), and one they never back. */
const BACKED_LINE = "Saw you're hiring a front desk coordinator for appointment reminders.";
const UNBACKED_LINE = "Saw you're hiring a receptionist and your clinic has no online booking; plans start at Rs 999.";
const UNBACKED = /hiring a receptionist|no online booking|Rs 999/;
/** Each lead the writer is asked about: its index and its facts. */
function leadsAsked(prompt: string): { index: number; facts: Record<string, string> }[] {
  return [...prompt.matchAll(/^(\d+)(?: \([^)]*\))?: (\{.*\})$/gm)].map((match) => ({ index: Number(match[1]), facts: JSON.parse(match[2]!) as Record<string, string> }));
}
/** Fixed answers for the plan writer, by what each lead index and channel it is asked about. */
function writerAnswer(input: Input): string {
  switch (input.schemaName) {
    case "lead_sorting":
      return JSON.stringify({ leads: leadsAsked(input.userPrompt).map(({ index, facts }) => (facts.hiring
        ? { index, group: "Clinics hiring front desk staff", approach: "standard", reason: "May fit: its website lists a front desk opening for appointment reminders.", requestFit: "fits", noWebsiteRequired: false }
        : { index, group: "Dental clinics", approach: "standard", reason: "A dental clinic in Pune, as the owner asked.", requestFit: "fits", noWebsiteRequired: false })) });
    case "outreach_sequences": {
      // The per-lead line's merge field is named per plan; the prompt lists it.
      const key = `${input.systemPrompt ?? ""}\n${input.userPrompt}`.match(/\{\{(p_[0-9a-f]+)\}\}/)?.[1];
      return JSON.stringify({ channels: [{ channel: "whatsapp", messages: [{ subject: "", body: FIRST.replace("{{line}}", key ? `{{${key}}}` : ""), waitDays: 0 }, { subject: "", body: SECOND, waitDays: 3 }] }] });
    }
    case "first_message_review":
      return JSON.stringify({ messages: [{ channel: "whatsapp", wouldReply: 4, reasons: [] }] });
    case "opening_lines":
      return JSON.stringify({ lines: leadsAsked(input.userPrompt).map(({ index, facts }) => ({ index, line: facts.hiring ? BACKED_LINE : UNBACKED_LINE })) });
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
/**
 * One step of a turn. A step that only writes the brief and starts searches
 * ends the turn; any other step is followed by another model call, and a step
 * with no actions closes the turn.
 */
const reply = (message: string, actions: { tool: string; args: Record<string, unknown> }[] = []): Script => () =>
  JSON.stringify({ message, actions: actions.map((action) => ({ tool: action.tool, arguments: JSON.stringify(action.args) })), suggestions: [] });

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
    // The first search's first clinic has its own website.
    const website = index === 0 && !phrase.startsWith("dentists") ? SMILE_SITE : "";
    return csv(["1", `https://maps.google.com/?cid=${stamp}${index}${key.length}`, `${["Smile", "Pearl", "Bright", "Care", "Lotus", "Apex"][index]} Dental ${phrase.startsWith("dentists") ? "Studio" : "Clinic"}`, "Dental clinic", "Koregaon Park, Pune", website, phone, 20, 4.6, `pl-${stamp}-${key}`, `${stamp}${index}`, "", JSON.stringify({ city: "Pune", country: "IN" }), ""]);
  });
  return [MAPS_HEADER, ...rows].join("\n");
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ------------------------------------------------------------ one clinic's own website (read through the discovery page reader)
const SMILE_SITE = `https://smile-${stamp}.test/`;
const SITE_PAGES: Record<string, string> = {
  [SMILE_SITE]: `<html><head><meta name="description" content="Smile Dental Clinic: family dentistry in Koregaon Park, Pune."></head><body><a href="/team">Our team</a><a href="/careers">Careers</a><a href="https://calendly.com/smile-${stamp}">Book online</a></body></html>`,
  [`${SMILE_SITE}team`]: `<h2>Our Team</h2><div><h3>Dr. Kavya Joshi</h3><p>Founder</p><a href="mailto:kavya@smile-${stamp}.test">kavya@smile-${stamp}.test</a></div>`,
  [`${SMILE_SITE}careers`]: `<h1>Careers</h1><p>We're hiring</p><ul><li>Front Desk Coordinator – appointment reminders and recalls</li></ul>`,
};
const pageReads: string[] = [];

// ------------------------------------------------------------ Bright Data, stood in: Reddit posts by keyword, then a poster's profile
const brightdata = { triggers: [] as { dataset: string; discoverBy: string | null; input: Record<string, unknown>[]; auth: string | null }[] };
function brightdataAnswer(method: string, url: URL, init?: RequestInit): Response {
  const auth = new Headers(init?.headers).get("authorization");
  if (auth !== `Bearer ${BRIGHTDATA_KEY}`) return new Response("Unauthorized", { status: 401 });
  if (method === "GET" && url.pathname === "/datasets/v3/scrapers") return json(200, [{ id: "gd_lvz8ah06191smkebj4", domain: "reddit.com" }]);
  if (method === "POST" && url.pathname === "/datasets/v3/trigger") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { input: Record<string, unknown>[] };
    brightdata.triggers.push({ dataset: url.searchParams.get("dataset_id") ?? "", discoverBy: url.searchParams.get("discover_by"), input: body.input, auth });
    return json(200, { snapshot_id: `sd_ff_${brightdata.triggers.length}_${stamp}` });
  }
  const snapshot = url.pathname.match(/^\/datasets\/v3\/(progress|snapshot)\/sd_ff_(\d+)_/);
  if (snapshot) {
    const trigger = brightdata.triggers[Number(snapshot[2]) - 1]!;
    const now = new Date().toISOString();
    const records = trigger.dataset === "gd_lvz8ah06191smkebj4"
      ? [
          { post_id: "t3_ff1", url: REDDIT_POST, user_posted: REDDIT_POSTER, title: "Our front desk misses calls all day", description: "We are a dental clinic in Pune and lose bookings every week. Looking for a service that answers missed calls.", num_comments: 1, date_posted: "2026-10-12T10:30:02.133Z", community_name: "Dentists", comments: [{ comment: "We sell exactly that, DM me", url: `${REDDIT_POST}comment/c1/`, user_commenting: REDDIT_VENDOR, date_of_comment: "2026-10-13T13:19:55.908Z", replies: [] }], timestamp: now, input: { url: REDDIT_POST }, discovery_input: { keyword: String(trigger.input[0]?.keyword ?? ""), date: "Past year" } },
        ]
      : trigger.input.map((input) => String(input.url).includes(REDDIT_VENDOR)
        ? { url: String(input.url), name: REDDIT_VENDOR, social_links: [], description: "We build AI receptionists", timestamp: now, input }
        : { url: String(input.url), name: REDDIT_POSTER, social_links: [{ url: PUNE_SMILES_SITE }], description: "Owner, Pune Smiles dental clinic", timestamp: now, input });
    if (snapshot[1] === "progress") return json(200, { status: "ready", snapshot_id: `sd_ff_${snapshot[2]}_${stamp}`, dataset_id: trigger.dataset, records: records.length, errors: 0 });
    return json(200, records);
  }
  return json(405, { error: `not in the stand-in: ${method} ${url.pathname}` });
}
const PUNE_SMILES_SITE = `https://pune-smiles-${stamp}.test/`;
SITE_PAGES[PUNE_SMILES_SITE] = `<html><head><title>Pune Smiles Dental</title></head><body><h1>Pune Smiles</h1><a href="tel:+912025531234">+91 20 2553 1234</a></body></html>`;

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
  if (url.origin === BRIGHTDATA) return brightdataAnswer(method, url, init);
  if (url.hostname.endsWith(".test") || url.hostname.endsWith(".invalid")) return new Response("not found", { status: 404 });
  return realFetch(input, init);
}) as typeof fetch;

// ------------------------------------------------------------ app modules
const { db } = await import("@/lib/db");
const { people } = await import("@/lib/leads/schema");
const { organizations, users, members } = await import("@/lib/auth/schema");
const { runInOrganization } = await import("@/lib/tenancy/scope");
const schema = await import("@/lib/assistant/schema");
const { gridProviderCredentials, gridProviders } = await import("@/lib/grid/schema");
const { encryptIntegrationCredentials } = await import("@/lib/integrations/credentials");
const { whatsappAccounts, whatsappCampaignLeads, whatsappCampaigns, whatsappCampaignSends, whatsappMessages } = await import("@/lib/whatsapp/schema");
const { createWhatsappCampaign } = await import("@/lib/whatsapp/campaigns/campaigns.server");
const { setDiscoveryPageOptions } = await import("@/lib/discovery/discovery.server");
const { setBrightdataApiBase } = await import("@/services/brightdata");
const { saveBrightdataSettings } = await import("@/lib/brightdata/brightdata.server");
const { setFeature } = await import("@/lib/features/flags.server");
const { memberInsights } = await import("@/lib/assistant/audiences.server");
const { providerUsage } = await import("@/lib/quota/schema");
const { runAgentTurn } = await import("@/lib/assistant/agent.server");
const { createThread, listMessages } = await import("@/lib/assistant/threads.server");
const { runOneAssistantStep, reconcileAssistantJobReports } = await import("@/lib/assistant/worker");
const { registerAssistantJobs, reportFinishedJob } = await import("@/lib/assistant/register.server");
const { updateBusinessProfile } = await import("@/lib/assistant/profile.server");
const { startOutreachRun, getRun, runOutreachStartStep } = await import("@/lib/assistant/outreach.server");
const { recordRequestApproval } = await import("@/lib/assistant/requestApproval.server");
const objectives = await import("@/lib/assistant/objective.server");
const { listWork } = await import("@/lib/activity/activity.server");
type AssistantJob = typeof schema.assistantJobs.$inferSelect;

setBrightdataApiBase(BRIGHTDATA);
setDiscoveryPageOptions({
  allowPrivate: true,
  fetchImpl: (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    pageReads.push(url);
    const html = SITE_PAGES[url];
    return html ? new Response(html, { status: 200, headers: { "content-type": "text/html" } }) : new Response("not found", { status: 404 });
  }) as typeof fetch,
});
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
    inArray(schema.assistantJobs.kind, ["discovery", "web_discovery", "linkedin_search", "apify_instagram", "social_research"]),
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
  await setFeature("brightdata", true, a.owner.id);
  await saveBrightdataSettings({ key: BRIGHTDATA_KEY, redditEnabled: true }, a.owner.id);
  // A contact the owner already has, named and titled their own way: the clinic's founder, by the address the clinic's website gives her.
  const [kavya] = await db.insert(people).values({ organizationId: a.org.id, email: `kavya@smile-${stamp}.test`, fullName: "Kavya Joshi-Rao", firstName: "Kavya", lastName: "Joshi-Rao", title: "Clinic Director", source: "manual" }).returning();

  // ---------------------------------------------------------- 1. the prompt, the search and the objective
  const thread = await createThread(a.owner.id);
  const ask = "Find 10 dental clinics in Pune and message them on WhatsApp";
  // The assistant writes the brief from the owner's words and starts the search: that step ends its turn.
  const brief = { goal: ask, leadTarget: 10, contact: true, channels: ["whatsapp"], spendCapUsd: null, timeLimitMinutes: null, done: "10 Pune dental clinics found and a WhatsApp plan ready" };
  replies = [reply("Searching Google Maps for dental clinics in Pune; I will write a WhatsApp plan for the ones with a number.", [{ tool: "set_brief", args: brief }, { tool: "find_leads", args: { what: "dental clinics", where: "Pune" } }])];
  await runAgentTurn({ threadId: thread.id, userId: a.owner.id, text: ask });
  const requestId = [...(await listMessages(thread.id, 500))].reverse().find((row) => row.role === "user")!.id;
  const objective = await objectives.objectiveForRequest(requestId);
  check("the prompt starts a search for the request, pursued with the target the owner named", Boolean(objective) && objective!.leadTarget === 10 && objective!.controls.named?.target === true && (await searches(requestId)).length === 1,
    JSON.stringify({ target: objective?.leadTarget, searches: (await searches(requestId)).length }));
  check("…in one model call: a step that only writes the brief and starts a search ends the turn", replies.length === 0 && modelCalls.filter((name) => name === "assistant_reply").length === 1, modelCalls.join(","));
  const [driver] = await db.select().from(schema.assistantJobs).where(and(eq(schema.assistantJobs.kind, "objective"), sql`${schema.assistantJobs.payload} ->> 'objectiveId' = ${objective!.id}`));

  // ---------------------------------------------------------- 2. research and qualification
  await finishSearches(requestId);
  const [first] = await searches(requestId);
  const firstResult = (first!.result ?? {}) as { found?: number; eligible?: number };
  check("the search ran on the built-in scraper and qualified each clinic with a WhatsApp route", first!.status === "succeeded" && firstResult.found === 6 && firstResult.eligible === 6 && scraper.posts.length === 1,
    JSON.stringify({ status: first!.status, ...firstResult, scraped: scraper.posts }));
  check("the finished search prepares no plan by itself (no contactAfter): the assistant decides when to plan", (await plans(thread.id)).length === 0 && !(first!.payload as { contactAfter?: unknown }).contactAfter,
    JSON.stringify({ plans: (await plans(thread.id)).length, contactAfter: (first!.payload as { contactAfter?: unknown }).contactAfter ?? null }));

  // ---------------------------------------------------------- 3. short of the target, the request goes on by itself: the plan of its matches, then another search
  replies = [
    reply("I'm writing the WhatsApp plan for the Pune clinics that match; it waits for your Start.", [{ tool: "prepare_outreach", args: {} }]),
    reply("Searching again with other words for the rest.", [{ tool: "find_leads", args: { what: "dentists", where: "Pune" } }]),
  ];
  await step(driver!.id);
  check("6 of 10: the request continues with no owner message", await continuationEnded(requestId, 1));
  let runs = await plans(thread.id);
  const plan1 = runs[0];
  check("in that continuation the assistant prepared a plan of those 6 matches on WhatsApp (the brief's channel), waiting for the owner's Start, and searched again", runs.length === 1 && plan1?.status === "proposed" && plan1.channels.join() === "whatsapp" && plan1.plan.assignments.length === 6 && plan1.plan.requestId === requestId && replies.length === 0 && (await searches(requestId)).length === 2,
    JSON.stringify({ runs: runs.map((run) => ({ status: run.status, channels: run.channels, leads: run.plan.assignments.length })), unused: replies.length, searches: (await searches(requestId)).length }));
  check("…with its messages and a sample from the writer", plan1!.plan.samples.length > 0 && (plan1!.plan.groups?.[0]?.sequences.whatsapp?.length ?? 0) === 2 && /chair hours/.test(JSON.stringify(plan1!.plan.samples)),
    JSON.stringify(plan1!.plan.samples).slice(0, 300));
  check("…the sample names the clinic, not its phone number", /^[A-Z][a-z]+ Dental Clinic$/.test(plan1!.plan.samples[0]?.name ?? ""), plan1!.plan.samples[0]?.name);

  // ---------------------------------------------------------- 3a. what one clinic's own website showed, through to the plan
  check("its website: each page read once, outside links never", JSON.stringify([...pageReads].sort()) === JSON.stringify([SMILE_SITE, `${SMILE_SITE}careers`, `${SMILE_SITE}team`].sort()), pageReads.join(", "));
  // The clinic's lead as its search saved it (the plan's own list copies it), and its sample in the plan: by that person.
  const [smileMember] = await db.select().from(schema.leadAudienceMembers)
    .where(and(eq(schema.leadAudienceMembers.organizationId, a.org.id), eq(schema.leadAudienceMembers.audienceId, first!.audienceId!), sql`${schema.leadAudienceMembers.facts} ->> 'website' = ${SMILE_SITE}`));
  const smileSample = plan1!.plan.samples.find((sample) => sample.personId === smileMember?.personId);
  const searchSaw = smileMember ? ((await memberInsights([smileMember.id])).get(smileMember.id)?.signals ?? []).map((signal) => signal.text) : [];
  check("the plan preview shows why that lead and what its website showed (its page, never as interest)", Boolean(smileSample) && /^May fit/.test(smileSample!.why ?? "") && (smileSample!.observed ?? []).some((item) => item.sourceUrl === `${SMILE_SITE}careers` && !item.need && /inferred/.test(item.relevance ?? "")),
    JSON.stringify({ samples: plan1!.plan.samples.map((sample) => ({ name: sample.name, why: sample.why, observed: sample.observed })), searchListSaw: searchSaw }));
  check("a line its facts back is kept in that sample", smileSample?.messages[0]?.body.includes(BACKED_LINE) === true, smileSample?.messages[0]?.body);
  check("a line its facts do not back (hiring, missing booking, a price) never reaches a plan", !UNBACKED.test(JSON.stringify(plan1!.plan)), JSON.stringify(plan1!.plan.samples.map((sample) => sample.messages[0]?.body)));
  const [kavyaNow] = await db.select().from(people).where(eq(people.id, kavya!.id));
  check("the founder's own address is a contact the owner already has: that person is the lead, and keeps the owner's name and title", smileMember?.personId === kavya!.id && kavyaNow?.fullName === "Kavya Joshi-Rao" && kavyaNow.firstName === "Kavya" && kavyaNow.lastName === "Joshi-Rao" && kavyaNow.title === "Clinic Director" && smileMember.facts.decisionMakers === undefined && smileMember.facts.booking === "Online booking link (Calendly)",
    JSON.stringify({ member: smileMember?.personId === kavya!.id, person: [kavyaNow?.fullName, kavyaNow?.firstName, kavyaNow?.lastName, kavyaNow?.title], facts: smileMember?.facts }));

  // ---------------------------------------------------------- 4. the second search, then the request's last turn at its target
  await step(driver!.id);
  await finishSearches(requestId);
  const secondSearch = (await searches(requestId))[1];
  const secondResult = (secondSearch?.result ?? {}) as { found?: number; eligible?: number };
  check("the second search qualified 6 more", secondSearch?.status === "succeeded" && secondResult.found === 6 && secondResult.eligible === 6 && (await plans(thread.id)).length === 1,
    JSON.stringify({ status: secondSearch?.status, found: secondResult.found, eligible: secondResult.eligible, plans: (await plans(thread.id)).length }));
  // At the target the owner named, the request is not stopped at once: it gets one last turn, in which no search starts.
  replies = [
    reply("I'm writing the WhatsApp plan for the clinics the second search found; it waits for your Start.", [{ tool: "prepare_outreach", args: { audienceId: secondSearch!.audienceId } }]),
    reply("Both WhatsApp plans are below. Nothing goes out before you press Start."),
  ];
  await step(driver!.id);
  const lastTurnEnded = await continuationEnded(requestId, 2);
  const atLastTurn = await objectives.objectiveForRequest(requestId);
  const lastNote = (await events(thread.id)).find((row) => (row.toolResult as { objectiveNote?: string } | null)?.objectiveNote === `${objective!.id}:2`);
  check("12 of 10: before it stops, the request gets one last turn, told the target was reached and that no more searches start",
    lastTurnEnded && (atLastTurn?.progress as { continuation?: { final?: string } }).continuation?.final === "target_reached" && atLastTurn?.status !== "stopped" && /has its 10 matching leads/.test(lastNote?.content ?? "") && /No more searches start for it/.test(lastNote?.content ?? ""),
    JSON.stringify({ ended: lastTurnEnded, status: atLastTurn?.status, continuation: (atLastTurn?.progress as { continuation?: unknown }).continuation, note: lastNote?.content.slice(0, 240) }));
  runs = await plans(thread.id);
  const planned = (run: (typeof runs)[number]) => run.plan.assignments.map((assignment) => assignment.personId);
  check("in its last turn the assistant prepared the second search's plan: its own 6 leads, none of the first plan's, waiting for Start",
    runs.length === 2 && runs[1]!.plan.assignments.length === 6 && runs[1]!.status === "proposed" && runs[1]!.channels.join() === "whatsapp" && runs[1]!.plan.requestId === requestId && !planned(runs[1]!).some((id) => planned(runs[0]!).includes(id)) && replies.length === 0 && (await searches(requestId)).length === 2,
    JSON.stringify({ runs: runs.map((run) => ({ status: run.status, channels: run.channels, leads: run.plan.assignments.length })), unused: replies.length, searches: (await searches(requestId)).length }));
  const done = await step(driver!.id);
  const stopped = await objectives.objectiveForRequest(requestId);
  const report = (await events(thread.id)).filter((row) => (row.toolResult as { objectiveId?: string; reportKey?: string } | null)?.objectiveId === objective!.id && (row.toolResult as { reportKey?: string }).reportKey);
  check("target reached: the request stops with that reason", stopped?.status === "stopped" && stopped.stopReason === "target_reached" && done.status === "succeeded", `${stopped?.status} ${stopped?.stopReason} ${done.status}`);
  check("one final report: what was searched by source, leads and routes, spend and the stop reason",
    report.length === 1 && /^Research finished: the target of 10 was reached/.test(report[0]!.content) && /Google Maps through the built-in scraper: 2 searches, 12 found/.test(report[0]!.content) && /Recorded spend: \$0\.00/.test(report[0]!.content),
    report.map((row) => row.content).join(" | ").slice(0, 600));

  // ---------------------------------------------------------- 5. Start, and the approval for the rest of the request
  const started = await startOutreachRun(plan1!.id, a.owner.id, { autopilot: false });
  const approval = await recordRequestApproval(plan1!.id, { autopilot: false, approvedBy: a.owner.id });
  check("Start on the first plan, and its approval starts the request's second plan", Boolean(started.jobId) && approval.started.length === 1 && approval.started[0]!.runId === runs[1]!.id, JSON.stringify(approval));

  // The first launch's worker dies after it created and recorded its campaign, before activating it.
  const [launch1] = await db.select().from(schema.assistantJobs).where(eq(schema.assistantJobs.id, started.jobId));
  const linesAsked = () => modelCalls.filter((name) => name === "opening_lines").length;
  const linesBefore = linesAsked();
  await step(launch1!.id); // personalizing
  const halfway = await jobRow(launch1!.id);
  // The worker runs a step again when its result could not be saved: the same personalizing step, from the row before it.
  const linesWritten = linesAsked();
  const rewritten = await runOutreachStartStep(launch1!, async () => {});
  check("a personalizing step that runs again (its saved progress lost) makes no second writer call: the texts it wrote are kept",
    linesWritten > linesBefore && linesAsked() === linesWritten && rewritten.next === "stage" && rewritten.stage === "launching",
    JSON.stringify({ before: linesBefore, firstRun: linesWritten, rerun: linesAsked(), outcome: rewritten.next }));
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
  // The launch finished and set the run running, but saving the job's outcome failed: the step runs again.
  const relaunchedAgain = await runOutreachStartStep(halfway, async () => {});
  check("a launch step that runs again after the run is running reports done with what the run recorded, never failed and never a second launch",
    relaunchedAgain.next === "done" && JSON.stringify((relaunchedAgain as { result: { started?: string[] } }).result.started) === "[\"whatsapp\"]" && (await getRun(plan1!.id))?.campaigns.whatsapp === precreated.id,
    JSON.stringify(relaunchedAgain).slice(0, 300));
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
  const written = await db.select({ raw: people.raw, website: sql<string | null>`${people.raw} ->> 'website'` }).from(people).where(eq(people.organizationId, a.org.id));
  const lineKey = plan1!.plan.personalizationKey;
  check("at Start the texts are written from the same facts: the backed line is kept, an unbacked one never stored", written.find((row) => row.website === SMILE_SITE)?.raw[lineKey] === BACKED_LINE && !written.some((row) => UNBACKED.test(JSON.stringify(row.raw))),
    JSON.stringify(written.map((row) => row.raw[lineKey])));

  // ---------------------------------------------------------- 7. what the owner sees
  const work = await listWork();
  const requestItem = work.find((item) => item.id === driver!.id);
  const planItems = work.filter((item) => item.type === "plan");
  check("Activity: the lead request is Done with 12 of 10, and both plans run with their 6 leads", requestItem?.state === "completed" && /12 of 10 leads/.test(requestItem.reason ?? "") && planItems.length === 2 && planItems.every((item) => item.counts?.leads === 6 && item.runStatus === "running"),
    JSON.stringify({ request: requestItem && { state: requestItem.state, reason: requestItem.reason }, plans: planItems.map((item) => ({ state: item.state, counts: item.counts })) }));
  check("the chat model was asked once for the owner's prompt and twice in each continuation (the plan, then the next search or the close), and the writer wrote each plan",
    modelCalls.filter((name) => name === "assistant_reply").length === 5 && replies.length === 0 && modelCalls.filter((name) => name === "outreach_sequences").length >= 2,
    modelCalls.join(","));

  // ---------------------------------------------------------- 8. a second request: Reddit research through Bright Data, qualified, planned and reported
  // No brief this time: the search starts a new request for the owner's new message (the first one has stopped), from their words.
  replies = [reply("Researching Reddit for clinics complaining about missed calls; I will write a WhatsApp plan for anyone whose own profile or website gives a number.", [{ tool: "research_social_sources", args: { platforms: ["reddit"], customers: "dental clinics", need: "missed calls at the front desk", where: "Pune" } }])];
  await runAgentTurn({ threadId: thread.id, userId: a.owner.id, text: "Find 1 dental clinic on Reddit complaining about missed calls and message them on WhatsApp" });
  const requestId2 = [...(await listMessages(thread.id, 500))].reverse().find((row) => row.role === "user")!.id;
  const objective2 = await objectives.objectiveForRequest(requestId2);
  const [social] = await searches(requestId2);
  check("the second prompt starts a Reddit research job through Bright Data for a new request with a target of 1", Boolean(objective2) && objective2!.id !== objective!.id && objective2!.leadTarget === 1 && objective2!.controls.named?.target === true && social?.kind === "social_research" && (await searches(requestId)).length === 2 && replies.length === 0,
    JSON.stringify({ target: objective2?.leadTarget, named: objective2?.controls.named, kind: social?.kind, firstRequestSearches: (await searches(requestId)).length, unused: replies.length }));
  await finishSearches(requestId2);
  const socialDone = await jobRow(social!.id);
  const socialResult = (socialDone.result ?? {}) as { found?: number; eligible?: number; excluded?: number; discussions?: number; creditsUsed?: number; fit?: { qualified?: number } };
  check("Bright Data discovered the post by keyword and read its authors' profiles (the poster's and the commenting vendor's), with the key as a Bearer header",
    brightdata.triggers.length === 2 && brightdata.triggers[0]!.discoverBy === "keyword" && brightdata.triggers[1]!.input.map((input) => input.url).join() === [`https://www.reddit.com/user/${REDDIT_POSTER}/`, `https://www.reddit.com/user/${REDDIT_VENDOR}/`].join() && brightdata.triggers.every((trigger) => trigger.auth === `Bearer ${BRIGHTDATA_KEY}`),
    JSON.stringify(brightdata.triggers.map((trigger) => [trigger.discoverBy, trigger.input])));
  check("the research found the poster (a lead by the phone her website publishes) and the vendor (research only), and judged the poster against the request",
    socialDone.status === "succeeded" && socialResult.found === 2 && socialResult.discussions === 2 && socialResult.eligible === 1 && socialResult.excluded === 1 && socialResult.fit?.qualified === 1 && socialResult.creditsUsed === 3,
    JSON.stringify({ status: socialDone.status, error: socialDone.error, ...socialResult }));
  const [posterMember] = await db.select().from(schema.leadAudienceMembers).where(and(eq(schema.leadAudienceMembers.audienceId, socialDone.audienceId!), eq(schema.leadAudienceMembers.status, "eligible")));
  check("the lead keeps its evidence: the post, her words, the profile that led to the website, and the phone with its page",
    posterMember?.fit === "match" && posterMember.sourceUrl === `https://www.reddit.com/user/${REDDIT_POSTER}/` && posterMember.facts.discussion === REDDIT_POST && /Looking for a service/.test(posterMember.facts.quote ?? "") && posterMember.evidence.some((item) => item.kind === "phone" && item.value === "+912025531234" && item.sourceUrl === PUNE_SMILES_SITE) && posterMember.channels.includes("whatsapp"),
    JSON.stringify({ fit: posterMember?.fit, source: posterMember?.sourceUrl, facts: posterMember?.facts, evidence: posterMember?.evidence, channels: posterMember?.channels }));
  check("the research prepares no plan by itself", (await plans(thread.id)).length === 2, `${(await plans(thread.id)).length} plans`);
  // Its target of 1 is reached: the request's last turn, in which the assistant prepares the plan of its match.
  replies = [
    reply("I'm writing the WhatsApp plan for the clinic whose website gives a number; it waits for your Start.", [{ tool: "prepare_outreach", args: {} }]),
    reply("The WhatsApp plan is below. Nothing goes out before you press Start."),
  ];
  const [driver2] = await db.select().from(schema.assistantJobs).where(and(eq(schema.assistantJobs.kind, "objective"), sql`${schema.assistantJobs.payload} ->> 'objectiveId' = ${objective2!.id}`));
  await step(driver2!.id);
  const lastTurn2 = await continuationEnded(requestId2, 1);
  const runsAfter = await plans(thread.id);
  const plan3 = runsAfter.find((run) => run.plan.requestId === requestId2);
  check("in the request's last turn a WhatsApp plan was prepared for that one lead and waits for Start", lastTurn2 && (((await objectives.objectiveForRequest(requestId2))?.progress) as { continuation?: { final?: string } }).continuation?.final === "target_reached" && runsAfter.length === 3 && plan3?.status === "proposed" && plan3.channels.join() === "whatsapp" && plan3.plan.assignments.length === 1 && replies.length === 0,
    JSON.stringify({ lastTurn: lastTurn2, unused: replies.length, runs: runsAfter.map((run) => ({ status: run.status, channels: run.channels, leads: run.plan.assignments.length })) }));
  await step(driver2!.id);
  const stopped2 = await objectives.objectiveForRequest(requestId2);
  const report2 = (await events(thread.id)).filter((row) => (row.toolResult as { objectiveId?: string; reportKey?: string } | null)?.objectiveId === objective2!.id && (row.toolResult as { reportKey?: string }).reportKey);
  check("target reached: one final report names Reddit through Bright Data, its yield and the credits as an estimate",
    stopped2?.status === "stopped" && stopped2.stopReason === "target_reached" && report2.length === 1 && /Reddit through Bright Data: 1 search, 2 found/.test(report2[0]!.content) && /3 credits, estimated from delivered records/.test(report2[0]!.content),
    `${stopped2?.status} ${stopped2?.stopReason} ${report2.map((row) => row.content).join(" | ").slice(0, 700)}`);
  const usage = await db.select({ status: providerUsage.status, used: providerUsage.usedUnits }).from(providerUsage).where(and(eq(providerUsage.organizationId, a.org.id), eq(providerUsage.provider, "brightdata")));
  check("the request's Bright Data use is on the ledger, settled from what was delivered", usage.length === 2 && usage.every((row) => row.status === "settled") && usage.reduce((sum, row) => sum + (row.used ?? 0), 0) === 3, JSON.stringify(usage));

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

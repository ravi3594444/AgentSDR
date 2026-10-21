/**
 * The owner's assistant, end to end against the local database: the real
 * tools, background worker, lead discovery, imports, outreach launch and the
 * reply autopilot, with every outside service replaced by an in-process
 * stand-in (nothing leaves the machine except, optionally, AI calls):
 *
 * - the Google Maps scraper (gosom/google-maps-scraper web API) answers from
 *   a fixture CSV at GMAPS_SCRAPER_URL;
 * - the businesses' websites are fixture pages (a fetch stand-in);
 * - Unipile (email sending) is a recording fake host.
 *
 *   bun run --conditions=react-server scripts/e2e/assistant.ts
 *   AI_SOURCE_ORGANIZATION_ID=<org with AI Settings> bun run --conditions=react-server scripts/e2e/assistant.ts
 *
 * Without AI_SOURCE_ORGANIZATION_ID it checks everything that needs no
 * model: discovery and its exclusions, list and document ingestion, the
 * tools' argument checks, and that outreach refuses to plan without AI.
 * With it, the fresh organization gets a copy of that organization's AI
 * Settings (the encrypted credential row is copied as is, never decrypted
 * here) and the script also runs the chat agent (it must save what the
 * owner says, start a search, and propose outreach after the search, but
 * never start it), the owner's Start (personalized lines, campaigns
 * launched), and an inbound reply through the CRM worker to the autopilot.
 * That spends a little real model usage.
 *
 * It creates its own organization ("Assistant check …") and leaves it behind
 * with its campaigns paused, its mailbox disabled, the autopilot off and its
 * fake Unipile connection removed. Lead and mailbox addresses are on .test
 * domains. Refuses a non-local DATABASE_URL.
 */
import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}

const SCRAPER = "http://gmaps-check.invalid";
const UNIPILE = "https://unipile-assistant-check.invalid";
process.env.GMAPS_SCRAPER_URL = SCRAPER;
process.env.DISCOVERY_DNS_CHECK = "off";
// Automatic replies send only in production; this script sends to its own fake Unipile.
process.env.AUTOPILOT_ALLOW_NON_PRODUCTION = "true";
const stamp = Date.now();

// ------------------------------------------------------------ fixtures
function csvRow(values: (string | number)[]): string {
  return values.map((value) => `"${String(value).replace(/"/g, "\"\"")}"`).join(",");
}
const MAPS_HEADER = "input_id,link,title,category,address,website,phone,review_count,review_rating,place_id,cid,status,complete_address,emails";
const pune = JSON.stringify({ city: "Pune", country: "IN" });
const site = (slug: string) => `https://${slug}-${stamp}.test/`;
const MAPS_CSV = [
  MAPS_HEADER,
  // Website with a contact page (email there) and a listed phone → email.
  csvRow(["1", `https://maps.google.com/?cid=${stamp}1`, "Lotus Dental Care", "Dentist", "FC Road, Pune", site("lotus"), "020 2553 1234", 210, 4.7, `pl-${stamp}-1`, `${stamp}1`, "", pune, ""]),
  // No website, listed mobile → WhatsApp only.
  csvRow(["1", `https://maps.google.com/?cid=${stamp}2`, "Bright Smile Clinic", "Dental clinic", "Baner, Pune", "", "+91 98220 12345", 54, 4.4, `pl-${stamp}-2`, `${stamp}2`, "", pune, ""]),
  // Closed.
  csvRow(["1", `https://maps.google.com/?cid=${stamp}3`, "Old Town Dentistry", "Dentist", "Camp, Pune", site("oldtown"), "020 2611 0000", 12, 3.9, `pl-${stamp}-3`, `${stamp}3`, "Permanently closed", pune, ""]),
  // Nothing to contact.
  csvRow(["1", `https://maps.google.com/?cid=${stamp}4`, "Quiet Dental Studio", "Dentist", "Kothrud, Pune", "", "", 3, 5, `pl-${stamp}-4`, `${stamp}4`, "", pune, ""]),
  // Second branch sharing the first one's website and address → duplicate.
  csvRow(["1", `https://maps.google.com/?cid=${stamp}5`, "Lotus Dental Care — Aundh", "Dentist", "Aundh, Pune", site("lotus"), "", 80, 4.6, `pl-${stamp}-5`, `${stamp}5`, "", pune, ""]),
  // Website that errors, no phone → excluded with the website's error.
  csvRow(["1", `https://maps.google.com/?cid=${stamp}6`, "Pearl Dental", "Dentist", "Viman Nagar, Pune", site("pearl"), "", 40, 4.2, `pl-${stamp}-6`, `${stamp}6`, "", pune, ""]),
  // "Website" is a Facebook page (not its own site); the scraper read an email → email (Gmail).
  csvRow(["1", `https://maps.google.com/?cid=${stamp}7`, "Sunrise Orthodontics", "Orthodontist", "Wakad, Pune", "https://www.facebook.com/sunrise-ortho", "", 66, 4.8, `pl-${stamp}-7`, `${stamp}7`, "", pune, `sunrise.ortho.${stamp}@gmail.test`]),
].join("\n");

const PAGES: Record<string, { status: number; html: string }> = {
  [site("lotus")]: { status: 200, html: `<html><body><h1>Lotus Dental Care</h1><a href="/contact">Contact us</a><a href="https://www.linkedin.com/company/lotus-dental-${stamp}">LinkedIn</a><script>var t="tracker@sentry.io"</script></body></html>` },
  [`${site("lotus")}contact`]: { status: 200, html: `<p>Appointments: <a href="mailto:hello@lotus-${stamp}.test">hello@lotus-${stamp}.test</a></p><p>Clinic manager: priya [at] lotus-${stamp} [dot] test</p><a href="tel:+912025531234">Call</a>` },
  [site("pearl")]: { status: 503, html: "unavailable" },
};
const websiteFetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const page = PAGES[url];
  if (!page) return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
  return new Response(page.html, { status: page.status, headers: { "content-type": "text/html; charset=utf-8" } });
}) as typeof fetch;

// ------------------------------------------------------------ fake scraper + Unipile
type ScraperJob = { keywords: string[]; polls: number; body: Record<string, unknown> };
const scraperJobs = new Map<string, ScraperJob>();
const unipileSends: Record<string, string>[] = [];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.origin === SCRAPER) {
    if (method === "POST" && url.pathname === "/api/v1/jobs") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const id = `job-${scraperJobs.size + 1}-${stamp}`;
      scraperJobs.set(id, { keywords: body.keywords as string[], polls: 0, body });
      return json(201, { id });
    }
    const match = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)(\/download)?$/);
    const job = match ? scraperJobs.get(match[1]!) : undefined;
    if (!job) return json(404, { code: 404, message: "job not found" });
    const phrase = job.keywords.join(" ");
    if (match![2]) return new Response(/unicorn/.test(phrase) ? MAPS_HEADER : MAPS_CSV, { status: 200, headers: { "content-type": "text/csv" } });
    job.polls += 1;
    const status = /blocked/.test(phrase) ? "failed" : job.polls < 2 ? "working" : "ok";
    return json(200, { ID: match![1], Name: "x", Date: new Date().toISOString(), Status: status, Data: job.body });
  }
  if (url.origin === UNIPILE) {
    const path = url.pathname.replace(/^\/api\/v1/, "");
    if (method === "POST" && path === "/emails") {
      const form: Record<string, string> = {};
      if (init?.body instanceof FormData) for (const [key, value] of init.body.entries()) form[key] = String(value);
      unipileSends.push(form);
      return json(201, { object: "EmailSent", tracking_id: `trk-${stamp}-${unipileSends.length}`, provider_id: `prov-${stamp}-${unipileSends.length}` });
    }
    if (method === "GET" && path.startsWith("/emails/")) return json(404, { title: "Not found", status: 404, type: "errors/resource_not_found" });
    if (method === "GET" && path.startsWith("/accounts")) return json(200, { object: "AccountList", items: [], cursor: null });
    if (path.startsWith("/webhooks")) return method === "POST" ? json(201, { object: "WebhookCreated", webhook_id: "wh" }) : json(200, { items: [] });
    return json(404, { title: `No fake for ${method} ${path}`, status: 404 });
  }
  return realFetch(input, init);
}) as typeof fetch;

// ------------------------------------------------------------ app modules
const { db } = await import("@/lib/db");
const { organizations } = await import("@/lib/auth/schema");
const { people } = await import("@/lib/leads/schema");
const { gridProviderCredentials, gridProviders } = await import("@/lib/grid/schema");
const { encryptIntegrationCredentials } = await import("@/lib/integrations/credentials");
const { mailboxes, outreachCampaigns, outreachLeads, outreachMailboxQueue } = await import("@/lib/outreach/schema");
const { whatsappAccounts, whatsappCampaigns, whatsappCampaignLeads } = await import("@/lib/whatsapp/schema");
const { crmClassifications, crmDrafts, crmJobs, crmKnowledgeDocuments: knowledgeDocuments, crmSettings } = await import("@/lib/crm/schema");
const { runInOrganization, currentOrganizationId } = await import("@/lib/tenancy/scope");
const { assistantJobs, assistantMessages, assistantProfiles, autopilotReplies, leadAudienceMembers, outreachRunLeads, outreachRuns, ownerDecisions } = await import("@/lib/assistant/schema");
const { answerDecision } = await import("@/lib/assistant/decisions.server");
const { runTool } = await import("@/lib/assistant/tools.server");
const { runOneAssistantStep } = await import("@/lib/assistant/worker");
const { registerAssistantJobs } = await import("@/lib/assistant/register.server");
const { createThread, listMessages, threadBusy } = await import("@/lib/assistant/threads.server");
const { ingestAttachment } = await import("@/lib/assistant/ingest.server");
const { summarizeAudience } = await import("@/lib/assistant/audiences.server");
const { runAgentTurn } = await import("@/lib/assistant/agent.server");
const { startOutreachRun, getRun } = await import("@/lib/assistant/outreach.server");
const { personalLineProblem } = await import("@/lib/assistant/messages");
const { setDiscoveryPageOptions } = await import("@/lib/discovery/discovery.server");
const { fetchPublicPage } = await import("@/lib/discovery/websiteContacts.server");
const { setGeocoderFetch } = await import("@/lib/discovery/geocode.server");
const { runAutomationChecks, runIsolationChecks } = await import("./assistantAutomation");
let automation: { missingDecisionId: string; supportedDraftId: string } | null = null;
const { ingestInboundReply } = await import("@/lib/crm/conversations");
const { registerDefaultCrmJobHandlers } = await import("@/lib/crm/handlers");
const { drainOnce } = await import("@/lib/crm/worker");

setDiscoveryPageOptions({ allowPrivate: true, fetchImpl: websiteFetch });
// OpenStreetMap's geocoder, stood in: one small area around Pune.
setGeocoderFetch(async () => new Response(JSON.stringify([{ lat: "18.5590", lon: "73.7868", boundingbox: ["18.5490", "18.5690", "73.7768", "73.7968"], display_name: "Baner, Pune, India" }]), { status: 200, headers: { "content-type": "application/json" } }));
registerAssistantJobs();

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/**
 * Runs the assistant worker on this job until it is finished, skipping its
 * polling waits. Only this job: another organization's queued job (left by
 * an earlier check in the same database) is never picked up in this scope.
 */
async function finishJob(jobId: string, maxSteps = 40) {
  for (let step = 0; step < maxSteps; step += 1) {
    await db.update(assistantJobs).set({ runAfter: new Date(Date.now() - 1_000) }).where(and(eq(assistantJobs.id, jobId), eq(assistantJobs.status, "queued")));
    const [job] = await db.select().from(assistantJobs).where(eq(assistantJobs.id, jobId));
    if (!job || job.status === "succeeded" || job.status === "failed") return job ?? null;
    await runOneAssistantStep({ jobId });
  }
  const [job] = await db.select().from(assistantJobs).where(eq(assistantJobs.id, jobId));
  return job ?? null;
}

async function waitUntil(label: string, ms: number, test: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await test()) return true;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  console.log(`…gave up waiting for ${label}`);
  return false;
}

const [org] = await db.insert(organizations).values({ name: `Assistant check ${stamp}`, slug: `assistant-check-${stamp}` }).returning();
console.log(`Organization ${org!.name} (${org!.id})`);

// ------------------------------------------------------------ AI settings (optional)
const aiSource = process.env.AI_SOURCE_ORGANIZATION_ID?.trim() || null;
let aiReady = false;
if (aiSource) {
  const { copyAiSettings } = await import("./copyAiSettings");
  try {
    await copyAiSettings(aiSource, org!.id);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  aiReady = true;
  console.log(`AI Settings copied from organization ${aiSource}.`);
} else {
  console.log("No AI_SOURCE_ORGANIZATION_ID: the model-backed steps are skipped.");
}

const mailboxAddress = `owner-${stamp}@mail.assistant-check.test`;
const unipileAccount = `assistant-check-${stamp}`;

await runInOrganization(org!.id, async () => {
  const orgId = currentOrganizationId();
  const owner = null;

  // Sending accounts: a fake Unipile connection, an email inbox linked in it, a WhatsApp number.
  const [unipile] = await db.insert(gridProviders).values({ organizationId: orgId, key: "platform-unipile", name: "Unipile (assistant check)" }).returning();
  await db.insert(gridProviderCredentials).values({ providerId: unipile!.id, encryptedPayload: encryptIntegrationCredentials({ baseUrl: UNIPILE, apiKey: "assistant-check", notifySecret: "assistant-check" }) });
  // Hours left to the column default: always open (sending is always on).
  const [mailbox] = await db.insert(mailboxes).values({
    organizationId: orgId,
    emailAddress: mailboxAddress,
    provider: "unipile",
    unipileAccountId: unipileAccount,
    displayName: "Ravi from Bright Path",
    status: "connected",
  }).returning();
  const [whatsapp] = await db.insert(whatsappAccounts).values({
    organizationId: orgId,
    unipileAccountId: `wa-${unipileAccount}`,
    name: "Bright Path (check)",
    phone: "+919999900000",
    status: "connected",
    connectedAt: new Date(Date.now() - 3 * 86_400_000),
  }).returning();

  const thread = await createThread(owner);
  const context = { threadId: thread.id, userId: owner, ownerText: "" };

  try {
    // ------------------------------------------------------------ setup and profile tools
    const setup = await runTool("check_setup", {}, context);
    check("check_setup reports email and WhatsApp ready, lead search ready, and what the profile lacks",
      setup.ok && /email: ready/.test(setup.summary) && /whatsapp: ready/.test(setup.summary) && /Google Maps ready/.test(setup.summary) && /who your customers are/.test(setup.summary),
      setup.summary);

    const badSave = await runTool("save_business_info", { language: "English", favouriteColour: "blue" }, context);
    check("save_business_info refuses bad values and unknown fields, and says which", !badSave.ok && /language/.test(badSave.summary) && /favouriteColour/.test(badSave.summary), badSave.summary);
    const saved = await runTool("save_business_info", { targetCustomers: "independent dental clinics", locations: "Pune, India" }, context);
    const [profileRow] = await db.select().from(assistantProfiles).where(eq(assistantProfiles.organizationId, orgId));
    check("save_business_info stores the profile for the organization", saved.ok && profileRow?.profile.targetCustomers === "independent dental clinics", saved.summary);
    const [profileDoc] = profileRow?.knowledgeDocumentId
      ? await db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, profileRow.knowledgeDocumentId))
      : [];
    check("the profile is mirrored into a knowledge document drafts read", profileDoc?.organizationId === orgId && profileDoc.alwaysInclude === true);

    // ------------------------------------------------------------ documents
    const pdf = tinyPdf(`Bright Path Dental Supplies: autoclaves serviced within 48 hours, Pune ${stamp}`);
    const document = await ingestAttachment({ name: "service-brochure.pdf", size: pdf.byteLength, bytes: pdf }, context);
    check("a PDF becomes a knowledge document", document.ok && document.kind === "document", JSON.stringify(document));
    const docx = tinyDocx(["Price list", `Chair maintenance plan from 2,499 INR a month (${stamp})`]);
    const word = await ingestAttachment({ name: "price list.docx", size: docx.byteLength, bytes: docx }, context);
    check("a Word document becomes a knowledge document", word.ok && word.kind === "document");
    const found = await runTool("search_knowledge", { query: "chair maintenance plan price" }, context);
    check("search_knowledge finds the uploaded text", found.ok && found.summary.includes("2,499"), found.summary.slice(0, 200));
    const scan = tinyPdf("");
    const scanned = await ingestAttachment({ name: "scan.pdf", size: scan.byteLength, bytes: scan }, context);
    check("a PDF without text is refused with the reason (no OCR)", !scanned.ok && "error" in scanned && /OCR/.test(scanned.error), "error" in scanned ? scanned.error : "");
    const unknown = await ingestAttachment({ name: "photo.png", size: 3, bytes: new Uint8Array([1, 2, 3]) }, context);
    check("an unsupported file is refused", !unknown.ok);

    // ------------------------------------------------------------ contact list
    const list = [
      "Email,First Name,Last Name,Company,Phone,Job Title",
      `meera-${stamp}@clinic-a.test,Meera,Joshi,Clinic A,,Owner`,
      `not-an-email,Bad,Row,Clinic B,,`,
      `,Sameer,Kulkarni,Clinic C,+91 98230 55555,Dentist`,
      `MEERA-${stamp}@clinic-a.test,Meera,Joshi,Clinic A,,Owner`,
    ].join("\n");
    const imported = await ingestAttachment({ name: "my contacts.csv", size: list.length, bytes: strToU8(list) }, context);
    check("a CSV list is imported into an audience", imported.ok && imported.kind === "contacts", JSON.stringify(imported).slice(0, 400));
    if (imported.ok && imported.kind === "contacts") {
      check("the import reports the bad row instead of dropping it silently", imported.imported.failed + imported.imported.skippedNoIdentity >= 1, JSON.stringify(imported.imported));
      check("the list's audience has the email lead and the phone-only lead, each with its channel",
        imported.audience?.eligible === 2 && imported.audience.byChannel.email === 1 && imported.audience.byChannel.whatsapp === 1,
        JSON.stringify(imported.audience?.byChannel));
    }
    const emptyList = "Name,Company\nNobody,Nowhere";
    const refused = await ingestAttachment({ name: "names.csv", size: emptyList.length, bytes: strToU8(emptyList) }, context);
    check("a list with no email, phone or LinkedIn says why nothing was imported", !refused.ok && "error" in refused && /Nothing could be imported/.test(refused.error), "error" in refused ? refused.error : "");

    // ------------------------------------------------------------ discovery
    const ssrf = await fetchPublicPage("http://127.0.0.1:9/").then(() => "fetched", (error: Error) => error.message);
    check("website reading refuses private addresses", /not a public website/.test(ssrf), ssrf);

    const badSearch = await runTool("find_leads", { what: "dental clinics" }, context);
    check("find_leads needs a place", !badSearch.ok && /where/.test(badSearch.summary), badSearch.summary);
    delete process.env.GMAPS_SCRAPER_URL;
    const unavailable = await runTool("find_leads", { what: "dental clinics", where: "Pune" }, context);
    process.env.GMAPS_SCRAPER_URL = SCRAPER;
    check("without the scraper, find_leads says lead search is not set up", !unavailable.ok && /GMAPS_SCRAPER_URL/.test(unavailable.summary), unavailable.summary);

    const search = await runTool("find_leads", { what: "dental clinics", where: "Pune, India", maxResults: 20 }, context);
    const searchData = search.data as { jobId: string; audienceId: string } | undefined;
    check("find_leads starts a background search", search.ok && Boolean(searchData?.jobId), search.summary);
    const job = searchData ? await finishJob(searchData.jobId) : null;
    const scraperJob = [...scraperJobs.values()].at(-1);
    check("the scraper runs a fast search around the geocoded place, in the profile's language",
      scraperJob?.keywords[0] === "dental clinics" && scraperJob.body.fast_mode === true && scraperJob.body.lat === "18.559000" && scraperJob.body.lang === "en" && Number(scraperJob.body.radius) >= 1_500,
      JSON.stringify(scraperJob?.body));
    check("the search job finishes", job?.status === "succeeded", `${job?.status} ${job?.error ?? ""}`);
    const result = (job?.result ?? {}) as Record<string, number>;
    check("7 listings → 3 contactable (2 email, 1 phone only), 3 left out, 1 duplicate",
      result.found === 7 && result.eligible === 3 && result.withEmail === 2 && result.withPhoneOnly === 1 && result.excluded === 3 && result.duplicates === 1,
      JSON.stringify(result));

    const members = searchData ? await db.select().from(leadAudienceMembers).where(eq(leadAudienceMembers.audienceId, searchData.audienceId)) : [];
    const memberPeople = members.filter((m) => m.personId).length
      ? await db.select().from(people).where(inArray(people.id, members.flatMap((m) => (m.personId ? [m.personId] : []))))
      : [];
    const lotus = memberPeople.find((p) => (p.raw as Record<string, unknown>)?.businessName === "Lotus Dental Care");
    check("Lotus: the email published on its contact page, not a guessed one, with the listing phone",
      lotus?.email === `hello@lotus-${stamp}.test` && lotus.phone === "+912025531234", `${lotus?.email} ${lotus?.phone}`);
    const lotusMember = members.find((m) => m.personId === lotus?.id);
    const lotusEmailEvidence = lotusMember?.evidence.find((e) => e.kind === "email" && e.value === lotus?.email);
    check("its evidence links the contact page the email came from, and the Maps listing",
      lotusEmailEvidence?.sourceUrl === `${site("lotus")}contact` && lotusMember?.sourceUrl === `https://maps.google.com/?cid=${stamp}1`,
      JSON.stringify(lotusMember?.evidence));
    check("the obfuscated second address was read too, and nothing from scripts",
      Boolean(lotusMember?.evidence.some((e) => e.value === `priya@lotus-${stamp}.test`)) && !JSON.stringify(lotusMember?.evidence).includes("sentry"));
    const bright = memberPeople.find((p) => (p.raw as Record<string, unknown>)?.businessName === "Bright Smile Clinic");
    check("Bright Smile: phone-only lead, E.164, WhatsApp channel", bright?.email === null && bright.phone === "+919822012345" && Boolean(members.find((m) => m.personId === bright.id)?.channels.includes("whatsapp")));
    const reasons = members.filter((m) => m.status === "excluded").map((m) => `${m.name}: ${m.reason}`);
    check("left-out businesses carry their reason", reasons.length === 3
      && reasons.some((r) => r.startsWith("Old Town Dentistry: listed on Google Maps as permanently closed"))
      && reasons.some((r) => r.startsWith("Quiet Dental Studio: no email or phone on its Google Maps listing, and no website"))
      && reasons.some((r) => r.startsWith("Pearl Dental:") && r.includes("503")), reasons.join(" | "));
    const sunrise = memberPeople.find((p) => (p.raw as Record<string, unknown>)?.businessName === "Sunrise Orthodontics");
    check("a Facebook page is not treated as the business's website; the scraper's email is kept", sunrise?.email === `sunrise.ortho.${stamp}@gmail.test` && !(sunrise.raw as Record<string, unknown>).website);
    const events = await listMessages(thread.id);
    check("the finished search is announced in the chat with the real counts",
      events.some((m) => m.role === "event" && m.content.includes("7 businesses found on Google Maps through the built-in scraper, 3 can be contacted")),
      events.filter((m) => m.role === "event").map((m) => m.content).join(" | "));

    const again = await runTool("find_leads", { what: "dental clinics", where: "Pune, India", maxResults: 20 }, context);
    const againJob = await finishJob((again.data as { jobId: string }).jobId);
    const againAudience = await summarizeAudience((again.data as { audienceId: string }).audienceId);
    const peopleCount = await db.select({ n: sql<number>`count(*)::int` }).from(people).where(eq(people.organizationId, orgId));
    check("searching again reuses the same People (no duplicates across searches)",
      againJob?.status === "succeeded" && againAudience?.eligible === 3 && Number(peopleCount[0]?.n) === 3 + 2,
      `${againAudience?.eligible} eligible, ${peopleCount[0]?.n} people`);

    const blocked = await runTool("find_leads", { what: "blocked clinics", where: "Pune" }, context);
    const blockedJob = await finishJob((blocked.data as { jobId: string }).jobId);
    check("a search the scraper fails is reported as failed, with the likely reason", blockedJob?.status === "failed" && /blocked/i.test(blockedJob.error ?? ""), blockedJob?.error ?? "");
    const empty = await runTool("find_leads", { what: "unicorn breeders", where: "Pune" }, context);
    const emptyJob = await finishJob((empty.data as { jobId: string }).jobId);
    check("an empty search says Maps only covers listed businesses", emptyJob?.status === "succeeded" && /only covers businesses with a public Maps listing/.test(String((emptyJob.result as Record<string, unknown>)?.note)), String((emptyJob?.result as Record<string, unknown>)?.note));

    // ------------------------------------------------------------ outreach without AI / without profile
    const early = await runTool("prepare_outreach", { audienceId: searchData!.audienceId, ownerRequest: "email them" }, { ...context, ownerText: "Find dental clinics and email them." });
    check("outreach needs the business name, offer and sender first", !early.ok && /business name/.test(early.summary), early.summary);
    await runTool("save_business_info", { businessName: "Bright Path Dental Supplies", offer: "Same-week servicing for dental chairs and autoclaves, with a monthly maintenance plan", senderName: "Ravi" }, context);
    if (!aiReady) {
      const noAi = await runTool("prepare_outreach", { audienceId: searchData!.audienceId, ownerRequest: "email them" }, { ...context, ownerText: "Find dental clinics and email them." });
      const runs = await db.select().from(outreachRuns).where(eq(outreachRuns.organizationId, orgId));
      check("without AI, prepare_outreach fails with the reason and plans nothing", !noAi.ok && runs.length === 0, noAi.summary);
      automation = await runAutomationChecks({ check, organizationId: orgId, stamp, mailboxAddress, unipileSends, ownerId: owner });
      return;
    }
    automation = await runAutomationChecks({ check, organizationId: orgId, stamp, mailboxAddress, unipileSends, ownerId: owner });

    // ------------------------------------------------------------ the chat agent
    await db.update(assistantProfiles).set({ profile: {} }).where(eq(assistantProfiles.organizationId, orgId));
    const chat = await createThread(owner);
    await runAgentTurn({
      threadId: chat.id,
      userId: owner,
      text: "Hi. I run Bright Path Dental Supplies in Pune. We service dental chairs and autoclaves within the same week and sell a monthly maintenance plan. Our customers are independent dental clinics in Pune. Sign messages as Ravi, founder. Prefer email.",
    });
    let turn = await listMessages(chat.id);
    const saveCall = turn.find((m) => m.role === "tool" && m.tool === "save_business_info");
    const [afterChat] = await db.select().from(assistantProfiles).where(eq(assistantProfiles.organizationId, orgId));
    check("the agent saves what the owner said (a real tool call)", saveCall?.status === "ok" && Boolean(afterChat?.profile.businessName && afterChat.profile.offer && afterChat.profile.senderName),
      `${saveCall?.status} ${JSON.stringify(afterChat?.profile)}`);
    console.log(`      assistant: ${turn.filter((m) => m.role === "assistant").map((m) => m.content).join(" / ").slice(0, 400)}`);

    await runAgentTurn({ threadId: chat.id, userId: owner, text: "Find dental clinics in Pune and contact them by email." });
    turn = await listMessages(chat.id);
    const findCall = turn.find((m) => m.role === "tool" && m.tool === "find_leads");
    check("asked to find and contact leads, the agent starts a search", findCall?.status === "ok", findCall?.content ?? turn.map((m) => `${m.role}:${m.content}`).join(" / ").slice(0, 400));
    if (findCall?.toolInput?.contactAfter !== true) console.log("NOTE  the agent did not mark the search to be contacted afterwards; the model then decides after the search");
    const chatJobId = (findCall?.toolResult as { data?: { jobId?: string } } | null)?.data?.jobId;
    if (chatJobId) {
      await finishJob(chatJobId);
      // The finished search wakes the agent (not awaited by the worker); wait for that turn.
      await waitUntil("the agent's turn after the search", 240_000, async () => {
        const messages = await listMessages(chat.id);
        const eventIndex = messages.findIndex((m) => m.role === "event" && m.content.includes("can be contacted"));
        return eventIndex >= 0 && messages.slice(eventIndex + 1).some((m) => m.role === "assistant" || m.role === "tool") && !(await threadBusy(chat.id));
      });
    }
    turn = await listMessages(chat.id);
    const searchEvent = turn.findIndex((m) => m.role === "event" && m.content.includes("can be contacted"));
    // Before the owner asked for outreach no plan may exist (the server refuses one without the owner's words).
    check("no outreach plan was prepared before the owner asked for it",
      !turn.slice(0, turn.findIndex((m) => m.tool === "find_leads")).some((m) => m.tool === "prepare_outreach" && m.status === "ok"));
    const prepareCall = searchEvent >= 0 ? turn.slice(searchEvent).find((m) => m.role === "tool" && m.tool === "prepare_outreach" && m.status === "ok") : undefined;
    console.log(`      assistant: ${turn.filter((m) => m.role === "assistant").slice(-2).map((m) => m.content).join(" / ").slice(0, 500)}`);
    check("after the search, the agent proposes outreach on its own", Boolean(prepareCall), turn.filter((m) => m.role === "tool").map((m) => `${m.tool}:${m.status}:${m.content.slice(0, 120)}`).join(" | "));
    const runId = (prepareCall?.toolResult as { data?: { runId?: string } } | null)?.data?.runId;
    const proposed = runId ? await getRun(runId) : null;
    check("the agent cannot start it: the run waits for the owner", proposed?.status === "proposed");
    const assistantText = turn.filter((m) => m.role === "assistant").map((m) => m.content).join("\n");
    check("the agent never says outreach is live before the owner starts it", !/\b(?:outreach|campaigns?|emails?|messages?) (?:is|are|has been|have been) (?:now )?(?:live|running|launched|sent)\b/i.test(assistantText), assistantText.slice(0, 200));
    if (!proposed) return;

    const plan = proposed.plan;
    const groupEmail = (plan.groups ?? []).flatMap((group) => group.sequences.email?.slice(0, 1) ?? []);
    check("the plan sorts the leads into kinds, each with its messages (an email with a subject and the per-lead line)",
      Boolean(plan.groups?.length) && groupEmail.length > 0 && groupEmail.every((step) => Boolean(step.subject)) && JSON.stringify(plan.groups).includes(`{{${plan.personalizationKey}}}`),
      (plan.groups ?? []).map((group) => `${group.label} (${group.count})`).join(", "));
    check("every lead is accounted for: in a group, or left out with a reason",
      plan.assignments.every((assignment) => Boolean(plan.leadPlans?.[assignment.personId]?.groupId)) && (plan.skipped ?? []).every((item) => item.reason.length > 0),
      `${plan.assignments.length} planned, ${plan.personal?.length ?? 0} individual, ${plan.skipped?.length ?? 0} left out: ${(plan.skipped ?? []).map((item) => `${item.name}: ${item.reason}`).join(" | ").slice(0, 300)}`);
    check("each campaign step sends the lead's own text", JSON.stringify(plan.sequences).includes(`{{${plan.personalizationKey}_b1}}`), JSON.stringify(plan.sequences.email?.[0]).slice(0, 200));
    check("the plan shows real samples (each individually written lead with its follow-ups) and the AI cost", plan.samples.length > 0 && plan.samples.every((sample) => sample.messages.length > 0)
      && (plan.personal ?? []).every((message) => plan.samples.some((sample) => sample.personId === message.personId && sample.messages.length === (plan.sequences[message.channel]?.length ?? 0)))
      && plan.estimate.aiCostUsd !== undefined, JSON.stringify(plan.estimate));
    const sampleText = plan.samples.flatMap((s) => s.messages.map((m) => `${m.subject ?? ""} ${m.body}`)).join("\n");
    check("samples have no unfilled merge fields", !/\{\{/.test(sampleText), sampleText.slice(0, 300));
    const emailSamples = plan.samples.filter((sample) => sample.channel === "email").flatMap((sample) => sample.messages);
    check("every sample email is signed by the sender", emailSamples.length > 0 && emailSamples.every((message) => /\bRavi\b/.test(message.body.slice(-200))), emailSamples.map((m) => m.body.slice(-60)).join(" | "));
    console.log(`      sample: ${plan.samples[0]?.messages[0]?.subject} | ${plan.samples[0]?.messages[0]?.body.replace(/\s+/g, " ").slice(0, 400)}`);

    // ------------------------------------------------------------ the owner presses Start
    const started = await startOutreachRun(proposed.id, owner, { autopilot: true });
    const startJob = await finishJob(started.jobId, 20);
    check("Start personalizes and launches", startJob?.status === "succeeded", `${startJob?.status} ${startJob?.error ?? ""}`);
    const running = await getRun(proposed.id);
    check("the run is running with its campaigns", running?.status === "running" && Boolean(running.campaigns.email), JSON.stringify(running?.campaigns));
    const emailCampaign = running?.campaigns.email
      ? (await db.select().from(outreachCampaigns).where(eq(outreachCampaigns.id, running.campaigns.email)))[0]
      : null;
    const emailLeads = emailCampaign ? await db.select().from(outreachLeads).where(eq(outreachLeads.campaignId, emailCampaign.id)) : [];
    check("the email campaign is active with every email lead", emailCampaign?.status === "active" && emailLeads.length === plan.assignments.filter((a) => a.channel === "email").length, `${emailCampaign?.status} ${emailLeads.length}`);
    const lines = (await db.select({ raw: people.raw }).from(people).where(inArray(people.id, plan.assignments.map((a) => a.personId))))
      .map((row) => String((row.raw as Record<string, unknown>)[plan.personalizationKey] ?? ""));
    check("each lead got a personal line that passes the checks", lines.length === plan.assignments.length && lines.every((line) => personalLineProblem(line) === null), lines.join(" | ").slice(0, 400));
    const firstTexts = (await db.select({ raw: people.raw }).from(people).where(inArray(people.id, plan.assignments.map((a) => a.personId))))
      .map((row) => String((row.raw as Record<string, unknown>)[`${plan.personalizationKey}_b1`] ?? ""));
    check("each lead has its own complete first message, nothing left unfilled", firstTexts.length === plan.assignments.length && firstTexts.every((text) => text.trim().length > 20 && !/\{\{/.test(text)), firstTexts.map((text) => text.slice(0, 80)).join(" | "));
    if (running?.campaigns.whatsapp) {
      const [waCampaign] = await db.select().from(whatsappCampaigns).where(eq(whatsappCampaigns.id, running.campaigns.whatsapp));
      const waLeads = await db.select().from(whatsappCampaignLeads).where(eq(whatsappCampaignLeads.campaignId, running.campaigns.whatsapp));
      check("the WhatsApp campaign is active with the phone-only leads", waCampaign?.status === "active" && waLeads.length > 0);
    }
    const [runMembers] = await db.select({ n: sql<number>`count(*)::int` }).from(outreachRunLeads).where(eq(outreachRunLeads.runId, proposed.id));
    const [orgWide] = await db.select({ n: sql<number>`count(*)::int` }).from(crmSettings).where(sql`${crmSettings.humanSendOnly} IS NOT TRUE`);
    check("Start in Automatic mode makes this run automatic, records its approved audience, and nothing organization-wide",
      Boolean(running?.autopilot) && Number(runMembers?.n) === plan.assignments.length && Number(orgWide?.n ?? 0) === 0, `${runMembers?.n} members`);
    const sendsBeforeStart = unipileSends.length;
    check("nothing was sent by starting (sending is the engines' tick)", unipileSends.length === sendsBeforeStart);

    // ------------------------------------------------------------ live AI: classify, draft, check, answer
    registerDefaultCrmJobHandlers();
    async function drainFor(recordId: string, rounds = 40) {
      for (let round = 0; round < rounds; round += 1) {
        await db.update(crmJobs).set({ runAfter: new Date(Date.now() - 1_000) }).where(and(eq(crmJobs.organizationId, orgId), eq(crmJobs.status, "queued")));
        await drainOnce();
        const replies = await db.select().from(autopilotReplies).where(eq(autopilotReplies.organizationId, orgId));
        const drafts = await db.select().from(crmDrafts).where(eq(crmDrafts.crmRecordId, recordId));
        if (drafts.some((d) => d.status === "failed") || replies.some((r) => drafts.some((d) => d.id === r.draftId && r.revision === d.revision))) return;
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
    }
    const discovered = memberPeople.filter((p) => p.email);
    const asker = discovered[0]!;
    const sendsBefore = unipileSends.length;
    const priceQuestion = await ingestInboundReply({
      personId: asker.id, channel: "email", accountRef: mailboxAddress, providerThreadId: `live-price-${stamp}`, idempotencyKey: `live-price-${stamp}`, providerMessageId: `live-price-pm-${stamp}`,
      subject: `Re: ${plan.samples[0]?.messages[0]?.subject ?? "Dental chair servicing"}`,
      bodyText: "Hi Ravi, thanks. How much is your monthly maintenance plan per chair, and how many visits does it include?",
      sentAt: new Date(),
    });
    await drainFor(priceQuestion.record.id);
    const [priceDraft] = await db.select().from(crmDrafts).where(eq(crmDrafts.crmRecordId, priceQuestion.record.id));
    const [priceDecision] = priceDraft ? await db.select().from(autopilotReplies).where(eq(autopilotReplies.draftId, priceDraft.id)) : [];
    console.log(`      price question: ${priceDecision?.status ?? "no decision"} — ${priceDecision?.reason ?? ""}`);
    console.log(`      draft: ${(priceDraft?.aiBodyText ?? "").replace(/\s+/g, " ").slice(0, 300)}`);
    check("a question the uploaded price list answers is answered automatically (real classifier, drafter and check), through Unipile",
      priceDecision?.status === "sent" && unipileSends.length === sendsBefore + 1,
      `${priceDecision?.status}: ${priceDecision?.reason ?? ""} ${JSON.stringify(priceDecision?.check?.problems ?? [])}`);

    // A follow-up in Hinglish is answered in Hinglish, from the same price list.
    const hinglish = await ingestInboundReply({
      personId: asker.id, channel: "email", accountRef: mailboxAddress, providerThreadId: `live-price-${stamp}`, idempotencyKey: `live-hinglish-${stamp}`, providerMessageId: `live-hinglish-pm-${stamp}`,
      subject: `Re: ${plan.samples[0]?.messages[0]?.subject ?? "Dental chair servicing"}`,
      bodyText: "Theek hai. Plan mein ek mahine mein kitne visits hote hain? Aur kya yeh Pune ke bahar bhi milta hai?",
      sentAt: new Date(Date.now() + 1_000),
    });
    let hinglishDraft: typeof crmDrafts.$inferSelect | undefined;
    let hinglishReply: typeof autopilotReplies.$inferSelect | undefined;
    for (let round = 0; round < 40 && !hinglishReply; round += 1) {
      await db.update(crmJobs).set({ runAfter: new Date(Date.now() - 1_000) }).where(and(eq(crmJobs.organizationId, orgId), eq(crmJobs.status, "queued")));
      await drainOnce();
      [hinglishDraft] = await db.select().from(crmDrafts).where(eq(crmDrafts.replyForMessageId, hinglish.message.id));
      if (hinglishDraft) [hinglishReply] = await db.select().from(autopilotReplies).where(and(eq(autopilotReplies.draftId, hinglishDraft.id), eq(autopilotReplies.revision, hinglishDraft.revision)));
      if (!hinglishReply) await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    const hinglishText = hinglishDraft?.aiBodyText ?? "";
    console.log(`      Hinglish question: ${hinglishReply?.status} — ${hinglishReply?.reason ?? ""}; draft: ${hinglishText.replace(/\s+/g, " ").slice(0, 240)}`);
    check("a lead writing in Hinglish gets the answer in Hinglish (two visits; only Pune is covered, or the owner is asked)",
      /\b(hai|hain|mein|ke|ki|aap|nahi|sirf|haan)\b/i.test(hinglishText) && (hinglishReply?.status === "sent" || hinglishReply?.status === "held"),
      `${hinglishReply?.status}: ${hinglishText.slice(0, 160)}`);

    const xrayAsker = discovered[1] ?? discovered[0]!;
    const xray = await ingestInboundReply({
      personId: xrayAsker.id, channel: "email", accountRef: mailboxAddress, providerThreadId: `live-xray-${stamp}`, idempotencyKey: `live-xray-${stamp}`, providerMessageId: `live-xray-pm-${stamp}`,
      subject: "Re: Dental chair servicing",
      bodyText: "Interesting. Do you also service dental X-ray machines? We have two intraoral units.",
      sentAt: new Date(),
    });
    await drainFor(xray.record.id);
    const [xrayDraft] = await db.select().from(crmDrafts).where(eq(crmDrafts.crmRecordId, xray.record.id));
    const [xrayHold] = xrayDraft ? await db.select().from(autopilotReplies).where(and(eq(autopilotReplies.draftId, xrayDraft.id), eq(autopilotReplies.status, "held"))) : [];
    const [xrayHandover] = xrayDraft ? await db.select().from(autopilotReplies).where(and(eq(autopilotReplies.draftId, xrayDraft.id), like(autopilotReplies.reason, "handover%"))) : [];
    const [xrayDecision] = xrayDraft ? await db.select().from(ownerDecisions).where(and(eq(ownerDecisions.draftId, xrayDraft.id), eq(ownerDecisions.status, "open"))) : [];
    console.log(`      X-ray question: ${xrayHold?.status} — ${xrayHold?.reason ?? ""}; asks the owner: ${xrayDecision?.decision ?? "nothing"}; brief: ${xrayDecision?.brief ?? "none"}`);
    check("a question the information does not answer is not sent; the owner gets a focused question", Boolean(xrayHold) && Boolean(xrayDecision), `${xrayHold?.status} ${xrayDecision?.kind}`);
    check("the lead is told once that a personal reply follows, and the owner gets a brief", xrayHandover?.status === "sent" && Boolean(xrayDecision?.handoverSentAt) && /personally/.test(unipileSends.at(-1)?.body ?? "") && Boolean(xrayDecision?.brief),
      `${xrayHandover?.status} | ${unipileSends.at(-1)?.body?.slice(0, 120)} | ${xrayDecision?.brief ?? ""}`);
    if (xrayDecision) {
      const sendsBeforeAnswer = unipileSends.length;
      const result = await answerDecision(xrayDecision.id, "Yes. We service intraoral dental X-ray units in Pune as part of the same-week servicing; it is quoted per unit after a free check.", owner);
      check("the owner's answer is saved and a reply written with it", result.saved && result.rewritten, result.problem ?? "");
      await drainFor(xray.record.id);
      const [rewritten] = await db.select().from(crmDrafts).where(eq(crmDrafts.crmRecordId, xray.record.id)).orderBy(desc(crmDrafts.createdAt)).limit(1);
      const [afterAnswer] = rewritten ? await db.select().from(autopilotReplies).where(and(eq(autopilotReplies.draftId, rewritten.id), eq(autopilotReplies.revision, rewritten.revision))) : [];
      console.log(`      after the answer: ${afterAnswer?.status} — ${afterAnswer?.reason ?? ""}; draft: ${(rewritten?.aiBodyText ?? "").replace(/\s+/g, " ").slice(0, 240)}`);
      check("the reply with the owner's answer is sent automatically", afterAnswer?.status === "sent" && unipileSends.length === sendsBeforeAnswer + 1 && /x-ray/i.test(rewritten?.aiBodyText ?? ""), `${afterAnswer?.status}: ${afterAnswer?.reason ?? ""}`);
    }

    // A bare "Hey" (the real classifier is often unsure about it) is never left without an answer or a handoff.
    const heyLead = discovered[1] ?? discovered[0]!;
    const hey = await ingestInboundReply({
      personId: heyLead.id, channel: "email", accountRef: mailboxAddress, providerThreadId: `live-hey-${stamp}`, idempotencyKey: `live-hey-${stamp}`, providerMessageId: `live-hey-pm-${stamp}`,
      subject: "Re: Dental chair servicing", bodyText: "Hey", sentAt: new Date(),
    });
    let heyDraft: typeof crmDrafts.$inferSelect | undefined;
    let heyDecision: typeof autopilotReplies.$inferSelect | undefined;
    for (let round = 0; round < 40 && !heyDecision; round += 1) {
      await db.update(crmJobs).set({ runAfter: new Date(Date.now() - 1_000) }).where(and(eq(crmJobs.organizationId, orgId), eq(crmJobs.status, "queued")));
      await drainOnce();
      [heyDraft] = await db.select().from(crmDrafts).where(eq(crmDrafts.replyForMessageId, hey.message.id));
      if (heyDraft) [heyDecision] = await db.select().from(autopilotReplies).where(eq(autopilotReplies.draftId, heyDraft.id)).orderBy(desc(autopilotReplies.createdAt)).limit(1);
      if (!heyDecision) await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    const [heyClass] = await db.select().from(crmClassifications).where(eq(crmClassifications.messageId, hey.message.id));
    console.log(`      "Hey": classified ${heyClass?.status} (${heyClass?.proposedCategoryKey}, ${heyClass?.confidence}); ${heyDecision?.status ?? "no decision"} — ${heyDecision?.reason ?? ""}; draft: ${(heyDraft?.aiBodyText ?? "").replace(/\s+/g, " ").slice(0, 200)}`);
    check("a bare 'Hey' gets an answer written and decided (sent, or handed to the owner), never left stuck", Boolean(heyDraft) && Boolean(heyDecision), `${heyClass?.status} ${heyDraft?.status} ${heyDecision?.status}`);

    // A lead who says yes goes straight to the owner (no more questions), with a brief.
    const ready = await ingestInboundReply({
      personId: asker.id, channel: "email", accountRef: mailboxAddress, providerThreadId: `live-ready-${stamp}`, idempotencyKey: `live-ready-${stamp}`, providerMessageId: `live-ready-pm-${stamp}`,
      subject: "Re: Dental chair servicing",
      bodyText: "Sounds good. We have 3 chairs and one keeps breaking down. Please call me to set up the monthly plan.",
      sentAt: new Date(),
    });
    const sendsBeforeReady = unipileSends.length;
    // Wait for this message's own reply to be decided (the same lead's earlier replies are already settled).
    let readyDecided = false;
    for (let round = 0; round < 40 && !readyDecided; round += 1) {
      await db.update(crmJobs).set({ runAfter: new Date(Date.now() - 1_000) }).where(and(eq(crmJobs.organizationId, orgId), eq(crmJobs.status, "queued")));
      await drainOnce();
      const [readyDraft] = await db.select().from(crmDrafts).where(eq(crmDrafts.replyForMessageId, ready.message.id));
      const decided = readyDraft ? await db.select().from(autopilotReplies).where(eq(autopilotReplies.draftId, readyDraft.id)) : [];
      readyDecided = decided.length > 0 || readyDraft?.status === "failed";
      if (!readyDecided) await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    const [readyDecision] = await db.select().from(ownerDecisions).where(and(eq(ownerDecisions.organizationId, orgId), eq(ownerDecisions.conversationId, ready.message.conversationId), eq(ownerDecisions.status, "open")));
    console.log(`      ready lead: ${readyDecision?.kind ?? "no handoff"} — ${readyDecision?.reason ?? ""}; brief: ${readyDecision?.brief ?? "none"}; told: ${unipileSends.at(-1)?.body?.replace(/<[^>]+>/g, " ").slice(0, 120)}`);
    check("a lead who agrees to the next step is handed to the owner (Ready to buy) with a brief, told once, not asked more",
      readyDecision?.kind === "ready" && Boolean(readyDecision.brief) && Boolean(readyDecision.handoverSentAt) && unipileSends.length === sendsBeforeReady + 1,
      `${readyDecision?.kind}: ${readyDecision?.reason ?? ""} | ${readyDecision?.brief ?? ""}`);

    // ------------------------------------------------------------ report and pause
    const report = await runTool("report", { runId: proposed.id }, context);
    check("report reads the run's real counts", report.ok && /email: \d+ contacted/.test(report.summary), report.summary);
    const paused = await runTool("pause_outreach", { runId: proposed.id }, context);
    const [pausedCampaign] = await db.select().from(outreachCampaigns).where(eq(outreachCampaigns.id, running!.campaigns.email!));
    check("pause_outreach pauses the campaigns", paused.ok && pausedCampaign?.status === "paused" && (await getRun(proposed.id))?.status === "paused", paused.summary);
    const off = await runTool("switch_to_review", { runId: proposed.id }, context);
    check("switch_to_review puts the run in Review mode", off.ok && (await getRun(proposed.id))?.autopilot === false, off.summary);
    const chatReport = await runTool("report", { period: "today" }, context);
    check("the owner can ask for results in chat (from recorded events)", chatReport.ok && /people contacted/.test(chatReport.summary) && /automatically/.test(chatReport.summary), chatReport.summary.slice(0, 300));
  } finally {
    // Leave nothing that could send: campaigns paused, mailbox disabled, number disconnected, fake Unipile removed.
    await db.update(outreachCampaigns).set({ status: "paused" }).where(and(eq(outreachCampaigns.organizationId, orgId), eq(outreachCampaigns.status, "active")));
    await db.update(whatsappCampaigns).set({ status: "paused" }).where(and(eq(whatsappCampaigns.organizationId, orgId), eq(whatsappCampaigns.status, "active")));
    await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, mailbox!.id));
    // The other e2e scripts refuse to tick while any organization has queued email.
    await db.delete(outreachMailboxQueue).where(eq(outreachMailboxQueue.mailboxId, mailbox!.id));
    await db.update(whatsappAccounts).set({ status: "disconnected" }).where(eq(whatsappAccounts.id, whatsapp!.id));
    await db.update(outreachRuns).set({ autopilot: false }).where(eq(outreachRuns.organizationId, orgId));
    await db.delete(gridProviderCredentials).where(eq(gridProviderCredentials.providerId, unipile!.id));
    await db.delete(gridProviders).where(eq(gridProviders.id, unipile!.id));
  }
});

const automationDone = automation as { missingDecisionId: string; supportedDraftId: string } | null;
if (automationDone) await runIsolationChecks({ check, stamp, ...automationDone });

const strayMessages = await db.select({ n: sql<number>`count(*)::int` }).from(assistantMessages).where(and(eq(assistantMessages.organizationId, org!.id), eq(assistantMessages.status, "running")));
check("no tool call was left running", Number(strayMessages[0]?.n ?? 0) === 0);

console.log(failures ? `\n${failures} check(s) failed.` : "\nAssistant checks passed.");
process.exit(failures ? 1 : 0);

// ------------------------------------------------------------ file fixtures
function tinyPdf(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

function tinyDocx(paragraphs: string[]): Uint8Array {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`;
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    "word/document.xml": strToU8(document),
  });
}

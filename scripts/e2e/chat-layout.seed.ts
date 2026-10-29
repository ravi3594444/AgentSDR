export {};
/**
 * A long owner request in the assistant chat, for the layout screenshots in
 * docs/plans/chat-layout-2026-10-28/: several searches through different
 * transports (the Maps scraper, Tavily, Apify, LinkedIn through Unipile,
 * TinyFish, Bright Data), one between polls of its provider run, one waiting
 * for an Apify slot, one retrying, report events, retry notices, tool cards
 * and a prepared outreach plan, with the request's default (unnamed) target.
 * The paired Chrome is connected but no search used it.
 *
 *   bun run --conditions=react-server scripts/e2e/chat-layout.seed.ts <out.json>
 *
 * Only for a disposable local database (agentsdr_chatlayout); nothing here
 * runs a provider. Run the app with ASSISTANT_WORKER_POLL_MS high so the
 * worker does not claim the seeded jobs while the pages are captured.
 */
if (!/^postgres(?:ql)?:\/\/[^/]+@(localhost|127\.0\.0\.1):\d+\/agentsdr_chatlayout$/.test(process.env.DATABASE_URL ?? "")) throw new Error("Requires the disposable agentsdr_chatlayout database");
const out = process.argv[2];
if (!out) throw new Error("Usage: chat-layout.seed.ts <out.json>");

const { hashPassword } = await import("better-auth/crypto");
const { randomUUID } = await import("node:crypto");
const { writeFileSync } = await import("node:fs");
const { db } = await import("@/lib/db");
const { users, accounts, organizations, members } = await import("@/lib/auth/schema");
const { assistantThreads, assistantMessages, assistantJobs, assistantObjectives, leadAudiences, leadAudienceMembers, outreachRuns } = await import("@/lib/assistant/schema");
const { browserConnections } = await import("@/lib/browser/connected/schema");

const stamp = Date.now();
const now = new Date();
const at = (minutesFromNow: number) => new Date(now.getTime() + minutesFromNow * 60_000);
const email = `chat-layout-${stamp}@example.test`;
const password = "Local-chat-layout-only-123!";

const [user] = await db.insert(users).values({ name: "Ravi Kumar", email, emailVerified: true }).returning();
const [org] = await db.insert(organizations).values({ name: "BrightSMS", slug: `chat-layout-${stamp}` }).returning();
const organizationId = org!.id;
await db.insert(members).values({ organizationId, userId: user!.id, role: "owner" });
await db.insert(accounts).values({ userId: user!.id, accountId: user!.id, providerId: "credential", password: await hashPassword(password) });
// Paired and online, but no search below used it.
await db.insert(browserConnections).values({ organizationId, userId: user!.id, status: "active", tokenHash: randomUUID(), deviceId: randomUUID(), deviceLabel: "Chrome on MacBook", extensionVersion: "0.17.0", sites: ["web", "linkedin"], lastSeenAt: at(120), pairedAt: at(-120) });

const [thread] = await db.insert(assistantThreads).values({ organizationId, title: "Dental clinics in Austin", createdBy: user!.id }).returning();
const threadId = thread!.id;
let clock = -55;
const tick = (minutes = 1) => at((clock += minutes));
const say = async (row: Omit<typeof assistantMessages.$inferInsert, "organizationId" | "threadId">, minutes = 1) =>
  (await db.insert(assistantMessages).values({ organizationId, threadId, createdAt: tick(minutes), ...row }).returning())[0]!;

// An earlier, finished turn.
await say({ role: "user", content: "We are BrightSMS: appointment reminder texts for dental and medical clinics, $49 a month per location. Save that.", createdBy: user!.id });
await say({ role: "tool", tool: "save_business_info", status: "ok", content: "Saved business information: BrightSMS, appointment reminder texts for clinics, $49/month per location.", toolResult: { display: "Saved business information: BrightSMS, appointment reminder texts for clinics, $49/month per location." } });
await say({ role: "assistant", content: "Saved. I'll describe BrightSMS as appointment reminder texts for dental and medical clinics at $49 a month per location." });

// The long request.
const request = await say({ role: "user", content: "Find dental clinics in Austin, TX that could use automated appointment reminders, and get an email outreach plan ready for the good ones.", createdBy: user!.id }, 3);
const requestId = request.id;

async function audience(name: string, criteria: Record<string, unknown>, counts: { found: number; eligible: number; match: number }) {
  const [row] = await db.insert(leadAudiences).values({ organizationId, threadId, name, source: "discovery", criteria: { ...criteria, requestId }, createdBy: user!.id }).returning();
  const rows = Array.from({ length: counts.found }, (_, index) => {
    const eligible = index < counts.eligible;
    const fit = !eligible ? null : index < counts.match ? "match" as const : "no_match" as const;
    return {
      organizationId, audienceId: row!.id, name: `${name} lead ${index + 1}`, status: eligible ? "eligible" as const : "excluded" as const,
      reason: eligible ? null : "no email or phone found", channels: eligible ? ["email" as const] : [], source: "google_maps",
      fit, fitReason: fit === "no_match" ? "a dental supply shop, not a clinic" : fit === "match" ? "independent clinic taking appointments" : null,
      fitRequestId: fit ? requestId : null, fitAt: fit ? now : null,
    };
  });
  if (rows.length) await db.insert(leadAudienceMembers).values(rows);
  return row!.id;
}

const base = { organizationId, threadId, createdBy: user!.id };
const fit = (found: number, contactable: number, qualified: number) => ({ found, contactable, qualified, notMatching: contactable - qualified, unconfirmed: 0, pending: 0, pendingMembers: 0, noMatchReasons: [] });

const mapsList = await audience("Dental clinics in Austin, TX (Google Maps)", { source: "google_maps", what: "dental clinics", where: "Austin, TX" }, { found: 48, eligible: 31, match: 19 });
const [maps] = await db.insert(assistantJobs).values({
  ...base, kind: "discovery", status: "succeeded", stage: "done", audienceId: mapsList, createdAt: tick(1), finishedAt: tick(6),
  payload: { requestMessageId: requestId, phrase: "dental clinics in Austin, TX", provider: "scraper", target: "maps" },
  progress: { stage: "done", source: "Google Maps through the built-in scraper" },
  result: { audienceId: mapsList, phrase: "dental clinics in Austin, TX", found: 48, eligible: 31, withEmail: 24, withPhoneOnly: 7, excluded: 17, duplicates: 2, provider: "scraper", fit: fit(48, 31, 19) },
}).returning();
const webList = await audience("Dental clinics in Austin, TX (web)", { source: "website" }, { found: 22, eligible: 12, match: 5 });
const [web] = await db.insert(assistantJobs).values({
  ...base, kind: "web_discovery", status: "succeeded", stage: "done", audienceId: webList, createdAt: at(clock - 5), finishedAt: tick(2),
  payload: { requestMessageId: requestId, phrase: "dental clinics in Austin, TX", searchProvider: "tavily" },
  progress: { stage: "done" },
  result: { audienceId: webList, phrase: "dental clinics in Austin, TX", found: 22, eligible: 12, withEmail: 10, withPhoneOnly: 2, withInstagram: 3, excluded: 10, searches: [{ query: "dental clinic Austin TX", provider: "tavily", sources: 9, error: null }, { query: "family dentist Austin appointments", provider: "tavily", sources: 8, error: null }], fit: fit(22, 12, 5) },
}).returning();

// Started later in the turn, still open.
const linkedinList = await audience("Dental practice managers in Austin (LinkedIn)", { source: "linkedin" }, { found: 0, eligible: 0, match: 0 });
const facebookList = await audience("Dental clinics in Austin (Facebook pages)", { source: "facebook" }, { found: 0, eligible: 0, match: 0 });
const instagramList = await audience("Instagram: dental clinics — Austin", { source: "apify_instagram" }, { found: 0, eligible: 0, match: 0 });
const roundRockList = await audience("Dental practices in Round Rock, TX (web)", { source: "website" }, { found: 0, eligible: 0, match: 0 });
const redditList = await audience("Reddit: Austin dentists asking about no-shows", { source: "social" }, { found: 0, eligible: 0, match: 0 });
const [linkedin] = await db.insert(assistantJobs).values({
  ...base, kind: "linkedin_search", status: "running", stage: "searching", audienceId: linkedinList, createdAt: at(-14), heartbeatAt: now, attempts: 1,
  payload: { requestMessageId: requestId, keywords: "dental practice manager Austin" }, progress: { stage: "searching", found: 37, total: 120 },
}).returning();
const [facebook] = await db.insert(assistantJobs).values({
  ...base, kind: "discovery", status: "queued", stage: "apify", audienceId: facebookList, createdAt: at(-13), runAfter: at(1), externalId: "apify-run-fixture",
  payload: { requestMessageId: requestId, phrase: "dental clinics in Austin, TX", provider: "apify", target: "facebook" },
  progress: { stage: "searching", provider: "Apify", actor: "Facebook pages scraper", source: "Facebook pages through Apify", startedSearchAt: at(-12).toISOString() },
}).returning();
const [instagram] = await db.insert(assistantJobs).values({
  ...base, kind: "apify_instagram", status: "queued", stage: "queued", audienceId: instagramList, createdAt: at(-13), runAfter: at(1),
  payload: { requestMessageId: requestId, phrase: "#austindentist #atxdentist", provider: "apify", target: "instagram" },
  progress: { stage: "queued", found: 0, source: "Instagram through Apify", waiting: { kind: "slot", provider: "apify", reason: "both of your Apify runs are in use; it starts when one finishes", since: at(-12).toISOString() } },
}).returning();
const [roundRock] = await db.insert(assistantJobs).values({
  ...base, kind: "web_discovery", status: "queued", stage: "searching", audienceId: roundRockList, createdAt: at(-12), runAfter: at(0.5), attempts: 2,
  payload: { requestMessageId: requestId, phrase: "dental practices in Round Rock, TX", searchProvider: "tinyfish" },
  progress: { stage: "searching", searches: 4, searchesDone: 1, candidates: 6, lastError: "TinyFish answered 503 Service Unavailable" },
}).returning();
const [reddit] = await db.insert(assistantJobs).values({
  ...base, kind: "social_research", status: "running", stage: "reading", audienceId: redditList, createdAt: at(-11), heartbeatAt: now, attempts: 1,
  payload: { requestMessageId: requestId, phrase: "Austin dentists asking about no-shows" },
  progress: { stage: "reading", found: 14, read: 12, websites: 30, sources: [{ platform: "reddit", state: "searched", found: 14, credits: 3 }], credits: 3 },
}).returning();

const [objective] = await db.insert(assistantObjectives).values({
  organizationId, threadId, requestMessageId: requestId, leadTarget: 25, timeLimitMinutes: 240, deadlineAt: at(185), spendCapUsd: null,
  controls: { named: { target: false, time: false, spend: false } }, status: "active", progress: { waiting: "5 searches still running" }, nextEligibleAt: at(1), createdBy: user!.id, createdAt: request.createdAt,
}).returning();
await db.insert(assistantJobs).values({
  ...base, kind: "objective", status: "queued", stage: "watching", createdAt: request.createdAt, runAfter: at(1),
  payload: { objectiveId: objective!.id, requestMessageId: requestId },
  progress: { stage: "watching", leads: 24, leadTarget: 25, waiting: { kind: "objective", reason: "5 searches still running" } },
});

const brief = "Brief: Goal: dental clinics in Austin, TX that take appointments and could use automated reminder texts; prepare an email plan for the ones that fit. No lead number named; no budget named.";
await say({ role: "tool", tool: "set_brief", status: "ok", content: brief, toolResult: { display: brief, summary: brief } }, 0.2);
await say({ role: "tool", tool: "check_setup", status: "ok", content: "Connected: AI provider, email (2 mailboxes), WhatsApp (1 number), Apify, Tavily, TinyFish, Bright Data. Your Chrome is connected (Other public websites, LinkedIn).", toolResult: { display: "Connected: AI provider, email (2 mailboxes), WhatsApp (1 number), Apify, Tavily, TinyFish, Bright Data. Your Chrome is connected (Other public websites, LinkedIn)." } }, 0.2);
await say({ role: "assistant", content: "I'm starting with Google Maps and a web search for dental clinics in Austin, then I'll check each clinic against your request." }, 0.2);
await say({ role: "tool", tool: "find_leads", status: "ok", toolInput: { what: "dental clinics", where: "Austin, TX" }, content: "Started a Google Maps search for dental clinics in Austin, TX.", toolResult: { display: "Started a Google Maps search for dental clinics in Austin, TX. It runs in the background.", data: { jobId: maps!.id, phrase: "dental clinics in Austin, TX" } } }, 0.2);
await say({ role: "tool", tool: "find_customers_on_web", status: "ok", toolInput: { customers: "dental clinics", where: "Austin, TX" }, content: "Started a web search for dental clinics in Austin, TX.", toolResult: { display: "Started a web search for dental clinics in Austin, TX (websites and directories).", data: { jobId: web!.id, phrase: "dental clinics in Austin, TX" } } }, 0.2);
await say({ role: "assistant", content: "Both searches are running in the background. I'll tell you when they finish." }, 0.2);
await say({ role: "event", content: "Retrying: the AI model's answer was incomplete, so I asked it again (attempt 2 of 3).", toolResult: { transient: true } }, 1);
await say({ role: "event", content: "The lead search for “dental clinics in Austin, TX” finished: 48 businesses found on Google Maps through the built-in scraper, 31 can be contacted (24 by email, 7 by phone only); 17 left out with the reason recorded, 2 duplicates skipped. Judged against your request: 19 match, 12 do not.", toolResult: { reportKey: `job:${maps!.id}:succeeded`, data: { event: { kind: "search_report", jobId: maps!.id, ok: true, source: "Google Maps through the built-in scraper", found: 48, contactable: 31, matching: 19, judged: 31, error: null } } } }, 3);
await say({ role: "event", content: "The web search for “dental clinics in Austin, TX” finished: 22 found on business websites, directories and public pages, 12 can be contacted (10 by email, 2 by phone only, 3 with Instagram profiles); 10 left out with the reason recorded. Judged against your request: 5 match, 7 do not.", toolResult: { reportKey: `job:${web!.id}:succeeded`, data: { event: { kind: "search_report", jobId: web!.id, ok: true, source: "websites and directories", found: 22, contactable: 12, matching: 5, judged: 12, error: null } } } }, 2);
await say({ role: "event", content: "Your request has 24 matching leads (step 1). Searches: Google Maps 48 found, 31 contactable, 19 match; web 22 found, 12 contactable, 5 match. $0.42 spent, 3 h 10 min left. Choose the next source.", toolResult: { objectiveNote: `${objective!.id}:1`, objectiveId: objective!.id, data: { event: { kind: "continuation", n: 1, leads: 24, target: null, spentUsd: 0.42, capUsd: null, minutesLeft: 190 } } } }, 0.5);
await say({ role: "assistant", content: "Google Maps and the web search are done: 24 clinics match so far. I'm adding LinkedIn, Facebook pages, Instagram, Round Rock and Reddit to find more." }, 0.5);
await say({ role: "tool", tool: "find_linkedin_leads", status: "ok", toolInput: { role: "dental practice manager", where: "Austin, TX" }, content: "Started a LinkedIn search.", toolResult: { display: "Started a LinkedIn people search for “dental practice manager Austin”.", data: { jobId: linkedin!.id, keywords: "dental practice manager Austin" } } }, 0.2);
await say({ role: "tool", tool: "find_social_leads", status: "ok", toolInput: { platform: "facebook", what: "dental clinics", where: "Austin, TX" }, content: "Started a Facebook pages search through Apify.", toolResult: { display: "Started a Facebook pages search through Apify.", data: { jobId: facebook!.id, phrase: "dental clinics in Austin, TX" } } }, 0.2);
await say({ role: "tool", tool: "find_instagram_prospects", status: "ok", toolInput: { what: "dental clinics", where: "Austin" }, content: "Started an Instagram search through Apify.", toolResult: { display: "Started an Instagram search through Apify (#austindentist #atxdentist).", data: { jobId: instagram!.id, phrase: "#austindentist #atxdentist" } } }, 0.2);
await say({ role: "tool", tool: "find_customers_on_web", status: "ok", toolInput: { customers: "dental practices", where: "Round Rock, TX" }, content: "Started a web search for dental practices in Round Rock, TX.", toolResult: { display: "Started a web search for dental practices in Round Rock, TX.", data: { jobId: roundRock!.id, phrase: "dental practices in Round Rock, TX" } } }, 0.2);
await say({ role: "tool", tool: "research_social_sources", status: "ok", toolInput: { platforms: ["reddit"], customers: "Austin dentists" }, content: "Started social research on Reddit through Bright Data.", toolResult: { display: "Started social research on Reddit through Bright Data.", data: { jobId: reddit!.id, phrase: "Austin dentists asking about no-shows" } } }, 0.2);
await say({ role: "tool", tool: "web_search", status: "ok", content: "Searched the web: “Austin dental association member directory” — 6 results.", toolResult: { display: "Searched the web: “Austin dental association member directory” — 6 results (capitalareadental.org, atxdentists.com, …)." } }, 0.3);
await say({ role: "tool", tool: "exa_search", status: "ok", content: "8 results for “independent dental practice Austin appointment reminders”.", toolResult: { display: "8 results for “independent dental practice Austin appointment reminders”: smilesofaustin.com, eastaustindental.com, …" } }, 0.3);
await say({ role: "tool", tool: "browser_connection", status: "ok", content: "Your Chrome is connected (Chrome on MacBook): Other public websites, LinkedIn.", toolResult: { display: "Your Chrome is connected (Chrome on MacBook): Other public websites, LinkedIn." } }, 0.3);
await say({ role: "event", content: "The AI model could not be reached just now, so I stopped here. Done so far: Started a LinkedIn people search; Started a Facebook pages search through Apify; Started an Instagram search through Apify; Started a web search for dental practices in Round Rock, TX. Press Retry to continue the same request: what is done is kept and will not be repeated.", toolResult: { data: { retry: true } } }, 0.5);
await say({ role: "assistant", content: "Picking up where I stopped. LinkedIn, Facebook, Instagram, Round Rock and Reddit are still running; I'll review the 24 matches now." }, 2);
await say({ role: "tool", tool: "review_leads", status: "ok", content: "Reviewed 24 matching leads: 19 independent clinics, 5 group practices; all take appointments online or by phone.", toolResult: { display: "Reviewed 24 matching leads: 19 independent clinics, 5 group practices; all take appointments online or by phone." } }, 0.5);

const planList = (await db.insert(leadAudiences).values({ organizationId, threadId, name: "Dental clinics in Austin — plan", source: "list", criteria: { requestId, fromRequest: true }, createdBy: user!.id }).returning())[0]!.id;
const assignments = Array.from({ length: 24 }, (_, index) => ({ personId: randomUUID(), channel: index < 21 ? "email" as const : "whatsapp" as const }));
const plan = {
  assignments,
  sequences: { email: [{ subject: "Fewer no-shows at {{company}}", body: "Hi {{firstName}}, …", waitDays: 0 }] },
  personalizationKey: "p_fixture",
  instructions: null,
  samples: [
    { personId: assignments[0]!.personId, name: "Smiles of Austin", channel: "email" as const, messages: [{ subject: "Fewer no-shows at Smiles of Austin", body: "Hi Dr. Patel,\n\nI saw Smiles of Austin books cleanings online. BrightSMS sends automatic reminder texts before each appointment, which usually cuts no-shows noticeably, for $49 a month per location.\n\nWould a 10-minute call next week be useful?\n\nRavi, BrightSMS" }, { subject: "Re: Fewer no-shows at Smiles of Austin", body: "Hi Dr. Patel, just checking whether reminder texts would help your front desk. Happy to send a short example.\n\nRavi" }], why: "Independent clinic with online booking", observed: [{ text: "Book your cleaning online in 2 minutes", sourceUrl: "https://smilesofaustin.example/book", relevance: "they take bookings online", need: false }] },
    { personId: assignments[1]!.personId, name: "East Austin Family Dental", channel: "email" as const, messages: [{ subject: "Appointment reminders for East Austin Family Dental", body: "Hi team,\n\nBrightSMS texts your patients a reminder before each visit, for $49 a month per location. Would it help to see how it works?\n\nRavi, BrightSMS" }], why: "Family practice, three dentists" },
  ],
  limits: { maxLeads: 24, emailPerMailboxPerDay: 40, whatsappNewChatsPerDay: 25 },
  excluded: [{ reason: "already in another running plan", count: 0 }].filter((item) => item.count > 0),
  estimate: { aiCalls: 30, aiCostUsd: 0.12, days: 3 },
  autopilot: false,
  ownerRequest: request.content,
  requestId,
};
const [run] = await db.insert(outreachRuns).values({ organizationId, threadId, audienceId: planList, name: "Dental clinics in Austin", status: "proposed", channels: ["email", "whatsapp"], plan, createdBy: user!.id }).returning();
await say({ role: "tool", tool: "prepare_outreach", status: "ok", content: "Prepared an outreach plan for 24 leads.", toolResult: { display: "Prepared an outreach plan for 24 leads: email 21, WhatsApp 3.", data: { runId: run!.id, name: "Dental clinics in Austin", audience: { name: "Dental clinics in Austin — plan", eligible: 24, total: 24 }, plan } } }, 0.5);
await say({ role: "event", content: "The outreach plan “Dental clinics in Austin” is ready: 24 leads (Email 21, WhatsApp 3). Nothing is sent before you press Start.", toolResult: { data: { event: { kind: "plan_ready", runId: run!.id, leads: 24, channels: { email: 21, whatsapp: 3 }, waitingReason: null } } } }, 0.2);
await say({ role: "assistant", content: "Your plan for 24 dental clinics is ready below. Nothing is sent until you press Start.\n\nLinkedIn, Facebook, Instagram, Round Rock and Reddit are still running; I'll add any new matches to a second plan for you to approve.", toolResult: { suggestions: ["Show me the 24 clinics", "Start in Review mode"] } }, 0.3);

writeFileSync(out, JSON.stringify({ email, password, organizationId, userId: user!.id, threadId, requestId, runId: run!.id }));
console.log(`Seeded ${email} with thread ${threadId}`);
process.exit(0);

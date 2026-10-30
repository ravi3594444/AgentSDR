/**
 * Browser outreach against a real database, through the real bridge routes,
 * the plan, Start, the courier and the CRM, with a stand-in extension that
 * plays X / LinkedIn pages and a scripted model:
 *
 * - who the browser reaches, and the owner's words choosing it ("using my
 *   browser", "on X");
 * - Start queues the first messages and their follow-ups, never Do Not Contact;
 * - Chrome offline is a wait with its reason, not a send;
 * - a delivery opens the profile, opens a message, types the approved text,
 *   sends once with the account confirmed, and is "sent" only when the page
 *   shows it; the first touch counts toward the daily lead limit;
 * - pacing between sends; a profile that cannot be messaged blocks with the
 *   site's words and gives its lead place back; a lost Send answer is
 *   uncertain and never resent;
 * - a reply read from the conversation reaches the CRM (with the browser
 *   history) and stops the follow-ups; a reply goes back through the browser;
 * - Stop cancels what has not gone out.
 *
 * Fixtures: the pages are the stand-in's own; nobody is messaged anywhere.
 * scripts/e2e/browser-outreach.live.ts drives the real extension.
 *
 *   DATABASE_URL=postgres://…@127.0.0.1:<port>/agentsdr_native \
 *     bun run --conditions=react-server scripts/e2e/browser-outreach.ts
 */
import { mock } from "bun:test";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

if (!/^postgres(?:ql)?:\/\/[^/]+@(localhost|127\.0\.0\.1):\d+\/agentsdr_native$/.test(process.env.DATABASE_URL ?? "")) throw new Error("Requires the disposable local agentsdr_native database");
process.env.GEOCODER_URL = "off";
const root = resolve(import.meta.dir, "../..");
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error(`External network refused: ${url.hostname}`);
  return realFetch(input, init);
}) as typeof fetch;

const stamp = randomUUID().slice(0, 8);
const BODY = "Hi there, saw your post about onboarding new customers. Would a 10-minute look at how we halve setup time help?";
const FOLLOW_UP = "Just checking whether shorter onboarding would help this quarter.";
const REPLY = "Thanks! Tuesday works for a quick call.";
const OWNER_X = "@owner_x";

type Input = { schemaName: string; userPrompt: string; accept: (text: string) => void };
const leadsAsked = (prompt: string) => [...prompt.matchAll(/^(\d+)(?: \([^)]*\))?: \{.*\}$/gm)].map((match) => Number(match[1]));
const channelsAsked = (prompt: string) => (prompt.match(/^Write the messages for: (.+)\.$/m)?.[1] ?? "").split(",").map((channel) => channel.trim()).filter(Boolean);

/** The scripted courier: reads the page it is shown and takes the obvious next step. */
function courierStep(prompt: string): Record<string, unknown> {
  const page = prompt.split("THE PAGE NOW:")[1] ?? "";
  const message = /<<<\n([\s\S]*?)\n>>>/.exec(prompt)?.[1] ?? "";
  const element = (label: string) => Number(new RegExp(`\\[(\\d+)\\] \\w+ "${label}"`).exec(page)?.[1] ?? NaN);
  const base = { account: page.includes(OWNER_X) ? OWNER_X : null, note: "next step", n: null, text: null, key: null, direction: null, url: null, outcome: null, reason: null };
  if (/can't message this account/i.test(page)) return { ...base, do: "finish", outcome: "cannot_message", reason: "You can't message this account" };
  if (/sent/.test(prompt.split("STEPS SO FAR:")[1]?.split("THE PAGE NOW:")[0] ?? "") && page.includes(message.slice(0, 40))) return { ...base, do: "finish", outcome: "sent", reason: "the conversation shows it" };
  const box = element("Message box");
  if (Number.isFinite(box) && /\{editor, empty/.test(page)) return { ...base, do: "fill", n: box, text: message };
  if (Number.isFinite(box)) return { ...base, do: "click", n: element("Send") };
  return { ...base, do: "click", n: element("Message") };
}

const replyReader = () => ({ conversationWith: "Priya Sharma", replies: [{ text: REPLY }, { text: BODY }] });
const calls: string[] = [];
mock.module(join(root, "src/lib/ai/server/structuredCompletion.ts"), () => ({
  completeStructured: async (input: Input) => {
    calls.push(input.schemaName);
    let answer: unknown;
    switch (input.schemaName) {
      case "lead_sorting": answer = { leads: leadsAsked(input.userPrompt).map((index) => ({ index, group: "SaaS founders", approach: "standard", reason: "A founder, as the owner asked.", requestFit: "fits", noWebsiteRequired: false })) }; break;
      case "outreach_sequences": answer = { channels: channelsAsked(input.userPrompt).map((channel) => ({ channel, messages: [{ subject: channel === "email" ? "Faster onboarding" : "", body: BODY, waitDays: 0 }, { subject: "", body: FOLLOW_UP, waitDays: 4 }] })) }; break;
      case "first_message_review": answer = { messages: ["email", "whatsapp", "linkedin", "instagram", "browser"].map((channel) => ({ channel, wouldReply: 4, reasons: [] })) }; break;
      case "opening_lines": answer = { lines: leadsAsked(input.userPrompt).map((index) => ({ index, line: "" })) }; break;
      case "browser_courier_step": answer = courierStep(input.userPrompt); break;
      case "browser_conversation_replies": answer = replyReader(); break;
      default: throw new Error(`unexpected model call ${input.schemaName}`);
    }
    const text = JSON.stringify(answer);
    input.accept(text);
    return { text, model: "fixture", response: {}, usage: {} };
  },
}));

const { and, eq, sql } = await import("drizzle-orm");
const { db } = await import("@/lib/db");
const { organizations, members, users } = await import("@/lib/auth/schema");
const { people } = await import("@/lib/leads/schema");
const { crmConversationMessages, crmConversations, crmPersonContactPolicies } = await import("@/lib/crm/schema");
const { leadFirstContacts } = await import("@/lib/channels/schema");
const { mailboxes } = await import("@/lib/outreach/schema");
const schema = await import("@/lib/assistant/schema");
const { browserConnections } = await import("@/lib/browser/connected/schema");
const { browserContactRoutes, browserOutreachSends } = await import("@/lib/browserOutreach/schema");
const { runInOrganization } = await import("@/lib/tenancy/scope");
const connections = await import("@/lib/browser/connected/connections.server");
const pairRoute = await import("@/app/api/browser-bridge/pair/route");
const pollRoute = await import("@/app/api/browser-bridge/poll/route");
const commandRoute = await import("@/app/api/browser-bridge/commands/[id]/route");
const { BROWSER_DEVICE_HEADER } = await import("@/lib/browser/connected/contract");
const { createAudience, addAudienceMembers } = await import("@/lib/assistant/audiences.server");
const { updateBusinessProfile } = await import("@/lib/assistant/profile.server");
const { prepareOutreach, startOutreachRun, getRun, stopRun } = await import("@/lib/assistant/outreach.server");
const { runOneAssistantStep } = await import("@/lib/assistant/worker");
const { registerAssistantJobs } = await import("@/lib/assistant/register.server");
const { saveProfileContact } = await import("@/lib/browserOutreach/routes.server");
const { profileRoute } = await import("@/lib/browserOutreach/routes");
const { courierForOrganization, sendBrowserReply, BrowserReplyError } = await import("@/lib/browserOutreach/courier.server");
const { saveChannelRules } = await import("@/lib/channels/rules.server");
type Command = import("@/lib/browser/connected/contract").BrowserResearchCommand;
type Result = import("@/lib/browser/connected/contract").BrowserResearchResult;
type Snapshot = import("@/lib/browser/connected/contract").ResearchSnapshot;
type Element = import("@/lib/browser/connected/contract").ResearchElement;
registerAssistantJobs();

let checks = 0;
function check(label: string, value: unknown, observed?: unknown) {
  if (!value) throw new Error(`FAIL ${label}${observed === undefined ? "" : ` — ${JSON.stringify(observed).slice(0, 1_200)}`}`);
  checks++;
  console.log(`PASS ${label}`);
}

// --- The stand-in browser: X and LinkedIn pages, a DM box, and what was "sent" ------------------------
const sentOnSite: { url: string; text: string }[] = [];
const threads = new Map<string, string[]>();
const tabs = new Map<number, { url: string; draft: string }>();
let nextTab = 100;
let loseSend = false;
const el = (n: number, kind: Element["kind"], label: string, patch: Partial<Element> = {}): Element => ({ n, kind, label, href: null, write: kind === "button", search: false, ...patch });
function pageOf(tab: { url: string; draft: string }): Snapshot {
  const nav = `Home Explore Messages ${OWNER_X} Profile`;
  const url = new URL(tab.url);
  const handle = url.pathname.split("/").filter(Boolean)[url.hostname.includes("linkedin") ? 1 : 0] ?? "";
  const base = { url: tab.url, scroll: { y: 0, height: 900, viewport: 900 }, attention: null, readAt: new Date().toISOString() };
  if (url.pathname.startsWith("/messages/")) {
    const who = url.pathname.split("/")[2]!;
    const history = threads.get(who) ?? [];
    return { ...base, title: `Messages with ${who}`, text: `${nav} Priya Sharma @${who} ${history.join(" ")}`, elements: [el(1, "input", "Message box", { write: false, field: { type: "editor", value: tab.draft } }), el(2, "button", "Send")] };
  }
  if (handle === "closed_dm") return { ...base, title: "Closed (@closed_dm)", text: `${nav} Closed Account @closed_dm You can't message this account`, elements: [el(1, "button", "Follow")] };
  return { ...base, title: `${handle} profile`, text: `${nav} Priya Sharma @${handle} Founder at Acme`, elements: [el(1, "link", "Home", { href: "https://x.com/home" }), el(2, "button", "Message"), el(3, "button", "Follow")] };
}
function respond(command: Command): Result | null {
  const action = command.action;
  switch (action.kind) {
    case "open": {
      const id = action.tabId ?? nextTab++;
      tabs.set(id, { url: action.url, draft: "" });
      return { ok: true, tabId: id, snapshot: pageOf(tabs.get(id)!) };
    }
    case "read": return tabs.has(action.tabId) ? { ok: true, tabId: action.tabId, snapshot: pageOf(tabs.get(action.tabId)!) } : { ok: false, error: "that tab is closed" };
    case "act": {
      const tab = tabs.get(action.tabId)!;
      const page = pageOf(tab);
      const target = page.elements.find((item) => item.n === action.n);
      if (!target || target.label !== action.label) return { ok: false, error: "the page changed", tabId: action.tabId };
      if (action.op === "fill") tab.draft = action.value ?? "";
      else if (target.label === "Message") {
        const url = new URL(tab.url);
        tab.url = `${url.origin}/messages/${url.pathname.split("/").filter(Boolean).at(-1)}`;
      } else if (target.label === "Send") {
        if (!action.grant.kinds.includes("message")) return { ok: false, error: "“Send” would message people", tabId: action.tabId };
        const who = tab.url.split("/").at(-1)!;
        threads.set(who, [...(threads.get(who) ?? []), tab.draft]);
        sentOnSite.push({ url: tab.url, text: tab.draft });
        tab.draft = "";
        if (loseSend) return null;
      }
      return { ok: true, tabId: action.tabId, snapshot: pageOf(tab) };
    }
    default: return { ok: true, closed: 0 };
  }
}

const request = (path: string, body: unknown, headers: Record<string, string> = {}) => new Request(`http://localhost:3000${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }) as never;
const device = (token: string, id: string) => ({ Authorization: `Bearer ${token}`, [BROWSER_DEVICE_HEADER]: id });
const ALL_SITES = ["web", "linkedin", "x", "reddit", "instagram", "facebook"];
let polling = false;
function startBrowser(token: string, deviceId: string) {
  polling = true;
  return (async () => {
    while (polling) {
      const response = await pollRoute.POST(request("/api/browser-bridge/poll", { extensionVersion: "0.18.0", sites: ALL_SITES, sharedTabs: [], lastSeq: 0, paused: false }, device(token, deviceId)));
      if (response.status !== 200) break;
      const { commands } = (await response.json()) as { commands: Command[] };
      for (const command of commands) {
        const result = respond(command);
        if (result) await commandRoute.POST(request(`/api/browser-bridge/commands/${command.id}`, { seq: command.seq, result }, device(token, deviceId)), { params: Promise.resolve({ id: command.id }) });
      }
    }
  })();
}

const [org] = await db.insert(organizations).values({ name: `Browser outreach ${stamp}`, slug: `browser-outreach-${stamp}` }).returning();
const [owner] = await db.insert(users).values({ name: "Owner", email: `owner-${stamp}@browser-outreach.test`, emailVerified: true }).returning();
await db.insert(members).values({ organizationId: org!.id, userId: owner!.id, role: "owner" });
let loop: Promise<void> | null = null;

try {
  await runInOrganization(org!.id, async () => {
    await updateBusinessProfile({ businessName: "OnboardKit", offer: "onboarding flows that halve setup time for SaaS teams", senderName: "Ravi" }, owner!.id);
    await saveChannelRules("browser", { secondsBetweenSends: 30 }, owner!.id);
    const { code } = await connections.createPairing(owner!.id);
    const deviceId = randomUUID();
    const paired = await (await pairRoute.POST(request("/api/browser-bridge/pair", { code, deviceId, deviceLabel: "Test Chrome", extensionVersion: "0.18.0", sites: ALL_SITES, domains: [] }))).json() as { token: string };
    await db.insert(mailboxes).values({ organizationId: org!.id, emailAddress: `sales-${stamp}@browser-outreach.test`, displayName: "Ravi", status: "connected", dailySendLimit: 5 });

    // --- Who the browser reaches ------------------------------------------------------------------
    const priya = (await saveProfileContact({ route: profileRoute("https://x.com/priya_k")!, name: "Priya Sharma", company: "Acme", sourceUrl: null }))!.personId;
    const closed = (await saveProfileContact({ route: profileRoute("https://x.com/closed_dm")!, name: "Closed Account", company: null, sourceUrl: null }))!.personId;
    const [rahul] = await db.insert(people).values({ organizationId: org!.id, source: "list", fullName: "Rahul Mehta", linkedinUrl: `rahul-${stamp}` }).returning();
    const [sam] = await db.insert(people).values({ organizationId: org!.id, source: "list", fullName: "Sam Lee", email: `sam-${stamp}@example.test` }).returning();
    const blocked = (await saveProfileContact({ route: profileRoute("https://x.com/no_contact_pls")!, name: "No Contact", company: null, sourceUrl: null }))!.personId;
    await db.insert(crmPersonContactPolicies).values({ personId: blocked, doNotContact: true, reason: "asked", source: "human", setAt: new Date() });
    const audienceId = await createAudience({ name: "SaaS founders", source: "list" });
    await addAudienceMembers(audienceId, [priya, closed, rahul!.id, sam!.id, blocked].map((personId) => ({ personId, source: "list" })));
    const channelOf = (plan: typeof schema.outreachRuns.$inferSelect["plan"], id: string) => plan.assignments.find((item) => item.personId === id)?.channel ?? null;

    const general = await prepareOutreach({ audienceId, ownerRequest: "reach out to them", threadId: null, userId: owner!.id });
    check("a general request with no Unipile and no mail sender: the browser reaches every lead with a profile, needing neither; the email-only lead waits on email; never Do Not Contact",
      channelOf(general.plan, priya) === "browser" && channelOf(general.plan, rahul!.id) === "browser" && channelOf(general.plan, closed) === "browser" && channelOf(general.plan, sam!.id) === null && channelOf(general.plan, blocked) === null
        && general.plan.excluded.some((item) => /reachable only by email, which cannot send yet/.test(item.reason)), { assignments: general.plan.assignments, excluded: general.plan.excluded });
    const mine = await prepareOutreach({ audienceId, ownerRequest: "Find SaaS founders and message them using my browser", threadId: null, userId: owner!.id });
    check("“using my browser”: the browser only, the email lead left out with the owner's reason",
      mine.plan.assignments.length === 3 && mine.plan.assignments.every((item) => item.channel === "browser") && channelOf(mine.plan, sam!.id) === null && mine.plan.channelNote === "you asked for your browser"
        && mine.plan.excluded.some((item) => /reachable only by email/.test(item.reason) && /you asked for your browser/.test(item.reason)), { assignments: mine.plan.assignments, excluded: mine.plan.excluded });
    const onX = await prepareOutreach({ audienceId, ownerRequest: "Message them on X", threadId: null, userId: owner!.id });
    check("“on X”: the browser on X only, so the LinkedIn-only lead is left out", channelOf(onX.plan, priya) === "browser" && channelOf(onX.plan, rahul!.id) === null && JSON.stringify(onX.plan.browserSites) === "[\"x\"]", onX.plan);
    await db.update(schema.outreachRuns).set({ status: "cancelled" }).where(and(eq(schema.outreachRuns.organizationId, org!.id), sql`${schema.outreachRuns.id} <> ${mine.runId}`));

    // --- Start: queued, follow-ups waiting, Do Not Contact absent ----------------------------------------
    await startOutreachRun(mine.runId, owner!.id, { autopilot: false });
    for (let round = 0; round < 20; round++) {
      const [job] = await db.select().from(schema.assistantJobs).where(and(eq(schema.assistantJobs.runId, mine.runId), eq(schema.assistantJobs.kind, "outreach_start")));
      if (!job || (job.status !== "queued" && job.status !== "running")) break;
      await db.update(schema.assistantJobs).set({ runAfter: new Date(Date.now() - 1_000) }).where(eq(schema.assistantJobs.id, job.id));
      await runOneAssistantStep({ jobId: job.id });
    }
    const run = await getRun(mine.runId);
    const queued = await db.select().from(browserOutreachSends).where(eq(browserOutreachSends.runId, mine.runId));
    check("Start queues each browser lead's first message now and its follow-up waiting, from the approver's browser",
      run?.status === "running" && run.campaigns.browser === run.id && queued.filter((row) => row.step === 0 && row.status === "queued").length === 3
        && queued.filter((row) => row.step === 1 && row.status === "waiting").length === 3 && queued.every((row) => row.userId === owner!.id), { run: run?.status, error: run?.error, queued: queued.map((row) => [row.step, row.status]) });
    check("…nothing is queued for Do Not Contact", !queued.some((row) => row.personId === blocked));

    // --- Chrome offline: a wait, with its reason ----------------------------------------------------------
    await db.update(browserConnections).set({ lastSeenAt: new Date(Date.now() - 3_600_000) }).where(eq(browserConnections.organizationId, org!.id));
    await courierForOrganization();
    const waiting = await db.select().from(browserOutreachSends).where(and(eq(browserOutreachSends.runId, mine.runId), eq(browserOutreachSends.step, 0)));
    check("with Chrome offline nothing is sent, and each message says why and when it is looked at again",
      sentOnSite.length === 0 && waiting.every((row) => row.status === "queued" && /Chrome is offline/.test(row.waitReason ?? "") && row.nextCheckAt), waiting.map((row) => row.waitReason));

    // --- Online: one delivery, verified on the page ---------------------------------------------------------
    loop = startBrowser(paired.token, deviceId);
    await Bun.sleep(300);
    await db.update(browserOutreachSends).set({ nextCheckAt: null }).where(eq(browserOutreachSends.runId, mine.runId));
    const order = [priya, closed, rahul!.id];
    await db.execute(sql`update browser_outreach_sends set due_at = now() - (case person_id when ${priya}::uuid then interval '3 minutes' when ${closed}::uuid then interval '2 minutes' else interval '1 minute' end) where run_id = ${mine.runId}`);
    await courierForOrganization();
    const [first] = await db.select().from(browserOutreachSends).where(and(eq(browserOutreachSends.personId, order[0]!), eq(browserOutreachSends.step, 0)));
    const [route] = await db.select().from(browserContactRoutes).where(eq(browserContactRoutes.id, first!.routeId));
    const [touch] = await db.select().from(leadFirstContacts).where(eq(leadFirstContacts.personId, priya));
    check("the courier opens the profile, opens a message, types the approved text and sends it once; the page shows it",
      first?.status === "sent" && sentOnSite.length === 1 && sentOnSite[0]!.text === first.body && first.senderHandle === OWNER_X && /\/messages\/priya_k$/.test(first.threadUrl ?? ""), { first, sentOnSite });
    check("…the route is now known to take messages, with its conversation's address; the first touch counts toward the daily limit",
      route?.state === "messageable" && route.threadUrl === first!.threadUrl && touch?.channel === "browser", { route, touch });
    const follow = await db.select().from(browserOutreachSends).where(and(eq(browserOutreachSends.personId, priya), eq(browserOutreachSends.step, 1)));
    await courierForOrganization();
    const [promoted] = await db.select().from(browserOutreachSends).where(and(eq(browserOutreachSends.personId, priya), eq(browserOutreachSends.step, 1)));
    check("…its follow-up becomes due 4 days after it, not now", follow[0]?.status === "waiting" && promoted?.status === "queued" && promoted.dueAt.getTime() > Date.now() + 3.9 * 86_400_000, promoted);
    const [paced] = await db.select().from(browserOutreachSends).where(and(eq(browserOutreachSends.personId, closed), eq(browserOutreachSends.step, 0)));
    check("…the next message waits for the time between messages, and says when", paced?.status === "queued" && /next browser message at/.test(paced.waitReason ?? "") && sentOnSite.length === 1, paced);

    // --- A profile that cannot take a message --------------------------------------------------------------
    await db.update(browserOutreachSends).set({ attemptedAt: sql`attempted_at - interval '10 minutes'`, sentAt: sql`sent_at - interval '10 minutes'` }).where(eq(browserOutreachSends.runId, mine.runId));
    await db.update(browserOutreachSends).set({ nextCheckAt: null }).where(eq(browserOutreachSends.runId, mine.runId));
    await courierForOrganization();
    const closedRows = await db.select().from(browserOutreachSends).where(eq(browserOutreachSends.personId, closed));
    const [closedRoute] = await db.select().from(browserContactRoutes).where(eq(browserContactRoutes.personId, closed));
    const closedTouch = await db.select().from(leadFirstContacts).where(eq(leadFirstContacts.personId, closed));
    check("a profile that cannot take a message: blocked with the site's words, its follow-up cancelled, its lead place given back, nothing sent",
      closedRows.find((row) => row.step === 0)?.status === "blocked" && /can't message this account/.test(closedRows.find((row) => row.step === 0)?.error ?? "") && closedRows.find((row) => row.step === 1)?.status === "cancelled"
        && closedRoute?.state === "not_messageable" && closedTouch.length === 0 && sentOnSite.length === 1, { closedRows: closedRows.map((row) => [row.step, row.status, row.error]), closedRoute, closedTouch });

    // --- A lost Send answer: uncertain, never resent --------------------------------------------------------
    await db.update(browserOutreachSends).set({ attemptedAt: sql`attempted_at - interval '10 minutes'`, nextCheckAt: null }).where(eq(browserOutreachSends.runId, mine.runId));
    loseSend = true;
    await courierForOrganization();
    loseSend = false;
    const rahulRows = await db.select().from(browserOutreachSends).where(eq(browserOutreachSends.personId, rahul!.id));
    await db.update(browserOutreachSends).set({ attemptedAt: sql`attempted_at - interval '10 minutes'`, nextCheckAt: null }).where(eq(browserOutreachSends.runId, mine.runId));
    await courierForOrganization();
    check("a Send whose answer was lost is uncertain, its follow-up cancelled, and it is never sent again",
      rahulRows.find((row) => row.step === 0)?.status === "uncertain" && rahulRows.find((row) => row.step === 1)?.status === "cancelled" && sentOnSite.filter((item) => /rahul/.test(item.url)).length === 1,
      { rows: rahulRows.map((row) => [row.step, row.status, row.error]), sent: sentOnSite });

    // --- A reply read in the browser reaches the CRM, and stops the follow-up ---------------------------------
    threads.set("priya_k", [...(threads.get("priya_k") ?? []), REPLY]);
    await db.update(browserContactRoutes).set({ syncedAt: null }).where(eq(browserContactRoutes.id, first!.routeId));
    await courierForOrganization();
    const [conversation] = await db.select().from(crmConversations).where(and(eq(crmConversations.personId, priya), eq(crmConversations.channel, "browser")));
    const messages = conversation ? await db.select().from(crmConversationMessages).where(eq(crmConversationMessages.conversationId, conversation.id)) : [];
    const [stopped] = await db.select().from(browserOutreachSends).where(and(eq(browserOutreachSends.personId, priya), eq(browserOutreachSends.step, 1)));
    check("a reply read from the conversation reaches the CRM on the browser channel, with the first message copied in; the owner's own text is not taken as theirs",
      conversation?.accountRef === `x:${OWNER_X}` && messages.some((message) => message.direction === "inbound" && message.bodyText === REPLY)
        && messages.some((message) => message.direction === "outbound" && message.bodyText === first!.body) && messages.filter((message) => message.direction === "inbound").length === 1, { conversation, messages: messages.map((message) => [message.direction, message.bodyText]) });
    check("…and the follow-up to them is cancelled", stopped?.status === "cancelled" && /replied/i.test(stopped.error ?? ""), stopped);
    await db.update(browserContactRoutes).set({ syncedAt: null }).where(eq(browserContactRoutes.id, first!.routeId));
    await courierForOrganization();
    const again = await db.select().from(crmConversationMessages).where(and(eq(crmConversationMessages.conversationId, conversation!.id), eq(crmConversationMessages.direction, "inbound")));
    check("…reading the conversation again records nothing twice", again.length === 1, again.length);

    // --- A reply back through the browser; offline defers it with the reason ---------------------------------------
    await db.update(browserOutreachSends).set({ attemptedAt: sql`attempted_at - interval '10 minutes'` }).where(eq(browserOutreachSends.organizationId, org!.id));
    const answer = await sendBrowserReply({ draftId: randomUUID(), personId: priya, routeId: first!.routeId, accountRef: `x:${OWNER_X}`, body: "Great, Tuesday it is." });
    check("a reply from the CRM goes out through the same browser and conversation, verified", Boolean(answer.sendId) && sentOnSite.at(-1)?.text === "Great, Tuesday it is." && /priya_k/.test(sentOnSite.at(-1)!.url), sentOnSite.at(-1));
    polling = false;
    await loop;
    loop = null;
    await db.update(browserConnections).set({ lastSeenAt: new Date(Date.now() - 3_600_000) }).where(eq(browserConnections.organizationId, org!.id));
    await db.update(browserOutreachSends).set({ attemptedAt: sql`attempted_at - interval '10 minutes'` }).where(eq(browserOutreachSends.organizationId, org!.id));
    const deferred = await sendBrowserReply({ draftId: randomUUID(), personId: priya, routeId: first!.routeId, accountRef: `x:${OWNER_X}`, body: "One more thing." }).catch((error: unknown) => error);
    check("…with Chrome offline a reply is deferred with the reason, not failed and not sent", deferred instanceof BrowserReplyError && deferred.outcome === "deferred" && /Chrome is offline/.test(deferred.message) && sentOnSite.at(-1)?.text !== "One more thing.", String(deferred));

    // --- Stop: what has not gone out never will ------------------------------------------------------------------
    await stopRun(mine.runId);
    const left = await db.select().from(browserOutreachSends).where(and(eq(browserOutreachSends.runId, mine.runId), sql`${browserOutreachSends.status} in ('queued', 'waiting')`));
    check("Stop cancels the run's browser messages that have not gone out", left.length === 0, left);
    check("nothing was ever sent to Do Not Contact, and every send is on the stand-in's pages", !sentOnSite.some((item) => /no_contact_pls/.test(item.url)) && sentOnSite.every((item) => /x\.com|linkedin\.com/.test(item.url)));
  });
  console.log(`Browser outreach database checks: ${checks} passed. Stand-in extension and scripted model; nobody was messaged. Model calls: ${[...new Set(calls)].join(", ")}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  polling = false;
  await (loop as Promise<void> | null)?.catch(() => undefined);
  process.exit();
}

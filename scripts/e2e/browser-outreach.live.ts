/**
 * Browser outreach through the REAL extension (0.18.0) in a VISIBLE Chromium
 * (run it under xvfb-run) and a REAL running AgentSDR: the owner connects
 * their browser from the chat with all-websites access; a plan made with
 * "using my browser" is started; the courier, in this process, delivers each
 * message through the extension's real page script on an X-like fixture
 * site (a profile, its Message button, a direct-message box that is a
 * contenteditable editor, Send); the fixture records what it received. A
 * profile that cannot be messaged is blocked; a reply the fixture shows is
 * read back into the CRM; Stop in the popup holds the courier with its
 * reason. With LIVE_REAL_CLAUDE=1 the installed `claude` CLI (this machine's
 * login, not a customer's) is the courier's model for one more delivery.
 *
 * What is not real, said plainly: x.com here is a fixture on 127.0.0.1:443
 * (Chromium's host mapping, a self-signed certificate) and nobody is signed
 * in to X; the site permission is pre-answered by a test copy of the
 * manifest (https://*\/*). Nothing reaches a real site or person.
 *
 * Needs: `bun run build:recorder`; a server on http://localhost:3000
 * started with BROWSER_RESEARCH_ALLOW_PRIVATE=true on the same disposable
 * DATABASE_URL; root (port 443); a display (xvfb-run -a).
 *
 *   DATABASE_URL=postgres://…@127.0.0.1:<port>/agentsdr_native \
 *     xvfb-run -a bun run --conditions=react-server scripts/e2e/browser-outreach.live.ts
 */
import { mock } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type BrowserContext } from "playwright-core";

if (!/^postgres(?:ql)?:\/\/[^/]+@(localhost|127\.0\.0\.1):\d+\/agentsdr_native$/.test(process.env.DATABASE_URL ?? "")) throw new Error("Requires the disposable local agentsdr_native database");
if (!process.env.DISPLAY) throw new Error("Run under a display (xvfb-run -a)");
process.env.BROWSER_RESEARCH_ALLOW_PRIVATE = "true";
process.env.GEOCODER_URL = "off";
const base = "http://localhost:3000";
const root = resolve(import.meta.dir, "../..");
const chromeExecutable = process.env.BROWSER_EXECUTABLE_PATH ?? "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome";
const REAL = process.env.LIVE_REAL_CLAUDE === "1";

const BODY = "Hi there, saw your post about onboarding new customers. Would a 10-minute look at how we halve setup time help?";
const FOLLOW_UP = "Just checking whether shorter onboarding would help this quarter.";
const REPLY = "Thanks! Tuesday works for a quick call.";
const OWNER = "@owner_x";

// --- Scripted models (the writer, the courier, the reply reader); the real ones with LIVE_REAL_CLAUDE=1 ---
type Input = { schemaName: string; userPrompt: string; accept: (text: string) => void };
const leadsAsked = (prompt: string) => [...prompt.matchAll(/^(\d+)(?: \([^)]*\))?: \{.*\}$/gm)].map((match) => Number(match[1]));
const channelsAsked = (prompt: string) => (prompt.match(/^Write the messages for: (.+)\.$/m)?.[1] ?? "").split(",").map((channel) => channel.trim()).filter(Boolean);
function courierStep(prompt: string): Record<string, unknown> {
  const page = prompt.split("THE PAGE NOW:")[1] ?? "";
  const message = /<<<\n([\s\S]*?)\n>>>/.exec(prompt)?.[1] ?? "";
  const element = (label: string) => Number(new RegExp(`\\[(\\d+)\\] \\w+ "${label}"`).exec(page)?.[1] ?? NaN);
  const done = prompt.split("STEPS SO FAR:")[1]?.split("THE PAGE NOW:")[0] ?? "";
  const base = { account: page.includes(OWNER) ? OWNER : null, note: "next step", n: null, text: null, key: null, direction: null, url: null, outcome: null, reason: null };
  if (/can't message this account/i.test(page)) return { ...base, do: "finish", outcome: "cannot_message", reason: "You can't message this account" };
  if (/ — sent/.test(done) && page.includes(message.slice(0, 40))) return { ...base, do: "finish", outcome: "sent", reason: "the conversation shows it" };
  const box = element("Message box");
  if (Number.isFinite(box) && /\{editor, empty/.test(page)) return { ...base, do: "fill", n: box, text: message };
  if (Number.isFinite(box)) return { ...base, do: "click", n: element("Send") };
  return { ...base, do: "click", n: element("Message") };
}
const realStructured = (await import(join(root, "src/lib/ai/server/structuredCompletion.ts"))).completeStructured as (input: unknown) => Promise<unknown>;
let realCourier = false;
const courierCalls: string[] = [];
mock.module(join(root, "src/lib/ai/server/structuredCompletion.ts"), () => ({
  completeStructured: async (input: Input) => {
    if (realCourier && (input.schemaName === "browser_courier_step" || input.schemaName === "browser_conversation_replies")) {
      courierCalls.push(`real:${input.schemaName}`);
      return realStructured(input);
    }
    let answer: unknown;
    switch (input.schemaName) {
      case "lead_sorting": answer = { leads: leadsAsked(input.userPrompt).map((index) => ({ index, group: "SaaS founders", approach: "standard", reason: "A founder, as the owner asked.", requestFit: "fits", noWebsiteRequired: false })) }; break;
      case "outreach_sequences": answer = { channels: channelsAsked(input.userPrompt).map((channel) => ({ channel, messages: [{ subject: "", body: BODY, waitDays: 0 }, { subject: "", body: FOLLOW_UP, waitDays: 4 }] })) }; break;
      case "first_message_review": answer = { messages: ["email", "whatsapp", "linkedin", "instagram", "browser"].map((channel) => ({ channel, wouldReply: 4, reasons: [] })) }; break;
      case "opening_lines": answer = { lines: leadsAsked(input.userPrompt).map((index) => ({ index, line: "" })) }; break;
      case "browser_courier_step": courierCalls.push("scripted:courier"); answer = courierStep(input.userPrompt); break;
      case "browser_conversation_replies": courierCalls.push("scripted:replies"); answer = { conversationWith: "Priya Sharma", replies: [{ text: REPLY }] }; break;
      default: throw new Error(`unexpected model call ${input.schemaName}`);
    }
    const text = JSON.stringify(answer);
    input.accept(text);
    return { text, model: "fixture", response: {}, usage: {} };
  },
}));

const { and, eq, sql } = await import("drizzle-orm");
const { hashPassword } = await import("better-auth/crypto");
const { db } = await import("@/lib/db");
const { accounts, members, organizations, users } = await import("@/lib/auth/schema");
const { browserConnections } = await import("@/lib/browser/connected/schema");
const { browserContactRoutes, browserOutreachSends } = await import("@/lib/browserOutreach/schema");
const { crmConversationMessages, crmConversations } = await import("@/lib/crm/schema");
const schema = await import("@/lib/assistant/schema");
const { runInOrganization } = await import("@/lib/tenancy/scope");
const { createThread } = await import("@/lib/assistant/threads.server");
const { updateBusinessProfile } = await import("@/lib/assistant/profile.server");
const { createAudience, addAudienceMembers } = await import("@/lib/assistant/audiences.server");
const { prepareOutreach } = await import("@/lib/assistant/outreach.server");
const { queueBrowserOutreach } = await import("@/lib/browserOutreach/queue.server");
const { saveProfileContact } = await import("@/lib/browserOutreach/routes.server");
const { profileRoute } = await import("@/lib/browserOutreach/routes");
const { courierForOrganization } = await import("@/lib/browserOutreach/courier.server");
const { saveChannelRules } = await import("@/lib/channels/rules.server");
const cli = await import("@/lib/ai/claudeCode/cli.server");
const engine = await import("@/lib/ai/claudeCode/engine.server");
const { resetRunnerForTests } = await import("@/lib/ai/claudeCode/runner.server");

let checks = 0;
function check(label: string, value: unknown, observed?: unknown) {
  if (!value) throw new Error(`FAIL ${label}${observed === undefined ? "" : ` — ${JSON.stringify(observed).slice(0, 1_200)}`}`);
  checks++;
  console.log(`PASS ${label}`);
}
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

// --- An X-like fixture on 127.0.0.1:443 ------------------------------------------------------------
const received: { to: string; text: string }[] = [];
const threads = new Map<string, { from: "owner" | "them"; text: string }[]>();
const work = mkdtempSync(join(tmpdir(), "agentsdr-browser-outreach-live-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=fixture", "-days", "1", "-keyout", join(work, "key.pem"), "-out", join(work, "cert.pem")], { stdio: "ignore" });
const escape = (value: string) => value.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;" })[c]!);
const html = (title: string, body: string) => new Response(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{margin:0;font:16px sans-serif} nav{padding:8px;border-bottom:1px solid #ddd}</style></head><body><nav><a href="/home">Home</a> <a href="/messages">Messages</a> <a href="/owner_x">${OWNER}</a></nav>${body}</body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
const NAMES: Record<string, string> = { priya_k: "Priya Sharma", maya_d: "Maya Desai", closed_dm: "Closed Account" };
const fixtures = Bun.serve({
  hostname: "127.0.0.1",
  port: 443,
  tls: { cert: readFileSync(join(work, "cert.pem"), "utf8"), key: readFileSync(join(work, "key.pem"), "utf8") },
  async fetch(request) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/api/send" && request.method === "POST") {
      const { to, text } = await request.json() as { to: string; text: string };
      received.push({ to, text });
      threads.set(to, [...(threads.get(to) ?? []), { from: "owner", text }]);
      return Response.json({ ok: true });
    }
    if (parts[0] === "messages" && parts[1]) {
      const who = parts[1];
      const history = (threads.get(who) ?? []).map((message) => `<p class="${message.from}">${message.from === "owner" ? "You: " : ""}${escape(message.text)}</p>`).join("");
      return html(`Messages with ${NAMES[who] ?? who}`, `<header><h1>${NAMES[who] ?? who}</h1><span>@${who}</span></header><main id="log">${history}</main>
        <div id="box" contenteditable="true" role="textbox" aria-label="Message box" style="min-height:40px;border:1px solid #999"></div>
        <button type="button" aria-label="Send" id="send">Send</button>
        <script>
          document.getElementById("send").addEventListener("click", async () => {
            const box = document.getElementById("box"), text = box.innerText.trim();
            if (!text) return;
            await fetch("/api/send", { method: "POST", body: JSON.stringify({ to: ${JSON.stringify(who)}, text }) });
            const p = document.createElement("p"); p.className = "owner"; p.textContent = "You: " + text; document.getElementById("log").appendChild(p);
            box.textContent = "";
          });
        </script>`);
    }
    if (parts[0] === "closed_dm") return html("Closed Account (@closed_dm)", "<h1>Closed Account</h1><span>@closed_dm</span><p>You can't message this account.</p><button type=\"button\">Follow</button>");
    if (parts[0] && NAMES[parts[0]]) {
      return html(`${NAMES[parts[0]]} (@${parts[0]})`, `<h1>${NAMES[parts[0]]}</h1><span>@${parts[0]}</span><p>Founder. Building onboarding tools.</p>
        <button type="button" onclick="location.href='/messages/${parts[0]}'">Message</button> <button type="button">Follow</button>`);
    }
    return html("X", "<h1>Home</h1>");
  },
});

// --- Workspace, owner, leads ---------------------------------------------------------------------
const stamp = randomUUID();
const email = `owner-${stamp}@browser-outreach.test`;
const password = "Local-browser-outreach-only-123!";
const [org] = await db.insert(organizations).values({ name: "Live browser outreach", slug: `browser-outreach-${stamp}` }).returning();
const [user] = await db.insert(users).values({ name: "Live Owner", email, emailVerified: true }).returning();
await db.insert(accounts).values({ userId: user!.id, accountId: user!.id, providerId: "credential", password: await hashPassword(password) });
await db.insert(members).values({ organizationId: org!.id, userId: user!.id, role: "owner" });
const inOrg = <T>(task: () => Promise<T>) => runInOrganization(org!.id, task);
await inOrg(async () => {
  await updateBusinessProfile({ businessName: "OnboardKit", offer: "onboarding flows that halve setup time for SaaS teams", senderName: "Ravi" }, user!.id);
  await saveChannelRules("browser", { secondsBetweenSends: 30 }, user!.id);
});

const extension = join(work, "extension");
cpSync(join(root, "extensions/whatsapp-recorder/dist"), extension, { recursive: true });
const manifest = JSON.parse(readFileSync(join(extension, "manifest.json"), "utf8")) as { host_permissions: string[]; version: string };
manifest.host_permissions.push("https://*/*");
writeFileSync(join(extension, "manifest.json"), JSON.stringify(manifest, null, 2));

const data = mkdtempSync(join(tmpdir(), "agentsdr-browser-outreach-claude-"));
let context: BrowserContext | null = null;
try {
  context = await chromium.launchPersistentContext(join(work, "profile"), {
    executablePath: chromeExecutable,
    headless: false,
    ignoreHTTPSErrors: true,
    viewport: null,
    ignoreDefaultArgs: ["--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
    args: ["--no-sandbox", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--host-resolver-rules=MAP x.com 127.0.0.1", "--ignore-certificate-errors", "--no-proxy-server", "--window-size=1280,900"],
  });
  const ctx = context;
  const worker = async () => ctx.serviceWorkers().find((sw) => sw.url().endsWith("/background.js")) ?? ctx.waitForEvent("serviceworker", { timeout: 90_000 });
  const extensionId = new URL((await worker()).url()).host;

  // --- The owner connects this browser from the chat, all websites ------------------------------------
  check("the owner signs in", (await ctx.request.post(`${base}/api/auth/sign-in/email`, { headers: { origin: base }, data: { email, password } })).ok());
  check("the workspace is selected", (await ctx.request.post(`${base}/api/auth/organization/set-active`, { headers: { origin: base }, data: { organizationId: org!.id } })).ok());
  const thread = await inOrg(() => createThread(user!.id));
  const app = ctx.pages()[0] ?? await ctx.newPage();
  await app.goto(`${base}/assistant?thread=${thread.id}`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  await app.waitForSelector("html[data-agentsdr-recorder]", { timeout: 60_000 });
  const connectButton = app.getByRole("button", { name: "Connect this browser" });
  for (let attempt = 0; !(await connectButton.isVisible()); attempt++) {
    if (attempt > 20) throw new Error("The Connect browser popover never opened");
    await app.getByTestId("browser-connection").click({ timeout: 120_000 }).catch(() => undefined);
    await connectButton.waitFor({ timeout: 5_000 }).catch(() => undefined);
  }
  const opened = ctx.waitForEvent("page", { predicate: (page) => page.url().includes("/connect.html?pairing="), timeout: 30_000 });
  await connectButton.click();
  const connect = await opened;
  await connect.waitForSelector("#access-all");
  await connect.check("#access-all");
  await connect.click("#connect");
  await connect.waitForSelector("#status.ok", { timeout: 30_000 });
  const [row] = await db.select().from(browserConnections).where(and(eq(browserConnections.organizationId, org!.id), eq(browserConnections.status, "active")));
  check("the 0.18.0 extension pairs with all-websites access", row?.extensionVersion === "0.18.0" && row.sites.length === 6, row);
  await connect.close();

  // --- A plan "using my browser", started -------------------------------------------------------------
  const { runId, priya, closed, maya } = await inOrg(async () => {
    const priya = (await saveProfileContact({ route: profileRoute("https://x.com/priya_k")!, name: "Priya Sharma", company: "Acme", sourceUrl: null }))!.personId;
    const closed = (await saveProfileContact({ route: profileRoute("https://x.com/closed_dm")!, name: "Closed Account", company: null, sourceUrl: null }))!.personId;
    const maya = (await saveProfileContact({ route: profileRoute("https://x.com/maya_d")!, name: "Maya Desai", company: null, sourceUrl: null }))!.personId;
    const audienceId = await createAudience({ name: "Founders on X", source: "list" });
    await addAudienceMembers(audienceId, [priya, closed, maya].map((personId) => ({ personId, source: "list" })));
    const plan = await prepareOutreach({ audienceId, ownerRequest: "Find SaaS founders on X and message them using my browser", threadId: thread.id, userId: user!.id });
    // Approved as Start approves it, and queued by the launch's own function. (The running server's
    // assistant worker would take an outreach_start job with its own, unscripted models: the database
    // suite covers that path.)
    const [approved] = await db.update(schema.outreachRuns).set({ status: "starting", approvedAt: new Date(), approvedBy: user!.id }).where(eq(schema.outreachRuns.id, plan.runId)).returning();
    const queued = await queueBrowserOutreach(approved!, plan.plan.assignments.map((item) => ({ personId: item.personId, bodies: [BODY, FOLLOW_UP], waits: [0, 4] })));
    await db.update(schema.outreachRuns).set({ status: "running", campaigns: { browser: plan.runId } }).where(eq(schema.outreachRuns.id, plan.runId));
    if (queued.problem) throw new Error(queued.problem);
    // One at a time, in this order; Maya's waits for the real model (or the script) at the end.
    await db.execute(sql`update browser_outreach_sends set due_at = now() - (case person_id when ${priya}::uuid then interval '3 minutes' when ${closed}::uuid then interval '2 minutes' else interval '1 minute' end),
      next_check_at = case person_id when ${maya}::uuid then now() + interval '1 day' else null end where run_id = ${plan.runId}`);
    return { runId: plan.runId, priya, closed, maya };
  });
  const sends = () => inOrg(() => db.select().from(browserOutreachSends).where(and(eq(browserOutreachSends.runId, runId), eq(browserOutreachSends.step, 0))));
  check("the started plan queues three first messages on the browser channel", (await sends()).length === 3);

  // --- Delivered through the real extension, verified on the page ---------------------------------------
  await inOrg(courierForOrganization);
  const priyaSend = (await sends()).find((item) => item.personId === priya)!;
  check("the courier delivers through the real page script: the fixture received exactly the approved text, once, to the right person",
    priyaSend.status === "sent" && received.length === 1 && received[0]!.to === "priya_k" && received[0]!.text === priyaSend.body.trim() && priyaSend.senderHandle === OWNER, { priyaSend, received, log: priyaSend.log });
  const releasedTabs = await (await worker()).evaluate(async () => (await chrome.tabs.query({})).filter((tab) => /x\.com/.test(tab.url ?? "")).length);
  await sleep(3_000);
  check("…and its tab is released afterwards", (await (await worker()).evaluate(async () => (await chrome.tabs.query({})).filter((tab) => /x\.com/.test(tab.url ?? "")).length)) <= releasedTabs);

  // --- A profile that cannot take a message -----------------------------------------------------------
  await inOrg(() => db.update(browserOutreachSends).set({ attemptedAt: sql`attempted_at - interval '10 minutes'`, nextCheckAt: sql`case when person_id = ${maya}::uuid then next_check_at else null end` }).where(eq(browserOutreachSends.runId, runId)));
  await inOrg(courierForOrganization);
  const closedSend = (await sends()).find((item) => item.personId === closed)!;
  check("a profile the page says cannot be messaged is blocked with those words, and nothing reaches it", closedSend.status === "blocked" && /can't message this account/i.test(closedSend.error ?? "") && !received.some((item) => item.to === "closed_dm"), closedSend);

  // --- A reply on the page reaches the CRM -----------------------------------------------------------
  threads.set("priya_k", [...(threads.get("priya_k") ?? []), { from: "them", text: REPLY }]);
  await inOrg(() => db.update(browserContactRoutes).set({ syncedAt: null }).where(eq(browserContactRoutes.id, priyaSend.routeId)));
  await inOrg(courierForOrganization);
  const inbound = await inOrg(() => db.select({ body: crmConversationMessages.bodyText }).from(crmConversationMessages)
    .innerJoin(crmConversations, eq(crmConversations.id, crmConversationMessages.conversationId))
    .where(and(eq(crmConversations.personId, priya), eq(crmConversations.channel, "browser"), eq(crmConversationMessages.direction, "inbound"))));
  check("the reply shown in the conversation is read back into the CRM on the browser channel", inbound.length === 1 && inbound[0]!.body === REPLY, inbound);

  // --- Stop in the popup holds the courier, with the reason --------------------------------------------
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.getByRole("button", { name: "Stop", exact: true }).click();
  for (let i = 0; i < 60 && (await db.select({ paused: browserConnections.paused }).from(browserConnections).where(eq(browserConnections.id, row!.id)))[0]?.paused !== true; i++) await sleep(500);
  await inOrg(() => db.update(browserOutreachSends).set({ nextCheckAt: null, attemptedAt: sql`attempted_at - interval '10 minutes'` }).where(and(eq(browserOutreachSends.runId, runId), eq(browserOutreachSends.personId, maya))));
  await inOrg(courierForOrganization);
  const held = (await sends()).find((item) => item.personId === maya)!;
  check("after Stop in the popup nothing is sent, and the message says why", held.status === "queued" && /pressed Stop/.test(held.waitReason ?? "") && !received.some((item) => item.to === "maya_d"), held);
  await popup.reload();
  await popup.getByRole("button", { name: "Resume", exact: true }).click();
  for (let i = 0; i < 60 && (await db.select({ paused: browserConnections.paused }).from(browserConnections).where(eq(browserConnections.id, row!.id)))[0]?.paused !== false; i++) await sleep(500);
  await popup.close();

  // --- Real Claude as the courier's model (this machine's CLI login) ----------------------------------
  if (REAL) {
    engine.setOperatorOrganizationForTests(org!.id);
    cli.setClaudeDataDirForTests(data);
    cli.setClaudeCliForTests(null);
    resetRunnerForTests();
    const paths = cli.accountPaths({ organizationId: org!.id, userId: user!.id });
    writeFileSync(join(paths.config, ".credentials.json"), "fake", { mode: 0o600 });
    await inOrg(() => engine.saveClaudeEngine({ selected: true, ownerUserId: user!.id, model: "sonnet", checks: {} }));
    realCourier = true;
    await inOrg(() => db.update(browserOutreachSends).set({ nextCheckAt: null, attemptedAt: sql`attempted_at - interval '10 minutes'` }).where(eq(browserOutreachSends.runId, runId)));
    await inOrg(courierForOrganization);
    const mayaSend = (await sends()).find((item) => item.personId === maya)!;
    console.log(`REAL CLAUDE courier for Maya: ${mayaSend.status} — ${JSON.stringify(mayaSend.log).slice(0, 1_500)}`);
    check("real Claude, as the courier's model, delivers the approved text once to the right person, verified on the page",
      mayaSend.status === "sent" && received.filter((item) => item.to === "maya_d").length === 1 && received.find((item) => item.to === "maya_d")!.text === mayaSend.body.trim(), { mayaSend, received });
  }

  check("nothing reached anyone but the fixture's recipients, and each got one message", received.every((item) => ["priya_k", "maya_d"].includes(item.to)) && new Set(received.map((item) => item.to)).size === received.length, received);
  console.log(`Live browser outreach checks: ${checks} passed. Real extension in a visible Chromium ${await ctx.browser()?.version() ?? ""} (Xvfb), real local server; an X-like fixture site; ${REAL ? "real Claude CLI (this machine's login) for the last delivery, scripted models otherwise" : "scripted models"}; ${courierCalls.length} courier model calls; nobody was messaged.`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => undefined);
  fixtures.stop(true);
  rmSync(work, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
  process.exit();
}

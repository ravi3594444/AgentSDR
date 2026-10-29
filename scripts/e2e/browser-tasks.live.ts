/**
 * Owner-requested browser tasks through the REAL extension (0.18.0) in a
 * VISIBLE Chromium (run it under xvfb-run) and a REAL running AgentSDR:
 * pairing from the chat, a CRM form filled, chosen, ticked and saved, a
 * Spanish registration form, what a task still refuses (in the page too,
 * when the server is bypassed), screenshots in the AgentSDR task window
 * through Chrome's debugger, a drag on a canvas at screenshot points that
 * lands where intended, stale screenshots (the page scrolled or navigated
 * itself), research staying read-only, a lost answer that is never
 * repeated, Stop, and the JSON harness doing a CRM task with a scripted
 * model. With LIVE_REAL_CLAUDE=1, the installed `claude` CLI (this
 * machine's login, not a customer's personal one) also reads a code that
 * exists only in a canvas's pixels, adds a contact, and draws on the board.
 *
 * What is not real here, said plainly: the sites are fixtures served on
 * 127.0.0.1:443 under their names by Chromium's host mapping, and nobody is
 * signed in to anything; the site-permission prompt is pre-answered by a
 * test copy of the manifest (https://*\/*); the window manager is Xvfb's
 * (none), so a task window is never covered by another window here. Nothing
 * is sent to anyone.
 *
 * Needs: `bun run build:recorder`; a server on http://localhost:3000 started
 * with BROWSER_RESEARCH_ALLOW_PRIVATE=true on the same disposable
 * DATABASE_URL; root (port 443); a display (xvfb-run -a).
 *
 *   DATABASE_URL=postgres://…@127.0.0.1:<port>/agentsdr_native \
 *     xvfb-run -a bun run --conditions=react-server scripts/e2e/browser-tasks.live.ts
 */
import { mock } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type BrowserContext } from "playwright-core";

if (!/^postgres(?:ql)?:\/\/[^/]+@(localhost|127\.0\.0\.1):\d+\/agentsdr_native$/.test(process.env.DATABASE_URL ?? "")) throw new Error("Requires the disposable local agentsdr_native database");
if (!process.env.DISPLAY) throw new Error("Run under a display (xvfb-run -a): the task window is a real, visible window");
process.env.BROWSER_RESEARCH_ALLOW_PRIVATE = "true";
process.env.GEOCODER_URL = "off";
const base = "http://localhost:3000";
const root = resolve(import.meta.dir, "../..");
const chromeExecutable = process.env.BROWSER_EXECUTABLE_PATH ?? "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome";

// The JSON harness's model, scripted; the vision check says it sees images. The authority judge is
// scripted too, except with LIVE_REAL_CLAUDE=1, where the organization's real engine (Claude) judges.
let apiReplies: string[] = [];
const apiImages: number[] = [];
const realStructured = (await import(join(root, "src/lib/ai/server/structuredCompletion.ts"))).completeStructured as (input: unknown) => Promise<unknown>;
let realJudge = false;
const scriptedJudge = (prompt: string) => {
  const said = prompt.split("THE OWNER'S MESSAGES IN THIS REQUEST").at(-1)!.toLowerCase();
  const change = /\b(?:add|rellena|draw|save)\b/.test(said) && !said.includes("research only");
  return { kinds: change ? ["interact"] : [], purchase: null, recipients: "none", missing: "", reason: "scripted" };
};
mock.module(join(root, "src/lib/ai/server/structuredCompletion.ts"), () => ({ completeStructured: async (input: { schemaName: string; userPrompt: string; images?: unknown[]; accept: (text: string) => void }) => {
  if (input.schemaName === "browser_authority") {
    if (realJudge) return realStructured(input);
    const text = JSON.stringify(scriptedJudge(input.userPrompt));
    input.accept(text);
    return { text, model: "scripted-judge", response: {}, usage: {} };
  }
  if (input.schemaName !== "assistant_reply") throw new Error(`Unexpected AI stage ${input.schemaName}`);
  apiImages.push(input.images?.length ?? 0);
  // The script adds a step's reply once it knows what the step before it opened.
  for (let waited = 0; !apiReplies.length && waited < 60_000; waited += 100) await new Promise((done) => setTimeout(done, 100));
  const text = apiReplies.shift() ?? JSON.stringify({ message: "Done.", actions: [], suggestions: [] });
  input.accept(text);
  return { text, model: "fake-api", response: {}, usage: {} };
} }));
mock.module(join(root, "src/lib/ai/server/vision.server.ts"), () => ({ structuredVision: async () => ({ supported: true, detail: "the scripted model sees images" }) }));

const { and, eq } = await import("drizzle-orm");
const { hashPassword } = await import("better-auth/crypto");
const { db } = await import("@/lib/db");
const { accounts, members, organizations, users } = await import("@/lib/auth/schema");
const { browserConnections } = await import("@/lib/browser/connected/schema");
const { runInOrganization } = await import("@/lib/tenancy/scope");
const { addMessage, createThread, listMessages } = await import("@/lib/assistant/threads.server");
const { runAgentTurn, runToolInThread } = await import("@/lib/assistant/agent.server");
const { releaseConnectedBrowser } = await import("@/lib/assistant/tools.server");
const { updateBusinessProfile } = await import("@/lib/assistant/profile.server");
const connections = await import("@/lib/browser/connected/connections.server");
const cli = await import("@/lib/ai/claudeCode/cli.server");
const engine = await import("@/lib/ai/claudeCode/engine.server");
const { resetRunnerForTests } = await import("@/lib/ai/claudeCode/runner.server");
type ToolContext = import("@/lib/assistant/tools.server").ToolContext;
type ToolResult = import("@/lib/assistant/tools.server").ToolResult;

let checks = 0;
function check(label: string, value: unknown, observed?: unknown) {
  if (!value) throw new Error(`FAIL ${label}${observed === undefined ? "" : ` — ${JSON.stringify(observed).slice(0, 1_200)}`}`);
  checks++;
  console.log(`PASS ${label}`);
}
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function until<T>(label: string, read: () => Promise<T>, ok: (value: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(250);
  }
}

// --- Fixture sites over https on 127.0.0.1:443 ---------------------------------------------------
const CRM = "crm.northwind-crm.com";
const EVENTS = "eventos-pune.com";
const BOARD = "board.canvas-board.com";
// Letters only: no id or time in a tool's text can contain it by chance.
const CODE = Array.from({ length: 4 }, () => "ABCDEFGHJKMNPQRSTUVWXYZ"[Math.floor(Math.random() * 23)]).join("");
const saved: Record<string, string>[] = [];
const registrations: Record<string, string>[] = [];
const drags: { from: number[]; to: number[]; trusted: boolean }[] = [];
let sends = 0;
let slowSaves = 0;
const work = mkdtempSync(join(tmpdir(), "agentsdr-browser-tasks-live-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=fixture", "-days", "1", "-keyout", join(work, "key.pem"), "-out", join(work, "cert.pem")], { stdio: "ignore" });
const html = (title: string, body: string) => new Response(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{margin:0;font:16px sans-serif} label{display:block;margin-top:8px}</style></head><body>${body}</body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
const form = async (request: Request) => Object.fromEntries([...(await request.formData()).entries()].map(([key, value]) => [key, String(value)]));
const fixtures = Bun.serve({
  hostname: "127.0.0.1",
  port: 443,
  tls: { cert: readFileSync(join(work, "cert.pem"), "utf8"), key: readFileSync(join(work, "key.pem"), "utf8") },
  async fetch(request) {
    const url = new URL(request.url);
    const host = (request.headers.get("host") ?? "").replace(/:\d+$/, "");
    if (host === CRM) {
      if (url.pathname === "/contacts/new") return html("Northwind CRM — New contact", `<h1>Northwind CRM — New contact</h1>
        <form method="post" action="/contacts">
          <label for="email">Email</label><input id="email" name="email" type="email" required>
          <label for="first">First name</label><input id="first" name="first">
          <label for="stage">Lifecycle stage</label><select id="stage" name="stage"><option>Lead</option><option>Customer</option><option>Partner</option></select>
          <label><input type="checkbox" name="subscribed" value="yes"> Subscribed to newsletter</label>
          <label for="notes">Notes</label><textarea id="notes" name="notes"></textarea>
          <label for="card">Card number for invoices</label><input id="card" name="card" autocomplete="cc-number">
          <button>Save contact</button>
        </form>
        <section><h2>Email this contact</h2><div contenteditable="true" aria-label="Email body" style="min-height:40px;border:1px solid #999"></div>
          <button type="button" onclick="fetch('/send', { method: 'POST' })">Send</button></section>`);
      if (url.pathname === "/contacts" && request.method === "POST") {
        const record = await form(request);
        saved.push(record);
        return html("Contact saved", `<h1>Contact saved</h1><p>${(record.email ?? "").replace(/[<>&]/g, "")} · ${(record.stage ?? "").replace(/[<>&]/g, "")} · newsletter ${record.subscribed === "yes" ? "on" : "off"}</p>`);
      }
      if (url.pathname === "/slow/new") return html("Northwind CRM — Slow form", `<form method="post" action="/slow"><label for="e">Email</label><input id="e" name="email"><button>Save contact</button></form>`);
      if (url.pathname === "/slow" && request.method === "POST") {
        slowSaves += 1;
        await sleep(12_000);
        return html("Saved slowly", "<h1>Saved</h1>");
      }
      if (url.pathname === "/send" && request.method === "POST") {
        sends += 1;
        return new Response("sent");
      }
    }
    if (host === EVENTS) {
      if (url.pathname === "/registro") {
        if (request.method === "POST") {
          registrations.push(await form(request));
          return html("Inscripción recibida", "<h1>¡Inscripción recibida!</h1>");
        }
        return html("Inscripción — Expo Dental Pune", `<h1>Inscripción — Expo Dental Pune</h1>
          <form method="post" action="/registro"><label for="n">Nombre</label><input id="n" name="nombre"><label for="c">Correo electrónico</label><input id="c" type="email" name="correo">
          <label><input type="checkbox" name="terminos" value="si"> Acepto los términos</label><button>Enviar inscripción</button></form>`);
      }
    }
    if (host === BOARD) {
      if (url.pathname === "/drag" && request.method === "POST") {
        drags.push(await request.json() as { from: number[]; to: number[]; trusted: boolean });
        return new Response("ok");
      }
      if (url.pathname === "/board") return html("Team board", `<h1 style="margin:8px">Team board</h1><p style="margin:8px">Join the two dots with a line.</p>
        <canvas id="c" style="position:absolute;left:40px;top:120px;width:600px;height:300px;border:0"></canvas>
        <script>
          const c = document.getElementById("c"), g = c.getContext("2d"), r = devicePixelRatio || 1;
          c.width = 600 * r; c.height = 300 * r; g.scale(r, r);
          g.fillStyle = "#fff"; g.fillRect(0, 0, 600, 300); g.strokeStyle = "#333"; g.strokeRect(0.5, 0.5, 599, 299);
          g.fillStyle = "#c00"; g.font = "bold 56px sans-serif"; g.fillText(${JSON.stringify(CODE.split("").join(" "))}, 30, 80);
          g.fillStyle = "#06c"; for (const x of [80, 520]) { g.beginPath(); g.arc(x, 220, 12, 0, 7); g.fill(); }
          let down = null;
          c.addEventListener("pointerdown", (e) => { down = { x: e.offsetX, y: e.offsetY, trusted: e.isTrusted }; });
          c.addEventListener("pointerup", (e) => {
            if (!down) return;
            g.strokeStyle = "#0a0"; g.lineWidth = 6; g.beginPath(); g.moveTo(down.x, down.y); g.lineTo(e.offsetX, e.offsetY); g.stroke();
            fetch("/drag", { method: "POST", body: JSON.stringify({ from: [down.x, down.y], to: [e.offsetX, e.offsetY], trusted: down.trusted && e.isTrusted }) });
            down = null;
          });
        </script>`);
      if (url.pathname === "/drifting") return html("Drifting page", `<h1>Drifting</h1><div style="height:4000px">A page that scrolls itself.</div><script>setTimeout(() => scrollTo(0, 600), 6000)</script>`);
      if (url.pathname === "/leaving") return html("Leaving page", `<h1>Leaving</h1><script>setTimeout(() => { location.href = "/board"; }, 6000)</script>`);
    }
    return new Response("not found", { status: 404 });
  },
});

// --- Workspace and person ----------------------------------------------------------------
const stamp = randomUUID();
const email = `owner-${stamp}@browser-tasks.test`;
const password = "Local-browser-tasks-only-123!";
const [org] = await db.insert(organizations).values({ name: "Live browser tasks", slug: `browser-tasks-${stamp}` }).returning();
const [user] = await db.insert(users).values({ name: "Live Owner", email, emailVerified: true }).returning();
await db.insert(accounts).values({ userId: user!.id, accountId: user!.id, providerId: "credential", password: await hashPassword(password) });
await db.insert(members).values({ organizationId: org!.id, userId: user!.id, role: "owner" });
await runInOrganization(org!.id, () => updateBusinessProfile({ businessName: "Smile Software", targetCustomers: "clinics", offer: "booking software", senderName: "Ravi" }, user!.id));
const inOrg = <T>(work: () => Promise<T>) => runInOrganization(org!.id, work);

// --- The extension, its site permission pre-answered in a test copy -----------------------------
const extension = join(work, "extension");
cpSync(join(root, "extensions/whatsapp-recorder/dist"), extension, { recursive: true });
const manifest = JSON.parse(readFileSync(join(extension, "manifest.json"), "utf8")) as { host_permissions: string[]; version: string };
manifest.host_permissions.push("https://*/*");
writeFileSync(join(extension, "manifest.json"), JSON.stringify(manifest, null, 2));

const data = mkdtempSync(join(tmpdir(), "agentsdr-browser-tasks-claude-"));
let context: BrowserContext | null = null;
try {
  context = await chromium.launchPersistentContext(join(work, "profile"), {
    executablePath: chromeExecutable,
    headless: false,
    ignoreHTTPSErrors: true,
    viewport: null,
    // As Chrome runs for a person: Playwright's switches that keep hidden tabs drawing are left out.
    ignoreDefaultArgs: ["--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
    args: ["--no-sandbox", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, `--host-resolver-rules=MAP ${CRM} 127.0.0.1, MAP ${EVENTS} 127.0.0.1, MAP ${BOARD} 127.0.0.1`, "--ignore-certificate-errors", "--no-proxy-server", "--window-size=1280,900"],
  });
  const ctx = context;
  const worker = async () => ctx.serviceWorkers().find((sw) => sw.url().endsWith("/background.js")) ?? ctx.waitForEvent("serviceworker", { timeout: 90_000 });
  const extensionId = new URL((await worker()).url()).host;

  check("the owner signs in", (await ctx.request.post(`${base}/api/auth/sign-in/email`, { headers: { origin: base }, data: { email, password } })).ok());
  check("the workspace is selected", (await ctx.request.post(`${base}/api/auth/organization/set-active`, { headers: { origin: base }, data: { organizationId: org!.id } })).ok());
  const thread = await inOrg(() => createThread(user!.id));
  const app = ctx.pages()[0] ?? await ctx.newPage();
  await app.goto(`${base}/assistant?thread=${thread.id}`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  await app.waitForSelector("html[data-agentsdr-recorder]", { timeout: 60_000 });
  check("the 0.18.0 extension marks the app page", (await app.getAttribute("html", "data-agentsdr-recorder")) === "0.18.0" && manifest.version === "0.18.0");

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
  check("the extension pairs from the chat with all-websites access, reporting 0.18.0", row?.userId === user!.id && row.extensionVersion === "0.18.0" && row.sites.length === 6);
  await connect.close();
  await app.bringToFront();

  // Each owner message is its own request; tools run as the harness runs them, with a model that sees images.
  const ask = async (text: string) => {
    const message = await inOrg(() => addMessage({ threadId: thread.id, role: "user", content: text, createdBy: user!.id }));
    const at: ToolContext = { threadId: thread.id, userId: user!.id, ownerText: text, requestMessageId: message.id, searchRequestId: message.id, v2: true, vision: { supported: true, detail: "test" } };
    return { at, tool: (name: string, args: Record<string, unknown>): Promise<ToolResult> => inOrg(() => runToolInThread(at, name, args)) };
  };
  const n = (summary: string, label: string) => Number(new RegExp(`\\[(\\d+)\\] \\w+ "${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).exec(summary)?.[1]);
  const sw = async <T>(fn: (arg: number) => Promise<T>, arg: number) => (await worker()).evaluate(fn, arg);

  // --- 1. A CRM record, entered and saved ---------------------------------------------------------
  const crm = await ask(`Add Priya Mehta (priya@acme-dental.in) as a new contact in my Northwind CRM at ${CRM}: lifecycle stage Customer, subscribed to the newsletter, note "Met at Pune dental expo".`);
  const page = await crm.tool("browser_tab_open", { url: `https://${CRM}/contacts/new` });
  const tab = Number(page.data?.tabId);
  check("the reading lists the form's fields with their types; the card field's value is never read", page.ok && /"Email" \{email, empty, required\}/.test(page.summary) && /"Lifecycle stage" \{select, = “Lead”, options: Lead \| Customer \| Partner\}/.test(page.summary)
    && /"Subscribed to newsletter" \{checkbox, unchecked\}/.test(page.summary) && /"Card number for invoices" \{text, password\/card\/code: never typed\}/.test(page.summary), page.summary);
  const early = await crm.tool("browser_tab_act", { tab, n: n(page.summary, "Email"), action: "fill", value: "priya@acme-dental.in" });
  check("before browser_task nothing is changed", !early.ok && /has not asked for changes/.test(early.summary), early.summary);
  const task = await crm.tool("browser_task", { ownerWords: "Add Priya Mehta (priya@acme-dental.in) as a new contact in my Northwind CRM", goal: "Add Priya Mehta as a contact" });
  check("the owner's words start a task that changes things (forms, records) and nothing more", task.ok && (task.data as { grant: { kinds: string[] } }).grant.kinds.join() === "interact", task.summary);
  const steps = [
    await crm.tool("browser_tab_act", { tab, n: n(page.summary, "Email"), action: "fill", value: "priya@acme-dental.in" }),
    await crm.tool("browser_tab_act", { tab, n: n(page.summary, "First name"), action: "fill", value: "Priya" }),
    await crm.tool("browser_tab_act", { tab, n: n(page.summary, "Lifecycle stage"), action: "select", value: "Customer" }),
    await crm.tool("browser_tab_act", { tab, n: n(page.summary, "Subscribed to newsletter"), action: "check" }),
    await crm.tool("browser_tab_act", { tab, n: n(page.summary, "Notes"), action: "fill", value: "Met at Pune dental expo" }),
  ];
  check("fields are filled, chosen and ticked in the real page, each read back", steps.every((step) => step.ok) && /now holds “priya@acme-dental.in”/.test(steps[0]!.summary) && /is now “Customer”/.test(steps[2]!.summary) && /is checked/.test(steps[3]!.summary), steps.map((step) => step.summary.split("\n")[0]));
  const card = await crm.tool("browser_tab_act", { tab, n: n(page.summary, "Card number for invoices"), action: "fill", value: "4242424242424242" });
  check("the card number field is refused", !card.ok && /card/.test(card.summary), card.summary);
  const body = await crm.tool("browser_tab_act", { tab, n: n(page.summary, "Email body"), action: "fill", value: "Hi Priya, great to meet you." });
  const send = await crm.tool("browser_tab_act", { tab, n: n(body.summary, "Send"), action: "click" });
  check("a draft may be written, but its Send is refused on the server (the owner asked for a record, not a message)", body.ok && !send.ok && /message people/.test(send.summary), [body.summary.split("\n")[0], send.summary]);
  const grant = { id: "bypass", kinds: ["interact" as const], purchase: null, expiresAt: new Date(Date.now() + 600_000).toISOString() };
  const forced = await inOrg(() => connections.runBrowserAction({ userId: user!.id, threadId: thread.id, requestId: crm.at.searchRequestId!, action: { kind: "act", tabId: tab, n: n(body.summary, "Send"), label: "Send", op: "click", value: null, key: null, grant }, timeoutMs: 30_000 }));
  check("with the server bypassed, the page itself still refuses Send beside a written message under a form grant, and nothing is sent", !forced.ok && /message people/.test(forced.error) && sends === 0, forced);
  const expired = await inOrg(() => connections.runBrowserAction({ userId: user!.id, threadId: thread.id, requestId: crm.at.searchRequestId!, action: { kind: "act", tabId: tab, n: 1, label: "Email", op: "fill", value: "x", key: null, grant: { ...grant, expiresAt: new Date(Date.now() - 1_000).toISOString() } }, timeoutMs: 30_000 }));
  check("the extension refuses a change whose grant has ended", !expired.ok && /has ended/.test(expired.error), expired);
  const save = await crm.tool("browser_tab_act", { tab, n: n(body.summary, "Save contact"), action: "click" });
  check("Save submits the form and the page afterwards shows it saved", save.ok && /Contact saved/.test(save.summary), save.summary);
  check("the CRM received exactly the requested record", saved.length === 1 && saved[0]!.email === "priya@acme-dental.in" && saved[0]!.first === "Priya" && saved[0]!.stage === "Customer" && saved[0]!.subscribed === "yes" && saved[0]!.notes === "Met at Pune dental expo" && !saved[0]!.card, saved);

  // --- 2. A Spanish form: labels in another language, its submit is "Enviar" ------------------------------
  const es = await ask(`Rellena el formulario de inscripción en ${EVENTS}/registro con mi nombre Ravi Kumar y el correo ravi@smile-software.in, y acepta los términos.`);
  const esTask = await es.tool("browser_task", { ownerWords: "Rellena el formulario de inscripción", goal: "Inscribir a Ravi" });
  const esPage = await es.tool("browser_tab_open", { url: `https://${EVENTS}/registro` });
  const esTab = Number(esPage.data?.tabId);
  const esSteps = [
    await es.tool("browser_tab_act", { tab: esTab, n: n(esPage.summary, "Nombre"), action: "fill", value: "Ravi Kumar" }),
    await es.tool("browser_tab_act", { tab: esTab, n: n(esPage.summary, "Correo electrónico"), action: "fill", value: "ravi@smile-software.in" }),
    await es.tool("browser_tab_act", { tab: esTab, n: n(esPage.summary, "Acepto los términos"), action: "check" }),
    await es.tool("browser_tab_act", { tab: esTab, n: n(esPage.summary, "Enviar inscripción"), action: "click" }),
  ];
  check("a Spanish form is filled and its “Enviar inscripción” submits it (no message written)", esTask.ok && esSteps.every((step) => step.ok) && /Inscripción recibida/.test(esSteps[3]!.summary)
    && registrations.length === 1 && registrations[0]!.nombre === "Ravi Kumar" && registrations[0]!.correo === "ravi@smile-software.in" && registrations[0]!.terminos === "si", { steps: esSteps.map((step) => step.summary.split("\n")[0]), registrations });

  // --- 3. A screenshot in the task window, and a drag that lands where it was aimed ------------------------
  const board = await ask(`On my team board at ${BOARD}, draw a line from the left dot to the right dot.`);
  const boardPage = await board.tool("browser_tab_open", { url: `https://${BOARD}/board` });
  const boardTab = Number(boardPage.data?.tabId);
  check("the board's code is nowhere in the page's text: only its pixels show it", boardPage.ok && !boardPage.summary.includes(CODE) && !boardPage.summary.includes(CODE.split("").join(" ")), boardPage.summary);
  const appWindow = await sw(async (tabId) => (await chrome.tabs.get(tabId)).windowId, boardTab);
  const shot = await board.tool("browser_tab_screenshot", { tab: boardTab });
  const width = Number(shot.data?.width);
  const height = Number(shot.data?.height);
  check("a screenshot comes back as a real JPEG image of the visible page", shot.ok && shot.images?.length === 1 && Buffer.from(shot.images[0]!.data, "base64").subarray(0, 3).toString("hex") === "ffd8ff" && width > 600 && height > 400, shot.summary);
  const windows = await sw(async (tabId) => {
    const all = await chrome.windows.getAll({ populate: true });
    const mine = all.find((window) => window.tabs?.some((item) => item.id === tabId));
    return { count: all.length, taskWindow: mine?.id, active: mine?.tabs?.find((item) => item.active)?.id, focused: mine?.focused };
  }, boardTab);
  check("the tab was moved into its own AgentSDR task window, active there and not focused; the owner's window keeps its tab", windows.taskWindow !== appWindow && windows.active === boardTab && windows.focused === false && (await app.evaluate(() => document.visibilityState)) === "visible", { windows, appWindow });
  // Only this extension's own attachment answers its commands (Playwright's sessions are not the extension's).
  const ours = (tabId: number) => sw(async (id) => chrome.debugger.sendCommand({ tabId: id }, "Runtime.evaluate", { expression: "1" }).then(() => true, () => false), tabId);
  check("the extension's debugger is attached to that tab, not to the owner's app tab", await ours(boardTab) && !(await ours(await sw(async () => (await chrome.tabs.query({ url: "http://localhost:3000/*" }))[0]!.id!, 0))));
  const shotFacts = await inOrg(() => connections.latestTabScreenshot(user!.id, board.at.searchRequestId!, boardTab));
  const scale = shotFacts!.scale;
  // The dots are at CSS (40 + 80, 120 + 220) and (40 + 520, 120 + 220) in the viewport: in the image, × scale.
  const noTask = await board.tool("browser_tab_visual", { tab: boardTab, screenshot: shotFacts!.id, action: "drag", x: 120 * scale, y: 340 * scale, toX: 560 * scale, toY: 340 * scale });
  check("before browser_task, a drag is refused", !noTask.ok && drags.length === 0, noTask.summary);
  const readOnlyClick = await board.tool("browser_tab_visual", { tab: boardTab, screenshot: shotFacts!.id, action: "click", x: 300 * scale, y: 300 * scale });
  check("before browser_task, a click on the canvas is refused in the page (not a link, tab or \"more\" control)", !readOnlyClick.ok && /not clicked/.test(readOnlyClick.summary) && drags.length === 0, readOnlyClick.summary);
  const boardTask = await board.tool("browser_task", { ownerWords: "draw a line from the left dot to the right dot", goal: "Join the two dots" });
  const shot2 = await board.tool("browser_tab_screenshot", { tab: boardTab });
  const drag = await board.tool("browser_tab_visual", { tab: boardTab, screenshot: String(shot2.data?.screenshotId), action: "drag", x: Math.round(120 * scale), y: Math.round(340 * scale), toX: Math.round(560 * scale), toY: Math.round(340 * scale) });
  await until("the board to report the drag", async () => drags.length, (count) => count >= 1, 10_000);
  const [line] = drags;
  check("the drag reaches the canvas as the browser's own input, from dot to dot within 2 CSS pixels", boardTask.ok && drag.ok && line!.trusted === true
    && Math.abs(line!.from[0]! - 80) <= 2 && Math.abs(line!.from[1]! - 220) <= 2 && Math.abs(line!.to[0]! - 520) <= 2 && Math.abs(line!.to[1]! - 220) <= 2, { drag: drag.summary, line, scale });
  check("the step returns a new screenshot, and the one it was taken from is no longer a target", drag.images?.length === 1 && !(await board.tool("browser_tab_visual", { tab: boardTab, screenshot: String(shot2.data?.screenshotId), action: "click", x: 5, y: 5 })).ok);

  // --- 4. Stale targets the server cannot see: the page scrolled or navigated itself -----------------------
  const drifting = await board.tool("browser_tab_open", { url: `https://${BOARD}/drifting`, tab: boardTab });
  const driftShot = await board.tool("browser_tab_screenshot", { tab: boardTab });
  await sleep(7_000);
  const drifted = await board.tool("browser_tab_visual", { tab: boardTab, screenshot: String(driftShot.data?.screenshotId), action: "click", x: 100, y: 100 });
  check("a page that scrolled itself since the screenshot: the extension refuses the stale point", drifting.ok && !drifted.ok && /scrolled, resized or zoomed/.test(drifted.summary), drifted.summary);
  await board.tool("browser_tab_open", { url: `https://${BOARD}/leaving`, tab: boardTab });
  const leaveShot = await board.tool("browser_tab_screenshot", { tab: boardTab });
  await sleep(7_000);
  const left = await board.tool("browser_tab_visual", { tab: boardTab, screenshot: String(leaveShot.data?.screenshotId), action: "click", x: 100, y: 100 });
  check("a page that navigated itself since the screenshot: refused as another page", !left.ok && /another page|not this tab's latest/.test(left.summary), left.summary);

  // --- 5. A lost answer: the change happened once, is reported uncertain, and is never repeated ----------------
  const slow = await ask(`In my Northwind CRM at ${CRM}, save priya@acme-dental.in on the slow form.`);
  await slow.tool("browser_task", { ownerWords: "save priya@acme-dental.in on the slow form", goal: "Save the email" });
  const slowPage = await slow.tool("browser_tab_open", { url: `https://${CRM}/slow/new` });
  const slowTab = Number(slowPage.data?.tabId);
  await slow.tool("browser_tab_act", { tab: slowTab, n: n(slowPage.summary, "Email"), action: "fill", value: "priya@acme-dental.in" });
  const lost = await inOrg(() => connections.runBrowserAction({ userId: user!.id, threadId: thread.id, requestId: slow.at.searchRequestId!, action: { kind: "act", tabId: slowTab, n: n(slowPage.summary, "Save contact"), label: "Save contact", op: "click", value: null, key: null, grant: { ...grant, id: "slow" } }, timeoutMs: 4_000 }).catch((error: unknown) => error));
  await sleep(20_000);
  check("a save whose answer came too late is reported as taken but unanswered, and the form was submitted exactly once", lost instanceof connections.BrowserConnectionError && /took the step/.test(lost.message) && slowSaves === 1, { lost: String(lost), slowSaves });

  // --- 6. Research stays read-only; Stop stops tasks too ---------------------------------------------------
  const research = await ask(`Research only: look at my team board at ${BOARD} and tell me what it shows. Change nothing.`);
  const researchTask = await research.tool("browser_task", { ownerWords: "look at my team board", goal: "draw" });
  check("a research request cannot start a task", !researchTask.ok && /read-only/.test(researchTask.summary), researchTask.summary);
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.getByRole("button", { name: "Stop", exact: true }).click();
  await until("the app to hear Stop", () => inOrg(() => connections.browserConnectionView(user!.id)), (view) => view.state === "paused", 30_000);
  const stopped = await board.tool("browser_tab_screenshot", { tab: boardTab });
  check("after Stop no screenshot or change runs", !stopped.ok && /Stop/.test(stopped.summary), stopped.summary);
  await popup.reload();
  await popup.getByRole("button", { name: "Resume", exact: true }).click();
  await until("the app to hear Resume", () => inOrg(() => connections.browserConnectionView(user!.id)), (view) => view.state !== "paused", 30_000);
  await popup.close();

  // --- 7. The JSON harness, with a scripted model: a CRM task end to end -----------------------------------
  saved.length = 0;
  const apiThread = await inOrg(() => createThread(user!.id));
  const apiText = `Add Rahul Shah (rahul@shah-dental.in) to my Northwind CRM at ${CRM} as a Lead.`;
  apiReplies = [
    JSON.stringify({ message: "", actions: [{ tool: "browser_task", args: { ownerWords: "Add Rahul Shah (rahul@shah-dental.in) to my Northwind CRM", goal: "Add Rahul as a lead" } }, { tool: "browser_tab_open", args: { url: `https://${CRM}/contacts/new` } }], suggestions: [] }),
  ];
  const fill = (summary: string) => [
    { tool: "browser_tab_act", args: { tab: "TAB", n: n(summary, "Email"), action: "fill", value: "rahul@shah-dental.in" } },
    { tool: "browser_tab_act", args: { tab: "TAB", n: n(summary, "First name"), action: "fill", value: "Rahul" } },
    { tool: "browser_tab_act", args: { tab: "TAB", n: n(summary, "Save contact"), action: "click" } },
  ];
  // The scripted model's later steps need the tab the first step opened: they are added once it exists.
  const apiTurn = inOrg(() => runAgentTurn({ threadId: apiThread.id, userId: user!.id, text: apiText }));
  const opened2 = await until("the API turn to open the form", () => inOrg(() => listMessages(apiThread.id)), (messages) => messages.some((message) => message.tool === "browser_tab_open" && message.status === "ok"), 60_000);
  const openRow = opened2.find((message) => message.tool === "browser_tab_open")!;
  const apiTab = (openRow.toolResult as { data?: { tabId?: number } }).data?.tabId;
  for (const action of fill(openRow.content)) apiReplies.push(JSON.stringify({ message: "", actions: [{ ...action, args: { ...action.args, tab: apiTab } }], suggestions: [] }));
  apiReplies.push(JSON.stringify({ message: "Rahul Shah is saved in your Northwind CRM as a lead.", actions: [], suggestions: [] }));
  const apiEnd = await apiTurn;
  check("an ordinary API model's turn does a CRM task through the same tools and the real extension", apiEnd === "done" && saved.length === 1 && saved[0]!.email === "rahul@shah-dental.in" && saved[0]!.stage === "Lead", { apiEnd, saved, messages: (await inOrg(() => listMessages(apiThread.id))).map((message) => `${message.tool}/${message.status}: ${message.content.slice(0, 160)}`) });

  // --- 8. Real Claude (this machine's CLI login): pixels only, a contact, a drawing ---------------------------
  if (process.env.LIVE_REAL_CLAUDE === "1") {
    engine.setOperatorOrganizationForTests(org!.id);
    cli.setClaudeDataDirForTests(data);
    cli.setClaudeCliForTests(null);
    resetRunnerForTests();
    const paths = cli.accountPaths({ organizationId: org!.id, userId: user!.id });
    writeFileSync(join(paths.config, ".credentials.json"), "fake", { mode: 0o600 });
    await inOrg(() => engine.saveClaudeEngine({ selected: true, ownerUserId: user!.id, model: "sonnet", checks: {} }));
    realJudge = true;
    const real = async (text: string) => {
      const realThread = await inOrg(() => createThread(user!.id));
      const end = await inOrg(() => runAgentTurn({ threadId: realThread.id, userId: user!.id, text }));
      const messages = await inOrg(() => listMessages(realThread.id));
      console.log(`REAL CLAUDE (${end}):\n  ${messages.map((message) => `${message.role}/${message.tool ?? "-"}/${message.status ?? "-"}: ${message.content.replace(/\s+/g, " ").slice(0, 200)}`).join("\n  ")}`);
      return { end, messages, answer: messages.filter((message) => message.role === "assistant").map((message) => message.content).join("\n") };
    };
    const pixels = await real(`Research only, change nothing: open https://${BOARD}/board in my connected browser, take a screenshot, and tell me the four-character code written in red on the board.`);
    const toolText = pixels.messages.filter((message) => message.role === "tool").map((message) => message.content).join("\n");
    check("real Claude reports the code that only the screenshot's pixels showed", pixels.end === "done" && pixels.messages.some((message) => message.tool === "browser_tab_screenshot" && message.status === "ok")
      && pixels.answer.replace(/\s+/g, "").toUpperCase().includes(CODE) && !toolText.replace(/\s+/g, "").includes(CODE), { code: CODE, answer: pixels.answer });
    saved.length = 0;
    const contact = await real(`Add Anita Rao (anita@rao-ortho.in) as a new contact in my Northwind CRM at https://${CRM}/contacts/new, lifecycle stage Partner, not subscribed. Save it and check it was saved.`);
    check("real Claude enters and saves the requested contact through the extension", contact.end === "done" && saved.length === 1 && saved[0]!.email === "anita@rao-ortho.in" && saved[0]!.stage === "Partner" && saved[0]!.subscribed !== "yes", { saved, answer: contact.answer });
    drags.length = 0;
    const drawing = await real(`On my team board at https://${BOARD}/board, draw a line from the left blue dot to the right blue dot.`);
    const [realLine] = drags;
    check("real Claude draws from dot to dot by sight (within 15 CSS pixels)", drawing.end === "done" && realLine?.trusted === true
      && Math.abs(realLine.from[0]! - 80) <= 15 && Math.abs(realLine.from[1]! - 220) <= 15 && Math.abs(realLine.to[0]! - 520) <= 15 && Math.abs(realLine.to[1]! - 220) <= 15, { drags, answer: drawing.answer });
  }

  // --- 9. The turn ends: tabs close, the debugger lets go -------------------------------------------------
  for (const request of [crm, es, board, slow, research]) await inOrg(() => releaseConnectedBrowser(request.at));
  await until("task tabs to close", async () => (await (await worker()).evaluate(() => chrome.tabs.query({}))).filter((item) => /northwind|eventos|canvas-board/.test(item.url ?? "")).length, (count) => count === 0, 45_000);
  const stillOurs = await (await worker()).evaluate(async () => {
    let count = 0;
    for (const item of await chrome.tabs.query({})) if (await chrome.debugger.sendCommand({ tabId: item.id! }, "Runtime.evaluate", { expression: "1" }).then(() => true, () => false)) count += 1;
    return count;
  });
  check("released task tabs close and the extension's debugger is attached nowhere", stillOurs === 0);
  check("nothing was ever sent from the CRM's composer", sends === 0);

  console.log(`Live browser task checks: ${checks} passed. Real extension in a visible Chromium ${await ctx.browser()?.version() ?? ""} (Xvfb), real local server; fixture sites; ${process.env.LIVE_REAL_CLAUDE === "1" ? "real Claude CLI (this machine's login) and a scripted API model" : "scripted models"}; nothing sent.`);
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

/**
 * The assistant's remote browser end to end against the local database,
 * with the real tools (browser_open … browser_close), a stand-in of
 * TinyFish's Browser API (fetch intercepted for *.tf.test) and a fake page
 * instead of playwright-core: off until the owner allows minutes; one
 * browser per organization; minutes reserved on open and settled on close;
 * idle sessions swept and ended at TinyFish; a 402 asks for Wallet funds and
 * charges nothing; private, login-walled and Reddit addresses refused before
 * any session; passwords never typed; a click landing on a login wall
 * reported, and the page it left open never read or scrolled afterwards; a
 * second organization's browser independent.
 *
 *   bun run --conditions=react-server scripts/e2e/browser.ts
 *
 * Creates its own organizations ("Browser check …") and leaves them.
 * Refuses a non-local DATABASE_URL.
 */
import { and, desc, eq } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}

const stamp = Date.now();
const KEY = `sk-tinyfish-browser-check-${stamp}`;
const calls: { method: string; path: string; body: unknown }[] = [];
let createAnswer: () => Response = () => json(201, { session_id: `br-${calls.length}`, cdp_url: `wss://cdp.tf.test/${calls.length}`, base_url: "https://cdp.tf.test" });
function json(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (!url.hostname.endsWith(".tf.test")) return realFetch(input, init);
  const method = init?.method ?? "GET";
  calls.push({ method, path: `${url.hostname}${url.pathname}`, body: init?.body ? JSON.parse(String(init.body)) : null });
  if (url.hostname === "search.tf.test") return json(200, { results: [] });
  if (url.hostname === "browser.tf.test" && method === "POST") return createAnswer();
  if (url.hostname === "browser.tf.test" && method === "DELETE") return new Response(null, { status: 204 });
  return json(404, {});
}) as typeof fetch;

const { db } = await import("@/lib/db");
const { organizations, users, members } = await import("@/lib/auth/schema");
const { runInOrganization } = await import("@/lib/tenancy/scope");
const { setTinyfishApiBase } = await import("@/services/tinyfish");
const { saveTinyfishSettings } = await import("@/lib/tinyfish/tinyfish.server");
const { setBrowserConnector } = await import("@/lib/browser/driver.server");
const { sweepBrowserSessions } = await import("@/lib/browser/browser.server");
const { browserSessions } = await import("@/lib/browser/schema");
const { providerUsage } = await import("@/lib/quota/schema");
const { runTool } = await import("@/lib/assistant/tools.server");
const { createThread } = await import("@/lib/assistant/threads.server");
setTinyfishApiBase({ search: "https://search.tf.test", fetch: "https://fetch.tf.test", browser: "https://browser.tf.test" });

// A fake page: two pages of a directory, a login wall behind element 3.
const pageLog: string[] = [];
setBrowserConnector(async (cdpUrl) => {
  let url = "about:blank";
  pageLog.push(`connect ${cdpUrl}`);
  const elements = () => url.includes("login")
    ? []
    : [
        { n: 1, tag: "a", type: null, label: "Next page", href: "https://example.com/agents?page=2" },
        { n: 2, tag: "input", type: "search", label: "Search agents", href: null },
        { n: 3, tag: "a", type: null, label: "Sign in with Instagram", href: "https://www.instagram.com/accounts/login/" },
        { n: 4, tag: "input", type: "password", label: "Password", href: null },
      ];
  return {
    goto: async (next) => {
      url = next;
      pageLog.push(`goto ${next}`);
    },
    snapshot: async () => ({ url, title: url.includes("page=2") ? "Agents · page 2" : "Agents in Pune", text: url.includes("page=2") ? "More agents: Patil Realty, write to hello@patilrealty.in" : "Real estate agents in Pune: Shah Homes", elements: elements() }),
    click: async (n) => {
      pageLog.push(`click ${n}`);
      if (n === 1) url = "https://example.com/agents?page=2";
      if (n === 3) url = "https://www.instagram.com/accounts/login/";
    },
    fill: async (n, value, submit) => {
      pageLog.push(`fill ${n} ${value} ${submit}`);
    },
    scroll: async () => {
      pageLog.push("scroll");
    },
    url: () => url,
    disconnect: async () => {
      pageLog.push("disconnect");
    },
  };
});

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function organization(label: string) {
  const [org] = await db.insert(organizations).values({ name: `Browser check ${label} ${stamp}`, slug: `browser-check-${label}-${stamp}` }).returning();
  const [owner] = await db.insert(users).values({ name: `Owner ${label}`, email: `owner-${label}-${stamp}@browser-check.test`, emailVerified: true }).returning();
  await db.insert(members).values({ organizationId: org!.id, userId: owner!.id, role: "owner" });
  return { org: org!, owner: owner! };
}
const a = await organization("a");
const b = await organization("b");
const creates = () => calls.filter((call) => call.path === "browser.tf.test/" && call.method === "POST").length;
const deletes = () => calls.filter((call) => call.method === "DELETE").length;

await runInOrganization(a.org.id, async () => {
  await saveTinyfishSettings({ key: KEY }, a.owner.id);
  const thread = await createThread(a.owner.id);
  const other = await createThread(a.owner.id);
  const ctx = (threadId: string) => ({ threadId, userId: a.owner.id, ownerText: "find agents" });

  const off = await runTool("browser_open", { url: "https://example.com/agents" }, ctx(thread.id));
  check("minutes a day 0 (the default): the browser is off and nothing is created", !off.ok && /browser is off/.test(off.summary) && creates() === 0, off.summary);

  await saveTinyfishSettings({ browserMinutesPerDay: 30 }, a.owner.id);
  for (const url of ["http://127.0.0.1:3000/", "https://www.instagram.com/someone/", "https://www.reddit.com/r/realestate/"]) {
    const refused = await runTool("browser_open", { url }, ctx(thread.id));
    check(`${new URL(url).hostname} is refused before any session`, !refused.ok && creates() === 0, refused.summary);
  }

  const opened = await runTool("browser_open", { url: "https://example.com/agents" }, ctx(thread.id));
  const [session] = await db.select().from(browserSessions).where(eq(browserSessions.organizationId, a.org.id)).orderBy(desc(browserSessions.startedAt)).limit(1);
  const createBody = calls.find((call) => call.method === "POST" && call.path === "browser.tf.test/")?.body as { url?: string; timeout_seconds?: number } | undefined;
  check("opening creates one TinyFish session that ends itself after 5 idle minutes", opened.ok && creates() === 1 && createBody?.timeout_seconds === 300 && createBody.url === "https://example.com/agents", opened.summary.slice(0, 120));
  check("the page comes back with numbered elements", /\[1\] link "Next page"/.test(opened.summary) && /Shah Homes/.test(opened.summary));
  check("the session is recorded open, its CDP URL encrypted", session?.status === "open" && Boolean(session.encryptedCdpUrl) && !session.encryptedCdpUrl!.startsWith("wss://"));
  const [reserved] = await db.select().from(providerUsage).where(and(eq(providerUsage.organizationId, a.org.id), eq(providerUsage.product, "browser")));
  check("its 10 minutes are reserved against today's allowance", reserved?.status === "reserved" && reserved.units === 10);

  const busy = await runTool("browser_open", { url: "https://example.com/" }, ctx(other.id));
  check("another chat of the organization waits: one browser at a time", !busy.ok && /in use by another chat/.test(busy.summary) && creates() === 1, busy.summary);

  const next = await runTool("browser_click", { n: 1 }, ctx(thread.id));
  check("a click returns the next page", next.ok && /page 2/.test(next.summary) && /patilrealty/.test(next.summary));
  const typed = await runTool("browser_fill", { n: 2, text: "Baner", submit: true }, ctx(thread.id));
  check("typing into a search box works", typed.ok && pageLog.includes("fill 2 Baner true"));
  const secret = await runTool("browser_fill", { n: 4, text: "hunter2" }, ctx(thread.id));
  check("a password field is never typed into", !secret.ok && /never types credentials/.test(secret.summary) && !pageLog.some((line) => line.startsWith("fill 4")));
  const walled = await runTool("browser_click", { n: 3 }, ctx(thread.id));
  check("a click that lands on a login wall is reported and its content not used", !walled.ok && /needs a login/.test(walled.summary), walled.summary);
  // The browser stays on the refused page: reading or scrolling it next is refused the same way.
  const reread = await runTool("browser_read", {}, ctx(thread.id));
  const rescrolled = await runTool("browser_scroll", { direction: "down" }, ctx(thread.id));
  check("reading or scrolling the refused page returns none of it", [reread, rescrolled].every((step) => !step.ok && /needs a login/.test(step.summary) && !/Shah Homes/.test(step.summary)), `${reread.summary.slice(0, 120)} | ${rescrolled.summary.slice(0, 120)}`);

  const closed = await runTool("browser_close", {}, ctx(thread.id));
  const [settled] = await db.select().from(providerUsage).where(eq(providerUsage.id, reserved!.id));
  check("closing ends it at TinyFish and settles the minutes used", closed.ok && deletes() === 1 && settled?.status === "settled" && settled.usedUnits === 1, `${closed.summary} ${settled?.status} ${settled?.usedUnits}`);
  const notOpen = await runTool("browser_read", {}, ctx(thread.id));
  check("after closing, a step asks to open first", !notOpen.ok && /open the page with browser_open/.test(notOpen.summary));

  // ---------------------------------------------------------- idle sessions are swept
  const again = await runTool("browser_open", { url: "https://example.com/agents" }, ctx(other.id));
  const [idle] = await db.select().from(browserSessions).where(and(eq(browserSessions.organizationId, a.org.id), eq(browserSessions.status, "open")));
  await db.update(browserSessions).set({ lastUsedAt: new Date(Date.now() - 6 * 60_000) }).where(eq(browserSessions.id, idle!.id));
  const swept = await sweepBrowserSessions();
  const [after] = await db.select().from(browserSessions).where(eq(browserSessions.id, idle!.id));
  check("an idle session is swept: ended at TinyFish and closed", again.ok && swept === 1 && after?.status === "closed" && deletes() === 2);

  // ---------------------------------------------------------- the day's allowance
  await saveTinyfishSettings({ browserMinutesPerDay: 11 }, a.owner.id);
  const short = await runTool("browser_open", { url: "https://example.com/agents" }, ctx(thread.id));
  check("less than one session's minutes left today: refused with what is left", !short.ok && /has 9 left/.test(short.summary), short.summary);

  // ---------------------------------------------------------- a 402 charges nothing
  await saveTinyfishSettings({ browserMinutesPerDay: 60 }, a.owner.id);
  createAnswer = () => json(402, { error: { code: "INSUFFICIENT_CREDITS" } });
  const poor = await runTool("browser_open", { url: "https://example.com/agents" }, ctx(thread.id));
  const [failedUsage] = await db.select().from(providerUsage).where(and(eq(providerUsage.organizationId, a.org.id), eq(providerUsage.product, "browser"))).orderBy(desc(providerUsage.createdAt)).limit(1);
  check("an empty TinyFish Wallet: not opened, never topped up, no minutes counted", !poor.ok && /Wallet/.test(poor.summary) && /never tops it up/.test(poor.summary) && failedUsage?.status === "failed" && failedUsage.usedUnits === 0, poor.summary);
  createAnswer = () => json(201, { session_id: `br-b-${calls.length}`, cdp_url: `wss://cdp.tf.test/b${calls.length}`, base_url: "https://cdp.tf.test" });
});

await runInOrganization(b.org.id, async () => {
  const sessions = await db.select().from(browserSessions).where(eq(browserSessions.organizationId, b.org.id));
  await saveTinyfishSettings({ key: KEY, browserMinutesPerDay: 20 }, b.owner.id);
  const thread = await createThread(b.owner.id);
  const own = await runTool("browser_open", { url: "https://example.com/agents" }, { threadId: thread.id, userId: b.owner.id, ownerText: "x" });
  check("B sees none of A's sessions and has its own browser", sessions.length === 0 && own.ok);
  await runTool("browser_close", {}, { threadId: thread.id, userId: b.owner.id, ownerText: "x" });
});

setBrowserConnector(null);
setTinyfishApiBase(null);
globalThis.fetch = realFetch;
console.log(failures ? `\n${failures} check(s) failed` : "\nAll browser checks passed");
process.exit(failures ? 1 : 0);

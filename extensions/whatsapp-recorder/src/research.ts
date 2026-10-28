/**
 * Connected-browser research, in the service worker: the owner's Chrome
 * opens and reads pages for the AgentSDR assistant, signed in as the owner,
 * on the sites the owner enabled (src/lib/browser/connected/contract.ts has
 * the whole flow).
 *
 * - The connection (app address, device token, sites, last command run) is
 *   in chrome.storage.local, so it survives a browser restart; the token is
 *   sent only to the app that issued it, never with the site's cookie.
 * - The worker long-polls the app while connected. Chrome suspends idle
 *   workers, so an alarm restarts the poll, and a call to an extension API
 *   while a poll waits keeps it from being suspended mid-command.
 * - Each command runs at most once: its sequence number is saved before it
 *   runs, and an expired, replayed or malformed command is refused.
 * - Tabs it opens are background tabs in one "AgentSDR research" group per
 *   window, each belonging to the request that opened it; a command for
 *   another request cannot touch them. The owner's own tabs are never read
 *   unless they shared one from the toolbar (that page, read only).
 * - Research reads; it does not act for the owner. Clicks on controls that
 *   send, post, follow, connect and the like are refused in the page, and
 *   only search fields take text.
 * - A task the owner asked for (the server checked their words, tasks.ts)
 *   comes with its grant: fields, selects, checkboxes, keys and clicks
 *   ("act"), and screen steps ("visual", screen.ts), only on pages of the
 *   grant's sites before it expires. Even then nothing sends, publishes,
 *   connects or pays, and no password, card or code is read or typed.
 *   A visual step points into the tab's latest screenshot and is refused
 *   once the tab navigated, scrolled or resized since; a fresh screenshot
 *   comes back after it.
 */

import {
  commandProblem,
  grantCovers,
  pageScript,
  pageScriptConfig,
  RESEARCH_LIMITS,
  researchSites,
  researchUrlProblem,
  parseTaskKey,
  siteOfHost,
  BROWSER_DEVICE_HEADER,
  READ_VISUAL_OPS,
  SCREENSHOT_TTL_MS,
  type BrowserPairResponse,
  type BrowserPollRequest,
  type BrowserPollResponse,
  type BrowserResearchAction,
  type BrowserResearchCommand,
  type BrowserResearchResult,
  type BrowserResearchTab,
  type PageOp,
  type PageScriptResult,
  type ResearchAttention,
  type ResearchSiteKey,
  type BrowserScreenshotFacts,
} from "../../../src/lib/browser/connected/contract";
import type { BridgeResult, ResearchMessage, ResearchPairing, ResearchStatus } from "./messages";
import * as screen from "./screen";

type Connection = {
  apiBase: string;
  token: string;
  connectionId: string;
  organizationName: string;
  userEmail: string;
  sites: ResearchSiteKey[];
  /** The last command run (or refused): nothing at or below it runs again. */
  lastSeq: number;
  paused: boolean;
};

/** A tab the extension opened for a request. */
type ResearchTab = { requestId: string; createdAt: number; lastUsedAt: number; attention: ResearchAttention | null };
type SharedTabEntry = { tabId: number; url: string; title: string; sharedAt: number };

const CONNECTION_KEY = "researchConnection";
const DEVICE_KEY = "researchDeviceId";
const TABS_KEY = "researchTabs";
const SHARED_KEY = "researchSharedTabs";
const GROUPS_KEY = "researchGroups";
/** Per tab, its latest screenshot: the only one a visual step may point into. */
const SHOTS_KEY = "researchShots";
const PAIRING_PREFIX = "researchPairing:";
const ALARM = "research-poll";
const GROUP_TITLE = "AgentSDR research";
const POLL_TIMEOUT_MS = 35_000;
const LOAD_TIMEOUT_MS = 30_000;
const PAGE_TIMEOUT_MS = 20_000;
/** executeScript gave no result: the document went away (a navigation) before it answered. */
const NO_ANSWER = "the page could not be read";

let polling = false;
let busy = false;
let lastContactAt: number | null = null;
let lastError: string | null = null;
/** Server time minus this browser's clock, from the last poll: deadlines are the server's. */
let clockOffset = 0;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// --- Storage ------------------------------------------------------------------

async function connection(): Promise<Connection | null> {
  const stored = await chrome.storage.local.get(CONNECTION_KEY);
  return (stored[CONNECTION_KEY] as Connection | undefined) ?? null;
}

// Writes to the connection run one at a time (each reads, changes a field and writes back).
let writes: Promise<unknown> = Promise.resolve();
function serialized<T>(write: () => Promise<T>): Promise<T> {
  const next = writes.then(write);
  writes = next.catch(() => {});
  return next;
}

/**
 * Changes the stored connection; with `token`, only while that is still the
 * stored connection. Work that began on one connection (a poll answer, a
 * 401) must never touch a newer pairing that replaced it meanwhile.
 */
function updateConnection(patch: Partial<Connection>, token?: string): Promise<Connection | null> {
  return serialized(async () => {
    const current = await connection();
    if (!current || (token !== undefined && current.token !== token)) return null;
    const updated = { ...current, ...patch };
    await chrome.storage.local.set({ [CONNECTION_KEY]: updated });
    return updated;
  });
}

async function deviceId(): Promise<string> {
  const stored = await chrome.storage.local.get(DEVICE_KEY);
  const existing = stored[DEVICE_KEY];
  if (typeof existing === "string" && /^[A-Za-z0-9-]{16,64}$/.test(existing)) return existing;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [DEVICE_KEY]: id });
  return id;
}

async function tabsRegistry(): Promise<Record<string, ResearchTab>> {
  const stored = await chrome.storage.session.get(TABS_KEY);
  return (stored[TABS_KEY] as Record<string, ResearchTab> | undefined) ?? {};
}

let tabWrites: Promise<unknown> = Promise.resolve();
function changeTabs(change: (tabs: Record<string, ResearchTab>) => void): Promise<void> {
  const next = tabWrites.then(async () => {
    const tabs = await tabsRegistry();
    change(tabs);
    await chrome.storage.session.set({ [TABS_KEY]: tabs });
  });
  tabWrites = next.catch(() => {});
  return next;
}

type Shot = BrowserScreenshotFacts & { tabId: number };

async function shots(): Promise<Record<string, Shot>> {
  return ((await chrome.storage.session.get(SHOTS_KEY))[SHOTS_KEY] as Record<string, Shot> | undefined) ?? {};
}

let shotWrites: Promise<unknown> = Promise.resolve();
function changeShots(change: (all: Record<string, Shot>) => void): Promise<void> {
  const next = shotWrites.then(async () => {
    const all = await shots();
    change(all);
    await chrome.storage.session.set({ [SHOTS_KEY]: all });
  });
  shotWrites = next.catch(() => {});
  return next;
}

/** After anything that may change the page, its old screenshot is no target any more. */
function forgetShot(tabId: number): Promise<void> {
  return changeShots((all) => {
    delete all[String(tabId)];
  });
}

async function sharedTabs(): Promise<SharedTabEntry[]> {
  const stored = await chrome.storage.session.get(SHARED_KEY);
  return (stored[SHARED_KEY] as SharedTabEntry[] | undefined) ?? [];
}

async function setSharedTabs(tabs: SharedTabEntry[]): Promise<void> {
  await chrome.storage.session.set({ [SHARED_KEY]: tabs.slice(-RESEARCH_LIMITS.maxSharedTabs) });
}

// --- Talking to the app -----------------------------------------------------------

class BridgeHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function bridgeFetch<T>(conn: Pick<Connection, "apiBase" | "token"> | { apiBase: string; token: null }, path: string, body: unknown, timeoutMs = 20_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (conn.token) {
      headers.Authorization = `Bearer ${conn.token}`;
      headers[BROWSER_DEVICE_HEADER] = await deviceId();
    }
    // Never the site's cookie: the device token is the only credential.
    const response = await fetch(`${conn.apiBase}${path}`, { method: "POST", headers, body: JSON.stringify(body), credentials: "omit", signal: controller.signal });
    const data = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!response.ok) throw new BridgeHttpError(response.status, data?.error ?? `the app answered ${response.status}`);
    return data as T;
  } finally {
    clearTimeout(timer);
  }
}

// --- Badge --------------------------------------------------------------------------

/** The toolbar shows research only between calls: a call's REC badge always wins. */
async function researchBadge(): Promise<void> {
  const current = await chrome.action.getBadgeText({});
  if (current === "REC") return;
  const conn = await connection();
  const tabs = await tabsRegistry();
  const attention = Object.values(tabs).some((tab) => tab.attention && tab.attention.kind !== "empty");
  const text = !conn ? "" : conn.paused ? "II" : attention ? "!" : busy ? "AI" : "";
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: attention ? "#d97706" : "#6d28d9" });
  await chrome.action.setTitle({
    title: !conn ? "AgentSDR" : conn.paused ? "AgentSDR research is stopped — click to resume" : attention ? "AgentSDR research: a page needs you" : busy ? "AgentSDR is researching in this browser" : `AgentSDR research connected (${conn.organizationName})`,
  });
}

// --- The poll -------------------------------------------------------------------------

/** Keeps the poll alive while it runs and restarts it from the alarm when Chrome suspended the worker. */
export function startResearch(): void {
  void chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  void pollLoop();
}

async function pollLoop(): Promise<void> {
  if (polling) return;
  polling = true;
  // An extension API call resets the worker's idle timer while a poll is open.
  const keepAlive = setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000);
  let failures = 0;
  try {
    for (;;) {
      const conn = await connection();
      if (!conn) break;
      const body: BrowserPollRequest = {
        extensionVersion: chrome.runtime.getManifest().version,
        sites: conn.sites,
        sharedTabs: (await sharedTabs()).map(({ tabId, url, title }) => ({ tabId, url, title })),
        lastSeq: conn.lastSeq,
        paused: conn.paused,
      };
      let answer: BrowserPollResponse;
      try {
        answer = await bridgeFetch<BrowserPollResponse>(conn, "/api/browser-bridge/poll", body, POLL_TIMEOUT_MS);
      } catch (error) {
        if (error instanceof BridgeHttpError && error.status === 401) {
          // Disconnected from the app, or its person left the workspace; a newer pairing made meanwhile stays.
          lastError = error.message;
          await forget(conn.token);
          continue;
        }
        lastError = error instanceof Error ? error.message : String(error);
        failures += 1;
        // Offline or asleep: back off, the alarm also brings it back.
        await sleep(Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5)));
        continue;
      }
      failures = 0;
      lastError = null;
      lastContactAt = Date.now();
      const serverTime = Date.parse(answer.serverTime);
      if (Number.isFinite(serverTime)) clockOffset = serverTime - Date.now();
      // The answer belongs to the connection that asked; once that one is replaced, the rest is dropped.
      for (const command of answer.commands) if (!(await runCommand(conn, command))) break;
      if (conn.paused) await sleep(5_000);
    }
  } finally {
    clearInterval(keepAlive);
    polling = false;
  }
}

/**
 * Runs one command a poll of `fetchedWith` returned. False when that
 * connection is no longer the stored one (the owner reconnected or switched
 * workspace while the poll waited): nothing is run, recorded or answered,
 * and the newer connection's sequence and token are left alone.
 */
async function runCommand(fetchedWith: Connection, command: BrowserResearchCommand): Promise<boolean> {
  const current = await connection();
  if (current?.token !== fetchedWith.token) return false;
  const problem = commandProblem(command, { lastSeq: current.lastSeq, now: Date.now() + clockOffset });
  // Already run, or past its deadline: the app has its answer or gave up; answering again changes nothing.
  if (problem && (command.seq <= current.lastSeq || /expired/.test(problem))) return true;
  // Saved before it runs, and only on its own connection: a restart part-way never runs it twice.
  const conn = await updateConnection({ lastSeq: Math.max(current.lastSeq, command.seq) }, fetchedWith.token);
  if (!conn) return false;
  let result: BrowserResearchResult;
  if (problem) {
    result = { ok: false, error: `refused by the extension: ${problem}` };
  } else if (conn.paused) {
    result = { ok: false, error: "the owner stopped research in this browser" };
  } else {
    busy = true;
    void researchBadge();
    try {
      result = await execute(conn, command);
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      busy = false;
    }
  }
  // Answered with the token of the connection it came to, whatever is stored by now.
  await bridgeFetch(conn, `/api/browser-bridge/commands/${command.id}`, { seq: command.seq, result }).catch((error: unknown) => {
    lastError = error instanceof Error ? error.message : String(error);
  });
  await researchBadge();
  return true;
}

// --- Commands -----------------------------------------------------------------

function originPattern(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

/** Why this browser may not open or read `url` for research, or null. */
async function urlRefusal(conn: Connection, url: string): Promise<{ error: string; attention?: ResearchAttention } | null> {
  const problem = researchUrlProblem(url, conn.sites);
  if (problem) return { error: problem };
  if (!(await chrome.permissions.contains({ origins: [originPattern(url)] }))) {
    return { error: `Chrome does not let the extension read ${new URL(url).hostname}`, attention: { kind: "permission", detail: "the owner has to allow that site again from the extension's Connect page" } };
  }
  return null;
}

async function ownTab(command: BrowserResearchCommand, tabId: number): Promise<ResearchTab | null> {
  const tab = (await tabsRegistry())[String(tabId)];
  return tab && tab.requestId === command.requestId ? tab : null;
}

async function shared(tabId: number): Promise<SharedTabEntry | null> {
  return (await sharedTabs()).find((tab) => tab.tabId === tabId) ?? null;
}

async function touch(tabId: number, attention: ResearchAttention | null): Promise<void> {
  await changeTabs((tabs) => {
    const tab = tabs[String(tabId)];
    if (tab) Object.assign(tab, { lastUsedAt: Date.now(), attention });
  });
}

async function waitForLoad(tabId: number): Promise<void> {
  const deadline = Date.now() + LOAD_TIMEOUT_MS;
  // A navigation just started can still report the previous page as complete.
  await sleep(400);
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") break;
    await sleep(300);
  }
  // Pages that draw after loading (most social sites) get a moment.
  await sleep(1_500);
}

async function inPage(tabId: number, op: PageOp): Promise<PageScriptResult & { attention?: ResearchAttention }> {
  try {
    const run = chrome.scripting.executeScript({ target: { tabId }, func: pageScript, args: [pageScriptConfig, op] })
      .then((frames) => frames[0]?.result as PageScriptResult | undefined);
    const result = await Promise.race([run, sleep(PAGE_TIMEOUT_MS).then(() => "timeout" as const)]);
    if (result === "timeout") return { ok: false, error: "the page did not answer", attention: { kind: "frozen", detail: "the page stopped responding" } };
    return result ?? { ok: false, error: NO_ANSWER };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/error page/i.test(message)) return { ok: false, error: "the page did not load (Chrome shows an error page: offline, blocked or no such site)" };
    if (/permission|cannot access/i.test(message)) return { ok: false, error: "Chrome did not let the extension read that page", attention: { kind: "permission", detail: "the owner has to allow that site from the extension's Connect page" } };
    return { ok: false, error: message };
  }
}

/** The research group of `windowId`, created on first use. */
async function addToGroup(tabId: number, windowId: number): Promise<void> {
  const stored = await chrome.storage.session.get(GROUPS_KEY);
  const groups = (stored[GROUPS_KEY] as Record<string, number> | undefined) ?? {};
  const known = groups[String(windowId)];
  if (known !== undefined) {
    const alive = await chrome.tabGroups.get(known).catch(() => null);
    if (alive) {
      await chrome.tabs.group({ tabIds: [tabId], groupId: known });
      return;
    }
  }
  const groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
  await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: "purple", collapsed: true });
  groups[String(windowId)] = groupId;
  await chrome.storage.session.set({ [GROUPS_KEY]: groups });
}

/** A new background tab for the request, its least recently used one closed first when it has the most it keeps. */
async function openTab(command: BrowserResearchCommand, url: string): Promise<number> {
  const mine = Object.entries(await tabsRegistry()).filter(([, tab]) => tab.requestId === command.requestId);
  if (mine.length >= RESEARCH_LIMITS.maxTabsPerRequest) {
    const [oldest] = mine.sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    await closeTabs([Number(oldest![0])]);
  }
  const window = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  const tab = await chrome.tabs.create({ url, active: false, ...(window?.id === undefined ? {} : { windowId: window.id }) });
  if (tab.id === undefined) throw new Error("Chrome did not open a tab");
  const id = tab.id;
  await changeTabs((tabs) => {
    tabs[String(id)] = { requestId: command.requestId, createdAt: Date.now(), lastUsedAt: Date.now(), attention: null };
  });
  await addToGroup(id, tab.windowId).catch((error: unknown) => console.warn("[research] could not group the tab", error));
  return id;
}

async function closeTabs(tabIds: number[]): Promise<number> {
  let closed = 0;
  for (const tabId of tabIds) {
    await changeTabs((tabs) => {
      delete tabs[String(tabId)];
    });
    if (await chrome.tabs.remove(tabId).then(() => true, () => false)) closed += 1;
  }
  return closed;
}

/** Reads the tab as it is now, after checking where it ended up. */
async function readTab(conn: Connection, tabId: number, op: PageOp = { op: "snapshot" }): Promise<BrowserResearchResult> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.url) return { ok: false, error: "that tab is closed", tabId };
  const isShared = Boolean(await shared(tabId));
  if (!isShared) {
    const refusal = await urlRefusal(conn, tab.url);
    if (refusal) return { ok: false, error: `the tab is on ${new URL(tab.url).hostname}: ${refusal.error}; nothing was read`, tabId, attention: refusal.attention ?? null };
  }
  const page = await inPage(tabId, op);
  if (!page.ok) {
    await touch(tabId, page.attention ?? null);
    return { ok: false, error: page.error, tabId, attention: page.attention ?? null };
  }
  if (!("snapshot" in page)) return { ok: false, error: "the page did not give a reading", tabId };
  await touch(tabId, page.snapshot.attention);
  return { ok: true, tabId, snapshot: page.snapshot };
}

async function navigate(conn: Connection, tabId: number, url: string): Promise<BrowserResearchResult> {
  const refusal = await urlRefusal(conn, url);
  if (refusal) return { ok: false, error: refusal.error, tabId, attention: refusal.attention ?? null };
  await chrome.tabs.update(tabId, { url });
  await waitForLoad(tabId);
  return readTab(conn, tabId);
}

async function execute(conn: Connection, command: BrowserResearchCommand): Promise<BrowserResearchResult> {
  const action: BrowserResearchAction = command.action;
  switch (action.kind) {
    case "open": {
      if (action.tabId !== null) {
        if (!(await ownTab(command, action.tabId))) return { ok: false, error: `tab ${action.tabId} is not one of this request's tabs; open a new one` };
        return navigate(conn, action.tabId, action.url);
      }
      const refusal = await urlRefusal(conn, action.url);
      if (refusal) return { ok: false, error: refusal.error, attention: refusal.attention ?? null };
      const tabId = await openTab(command, action.url);
      await waitForLoad(tabId);
      return readTab(conn, tabId);
    }
    case "read":
    case "scroll": {
      if (!(await ownTab(command, action.tabId)) && !(await shared(action.tabId))) return { ok: false, error: `tab ${action.tabId} is neither one of this request's tabs nor shared by the owner` };
      return readTab(conn, action.tabId, action.kind === "read" ? { op: "snapshot" } : { op: "scroll", direction: action.direction });
    }
    case "click":
    case "search":
    case "act": {
      if (!(await ownTab(command, action.tabId))) {
        return { ok: false, error: (await shared(action.tabId)) ? "a tab the owner shared is read only: open its address in a new tab to work it" : `tab ${action.tabId} is not one of this request's tabs` };
      }
      const before = (await chrome.tabs.get(action.tabId).catch(() => null))?.url;
      if (!before) return { ok: false, error: "that tab is closed", tabId: action.tabId };
      const refusal = await urlRefusal(conn, before);
      if (refusal) return { ok: false, error: refusal.error, tabId: action.tabId, attention: refusal.attention ?? null };
      let op: PageOp;
      if (action.kind === "act") {
        const host = new URL(before).hostname;
        // The grant travels with the change: a page off the owner's named sites is never changed, whatever the model asked.
        if (!grantCovers(action.grant, host, Date.now() + clockOffset)) return { ok: false, error: `the owner's request covers ${action.grant.hosts.join(", ")}, not ${host} (or it expired); nothing was changed`, tabId: action.tabId };
        const key = action.key === null ? null : parseTaskKey(action.key);
        op = { op: "act", n: action.n, label: action.label, action: action.op, value: action.value, key, social: siteOfHost(host) !== "web" };
      } else {
        op = action.kind === "click" ? { op: "click", n: action.n, label: action.label } : { op: "search", n: action.n, label: action.label, text: action.text };
      }
      await forgetShot(action.tabId);
      const page = await inPage(action.tabId, op);
      // No answer at all: the page navigated away while the script returned, which is the action working.
      if (!page.ok && page.error !== NO_ANSWER) return { ok: false, error: page.error, tabId: action.tabId, attention: page.attention ?? null };
      if (page.ok && "navigate" in page) return navigate(conn, action.tabId, page.navigate);
      const note = page.ok && "acted" in page ? page.note : undefined;
      // A button or a search may have navigated: read only where the enabled sites allow.
      await waitForLoad(action.tabId);
      const after = (await chrome.tabs.get(action.tabId).catch(() => null))?.url;
      if (after && after !== before && (await urlRefusal(conn, after))) {
        await chrome.tabs.goBack(action.tabId).catch(() => undefined);
        return { ok: false, error: `that led to ${new URL(after).hostname}, which is not enabled for research; went back and read nothing`, tabId: action.tabId };
      }
      const read = await readTab(conn, action.tabId);
      return note && read.ok ? { ...read, note } : read;
    }
    case "screenshot": {
      if (!(await ownTab(command, action.tabId))) return { ok: false, error: (await shared(action.tabId)) ? "a tab the owner shared is not pictured: open its address in a new tab" : `tab ${action.tabId} is not one of this request's tabs` };
      return screenshot(conn, action.tabId);
    }
    case "visual":
      if (!(await ownTab(command, action.tabId))) return { ok: false, error: (await shared(action.tabId)) ? "a tab the owner shared is read only: open its address in a new tab to work it" : `tab ${action.tabId} is not one of this request's tabs` };
      return visual(conn, action);
    case "tabs": {
      const list: BrowserResearchTab[] = [];
      for (const [id, entry] of Object.entries(await tabsRegistry())) {
        if (entry.requestId !== command.requestId) continue;
        const tab = await chrome.tabs.get(Number(id)).catch(() => null);
        if (tab) list.push({ tabId: Number(id), url: tab.url ?? "", title: tab.title ?? "", shared: false, attention: entry.attention });
      }
      for (const entry of await sharedTabs()) list.push({ tabId: entry.tabId, url: entry.url, title: entry.title, shared: true, attention: null });
      return { ok: true, tabs: list };
    }
    case "close": {
      const mine = Object.entries(await tabsRegistry()).filter(([id, tab]) => tab.requestId === command.requestId && (action.tabId === null || Number(id) === action.tabId));
      if (action.tabId !== null && !mine.length) return { ok: false, error: `tab ${action.tabId} is not one of this request's tabs (the owner's own tabs stay open)` };
      return { ok: true, closed: await closeTabs(mine.map(([id]) => Number(id))) };
    }
    case "release": {
      // Tabs waiting for the owner (a sign-in, a CAPTCHA) stay for them to deal with.
      const ending = Object.entries(await tabsRegistry()).filter(([, tab]) => tab.requestId === command.requestId && !(tab.attention && ["login", "captcha", "blocked", "permission"].includes(tab.attention.kind)));
      return { ok: true, closed: await closeTabs(ending.map(([id]) => Number(id))) };
    }
  }
}

// --- Screen steps (screen.ts) --------------------------------------------------------

/** The tab, shown in the task window, as an image; it becomes the tab's only screenshot a visual step may use. */
async function screenshot(conn: Connection, tabId: number): Promise<BrowserResearchResult> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.url) return { ok: false, error: "that tab is closed", tabId };
  const refusal = await urlRefusal(conn, tab.url);
  if (refusal) return { ok: false, error: `the tab is on ${new URL(tab.url).hostname}: ${refusal.error}; nothing was captured`, tabId, attention: refusal.attention ?? null };
  try {
    const windowId = await screen.showInTaskWindow(tabId);
    await addToGroup(tabId, windowId).catch(() => undefined);
    // A tab just made visible draws its next frame first.
    await sleep(300);
    const image = await screen.capture(tabId);
    const current = await chrome.tabs.get(tabId);
    const shot: BrowserScreenshotFacts = { id: crypto.randomUUID(), url: current.url ?? tab.url, title: current.title ?? "", width: image.width, height: image.height, scale: image.scale, viewport: image.viewport, takenAt: new Date(Date.now() + clockOffset).toISOString() };
    await changeShots((all) => {
      all[String(tabId)] = { ...shot, tabId };
    });
    await touch(tabId, null);
    return { ok: true, tabId, screenshot: { ...shot, mediaType: image.mediaType, data: image.data } };
  } catch (error) {
    await forgetShot(tabId);
    return { ok: false, error: `no screenshot: ${error instanceof Error ? error.message : String(error)}`, tabId };
  }
}

/**
 * A pointer or keyboard step into the tab's latest screenshot. Refused when
 * that screenshot is not the one named, is old, or the tab has since moved
 * (a navigation, a scroll, a resize, a zoom): the same point would land on
 * something else. Steps that may change things need the grant (a click
 * without one only lands where a research click could); what is under the
 * point, or has the keyboard, is checked in the page first.
 */
async function visual(conn: Connection, action: Extract<BrowserResearchAction, { kind: "visual" }>): Promise<BrowserResearchResult> {
  const tabId = action.tabId;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.url) return { ok: false, error: "that tab is closed", tabId };
  const refusal = await urlRefusal(conn, tab.url);
  if (refusal) return { ok: false, error: refusal.error, tabId, attention: refusal.attention ?? null };
  const host = new URL(tab.url).hostname;
  const acting = !READ_VISUAL_OPS.includes(action.op);
  if (action.grant && !grantCovers(action.grant, host, Date.now() + clockOffset)) return { ok: false, error: `the owner's request covers ${action.grant.hosts.join(", ")}, not ${host} (or it expired); nothing was done`, tabId };
  if (acting && !action.grant && action.op !== "click") return { ok: false, error: `${action.op} may change things, and the owner has not asked for changes on ${host}; nothing was done`, tabId };
  const shot = (await shots())[String(tabId)];
  const stale = (why: string): BrowserResearchResult => ({ ok: false, error: `that screenshot is no longer a valid target (${why}); take a new one with browser_tab_screenshot. Nothing was done`, tabId });
  if (!shot || shot.id !== action.shotId) return stale("it is not this tab's latest screenshot");
  if (Date.now() + clockOffset - Date.parse(shot.takenAt) > SCREENSHOT_TTL_MS) return stale("it is more than 10 minutes old");
  if (tab.url !== shot.url) return stale("the tab went to another page since");
  const points = [[action.x, action.y], ...(action.toX !== null && action.toY !== null ? [[action.toX, action.toY]] : [])];
  if (points.some(([x, y]) => x! > shot.width || y! > shot.height)) return { ok: false, error: `a point is outside the ${shot.width}×${shot.height} screenshot; nothing was done`, tabId };
  try {
    const live = await screen.metrics(tabId);
    if (!screen.sameView(live, shot.viewport)) return stale("the tab scrolled, resized or zoomed since");
    const css = (value: number) => value / shot.scale;
    const key = action.key === null ? null : parseTaskKey(action.key);
    const social = siteOfHost(host) !== "web";
    if (action.op !== "scroll") {
      const probe = await inPage(tabId, action.op === "type" || action.op === "key"
        ? { op: "probe", x: 0, y: 0, target: "focus", key, social, readOnly: !action.grant }
        : { op: "probe", x: css(action.x), y: css(action.y), target: "point", key: null, social, readOnly: !action.grant });
      if (!probe.ok) return { ok: false, error: `${probe.error}; nothing was done`, tabId, attention: probe.attention ?? null };
    }
    await forgetShot(tabId);
    await screen.input(tabId, {
      op: action.op,
      x: css(action.x),
      y: css(action.y),
      toX: action.toX === null ? null : css(action.toX),
      toY: action.toY === null ? null : css(action.toY),
      deltaX: action.deltaX === null ? null : css(action.deltaX),
      deltaY: action.deltaY === null ? null : css(action.deltaY),
      text: action.text,
      key,
    });
  } catch (error) {
    await forgetShot(tabId);
    // The step may or may not have reached the page: said so, and never repeated here.
    return { ok: false, error: `screen control failed part-way, so the step may or may not have happened: ${error instanceof Error ? error.message : String(error)}`, tabId };
  }
  await sleep(700);
  const loading = (await chrome.tabs.get(tabId).catch(() => null))?.status === "loading";
  if (loading) await waitForLoad(tabId);
  const after = (await chrome.tabs.get(tabId).catch(() => null))?.url;
  if (after && after !== tab.url && (await urlRefusal(conn, after))) {
    await chrome.tabs.goBack(tabId).catch(() => undefined);
    return { ok: false, error: `that led to ${new URL(after).hostname}, which is not enabled; went back`, tabId };
  }
  const next = await screenshot(conn, tabId);
  return next.ok ? { ...next, note: `${action.op.replace("_", " ")} done${after && after !== tab.url ? `; the tab is now on ${after}` : ""}` } : next;
}

// --- Housekeeping -----------------------------------------------------------------

/** Tabs a request left unused close; the owner's closing a tab or leaving a shared page ends it here too. */
async function sweep(): Promise<void> {
  const now = Date.now();
  const stale = Object.entries(await tabsRegistry()).filter(([, tab]) => now - tab.lastUsedAt > (tab.attention ? 4 : 1) * RESEARCH_LIMITS.idleTabMinutes * 60_000);
  if (stale.length) await closeTabs(stale.map(([id]) => Number(id)));
  await screen.releaseIdle(now);
}

// The owner's Cancel on Chrome's "started debugging" bar is their Stop: research pauses until they resume.
screen.watchDetach(() => {
  void updateConnection({ paused: true }).then(async (conn) => {
    if (conn) await closeTabs(Object.keys(await tabsRegistry()).map(Number));
    await researchBadge();
    void pollLoop();
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void changeTabs((tabs) => {
    delete tabs[String(tabId)];
  }).then(() => researchBadge());
  void forgetShot(tabId);
  void sharedTabs().then((list) => setSharedTabs(list.filter((tab) => tab.tabId !== tabId)));
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  // Sharing was for that page: the owner moving on ends it.
  if (!change.url) return;
  void shots().then((all) => (all[String(tabId)] && all[String(tabId)]!.url !== change.url ? forgetShot(tabId) : undefined));
  void sharedTabs().then((list) => {
    const entry = list.find((tab) => tab.tabId === tabId);
    if (entry && entry.url !== change.url) return setSharedTabs(list.filter((tab) => tab.tabId !== tabId));
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM) return;
  void sweep();
  void pollLoop();
});

/** Closes every research tab and forgets the shared ones. */
async function clearTabs(): Promise<void> {
  await closeTabs(Object.keys(await tabsRegistry()).map(Number));
  await setSharedTabs([]);
}

/**
 * Forgets the connection here and closes every research tab (the app side
 * was already revoked, or is told). With `token`, only if that connection is
 * still the stored one, checked and removed in one step.
 */
async function forget(token?: string): Promise<void> {
  const removed = await serialized(async () => {
    const current = await connection();
    if (!current || (token !== undefined && current.token !== token)) return false;
    await chrome.storage.local.remove(CONNECTION_KEY);
    return true;
  });
  if (!removed) return;
  await clearTabs();
  await chrome.alarms.clear(ALARM);
  await researchBadge();
}

export async function disconnectResearch(): Promise<void> {
  const conn = await connection();
  if (!conn) return;
  await bridgeFetch(conn, "/api/browser-bridge/disconnect", {}).catch(() => undefined);
  await forget(conn.token);
}

/** The app's Disconnect: only the app this browser is connected to may ask. */
export async function disconnectFrom(origin: string): Promise<BridgeResult> {
  const conn = await connection();
  if (conn && conn.apiBase !== origin) return { ok: false, error: `This browser is connected to ${conn.apiBase}, not this address.` };
  await disconnectResearch();
  return { ok: true };
}

// --- Pairing ------------------------------------------------------------------

/** The app's Connect browser: keeps its code for the Connect page, which asks Chrome for the sites' permissions. */
export async function beginPairing(code: string, apiBase: string): Promise<BridgeResult> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(code)) return { ok: false, error: "That connect code is not valid. Press Connect browser again." };
  const nonce = crypto.randomUUID();
  await chrome.storage.session.set({ [`${PAIRING_PREFIX}${nonce}`]: { code, apiBase, createdAt: Date.now() } });
  await chrome.tabs.create({ url: chrome.runtime.getURL(`connect.html?pairing=${nonce}`), active: true });
  return { ok: true };
}

async function pairingFor(nonce: string): Promise<{ code: string; apiBase: string; createdAt: number } | null> {
  const key = `${PAIRING_PREFIX}${nonce}`;
  const stored = (await chrome.storage.session.get(key))[key] as { code: string; apiBase: string; createdAt: number } | undefined;
  return stored && Date.now() - stored.createdAt < 10 * 60_000 ? stored : null;
}

function deviceLabel(): string {
  const brand = (navigator as Navigator & { userAgentData?: { brands?: { brand: string }[]; platform?: string } }).userAgentData;
  const browser = brand?.brands?.find((item) => !/not.?a.?brand|chromium/i.test(item.brand))?.brand ?? "Chrome";
  return `${browser} on ${brand?.platform || navigator.platform || "this computer"}`.slice(0, 80);
}

async function pair(nonce: string, sites: ResearchSiteKey[]): Promise<BridgeResult & { organizationName?: string }> {
  const pairing = await pairingFor(nonce);
  if (!pairing) return { ok: false, error: "This connect link expired. Press Connect browser in AgentSDR again." };
  const chosen = researchSites(sites);
  if (!chosen.length) return { ok: false, error: "Choose at least one kind of site to research." };
  try {
    const previous = await connection();
    const paired = await bridgeFetch<BrowserPairResponse>({ apiBase: pairing.apiBase, token: null }, "/api/browser-bridge/pair", {
      code: pairing.code,
      deviceId: await deviceId(),
      deviceLabel: deviceLabel(),
      extensionVersion: chrome.runtime.getManifest().version,
      sites: chosen,
    });
    await chrome.storage.session.remove(`${PAIRING_PREFIX}${nonce}`);
    // A new pairing (another workspace or app) replaces the old one: its token is dropped, its tabs close.
    if (previous) await bridgeFetch(previous, "/api/browser-bridge/disconnect", {}).catch(() => undefined);
    const next: Connection = { apiBase: pairing.apiBase, token: paired.token, connectionId: paired.connectionId, organizationName: paired.organizationName, userEmail: paired.userEmail, sites: chosen, lastSeq: 0, paused: false };
    await serialized(() => chrome.storage.local.set({ [CONNECTION_KEY]: next }));
    if (previous) await clearTabs();
    startResearch();
    await researchBadge();
    return { ok: true, organizationName: paired.organizationName };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function status(): Promise<ResearchStatus> {
  const conn = await connection();
  const tabs = await tabsRegistry();
  const attentionEntry = Object.entries(tabs).find(([, tab]) => tab.attention && tab.attention.kind !== "empty");
  let attention: ResearchStatus["attention"] = null;
  if (attentionEntry) {
    const tab = await chrome.tabs.get(Number(attentionEntry[0])).catch(() => null);
    if (tab) attention = { detail: attentionEntry[1].attention!.detail, url: tab.url ?? "", tabId: Number(attentionEntry[0]) };
  }
  return {
    connected: Boolean(conn),
    apiBase: conn?.apiBase ?? null,
    organizationName: conn?.organizationName ?? null,
    userEmail: conn?.userEmail ?? null,
    sites: conn?.sites ?? [],
    paused: conn?.paused ?? false,
    busy,
    openTabs: Object.keys(tabs).length,
    sharedTabs: (await sharedTabs()).map(({ tabId, title, url }) => ({ tabId, title, url })),
    attention,
    lastContactAt,
    lastError,
  };
}

/** Only the extension's own pages (Connect, the popup) may change research; content scripts run on web pages. */
function fromExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
}

async function handle(message: ResearchMessage): Promise<unknown> {
  switch (message.type) {
    case "pairing": {
      const conn = await connection();
      const pairing = message.nonce ? await pairingFor(message.nonce) : null;
      const answer: ResearchPairing | null = pairing || conn
        ? { apiBase: pairing?.apiBase ?? conn!.apiBase, sites: conn?.sites ?? ["web"], connected: Boolean(conn) && !pairing, organizationName: conn?.organizationName ?? null }
        : null;
      return answer;
    }
    case "pair":
      return pair(message.nonce, message.sites);
    case "set-sites": {
      const sites = researchSites(message.sites);
      if (!sites.length) return { ok: false, error: "Choose at least one kind of site to research." } satisfies BridgeResult;
      return (await updateConnection({ sites })) ? { ok: true } : { ok: false, error: "This browser is not connected." };
    }
    case "status":
      return status();
    case "pause": {
      const conn = await updateConnection({ paused: message.paused });
      if (!conn) return { ok: false, error: "This browser is not connected." } satisfies BridgeResult;
      if (message.paused) await closeTabs(Object.keys(await tabsRegistry()).map(Number));
      await researchBadge();
      // Tell the app now rather than at the next poll.
      void pollLoop();
      return { ok: true } satisfies BridgeResult;
    }
    case "share-tab": {
      const tab = await chrome.tabs.get(message.tabId).catch(() => null);
      if (!tab?.url || !/^https:\/\//i.test(tab.url)) return { ok: false, error: "Only an https page can be shared." } satisfies BridgeResult;
      const list = (await sharedTabs()).filter((entry) => entry.tabId !== message.tabId);
      list.push({ tabId: message.tabId, url: tab.url, title: tab.title ?? "", sharedAt: Date.now() });
      await setSharedTabs(list);
      return { ok: true } satisfies BridgeResult;
    }
    case "unshare-tab":
      await setSharedTabs((await sharedTabs()).filter((entry) => entry.tabId !== message.tabId));
      return { ok: true } satisfies BridgeResult;
    case "disconnect":
      await disconnectResearch();
      return { ok: true } satisfies BridgeResult;
  }
}

chrome.runtime.onMessage.addListener((message: ResearchMessage, sender, sendResponse) => {
  if (message?.target !== "research") return;
  if (!fromExtensionPage(sender)) {
    sendResponse({ ok: false, error: "Not allowed." });
    return;
  }
  void handle(message).then(sendResponse, (error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

chrome.runtime.onStartup.addListener(() => void connection().then((conn) => conn && startResearch()));
chrome.runtime.onInstalled.addListener(() => void connection().then((conn) => conn && startResearch()));
// The worker itself starting (after a suspension): pick the poll back up.
void connection().then((conn) => {
  if (conn) startResearch();
});

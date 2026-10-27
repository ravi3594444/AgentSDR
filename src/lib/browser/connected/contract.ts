/**
 * Connected-browser research: the shapes and rules the app's server, its
 * bridge API and the recorder extension share. The owner's own Chrome (the
 * AgentSDR extension, extensions/whatsapp-recorder) opens and reads pages for
 * the assistant, signed in as the owner, on the sites the owner enabled.
 *
 * Pure: no imports, safe in client components and the extension. `pageScript`
 * runs inside web pages through chrome.scripting.executeScript, which sends
 * only the function's own source, so it uses nothing from outside its body;
 * what it needs from here arrives in its argument (`pageScriptConfig`).
 *
 * The flow:
 *   1. The owner presses Connect browser in the chat. The page POSTs
 *      /api/browser-connections (cookie) for a one-time pairing code bound
 *      to them and the workspace, and hands it to the extension over
 *      window.postMessage (BrowserBridgeRequest).
 *   2. The extension's Connect page asks Chrome for the chosen sites'
 *      permissions once, then POSTs /api/browser-bridge/pair with the code and
 *      its device id, and keeps the device token it gets back.
 *   3. The extension long-polls /api/browser-bridge/poll with that token;
 *      the assistant's browser_tab_* tools queue commands there and wait for
 *      the result the extension POSTs to /api/browser-bridge/commands/:id.
 */

/** The first extension version with connected-browser research. */
export const BROWSER_RESEARCH_MIN_VERSION = "0.16.0";

// --- Sites ---------------------------------------------------------------

export const RESEARCH_SITE_KEYS = ["web", "linkedin", "x", "reddit", "instagram", "facebook"] as const;
export type ResearchSiteKey = (typeof RESEARCH_SITE_KEYS)[number];

export type ResearchSite = {
  label: string;
  /** Registrable domains that make a host this site; "web" is every other public host. */
  domains: readonly string[];
  /** Chrome match patterns requested when the owner enables the site. */
  origins: readonly string[];
};

export const RESEARCH_SITES: Record<ResearchSiteKey, ResearchSite> = {
  web: { label: "Other public websites", domains: [], origins: ["https://*/*"] },
  linkedin: { label: "LinkedIn", domains: ["linkedin.com"], origins: ["https://*.linkedin.com/*"] },
  x: { label: "X (Twitter)", domains: ["x.com", "twitter.com"], origins: ["https://*.x.com/*", "https://*.twitter.com/*"] },
  reddit: { label: "Reddit", domains: ["reddit.com", "redd.it"], origins: ["https://*.reddit.com/*", "https://*.redd.it/*"] },
  instagram: { label: "Instagram", domains: ["instagram.com"], origins: ["https://*.instagram.com/*"] },
  facebook: { label: "Facebook", domains: ["facebook.com", "fb.com"], origins: ["https://*.facebook.com/*", "https://*.fb.com/*"] },
};

export function isResearchSiteKey(value: unknown): value is ResearchSiteKey {
  return typeof value === "string" && (RESEARCH_SITE_KEYS as readonly string[]).includes(value);
}

/** The enabled sites in `value`, deduplicated in catalog order; anything else is dropped. */
export function researchSites(value: unknown): ResearchSiteKey[] {
  const given = new Set(Array.isArray(value) ? value.filter(isResearchSiteKey) : []);
  return RESEARCH_SITE_KEYS.filter((key) => given.has(key));
}

/** Which site a host belongs to: one of the social sites, else "web". */
export function siteOfHost(hostname: string): ResearchSiteKey {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  for (const key of RESEARCH_SITE_KEYS) {
    if (RESEARCH_SITES[key].domains.some((domain) => host === domain || host.endsWith(`.${domain}`))) return key;
  }
  return "web";
}

const PRIVATE_SUFFIX = /(?:^|\.)(?:localhost|local|internal|intranet|lan|home|corp|home\.arpa|test|invalid|example)$/i;

/**
 * Why a host is not a public website, or null. The browser runs on the
 * owner's own network, so an address a page or a model writes must not reach
 * their router, intranet or this machine. Names are checked by shape here;
 * the server also resolves "web" hosts before it queues a command.
 */
export function privateHostProblem(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return "it has no host";
  if (host.startsWith("[") || host.includes(":")) return `${host} is an IP address, not a website`;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) return `${host} is an IP address, not a website`;
  if (!host.includes(".")) return `${host} is not a public website`;
  if (PRIVATE_SUFFIX.test(host)) return `${host} is a local or private address`;
  return null;
}

/**
 * Why `raw` may not be opened in the owner's browser, or null: only https
 * public pages, on a site the owner enabled. A social site needs its own
 * switch; "Other public websites" does not include them.
 */
export function researchUrlProblem(raw: string, enabled: readonly ResearchSiteKey[]): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `“${raw.slice(0, 200)}” is not a web address`;
  }
  if (url.protocol !== "https:") return `${url.protocol.replace(":", "")} pages are not opened; only https`;
  if (url.username || url.password) return "addresses with a user name or password are not opened";
  if (url.port && url.port !== "443") return "addresses with a port are not opened";
  const host = privateHostProblem(url.hostname);
  if (host) return host;
  const site = siteOfHost(url.hostname);
  if (!enabled.includes(site)) {
    return `${RESEARCH_SITES[site].label} is not enabled for research in the owner's browser (enabled: ${enabled.map((key) => RESEARCH_SITES[key].label).join(", ") || "none"}); the owner turns it on from the extension's Connect page`;
  }
  return null;
}

// --- What a page shows the assistant ------------------------------------------

export type ResearchElementKind = "link" | "button" | "input" | "select" | "tab" | "other";

export type ResearchElement = {
  n: number;
  kind: ResearchElementKind;
  label: string;
  /** A link's target. */
  href: string | null;
  /** A control that acts for the owner on the site (send, post, follow, …): clicks are refused. */
  write: boolean;
  /** A search field: the only kind the assistant may type into. */
  search: boolean;
};

export type ResearchAttentionKind = "captcha" | "login" | "blocked" | "frozen" | "empty" | "permission";

/** A page the assistant could not honestly read: the owner has to look at it, or nothing was there. */
export type ResearchAttention = { kind: ResearchAttentionKind; detail: string };

export type ResearchSnapshot = {
  url: string;
  title: string;
  /** Visible text from the current scroll position down. */
  text: string;
  elements: ResearchElement[];
  scroll: { y: number; height: number; viewport: number };
  attention: ResearchAttention | null;
  /** ISO time the page was read, in the browser. */
  readAt: string;
};

export const RESEARCH_LIMITS = {
  maxTextChars: 12_000,
  maxElements: 150,
  maxLabelChars: 100,
  maxSearchChars: 200,
  /** Research tabs one request keeps open; opening another closes its least recently used. */
  maxTabsPerRequest: 6,
  /** Tabs of a request left unused this long are closed by the extension. */
  idleTabMinutes: 15,
  /** Tabs the owner shares from the toolbar button, at most. */
  maxSharedTabs: 10,
} as const;

/**
 * Controls that act for the owner rather than read: sending, posting,
 * reacting, following, connecting, voting, buying, deleting. Clicks on them
 * are refused, in the server and again in the page at the moment of the
 * click. It reads English labels; typing is limited to search fields, so a
 * message cannot be written whatever a button says.
 */
export const WRITE_CONTROL_PATTERN = "\\b(?:send|post|publish|reply|comment|share|repost|retweet|quote|like|unlike|react|follow|unfollow|connect|invite|message|subscribe|join|submit|buy|order|purchase|pay|checkout|donate|book|delete|remove|block|report|mute|accept|ignore|withdraw|endorse|recommend|vote|upvote|downvote|save|bookmark|sign up|register|log ?out|sign ?out)\\b";

/** What marks an input as a search field when its type and role do not. */
export const SEARCH_FIELD_PATTERN = "\\b(?:search|query|find|keywords?|lookup)\\b";

/** Why element `n` may not be clicked, or null. */
export function clickProblem(element: ResearchElement | undefined): string | null {
  if (!element) return "there is no such element in the latest reading of that tab; read it again for the current numbers";
  if (element.write) return `“${element.label || element.kind}” acts for the owner on the site (sending, posting, reacting, following, connecting, buying or deleting); the assistant only reads`;
  if (element.kind === "input") return "it is a field: type a search with browser_tab_search, or click a link or button";
  return null;
}

/** Why `text` may not be typed into element `n`, or null. */
export function searchProblem(element: ResearchElement | undefined, text: string): string | null {
  if (!element) return "there is no such element in the latest reading of that tab; read it again for the current numbers";
  if (!element.search) return "it is not a search field: the assistant types only searches, never messages, comments, posts or logins";
  if (!text.trim()) return "the search is empty";
  if (text.length > RESEARCH_LIMITS.maxSearchChars) return `a search is at most ${RESEARCH_LIMITS.maxSearchChars} characters`;
  return null;
}

// --- Commands --------------------------------------------------------------

export type BrowserResearchAction =
  /** A new background tab, or `tabId` (one of the request's tabs) navigated. */
  | { kind: "open"; url: string; tabId: number | null }
  | { kind: "read"; tabId: number }
  /** `label` is the element's label in the reading the click was chosen from: a page that renumbered is not clicked. */
  | { kind: "click"; tabId: number; n: number; label: string }
  | { kind: "scroll"; tabId: number; direction: "down" | "up" }
  | { kind: "search"; tabId: number; n: number; label: string; text: string }
  | { kind: "tabs" }
  /** One of the request's tabs, or all of them (null). */
  | { kind: "close"; tabId: number | null }
  /** The turn ended: close the request's tabs, except those waiting for the owner (a login, a CAPTCHA). */
  | { kind: "release" };

export type BrowserResearchCommand = {
  id: string;
  /** Per connection, increasing: the extension never runs one at or below the last it ran. */
  seq: number;
  /** The request (or chat) the command serves; its tabs are its own. */
  requestId: string;
  issuedAt: string;
  expiresAt: string;
  action: BrowserResearchAction;
};

export type BrowserResearchTab = {
  tabId: number;
  url: string;
  title: string;
  /** A tab the owner shared from the toolbar button: read only. */
  shared: boolean;
  attention: ResearchAttention | null;
};

export type BrowserResearchResult =
  | { ok: true; tabId?: number; snapshot?: ResearchSnapshot; tabs?: BrowserResearchTab[]; closed?: number }
  | { ok: false; error: string; tabId?: number; attention?: ResearchAttention | null };

/** Why the extension must not run `command`, or null: an old, replayed, expired or malformed command. */
export function commandProblem(command: unknown, state: { lastSeq: number; now: number }): string | null {
  if (!command || typeof command !== "object") return "not a command";
  const value = command as Partial<BrowserResearchCommand>;
  if (typeof value.id !== "string" || !/^[0-9a-f-]{36}$/i.test(value.id)) return "bad command id";
  if (typeof value.requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(value.requestId)) return "bad request id";
  if (typeof value.seq !== "number" || !Number.isSafeInteger(value.seq) || value.seq < 1) return "bad sequence";
  if (value.seq <= state.lastSeq) return `command ${value.seq} was already run or skipped (last ${state.lastSeq})`;
  const expires = typeof value.expiresAt === "string" ? Date.parse(value.expiresAt) : Number.NaN;
  if (!Number.isFinite(expires)) return "bad expiry";
  if (expires <= state.now) return "the command expired before it arrived";
  const action = value.action as Partial<BrowserResearchAction> | undefined;
  if (!action || typeof action !== "object") return "no action";
  const tab = (id: unknown, optional = false) => (optional && id === null) || (typeof id === "number" && Number.isSafeInteger(id) && id >= 0);
  switch (action.kind) {
    case "open": return typeof action.url === "string" && tab(action.tabId, true) ? null : "bad open";
    case "read": return tab(action.tabId) ? null : "bad read";
    case "click": return tab(action.tabId) && Number.isSafeInteger(action.n) && typeof action.label === "string" ? null : "bad click";
    case "scroll": return tab(action.tabId) && (action.direction === "down" || action.direction === "up") ? null : "bad scroll";
    case "search": return tab(action.tabId) && Number.isSafeInteger(action.n) && typeof action.label === "string" && typeof action.text === "string" ? null : "bad search";
    case "close": return tab(action.tabId, true) ? null : "bad close";
    case "tabs":
    case "release": return null;
    default: return "unknown action";
  }
}

// --- Bridge API (device token, called by the extension's service worker) ----

/** POST /api/browser-bridge/pair */
export type BrowserPairRequest = { code: string; deviceId: string; deviceLabel: string; extensionVersion: string; sites: ResearchSiteKey[] };
export type BrowserPairResponse = { connectionId: string; token: string; organizationName: string; userEmail: string };

/** A tab the owner shared, as the extension reports it. */
export type SharedTab = { tabId: number; url: string; title: string };

/** POST /api/browser-bridge/poll — a heartbeat that waits up to `waitMs` for commands. */
export type BrowserPollRequest = { extensionVersion: string; sites: ResearchSiteKey[]; sharedTabs: SharedTab[]; lastSeq: number; paused: boolean };
export type BrowserPollResponse = { commands: BrowserResearchCommand[]; serverTime: string };

/** POST /api/browser-bridge/commands/:id */
export type BrowserCommandResultRequest = { seq: number; result: BrowserResearchResult };

/** The header naming the device beside its bearer token. */
export const BROWSER_DEVICE_HEADER = "x-agentsdr-browser-device";

// --- Page ⇄ extension bridge (window.postMessage) ---------------------------

export type BrowserBridgeRequest =
  /** Opens the extension's Connect page for this pairing code. */
  | { source: "agentsdr-app"; type: "browser:connect"; requestId: string; code: string; apiBase: string }
  /** Stops research in this browser and forgets the connection. */
  | { source: "agentsdr-app"; type: "browser:disconnect"; requestId: string };

export type BrowserBridgeReply = { source: "agentsdr-recorder"; requestId: string } & (
  | { type: "browser:connect-opened" | "browser:disconnected" }
  | { type: "browser:connect-rejected" | "browser:disconnect-rejected"; error: string }
);

/** The connection as the chat shows it: one short state. */
export type BrowserConnectionState = "none" | "connected" | "offline" | "needs_attention" | "paused";

export type BrowserConnectionView = {
  state: BrowserConnectionState;
  connectionId: string | null;
  deviceLabel: string | null;
  sites: ResearchSiteKey[];
  lastSeenAt: string | null;
  attention: (ResearchAttention & { host: string | null; at: string }) | null;
  extensionVersion: string | null;
};

// --- In the page -----------------------------------------------------------

export type PageOp =
  | { op: "snapshot" }
  | { op: "click"; n: number; label: string }
  | { op: "scroll"; direction: "down" | "up" }
  | { op: "search"; n: number; label: string; text: string };

export type PageScriptConfig = {
  attr: string;
  maxTextChars: number;
  maxElements: number;
  maxLabelChars: number;
  writePattern: string;
  searchPattern: string;
};

export const pageScriptConfig: PageScriptConfig = {
  attr: "data-agentsdr-research-n",
  maxTextChars: RESEARCH_LIMITS.maxTextChars,
  maxElements: RESEARCH_LIMITS.maxElements,
  maxLabelChars: RESEARCH_LIMITS.maxLabelChars,
  writePattern: WRITE_CONTROL_PATTERN,
  searchPattern: SEARCH_FIELD_PATTERN,
};

export type PageScriptResult =
  | { ok: true; snapshot: ResearchSnapshot }
  /** A link: the extension checks the address and navigates the tab itself. */
  | { ok: true; navigate: string }
  /** Clicked or searched: the page may be navigating, so the extension waits and reads it afresh. */
  | { ok: true; acted: true }
  | { ok: false; error: string };

/**
 * Runs inside a research tab (ISOLATED world). Self-contained by necessity:
 * executeScript serializes only this function. Page content can change the
 * DOM but not this code; what it returns is still untrusted page data.
 */
export async function pageScript(config: PageScriptConfig, op: PageOp): Promise<PageScriptResult> {
  const write = new RegExp(config.writePattern, "i");
  const searchy = new RegExp(config.searchPattern, "i");
  const clean = (value: string | null | undefined, max: number) => (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const visible = (el: Element) => {
    const box = el.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
  };
  const labelOf = (el: Element) => clean(
    el.getAttribute("aria-label") || (el as HTMLElement).innerText || el.getAttribute("placeholder") || el.getAttribute("title")
      || el.getAttribute("name") || el.getAttribute("value") || el.getAttribute("alt") || "",
    config.maxLabelChars,
  );
  const isSearch = (el: Element) => {
    if (el.tagName !== "INPUT") return false;
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "search") return true;
    if (type !== "text") return false;
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (role === "searchbox" || role === "combobox") return true;
    if (el.closest("[role=search], form[role=search], search")) return true;
    return searchy.test(`${el.getAttribute("name") || ""} ${el.getAttribute("placeholder") || ""} ${el.getAttribute("aria-label") || ""} ${el.id}`);
  };
  const isWrite = (el: Element, label: string) => {
    const href = el.tagName === "A" ? el.getAttribute("href") || "" : "";
    const navigates = /^https?:/i.test((el as HTMLAnchorElement).href || "") && href !== "#" && !/^javascript:/i.test(href);
    if (el.tagName === "A" && navigates) return false;
    if (write.test(label)) return true;
    // A submit inside a form holding a message box or a password: a composer or a sign-in.
    const form = el.closest("form");
    const submits = el.tagName === "BUTTON" ? (el.getAttribute("type") || "submit").toLowerCase() === "submit" : (el.getAttribute("type") || "").toLowerCase() === "submit";
    return Boolean(form && submits && form.querySelector("textarea, [contenteditable=''], [contenteditable=true], input[type=password]"));
  };
  const kindOf = (el: Element): ResearchElementKind => {
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (el.tagName === "A" || role === "link") return "link";
    if (el.tagName === "BUTTON" || role === "button") return "button";
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return "input";
    if (el.tagName === "SELECT") return "select";
    if (role === "tab") return "tab";
    return "other";
  };
  const find = (n: number) => document.querySelector(`[${config.attr}="${n}"]`);
  const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

  const snapshot = (): ResearchSnapshot => {
    document.querySelectorAll(`[${config.attr}]`).forEach((el) => el.removeAttribute(config.attr));
    const viewport = window.innerHeight || 800;
    const elements: ResearchElement[] = [];
    const selector = "a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=tab]";
    for (const el of Array.from(document.querySelectorAll(selector))) {
      if (elements.length >= config.maxElements) break;
      if (!visible(el)) continue;
      // From a little above the current position down: what scrolling has passed is gone from the reading.
      if (el.getBoundingClientRect().bottom < -viewport * 0.25) continue;
      const n = elements.length + 1;
      el.setAttribute(config.attr, String(n));
      const label = labelOf(el);
      const kind = kindOf(el);
      const anchor = el.tagName === "A" ? (el as HTMLAnchorElement).href : "";
      elements.push({ n, kind, label, href: /^https?:/i.test(anchor) ? anchor : null, write: kind !== "input" && kind !== "select" && isWrite(el, label), search: isSearch(el) });
    }
    let text = "";
    const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node && text.length < config.maxTextChars; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(parent.tagName)) continue;
      const value = clean(node.textContent, config.maxTextChars);
      if (!value) continue;
      if (!visible(parent) || parent.getBoundingClientRect().bottom < -40) continue;
      text += `${value} `;
    }
    text = text.slice(0, config.maxTextChars).trim();
    const title = clean(document.title, 300);
    const where = `${location.hostname}${location.pathname}`.toLowerCase();
    const page = `${title} ${text.slice(0, 3_000)}`;
    let attention: ResearchAttention | null = null;
    if (document.querySelector("iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[src*='challenges.cloudflare.com'], #challenge-form, #cf-challenge-running")
      || /just a moment|attention required|are you a robot|security check|verify you are (?:a )?human|unusual traffic/i.test(page)) {
      attention = { kind: "captcha", detail: "the site shows a CAPTCHA or a security check" };
    } else if (Array.from(document.querySelectorAll("input[type=password]")).some(visible)
      && (/(?:^|\/)(?:login|signin|sign-in|log-in|auth|checkpoint|uas\/login|accounts\/login|i\/flow\/login)/i.test(where) || /\b(?:log ?in|sign ?in)\b/i.test(title) || text.length < 2_000)) {
      attention = { kind: "login", detail: "the site asks the owner to sign in" };
    } else if (text.length < 1_500 && /too many requests|rate limit|temporarily (?:blocked|restricted)|access denied|try again later/i.test(page)) {
      attention = { kind: "blocked", detail: "the site refused or limited the request" };
    } else if (text.length < 5 && !elements.length) {
      attention = { kind: "empty", detail: "the page showed nothing readable (it may not render in a background tab)" };
    }
    return {
      url: location.href,
      title,
      text,
      elements,
      scroll: { y: Math.round(window.scrollY), height: Math.round(document.documentElement.scrollHeight), viewport: Math.round(viewport) },
      attention,
      readAt: new Date().toISOString(),
    };
  };

  if (op.op === "snapshot") return { ok: true, snapshot: snapshot() };
  if (op.op === "scroll") {
    window.scrollBy({ top: (op.direction === "down" ? 1 : -1) * Math.round((window.innerHeight || 800) * 0.85) });
    // Pages that load as you scroll fetch the next part now.
    await wait(1_200);
    return { ok: true, snapshot: snapshot() };
  }
  const el = find(op.n);
  if (!el) return { ok: false, error: "that element is no longer on the page; read the tab again for the current numbers" };
  const label = labelOf(el);
  if (label !== op.label) return { ok: false, error: `element ${op.n} is now “${label}”, not “${op.label}”: the page changed; read the tab again` };
  if (op.op === "click") {
    if (kindOf(el) !== "input" && isWrite(el, label)) return { ok: false, error: `“${label}” acts for the owner on the site; not clicked` };
    const href = el.tagName === "A" ? (el as HTMLAnchorElement).href : "";
    const raw = el.tagName === "A" ? el.getAttribute("href") || "" : "";
    if (/^https?:/i.test(href) && raw !== "#" && !/^javascript:/i.test(raw)) return { ok: true, navigate: href };
    (el as HTMLElement).scrollIntoView({ block: "center" });
    (el as HTMLElement).click();
    return { ok: true, acted: true };
  }
  if (!isSearch(el)) return { ok: false, error: "it is not a search field" };
  const input = el as HTMLInputElement;
  input.focus();
  // The native setter, so frameworks that track the value (React) see the change.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter) setter.call(input, op.text);
  else input.value = op.text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  const enter = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
  const proceed = input.dispatchEvent(new KeyboardEvent("keydown", enter));
  input.dispatchEvent(new KeyboardEvent("keypress", enter));
  input.dispatchEvent(new KeyboardEvent("keyup", enter));
  if (proceed && input.form) {
    if (typeof input.form.requestSubmit === "function") input.form.requestSubmit();
    else input.form.submit();
  }
  return { ok: true, acted: true };
}

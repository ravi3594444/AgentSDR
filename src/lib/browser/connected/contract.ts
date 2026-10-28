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
/** The first extension version that carries out owner-requested tasks: fields, forms, screenshots and screen coordinates. */
export const BROWSER_TASK_MIN_VERSION = "0.17.0";

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
  /**
   * A control the assistant may not click, because it may act for the owner
   * on the site: anything but a link, a tab, a disclosure, pagination, a
   * search form's button or a "more"/"next" control (see pageScript).
   */
  write: boolean;
  /** A search field: the only kind the assistant may type into. */
  search: boolean;
  /** A field's type and current state, for tasks (browser_tab_act); a password or card field's value is never read. */
  field?: ResearchField;
};

export type ResearchField = {
  /** An input's type ("text", "email", "checkbox", …), "textarea", "select", "editor" (contenteditable) or an ARIA role. */
  type: string;
  value: string;
  checked?: boolean;
  /** A select's options, first ones only. */
  options?: string[];
  disabled?: boolean;
  required?: boolean;
  /** A password, card or one-time code: the assistant never reads or types it. */
  sensitive?: boolean;
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
 * Clicks are allowed by what a control is, not by what it says it does: a
 * link (followed by address, never clicked), a tab, a disclosure
 * (aria-expanded, <summary>), pagination, a search form's own button, or a
 * control labelled as showing more or the next page (READ_CONTROL_PATTERN).
 * Every other control is refused, so a "Seguir" or an icon-only button is
 * refused even though no word list names it. These English verbs are refused
 * even on a control that otherwise qualifies (a "Share" menu, a "Follow"
 * disclosure), and so is any toggle (aria-pressed: follow, like, save).
 */
export const WRITE_CONTROL_PATTERN = "\\b(?:send|post|publish|reply|comment|share|repost|retweet|quote|like|unlike|react|follow|unfollow|connect|invite|message|subscribe|join|submit|buy|order|purchase|pay|checkout|donate|book|delete|remove|block|report|mute|accept|ignore|withdraw|endorse|recommend|vote|upvote|downvote|save|bookmark|sign up|register|log ?out|sign ?out)\\b";

/**
 * Labels of controls that only show more of the page or the next one, in a
 * few languages; matched at the start of the label. A language not here is
 * refused (safe), not allowed.
 */
export const READ_CONTROL_PATTERN = "^(?:(?:show|see|view|load|read|display)\\s+(?:more|all|less)|more|next|previous|prev|older|newer|expand|continue reading|(?:ver|mostrar|cargar|leer)\\s+m[aá]s|siguiente|anterior|(?:voir|afficher)\\s+plus|suivant|précédent|mehr|weiter|zurück|nächste|vorherige|(?:ver|carregar|mostrar)\\s+mais|próximo|mostra altro|altro|successivo|और देखें|अगला|पिछला)(?!\\p{L})";

/** What marks an input as a search field when its type and role do not. */
export const SEARCH_FIELD_PATTERN = "\\b(?:search|query|find|keywords?|lookup)\\b";

/**
 * Controls a task never uses, whatever the owner asked: they send, publish
 * or connect for the owner (contacting people goes through AgentSDR's
 * tracked outreach, never through a second, untracked sender), in a few
 * languages. On social sites SOCIAL_CONTACT_PATTERN refuses more, and so
 * does structure (pageScript taskRefusal): a form or control around a
 * message box with text in it.
 */
export const CONTACT_CONTROL_PATTERN = "(?<![\\p{L}\\p{N}])(?:send|reply|reply all|forward|message|invite|dm|tweet|repost|retweet"
  + "|enviar|responder|reenviar|mensaje|invitar|mensagem|convidar|envoyer|r[ée]pondre|transf[ée]rer|inviter"
  + "|senden|absenden|antworten|weiterleiten|nachricht|einladen|invia|inviare|rispondi|inoltra|messaggio|invita"
  + "|भेजें|भेजो|जवाब दें|आमंत्रित करें)(?![\\p{L}\\p{N}])";

/** On social sites, also what publishes or connects in the owner's name (a CRM's "Add comment" or "Follow-up" stays usable elsewhere). */
export const SOCIAL_CONTACT_PATTERN = "(?<![\\p{L}\\p{N}])(?:post|publish|comment|share|connect|follow(?![\\s-]?up)|subscribe|join"
  + "|publicar|comentar|compartir|conectar|seguir|compartilhar|partilhar|publier|commenter|partager|se connecter|suivre"
  + "|ver[öo]ffentlichen|posten|kommentieren|teilen|vernetzen|folgen|pubblica|commenta|condividi|collegati|segui"
  + "|पोस्ट करें|टिप्पणी करें|साझा करें|कनेक्ट करें|फ़ॉलो करें|फॉलो करें)(?![\\p{L}\\p{N}])";

/** Controls that pay or order: payments stay with the owner, like sign-ins. */
export const PAYMENT_CONTROL_PATTERN = "(?<![\\p{L}\\p{N}])(?:buy|pay|purchase|checkout|check out|place (?:my |your )?order|order now|donate"
  + "|comprar|pagar|finalizar compra|acheter|payer|commander|kaufen|bezahlen|zur kasse|acquista|paga|खरीदें|भुगतान करें)(?![\\p{L}\\p{N}])";

/** Why a task may not do `op` with `element` of a reading, or null; the page checks again on the live element. */
export function taskActProblem(element: ResearchElement | undefined, op: TaskOp, value: string | null, social: boolean): string | null {
  if (!element) return "there is no such element in the latest reading of that tab; read it again for the current numbers";
  const label = element.label || element.kind;
  if (op === "click" || op === "press") {
    if (new RegExp(CONTACT_CONTROL_PATTERN, "iu").test(element.label) || (social && new RegExp(SOCIAL_CONTACT_PATTERN, "iu").test(element.label))) {
      return `“${label}” sends, publishes or connects for the owner: contacting people goes through AgentSDR's outreach (prepare_outreach), never the browser`;
    }
    if (new RegExp(PAYMENT_CONTROL_PATTERN, "iu").test(element.label)) return `“${label}” pays or orders: payments stay with the owner`;
  }
  if (op === "fill" || op === "select" || op === "check" || op === "uncheck") {
    if (!element.field) return `“${label}” is not a field; click it instead`;
    if (element.field.sensitive) return `“${label}” is a password, card or code field: sign-ins and payments stay with the owner`;
    if (element.field.disabled) return `“${label}” is disabled on the page`;
  }
  if (op === "fill") {
    if (value === null) return "fill needs the text to put in the field (value)";
    if (["checkbox", "radio", "select", "file", "switch", "submit", "button", "reset", "image"].includes(element.field!.type)) return `“${label}” is a ${element.field!.type}, not a text field`;
  }
  if (op === "select" && element.field!.type !== "select") return `“${label}” is not a dropdown (select); click it and then the option`;
  if (op === "select" && !value) return "select needs the option to choose (value)";
  if ((op === "check" || op === "uncheck") && !["checkbox", "radio", "switch"].includes(element.field!.type)) return `“${label}” is not a checkbox, radio button or switch`;
  return null;
}

/** Why element `n` may not be clicked, or null. */
export function clickProblem(element: ResearchElement | undefined): string | null {
  if (!element) return "there is no such element in the latest reading of that tab; read it again for the current numbers";
  if (element.kind === "input" || element.kind === "select") return "it is a field: type a search with browser_tab_search, or open the address with the filter you want";
  if (element.write) return `“${element.label || element.kind}” is not a link, tab, expand, next or "more" control, so it may act for the owner on the site (send, post, react, follow, connect, buy, delete); the assistant only reads`;
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
  | { kind: "release" }
  /** A change the owner asked for, on element `n` of the tab's latest reading; refused off the grant's sites. */
  | { kind: "act"; tabId: number; n: number; label: string; op: TaskOp; value: string | null; key: string | null; grant: BrowserTaskGrantRef }
  /** The tab's visible part as an image, the tab made visible in the AgentSDR task window first. */
  | { kind: "screenshot"; tabId: number }
  /**
   * A pointer or keyboard step at a point of the tab's latest screenshot
   * (`shotId`), in that image's pixels: refused when the tab moved, scrolled,
   * resized or navigated since. Steps that may act need a grant; a fresh
   * screenshot comes back.
   */
  | { kind: "visual"; tabId: number; shotId: string; op: VisualOp; x: number; y: number; toX: number | null; toY: number | null; deltaX: number | null; deltaY: number | null; text: string | null; key: string | null; grant: BrowserTaskGrantRef | null };

export const TASK_OPS = ["click", "fill", "select", "check", "uncheck", "press"] as const;
export type TaskOp = (typeof TASK_OPS)[number];
export const VISUAL_OPS = ["click", "double_click", "move", "drag", "scroll", "type", "key"] as const;
export type VisualOp = (typeof VISUAL_OPS)[number];
/** Visual steps that only look (hover, scroll): no grant needed. */
export const READ_VISUAL_OPS: readonly VisualOp[] = ["move", "scroll"];

/**
 * The owner's request to change things on some sites, as the server checked
 * it (tasks.ts) and carries it with every change: the extension acts only on
 * pages of `hosts` (and their subdomains), before `expiresAt`.
 */
export type BrowserTaskGrantRef = { id: string; hosts: string[]; expiresAt: string };

/** What a screenshot is, beside its image: everything a later visual step is checked against. */
export type BrowserScreenshotFacts = {
  id: string;
  url: string;
  title: string;
  /** The image's size in pixels. */
  width: number;
  height: number;
  /** Image pixels per CSS pixel of the page: a point (x, y) of the image is CSS (x / scale, y / scale) of the viewport. */
  scale: number;
  /** The viewport in CSS pixels, and its scroll position, when it was taken. */
  viewport: { width: number; height: number; scrollX: number; scrollY: number; zoom: number };
  takenAt: string;
};

export type BrowserScreenshot = BrowserScreenshotFacts & { mediaType: "image/jpeg" | "image/png"; data: string };

/** The biggest screenshot side, in image pixels: a wider viewport is scaled down to fit. */
export const SCREENSHOT_MAX_SIDE = 1280;
/** How long a screenshot stays a valid target for a visual step. */
export const SCREENSHOT_TTL_MS = 10 * 60_000;
/** A task may run this long after the owner asked; then the model asks again (browser_task). */
export const TASK_GRANT_TTL_MS = 12 * 3_600_000;

/** Keys a task may press: named keys, one printable character, with modifiers ("Control+a", "Shift+Tab"). */
export const TASK_KEYS = ["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Space"] as const;
export const KEY_MODIFIERS = ["Control", "Shift", "Alt", "Meta"] as const;

/** The key and modifiers in `value`, or null when it is not one a task may press. */
export function parseTaskKey(value: string): { key: string; modifiers: (typeof KEY_MODIFIERS)[number][] } | null {
  const parts = value.trim().split("+").map((part) => part.trim()).filter(Boolean);
  if (!parts.length || parts.length > 4) return null;
  const aliases: Record<string, (typeof KEY_MODIFIERS)[number]> = { ctrl: "Control", control: "Control", shift: "Shift", alt: "Alt", option: "Alt", meta: "Meta", cmd: "Meta", command: "Meta" };
  const modifiers: (typeof KEY_MODIFIERS)[number][] = [];
  for (const part of parts.slice(0, -1)) {
    const modifier = aliases[part.toLowerCase()];
    if (!modifier || modifiers.includes(modifier)) return null;
    modifiers.push(modifier);
  }
  const last = parts[parts.length - 1]!;
  const named = TASK_KEYS.find((key) => key.toLowerCase() === last.toLowerCase() || (key === "Escape" && last.toLowerCase() === "esc"));
  if (named) return { key: named, modifiers };
  return [...last].length === 1 ? { key: last, modifiers } : null;
}

/** Whether `host` is one of the grant's sites (or a subdomain of one) and the grant still holds. */
export function grantCovers(grant: Pick<BrowserTaskGrantRef, "hosts" | "expiresAt"> | null | undefined, host: string, now: number): boolean {
  if (!grant || !(Date.parse(grant.expiresAt) > now)) return false;
  const name = host.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  return grant.hosts.some((granted) => name === granted || name.endsWith(`.${granted}`));
}

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
  | { ok: true; tabId?: number; snapshot?: ResearchSnapshot; tabs?: BrowserResearchTab[]; closed?: number; screenshot?: BrowserScreenshot; note?: string }
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
    case "act":
      return tab(action.tabId) && Number.isSafeInteger(action.n) && typeof action.label === "string" && (TASK_OPS as readonly string[]).includes(action.op as string)
        && (action.value === null || typeof action.value === "string") && (action.key === null || (typeof action.key === "string" && parseTaskKey(action.key) !== null))
        && grantRef(action.grant) ? null : "bad act";
    case "screenshot": return tab(action.tabId) ? null : "bad screenshot";
    case "visual": {
      const point = (value: unknown, optional: boolean) => (optional && value === null) || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 20_000);
      return tab(action.tabId) && typeof action.shotId === "string" && /^[0-9a-f-]{36}$/i.test(action.shotId) && (VISUAL_OPS as readonly string[]).includes(action.op as string)
        && point(action.x, false) && point(action.y, false) && point(action.toX, true) && point(action.toY, true)
        && [action.deltaX, action.deltaY].every((delta) => delta === null || (typeof delta === "number" && Number.isFinite(delta) && Math.abs(delta) <= 20_000))
        && (action.text === null || typeof action.text === "string") && (action.key === null || (typeof action.key === "string" && parseTaskKey(action.key) !== null))
        && (action.grant === null || grantRef(action.grant)) ? null : "bad visual step";
    }
    default: return "unknown action";
  }
}

function grantRef(value: unknown): value is BrowserTaskGrantRef {
  const grant = value as Partial<BrowserTaskGrantRef> | null;
  return Boolean(grant) && typeof grant!.id === "string" && Array.isArray(grant!.hosts) && grant!.hosts.length > 0
    && grant!.hosts.every((host) => typeof host === "string" && /^[a-z0-9.-]+$/i.test(host)) && typeof grant!.expiresAt === "string" && Number.isFinite(Date.parse(grant!.expiresAt));
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
  | { op: "search"; n: number; label: string; text: string }
  /** A task's change (the extension checked the grant): `social` when the page is on one of the social sites. */
  | { op: "act"; n: number; label: string; action: TaskOp; value: string | null; key: PageKey | null; social: boolean }
  /**
   * Before a visual step: what is at CSS point (x, y), or has the keyboard
   * focus, and whether the step may use it: with `readOnly` (no grant) only
   * what a research click may use, otherwise what a task may.
   */
  | { op: "probe"; x: number; y: number; target: "point" | "focus"; key: PageKey | null; social: boolean; readOnly: boolean };

/** A key as the page script takes it (parseTaskKey's answer). */
export type PageKey = { key: string; modifiers: string[] };

export type PageScriptConfig = {
  attr: string;
  maxTextChars: number;
  maxElements: number;
  maxLabelChars: number;
  writePattern: string;
  readPattern: string;
  searchPattern: string;
  contactPattern: string;
  socialContactPattern: string;
  paymentPattern: string;
};

export const pageScriptConfig: PageScriptConfig = {
  attr: "data-agentsdr-research-n",
  maxTextChars: RESEARCH_LIMITS.maxTextChars,
  maxElements: RESEARCH_LIMITS.maxElements,
  maxLabelChars: RESEARCH_LIMITS.maxLabelChars,
  writePattern: WRITE_CONTROL_PATTERN,
  readPattern: READ_CONTROL_PATTERN,
  searchPattern: SEARCH_FIELD_PATTERN,
  contactPattern: CONTACT_CONTROL_PATTERN,
  socialContactPattern: SOCIAL_CONTACT_PATTERN,
  paymentPattern: PAYMENT_CONTROL_PATTERN,
};

export type PageScriptResult =
  | { ok: true; snapshot: ResearchSnapshot }
  /** A link: the extension checks the address and navigates the tab itself. */
  | { ok: true; navigate: string }
  /** Clicked or searched: the page may be navigating, so the extension waits and reads it afresh. */
  | { ok: true; acted: true; note?: string }
  /** A probe's answer: the visual step may go ahead. */
  | { ok: true; probe: string }
  | { ok: false; error: string };

/**
 * Runs inside a research tab (ISOLATED world). Self-contained by necessity:
 * executeScript serializes only this function. Page content can change the
 * DOM but not this code; what it returns is still untrusted page data.
 */
export async function pageScript(config: PageScriptConfig, op: PageOp): Promise<PageScriptResult> {
  const write = new RegExp(config.writePattern, "i");
  const reads = new RegExp(config.readPattern, "iu");
  const searchy = new RegExp(config.searchPattern, "i");
  const clean = (value: string | null | undefined, max: number) => (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const visible = (el: Element) => {
    const box = el.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
  };
  const editorRoot = (el: Element) => (el as HTMLElement).isContentEditable && !(el.parentElement?.isContentEditable ?? false);
  const isField = (el: Element) => ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName) || editorRoot(el) || (el.getAttribute("role") || "").toLowerCase() === "textbox";
  const labelledBy = (el: Element) => (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)
    .map((id) => (document.getElementById(id) as HTMLElement | null)?.innerText || "").join(" ");
  // A field is named by its label, never by what is typed in it (that changes as the task fills it).
  const labelOf = (el: Element) => clean(
    isField(el)
      ? el.getAttribute("aria-label") || labelledBy(el) || ((el as HTMLInputElement).labels?.[0] as HTMLElement | undefined)?.innerText || el.getAttribute("placeholder")
        || el.getAttribute("data-placeholder") || el.getAttribute("title") || el.getAttribute("name")
        || (["submit", "button", "reset"].includes((el.getAttribute("type") || "").toLowerCase()) ? el.getAttribute("value") : "") || ""
      : el.getAttribute("aria-label") || (el as HTMLElement).innerText || el.getAttribute("placeholder") || el.getAttribute("title")
        || el.getAttribute("name") || el.getAttribute("value") || el.getAttribute("alt") || "",
    config.maxLabelChars,
  );
  // A form a search may submit: GET, and nothing in it that sends or signs in (a message box, a password, a file).
  const sending = "textarea, [contenteditable]:not([contenteditable=false]), input[type=password], input[type=file]";
  const safeForm = (form: HTMLFormElement) => (form.getAttribute("method") || "get").toLowerCase() === "get"
    && !form.querySelector(sending) && !Array.from(form.elements).some((field) => field.matches(sending));
  const isSearch = (el: Element) => {
    if (el.tagName !== "INPUT" || el.closest("[contenteditable]:not([contenteditable=false])")) return false;
    const form = (el as HTMLInputElement).form;
    if (form && !safeForm(form)) return false;
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "search") return true;
    if (type !== "text") return false;
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (role === "searchbox" || role === "combobox") return true;
    if (el.closest("[role=search], form[role=search], search")) return true;
    return searchy.test(`${el.getAttribute("name") || ""} ${el.getAttribute("placeholder") || ""} ${el.getAttribute("aria-label") || ""} ${el.id}`);
  };
  const navigates = (el: Element) => {
    const raw = el.tagName === "A" ? el.getAttribute("href") || "" : "";
    return el.tagName === "A" && /^https?:/i.test((el as HTMLAnchorElement).href || "") && raw !== "#" && !/^javascript:/i.test(raw);
  };
  // True unless the control, by its structure, only navigates or reveals (WRITE_CONTROL_PATTERN's comment has the rule).
  const isWrite = (el: Element, label: string) => {
    if (navigates(el)) return false;
    if (write.test(label) || el.hasAttribute("aria-pressed")) return true;
    // A button submits (or resets) its form whatever its role or label says: <button> without a type submits,
    // and form= ties it to a form elsewhere. Only a search form's own submit is a read.
    const type = (el.getAttribute("type") || "").toLowerCase();
    const submits = el.tagName === "BUTTON" ? type !== "button" : el.tagName === "INPUT" && ["submit", "image", "reset"].includes(type);
    const form = submits ? (el as HTMLButtonElement).form : null;
    if (form) {
      const method = (el.getAttribute("formmethod") || form.getAttribute("method") || "get").toLowerCase();
      return type === "reset" || method !== "get" || !safeForm(form) || !Array.from(form.elements).some(isSearch);
    }
    if ((el.getAttribute("role") || "").toLowerCase() === "tab" || el.tagName === "SUMMARY" || el.hasAttribute("aria-expanded")) return false;
    if ((el.getAttribute("rel") || "").split(/\s+/).some((rel) => rel === "next" || rel === "prev")) return false;
    return !reads.test(label);
  };
  const kindOf = (el: Element): ResearchElementKind => {
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (el.tagName === "A" || role === "link") return "link";
    if (el.tagName === "BUTTON" || role === "button") return "button";
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || editorRoot(el) || ["textbox", "checkbox", "radio", "switch", "combobox", "searchbox"].includes(role)) return "input";
    if (el.tagName === "SELECT") return "select";
    if (role === "tab") return "tab";
    return "other";
  };
  // A password, card number or one-time code: never read, never typed.
  const sensitive = (el: Element) => {
    if (el.tagName !== "INPUT") return false;
    const auto = (el.getAttribute("autocomplete") || "").toLowerCase();
    return (el.getAttribute("type") || "").toLowerCase() === "password" || /(?:^|\s)(?:cc-[a-z-]+|current-password|new-password|one-time-code)(?:\s|$)/.test(auto)
      || /card.?(?:number|no\b)|cvv|cvc|security.?code/i.test(`${el.getAttribute("name") || ""} ${el.id}`);
  };
  const fieldOf = (el: Element): ResearchField => {
    const role = (el.getAttribute("role") || "").toLowerCase();
    const base = { disabled: (el as HTMLInputElement).disabled === true || el.getAttribute("aria-disabled") === "true", required: (el as HTMLInputElement).required === true || el.getAttribute("aria-required") === "true" };
    if (el.tagName === "SELECT") {
      const select = el as HTMLSelectElement;
      return { ...base, type: "select", value: clean(select.selectedOptions[0]?.label ?? "", 120), options: Array.from(select.options).slice(0, 30).map((option) => clean(option.label || option.text, 80)) };
    }
    if (el.tagName === "INPUT") {
      const input = el as HTMLInputElement;
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") return { ...base, type, value: clean(input.value, 80), checked: input.checked };
      if (sensitive(el)) return { ...base, type, value: "", sensitive: true };
      return { ...base, type, value: type === "file" ? "" : clean(input.value, 300) };
    }
    if (el.tagName === "TEXTAREA") return { ...base, type: "textarea", value: clean((el as HTMLTextAreaElement).value, 300) };
    if (role === "checkbox" || role === "radio" || role === "switch") return { ...base, type: role, value: "", checked: el.getAttribute("aria-checked") === "true" };
    if (editorRoot(el)) return { ...base, type: "editor", value: clean((el as HTMLElement).innerText, 300) };
    return { ...base, type: role || "text", value: clean((el as HTMLElement).innerText || el.getAttribute("aria-valuetext") || "", 300) };
  };
  const find = (n: number) => document.querySelector(`[${config.attr}="${n}"]`);
  const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

  // --- Tasks: what the owner asked for, never contacting people or paying ---
  const contact = new RegExp(config.contactPattern, "iu");
  const socialContact = new RegExp(config.socialContactPattern, "iu");
  const payment = new RegExp(config.paymentPattern, "iu");
  const composers = "textarea, [contenteditable]:not([contenteditable=false])";
  const isComposer = (el: Element | null) => Boolean(el) && (el!.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable);
  const hasText = (el: Element) => (el.tagName === "TEXTAREA" ? (el as HTMLTextAreaElement).value : (el as HTMLElement).innerText || "").trim().length > 0;
  // A message box with something written in it, a few levels around `el`: a chat's send button sits close to its box.
  const nearDraft = (el: Element) => {
    let node = el.parentElement;
    for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
      if (Array.from(node.querySelectorAll(composers)).some(hasText)) return true;
    }
    return false;
  };
  const taskRefusal = (el: Element, label: string, social: boolean): string | null => {
    const name = label || el.tagName.toLowerCase();
    if (contact.test(label) || (social && socialContact.test(label))) return `“${name}” sends, publishes or connects for the owner: contacting people goes through AgentSDR's outreach, never the browser`;
    if (payment.test(label)) return `“${name}” pays or orders: payments stay with the owner`;
    if (social && !isComposer(el) && isWrite(el, label) && nearDraft(el)) return `on a social site “${name}” sits beside a written message and may send it: contacting people goes through AgentSDR's outreach, never the browser`;
    return null;
  };
  const KEY_CODES: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34, Space: 32 };
  // Enter where it would send or submit: refused in a message box (chats send on Enter), and as a refused form submission.
  const enterRefusal = (el: Element, social: boolean): string | null => {
    if (isComposer(el)) return "Enter sends in many message boxes, so it is not pressed in one; put line breaks in the text instead";
    const form = (el as HTMLInputElement).form ?? null;
    if (!form) return null;
    const submitter = Array.from(form.elements).find((item) => (item.tagName === "BUTTON" && !["button", "reset"].includes((item.getAttribute("type") || "").toLowerCase()))
      || (item.tagName === "INPUT" && ["submit", "image"].includes((item.getAttribute("type") || "").toLowerCase())));
    const refusal = submitter ? taskRefusal(submitter, labelOf(submitter), social) : null;
    if (refusal) return `Enter would submit the form through ${refusal}`;
    if (social && Array.from(form.elements).some((item) => isComposer(item) && hasText(item))) return "Enter would submit a written message on a social site: contacting people goes through AgentSDR's outreach, never the browser";
    return null;
  };
  const setValue = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const act = (el: Element, label: string, op: Extract<PageOp, { op: "act" }>): PageScriptResult => {
    const type = (el.getAttribute("type") || "").toLowerCase();
    const role = (el.getAttribute("role") || "").toLowerCase();
    const name = label || el.tagName.toLowerCase();
    if (op.action === "click") {
      if (navigates(el)) return { ok: true, navigate: (el as HTMLAnchorElement).href };
      const refusal = taskRefusal(el, label, op.social);
      if (refusal) return { ok: false, error: refusal };
      (el as HTMLElement).scrollIntoView({ block: "center" });
      (el as HTMLElement).click();
      return { ok: true, acted: true };
    }
    if (op.action === "fill") {
      if (sensitive(el)) return { ok: false, error: `“${name}” is a password, card or code field: sign-ins and payments stay with the owner` };
      const value = op.value ?? "";
      (el as HTMLElement).focus();
      if (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !["checkbox", "radio", "file", "submit", "button", "reset", "image", "range", "color"].includes(type || "text"))) {
        setValue(el as HTMLInputElement, value);
        return { ok: true, acted: true, note: `“${name}” now holds “${clean((el as HTMLInputElement).value, 200)}”` };
      }
      if ((el as HTMLElement).isContentEditable) {
        const selection = getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        selection?.removeAllRanges();
        selection?.addRange(range);
        // insertText goes through the editor's own input handling (it fires beforeinput and input).
        if (!document.execCommand("insertText", false, value)) {
          el.textContent = value;
          el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
        }
        return { ok: true, acted: true, note: `“${name}” now holds “${clean((el as HTMLElement).innerText, 200)}”` };
      }
      return { ok: false, error: `“${name}” is not a text field` };
    }
    if (op.action === "select") {
      if (el.tagName !== "SELECT") return { ok: false, error: `“${name}” is not a dropdown (select): click it, then click the option` };
      const select = el as HTMLSelectElement;
      const wanted = (op.value ?? "").trim().toLowerCase();
      const options = Array.from(select.options);
      const text = (option: HTMLOptionElement) => clean(option.label || option.text, 200).toLowerCase();
      const option = options.find((item) => text(item) === wanted || item.value.toLowerCase() === wanted) ?? options.find((item) => wanted && text(item).startsWith(wanted));
      if (!option) return { ok: false, error: `“${name}” has no option “${op.value ?? ""}”; its options: ${options.slice(0, 30).map((item) => clean(item.label || item.text, 60)).join(" | ")}` };
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      if (setter) setter.call(select, option.value);
      else select.value = option.value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, acted: true, note: `“${name}” is now “${clean(option.label || option.text, 120)}”` };
    }
    if (op.action === "check" || op.action === "uncheck") {
      const want = op.action === "check";
      const box = el.tagName === "INPUT" && (type === "checkbox" || type === "radio");
      if (!box && !["checkbox", "radio", "switch"].includes(role)) return { ok: false, error: `“${name}” is not a checkbox, radio button or switch` };
      const state = () => (box ? (el as HTMLInputElement).checked : el.getAttribute("aria-checked") === "true");
      if (state() !== want) {
        if (!want && (type === "radio" || role === "radio")) return { ok: false, error: "a radio button is unchecked by choosing another one" };
        (el as HTMLElement).scrollIntoView({ block: "center" });
        (el as HTMLElement).click();
      }
      return state() === want ? { ok: true, acted: true, note: `“${name}” is ${want ? "checked" : "unchecked"}` } : { ok: false, error: `“${name}” did not change; take a screenshot to see why` };
    }
    // press: synthetic key events, which page scripts hear; the browser's own default actions (moving focus, typing) need browser_tab_visual.
    const key = op.key;
    if (!key) return { ok: false, error: "press needs a key" };
    if (key.key === "Enter") {
      const refusal = enterRefusal(el, op.social);
      if (refusal) return { ok: false, error: refusal };
    }
    (el as HTMLElement).focus();
    const printable = [...key.key].length === 1 ? key.key : key.key === "Space" ? " " : "";
    const init: KeyboardEventInit = {
      key: printable || key.key, code: printable ? (/^[a-z]$/i.test(printable) ? `Key${printable.toUpperCase()}` : /^\d$/.test(printable) ? `Digit${printable}` : printable === " " ? "Space" : "") : key.key,
      keyCode: KEY_CODES[key.key] ?? printable.toUpperCase().charCodeAt(0), which: KEY_CODES[key.key] ?? printable.toUpperCase().charCodeAt(0), bubbles: true, cancelable: true,
      ctrlKey: key.modifiers.includes("Control"), shiftKey: key.modifiers.includes("Shift"), altKey: key.modifiers.includes("Alt"), metaKey: key.modifiers.includes("Meta"),
    };
    const proceed = el.dispatchEvent(new KeyboardEvent("keydown", init));
    if (printable || key.key === "Enter") el.dispatchEvent(new KeyboardEvent("keypress", init));
    el.dispatchEvent(new KeyboardEvent("keyup", init));
    const form = (el as HTMLInputElement).form ?? null;
    if (proceed && key.key === "Enter" && !key.modifiers.length && form && el.tagName === "INPUT") form.requestSubmit();
    return { ok: true, acted: true, note: `pressed ${[...key.modifiers, key.key].join("+")} on “${name}” (page scripts hear it; a page that ignores it takes real keys through browser_tab_visual)` };
  };
  const probe = (op: Extract<PageOp, { op: "probe" }>): PageScriptResult => {
    if (op.target === "focus") {
      let el: Element | null = document.activeElement;
      while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
      for (let depth = 0; el?.tagName === "IFRAME" && depth < 3; depth += 1) {
        let inner: Document | null = null;
        try {
          inner = (el as HTMLIFrameElement).contentDocument;
        } catch { /* another site's frame */ }
        if (!inner) return { ok: false, error: "the keyboard focus is inside an embedded frame from another site; open that frame's page in its own tab to work there" };
        el = inner.activeElement;
      }
      if (el && sensitive(el)) return { ok: false, error: "the keyboard focus is in a password, card or code field: sign-ins and payments stay with the owner" };
      if (el && op.key?.key === "Enter") {
        const refusal = enterRefusal(el, op.social);
        if (refusal) return { ok: false, error: refusal };
      }
      return { ok: true, probe: el && el !== document.body ? `${el.tagName.toLowerCase()}${labelOf(el) ? ` “${labelOf(el)}”` : ""}` : "the page" };
    }
    let x = op.x;
    let y = op.y;
    let el = document.elementFromPoint(x, y);
    for (let depth = 0; el?.tagName === "IFRAME" && depth < 3; depth += 1) {
      const frame = el as HTMLIFrameElement;
      let inner: Document | null = null;
      try {
        inner = frame.contentDocument;
      } catch { /* another site's frame */ }
      if (!inner) return { ok: false, error: "that point is inside an embedded frame from another site; open that frame's page in its own tab to work there" };
      const box = frame.getBoundingClientRect();
      x -= box.left + frame.clientLeft;
      y -= box.top + frame.clientTop;
      el = inner.elementFromPoint(x, y);
    }
    if (!el) return { ok: true, probe: "nothing (outside the page)" };
    const control = el.closest("a[href], button, input, select, textarea, summary, label, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=checkbox], [role=radio], [role=switch], [contenteditable]:not([contenteditable=false])") ?? el;
    const label = labelOf(control);
    const what = `${control.tagName.toLowerCase()}${label ? ` “${label}”` : ""}`;
    if (op.readOnly) {
      // Without the owner's request to change anything, a point is clicked only where a research click could be.
      if (navigates(control) || (!isField(control) && control.tagName !== "SELECT" && !isWrite(control, label) && control !== el.ownerDocument.body)) return { ok: true, probe: what };
      return { ok: false, error: `${what} is not a link, tab, expand, next or "more" control, and the owner has not asked for changes on this site (browser_task), so it is not clicked` };
    }
    const refusal = taskRefusal(control, label, op.social);
    return refusal ? { ok: false, error: refusal } : { ok: true, probe: what };
  };

  const snapshot = (): ResearchSnapshot => {
    document.querySelectorAll(`[${config.attr}]`).forEach((el) => el.removeAttribute(config.attr));
    const viewport = window.innerHeight || 800;
    const elements: ResearchElement[] = [];
    const selector = "a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [contenteditable]:not([contenteditable=false]), "
      + "[role=textbox], [role=searchbox], [role=checkbox], [role=radio], [role=switch], [role=combobox], [role=option], [role=menuitem]";
    for (const el of Array.from(document.querySelectorAll(selector))) {
      if (elements.length >= config.maxElements) break;
      if (!visible(el)) continue;
      if ((el as HTMLElement).isContentEditable && !editorRoot(el) && !el.matches("a[href], button, [role]")) continue;
      // From a little above the current position down: what scrolling has passed is gone from the reading.
      if (el.getBoundingClientRect().bottom < -viewport * 0.25) continue;
      const n = elements.length + 1;
      el.setAttribute(config.attr, String(n));
      const label = labelOf(el);
      const kind = kindOf(el);
      const anchor = el.tagName === "A" ? (el as HTMLAnchorElement).href : "";
      elements.push({
        n, kind, label, href: /^https?:/i.test(anchor) ? anchor : null, write: kind !== "input" && kind !== "select" && isWrite(el, label), search: isSearch(el),
        ...(kind === "input" || kind === "select" ? { field: fieldOf(el) } : {}),
      });
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
  if (op.op === "probe") return probe(op);
  const el = find(op.n);
  if (!el) return { ok: false, error: "that element is no longer on the page; read the tab again for the current numbers" };
  const label = labelOf(el);
  if (label !== op.label) return { ok: false, error: `element ${op.n} is now “${label}”, not “${op.label}”: the page changed; read the tab again` };
  if (op.op === "click") {
    // Checked again on the live element: the page may have changed since the reading.
    if (navigates(el)) return { ok: true, navigate: (el as HTMLAnchorElement).href };
    if (kindOf(el) === "input" || kindOf(el) === "select" || isWrite(el, label)) return { ok: false, error: `“${label}” is not a link, tab, expand, next or "more" control, so it may act for the owner on the site; not clicked` };
    (el as HTMLElement).scrollIntoView({ block: "center" });
    (el as HTMLElement).click();
    return { ok: true, acted: true };
  }
  if (op.op === "act") return act(el, label, op);
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

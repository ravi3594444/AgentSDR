import type { BusinessProfile, LeadSignal } from "@/lib/assistant/schema";
import { cleanEmail, cleanLinkedinUrl, contactPageLinks, hrefs, MAX_TEXT_SCAN, visibleText, withoutElements } from "./contacts";

/**
 * What a business's own website shows that bears on the owner's offer, read
 * from the pages the contact reader already fetched (websiteContacts.server.ts):
 * booking and contact options, hiring that matches the offer, an explicit
 * request for suppliers, its own description, and the people it names with
 * a role. Pure and client-safe; linear in the size of each page.
 *
 * The rules that keep it honest:
 * - Every observation keeps its page, the time it was read and how sure it
 *   is. Relevance to the offer is inferred from matching words and is never
 *   buying interest; only an explicit request for suppliers is a need.
 * - Nothing is recorded as absent. A topic the pages read do not show is
 *   "not found on the pages read", never "does not exist".
 * - A person is someone the page names together with a role. Only an
 *   address or LinkedIn profile shown in that person's own card is theirs,
 *   and a general address (info@, contact@, …) is never anyone's.
 */

export type ObservationTopic = "need" | "hiring" | "booking" | "contact" | "context";

export type Observation = {
  topic: ObservationTopic;
  /** As the page says it, or what was found ("Online booking link (Calendly)"). */
  text: string;
  sourceUrl: string;
  /** How sure it is, in the owner's words. */
  uncertainty: string;
  /** Why it may matter to the owner's offer, inferred from matching words; null when not claimed. */
  relevance: string | null;
};

export type NamedPerson = { name: string; role: string; email: string | null; linkedin: string | null; sourceUrl: string };

export type WebsiteProfile = {
  /** When the pages were read (ISO). */
  checkedAt: string;
  pagesRead: string[];
  observations: Observation[];
  people: NamedPerson[];
};

/** The words of the owner's saved business information findings are matched against. */
export type OfferFocus = {
  /** From what is sold and the problems it solves. */
  offer: string[];
  /** From who the customers are. */
  customers: string[];
};

const PER_SITE: Record<ObservationTopic, number> = { booking: 2, contact: 3, hiring: 2, need: 1, context: 3 };
const MAX_PEOPLE = 5;
const MAX_LINES = 6_000;
const MAX_LINE = 500;
const MAX_ANCHORS = 2_000;
const MAX_TAG = 2_000;

// ── The owner's words ───────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "about", "after", "also", "area", "based", "been", "before", "being", "best", "better", "business", "businesses", "city", "client", "clients",
  "companies", "company", "could", "customer", "customers", "does", "done", "each", "easy", "every", "fast", "faster", "first", "free", "from",
  "full", "good", "great", "have", "help", "helps", "high", "into", "just", "like", "local", "make", "makes", "many", "month", "months", "more",
  "most", "need", "needs", "offer", "offers", "online", "only", "other", "others", "over", "owner", "owners", "people", "platform", "provide",
  "provides", "save", "saves", "service", "services", "should", "simple", "small", "solution", "solutions", "such", "system", "systems", "than",
  "that", "their", "them", "then", "there", "these", "they", "this", "those", "through", "time", "today", "tool", "tools", "using", "want", "week",
  "weeks", "what", "when", "where", "which", "while", "will", "with", "within", "without", "work", "works", "would", "year", "years", "your",
]);

function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 5 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(?:ss|x|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function wordsOf(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function termsOf(text: string | undefined): string[] {
  const out: string[] = [];
  for (const word of wordsOf(text ?? "")) {
    if (word.length < 4 || STOP_WORDS.has(word)) continue;
    const term = stem(word);
    if (term.length < 3 || STOP_WORDS.has(term) || out.includes(term)) continue;
    out.push(term);
  }
  return out;
}

/** The terms of an organization's saved offer, problems solved and target customers; empty when none is saved. */
export function offerFocus(profile: Pick<BusinessProfile, "offer" | "problemsSolved" | "targetCustomers">): OfferFocus {
  const customers = termsOf(profile.targetCustomers).slice(0, 20);
  const offer = termsOf(`${profile.offer ?? ""} ${profile.problemsSolved ?? ""}`).filter((term) => !customers.includes(term)).slice(0, 40);
  return { offer, customers };
}

function matching(text: string, terms: readonly string[]): string[] {
  if (!terms.length) return [];
  const present = new Set(wordsOf(text).map(stem));
  return terms.filter((term) => present.has(term));
}

function clip(text: string, limit = 200): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:–—-]+$/, "")}…`;
}

// ── Pages as lines ──────────────────────────────────────────────────────────

type Anchor = { href: string; text: string };
export type PageLine = { text: string; anchors: Anchor[] };
type PageScan = { lines: PageLine[]; description: string | null; contactForm: boolean };

/** Tags that end a line of text: a card's name and its role are separate lines. */
const BLOCK_TAGS = new Set(["p", "div", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "br", "hr", "tr", "td", "th", "table", "section", "article", "header", "footer", "nav", "aside", "main", "dt", "dd", "dl", "blockquote", "figcaption", "figure", "form", "label", "button", "address", "option", "select"]);
const TAG_NAME = /^(\/?)([a-zA-Z][a-zA-Z0-9]*)/;
const HREF_ATTRIBUTE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const CONTENT_ATTRIBUTE = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const DESCRIPTION_META = /\b(?:name|property)\s*=\s*["']?(?:og:)?description["'\s/>]/i;

function lineText(raw: string): string {
  // Tags are already gone: entities are decoded only where there are some.
  const text = (/[&<]/.test(raw) ? visibleText(raw) : raw.replace(/\s+/g, " ")).trim();
  return text.length > MAX_LINE ? text.slice(0, MAX_LINE) : text;
}

/**
 * A page as its lines of visible text, each with the links in it, plus its
 * own description and whether it has a contact form. One pass over the
 * page; at most MAX_TEXT_SCAN characters of text, MAX_LINES lines and
 * MAX_ANCHORS links.
 */
function scanPage(html: string): PageScan {
  const source = withoutElements(html, ["script", "style", "noscript", "svg", "template", "title"]);
  const lines: PageLine[] = [];
  let description: string | null = null;
  let contactForm = false;
  let inForm = false;
  let text = "";
  let anchors: Anchor[] = [];
  let open: { href: string; from: number } | null = null;
  let anchorCount = 0;
  let scanned = 0;
  const closeAnchor = () => {
    if (!open) return;
    if (anchorCount < MAX_ANCHORS) {
      anchors.push({ href: visibleText(open.href).trim(), text: lineText(text.slice(open.from)) });
      anchorCount += 1;
    }
    open = null;
  };
  const flush = () => {
    closeAnchor();
    if (!anchors.length && !/\S/.test(text)) {
      scanned += text.length;
      text = "";
      return;
    }
    const value = lineText(text);
    if (value || anchors.length) lines.push({ text: value, anchors });
    scanned += text.length;
    text = "";
    anchors = [];
  };
  let at = 0;
  while (at < source.length && lines.length < MAX_LINES && scanned < MAX_TEXT_SCAN) {
    const lt = source.indexOf("<", at);
    if (lt < 0) {
      text += source.slice(at);
      break;
    }
    text += source.slice(at, lt);
    const gt = source.indexOf(">", lt + 1);
    // No ">" after this "<": none after any later one either; the rest is text.
    if (gt < 0) {
      text += source.slice(lt, lt + MAX_TEXT_SCAN);
      break;
    }
    const tag = source.slice(lt + 1, Math.min(gt, lt + 1 + MAX_TAG));
    at = gt + 1;
    const parsed = TAG_NAME.exec(tag);
    if (!parsed) {
      text += " ";
      continue;
    }
    const closing = parsed[1] === "/";
    const name = parsed[2]!.toLowerCase();
    if (name === "a") {
      closeAnchor();
      const href = closing ? null : HREF_ATTRIBUTE.exec(tag);
      if (href) open = { href: href[1] ?? href[2] ?? href[3] ?? "", from: text.length };
      continue;
    }
    if (name === "meta") {
      if (!description && DESCRIPTION_META.test(tag)) {
        const content = CONTENT_ATTRIBUTE.exec(tag);
        const value = content ? visibleText(content[1] ?? content[2] ?? "").trim() : "";
        if (value) description = clip(value);
      }
      continue;
    }
    if (name === "form") inForm = !closing;
    else if (inForm && !closing && (name === "textarea" || (name === "input" && /\btype\s*=\s*["']?email\b/i.test(tag)))) contactForm = true;
    if (BLOCK_TAGS.has(name)) flush();
    else text += " ";
  }
  flush();
  return { lines, description, contactForm };
}

/** A page as its lines of visible text with their links (for tests and the people reader). */
export function pageLines(html: string): PageLine[] {
  return scanPage(html).lines;
}

// ── Which pages to read ─────────────────────────────────────────────────────

const PATH_END = String.raw`(?:/|\.html?|\.php|\.aspx?|$)`;
const CONTACT_PATH = new RegExp(`(?:^|/)(?:contact(?:-us)?|contacts|kontakt|contacto|contato|contatti|impressum|reach-us|get-in-touch)${PATH_END}`, "i");
const PEOPLE_PATH = new RegExp(`(?:^|/)(?:about(?:-us)?|team|our-team|the-team|meet-the-team|people|leadership|management|doctors|our-doctors|staff|founders?|who-we-are)${PATH_END}`, "i");
const CAREERS_PATH = new RegExp(`(?:^|/)(?:careers?|jobs|job-openings|openings|vacancies|join-us|join-our-team|work-with-us|we-are-hiring|hiring)${PATH_END}`, "i");

/** Same-site links whose path matches, in page order, each once. */
function sameSiteLinks(html: string, pageUrl: string, path: RegExp): string[] {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return [];
  }
  const site = base.hostname.replace(/^www\./, "");
  const out: string[] = [];
  let seen = 0;
  for (const href of hrefs(html)) {
    if (++seen > MAX_ANCHORS * 5) break;
    if (/^(?:mailto|tel|javascript|data):/i.test(href)) continue;
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol) || url.hostname.replace(/^www\./, "") !== site || !path.test(url.pathname)) continue;
    url.hash = "";
    const normalized = url.toString();
    if (normalized !== base.toString() && !out.includes(normalized)) out.push(normalized);
    if (out.length >= 3) break;
  }
  return out;
}

/**
 * The same-site pages to read after the home page, at most `limit` (the
 * reader's existing budget): one contact page, one about or team page and
 * one careers page when the home page links them, then the contact, about
 * and imprint pages it always read.
 */
export function profilePageLinks(html: string, pageUrl: string, limit = 3): string[] {
  const out: string[] = [];
  for (const path of [CONTACT_PATH, PEOPLE_PATH, CAREERS_PATH]) {
    const link = sameSiteLinks(html, pageUrl, path).find((url) => !out.includes(url));
    if (link) out.push(link);
  }
  for (const link of contactPageLinks(html, pageUrl, limit + out.length)) {
    if (out.length >= limit) break;
    if (!out.includes(link)) out.push(link);
  }
  return out.slice(0, limit);
}

// ── Observations ────────────────────────────────────────────────────────────

const BOOKING_HOSTS: [RegExp, string][] = [
  [/(?:^|\.)calendly\.com$/i, "Calendly"],
  [/(?:^|\.)(?:acuityscheduling\.com|as\.me)$/i, "Acuity Scheduling"],
  [/(?:^|\.)practo\.com$/i, "Practo"],
  [/(?:^|\.)zocdoc\.com$/i, "Zocdoc"],
  [/(?:^|\.)setmore\.com$/i, "Setmore"],
  [/(?:^|\.)simplybook\.(?:me|it|asia)$/i, "SimplyBook.me"],
  [/(?:^|\.)booksy\.com$/i, "Booksy"],
  [/(?:^|\.)fresha\.com$/i, "Fresha"],
  [/(?:^|\.)vagaro\.com$/i, "Vagaro"],
  [/(?:^|\.)youcanbook\.me$/i, "YouCanBookMe"],
  [/(?:^|\.)tidycal\.com$/i, "TidyCal"],
  [/^(?:www\.)?cal\.com$/i, "Cal.com"],
  [/^meetings(?:-[a-z0-9]+)?\.hubspot\.com$/i, "HubSpot Meetings"],
  [/^book\.squareup\.com$/i, "Square Appointments"],
  [/(?:^|\.)opentable\.[a-z.]+$/i, "OpenTable"],
  [/(?:^|\.)mindbodyonline\.com$/i, "Mindbody"],
];
const BOOKING_TEXT = /\b(?:book (?:an? |your |a free )?(?:appointment|consultation|visit|table|session|call|demo|slot)|book (?:now|online)|schedule (?:an? |your )?(?:appointment|visit|consultation|call)|request (?:an? )?appointment|make an appointment)\b/i;
const CHAT_WIDGETS = /(embed\.tawk\.to|widget\.intercom\.io|js\.intercomcdn\.com|client\.crisp\.chat|code\.tidio\.co|static\.zdassets\.com|wchat\.freshchat\.com|js\.driftt\.com|cdn\.livechatinc\.com)/i;
const CHAT_LABEL: Record<string, string> = {
  "embed.tawk.to": "tawk.to",
  "widget.intercom.io": "Intercom",
  "js.intercomcdn.com": "Intercom",
  "client.crisp.chat": "Crisp",
  "code.tidio.co": "Tidio",
  "static.zdassets.com": "Zendesk",
  "wchat.freshchat.com": "Freshchat",
  "js.driftt.com": "Drift",
  "cdn.livechatinc.com": "LiveChat",
};
const HIRING_CUE = /\b(?:we(?:['’]re| are) hiring|now hiring|hiring (?:an?|for)\b|join our team|(?:we(?:['’]re| are)) looking for (?:an?|new)\b|open (?:positions?|roles?)|vacanc(?:y|ies)|job openings?|current openings?)/i;
const NEED_CUE = /\b(?:request for (?:proposals?|quotations?|quotes?)|rfp|rfq|tenders? (?:for|notice|invited)|e-?tender|(?:we are|we['’]re|currently) (?:seeking|looking for|inviting) (?:an? |new |qualified |reliable )?(?:vendors?|suppliers?|agenc(?:y|ies)|partners?|contractors?|service providers?|consultants?|bids?|quotations?|proposals?)|call for (?:suppliers|vendors|proposals|tenders)|invit(?:e|es|ing) (?:bids|quotations|proposals|tenders))\b/i;
/** A line that is a contact detail or a link, not a job or a sentence about the business. */
const NOT_PROSE = /\d{4,}|@|https?:|^(?:call|email|phone|tel|contact|address|follow)\b/i;
const QUOTED = /^["“”‘’'—–-]/;
const SENTENCE_END = /[.!?…]["”’']?$/;

function relevanceText(offer: string[], customers: string[] = []): string | null {
  const parts = [
    offer.length ? `matching words from your offer: ${offer.join(", ")}` : null,
    customers.length ? `words from your target customers: ${customers.join(", ")}` : null,
  ].filter(Boolean);
  return parts.length ? `inferred from ${parts.join("; ")}` : null;
}

function whatsappNumber(url: URL): string | null {
  const digits = url.hostname.replace(/^www\./, "") === "wa.me" ? url.pathname.replace(/\D/g, "") : (url.searchParams.get("phone") ?? "").replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
}

function pageObservations(scan: PageScan, html: string, pageUrl: string, focus: OfferFocus): Observation[] {
  const out: Observation[] = [];
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return out;
  }
  const site = base.hostname.replace(/^www\./, "");
  const careersPage = CAREERS_PATH.test(base.pathname);

  for (const line of scan.lines) {
    for (const anchor of line.anchors) {
      let url: URL;
      try {
        url = new URL(anchor.href, base);
      } catch {
        continue;
      }
      if (!/^https?:$/.test(url.protocol)) continue;
      const host = url.hostname.toLowerCase();
      const bare = host.replace(/^www\./, "");
      const booking = BOOKING_HOSTS.find(([pattern]) => pattern.test(host));
      if (booking) {
        out.push({ topic: "booking", text: `Online booking link (${booking[1]})`, sourceUrl: pageUrl, uncertainty: "a booking link on the page; the booking page itself was not opened", relevance: null });
      } else if (bare === "wa.me" || (/^(?:api\.|web\.)?whatsapp\.com$/.test(bare) && /\/send\b/.test(url.pathname))) {
        const number = whatsappNumber(url);
        out.push({ topic: "contact", text: number ? `WhatsApp chat link (${number})` : "WhatsApp chat link", sourceUrl: pageUrl, uncertainty: "a click-to-chat link on the page; the number was not checked", relevance: null });
      } else if (bare === site && BOOKING_TEXT.test(anchor.text) && anchor.text.length <= 60) {
        out.push({ topic: "booking", text: `Booking link: “${anchor.text}”`, sourceUrl: pageUrl, uncertainty: "a booking button or link on the page; where it leads was not checked", relevance: null });
      }
    }
  }
  const widget = CHAT_WIDGETS.exec(html)?.[1]?.toLowerCase();
  if (widget) out.push({ topic: "contact", text: `Live chat on the website (${CHAT_LABEL[widget] ?? widget})`, sourceUrl: pageUrl, uncertainty: "a chat widget's script on the page; whether anyone answers it was not checked", relevance: null });
  if (scan.contactForm) out.push({ topic: "contact", text: "Contact form", sourceUrl: pageUrl, uncertainty: "a form on the page; it was not submitted", relevance: null });

  if (scan.description) {
    out.push({ topic: "context", text: scan.description, sourceUrl: pageUrl, uncertainty: "their own description of the business (the page's summary)", relevance: relevanceText(matching(scan.description, focus.offer), matching(scan.description, focus.customers)) });
  }

  let lastHiringCue = -Infinity;
  scan.lines.forEach((line, index) => {
    const text = line.text;
    if (!text) return;
    const cue = HIRING_CUE.test(text);
    if (cue) lastHiringCue = index;
    if (QUOTED.test(text)) return;
    const offerWords = matching(text, focus.offer);
    if (!offerWords.length) return;
    if (NEED_CUE.test(text)) {
      out.push({ topic: "need", text: clip(text, 240), sourceUrl: pageUrl, uncertainty: "stated on their website, undated; it may already be closed", relevance: relevanceText(offerWords) });
      return;
    }
    // A job: a line that says so, or on a careers page a short line soon after its "we're hiring".
    const listedJob = careersPage && index - lastHiringCue <= 12 && text.length <= 100 && !NOT_PROSE.test(text);
    if ((cue || listedJob) && !NOT_PROSE.test(text.slice(0, 20))) {
      out.push({
        topic: "hiring",
        text: clip(text),
        sourceUrl: pageUrl,
        uncertainty: careersPage ? "on their careers page, undated; the opening may already be filled" : "mentioned on their website, undated; the opening may already be filled",
        relevance: relevanceText(offerWords),
      });
      return;
    }
    // A sentence of theirs (not a row of link labels) with at least two of the offer's words.
    if (offerWords.length >= 2 && text.length >= 40 && text.length <= 300 && SENTENCE_END.test(text) && !NOT_PROSE.test(text) && !cue) {
      out.push({ topic: "context", text: clip(text, 240), sourceUrl: pageUrl, uncertainty: "a sentence on their website, read as written; undated", relevance: relevanceText(offerWords) });
    }
  });
  return out;
}

// ── People ──────────────────────────────────────────────────────────────────

const HONORIFIC = /^(?:dr|mr|mrs|ms|miss|prof|er|adv)\.?$/i;
const NAME_TOKEN = /^(?:[A-Z][a-zA-Z'’-]{1,24}|[A-Z]\.)$/;
/** Words that are never part of a person's name on a business's page. */
const NOT_NAME = new Set([
  "about", "academy", "all", "and", "appointment", "appointments", "at", "book", "by", "call", "care", "center", "centre", "ceo", "chat", "clinic",
  "co", "contact", "copyright", "dental", "dentist", "director", "email", "for", "founder", "group", "home", "hospital", "in", "inc", "llc", "llp",
  "ltd", "manager", "meet", "more", "now", "of", "online", "our", "owner", "partner", "policy", "privacy", "private", "profile", "pvt", "read", "reserved",
  "rights", "salon", "school", "services", "solutions", "studio", "team", "technologies", "terms", "the", "us", "view", "welcome", "with", "your",
]);
const ROLE = String.raw`(?:co-?founder|founder|owner|proprietor|ceo|chief executive(?: officer)?|chief [a-z]+ officer|cto|cfo|coo|cmo|managing director|medical director|clinical director|creative director|director|managing partner|senior partner|founding partner|partner|principal|president|vice president|head of [a-z&]+(?: [a-z&]+){0,2}|(?:practice|office|clinic|operations|general|marketing|sales|business|front desk|hospital|branch|store|studio|centre|center|restaurant|hotel|salon) manager)`;
const ROLE_START = new RegExp(`^(?:the |our )?${ROLE}\\b`, "i");
const NOT_A_ROLE = /\b(?:with us|join|contact|call|book|learn|read|view|apply)\b|\s(?:at|@)\s/i;
const SPLIT_NAME_ROLE = /^(.{3,60}?)\s*(?:,|\s[-–—|]\s|\()\s*(.{3,80}?)\)?$/;
const SPLIT_ROLE_NAME = /^(.{3,40}?)\s*(?::|\s[-–—|]\s)\s*(.{3,60})$/;
const FOUNDED_BY = /\b([Ff]ounded|[Ss]tarted|[Ee]stablished|[Oo]wned)(?: in \d{4})? by ((?:(?:Dr|Mr|Mrs|Ms|Prof)\.?\s+)?[A-Z][a-zA-Z'’-]+(?:\s+[A-Z][a-zA-Z'’-]+){0,3})/;
const IS_ROLE = /^((?:(?:Dr|Mr|Mrs|Ms|Prof)\.?\s+)?[A-Z][a-zA-Z'’-]+(?:\s+[A-Z][a-zA-Z'’-]+){0,3}),? (?:is|was) (?:the |our |a )?(co-?founder|founder|owner|proprietor|managing director|director|ceo|principal|president|managing partner)\b/;
/** "BDS, MDS", "MBA": qualifications between a name and its role. */
const DEGREES = /^[A-Z][A-Za-z.()]{1,6}(?:\s*[,&/]\s*[A-Z][A-Za-z.()]{1,6}){0,4}$/;
/** Local parts of a general inbox: never one person's address. */
const GENERIC_LOCAL = /^(?:info|contact|contacts|contactus|hello|hi|office|admin|reception|frontdesk|front\.desk|enquiry|enquiries|inquiry|inquiries|support|help|sales|appointment|appointments|booking|bookings|team|mail|care|customercare|service|services|clinic|accounts|billing|hr|careers|jobs|marketing|media|press|general|connect|ask|query|queries|feedback|orders?|admissions?)$/i;
const EMAIL_IN_LINE = /(?<![A-Z0-9._%+-])[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,24}/gi;

/** A person's name as written ("Dr. Asha Kulkarni", "ROHAN DESHPANDE" → "Rohan Deshpande"), or null. */
function personName(raw: string): string | null {
  const tokens = raw.trim().replace(/\s+/g, " ").split(" ");
  if (!tokens.length || tokens.length > 5) return null;
  const honorific = HONORIFIC.test(tokens[0]!) ? tokens.shift()! : null;
  if (!tokens.length || tokens.length > 4 || (!honorific && tokens.length < 2)) return null;
  if (!tokens.every((token) => NAME_TOKEN.test(token)) || tokens.every((token) => /^[A-Z]\.$/.test(token))) return null;
  if (tokens.some((token) => NOT_NAME.has(token.toLowerCase().replace(/[.'’-]/g, "")))) return null;
  const words = tokens.map((token) => (token.length > 2 && token === token.toUpperCase() ? `${token[0]}${token.slice(1).toLowerCase()}` : token));
  const title = honorific ? `${honorific[0]!.toUpperCase()}${honorific.slice(1).toLowerCase().replace(/\.$/, "")}.` : null;
  return [title, ...words].filter(Boolean).join(" ");
}

/** A role as written, when the whole text is one ("Founder & Lead Dentist"), or null. */
function roleOf(raw: string): string | null {
  const text = raw.trim().replace(/[.;:,]+$/, "");
  if (!text || text.length > 80 || !ROLE_START.test(text) || NOT_A_ROLE.test(text)) return null;
  return clip(text, 60);
}

function nameKey(name: string): string {
  return name.toLowerCase().replace(/^(?:dr|mr|mrs|ms|miss|prof|er|adv)\.?\s+/, "");
}

/** Whether an address is this person's own: not a general inbox, and it carries their first or last name. */
function ownAddress(email: string, name: string): boolean {
  const local = email.split("@")[0]!.toLowerCase();
  if (GENERIC_LOCAL.test(local)) return false;
  const parts = nameKey(name).split(" ").map((part) => part.replace(/[^a-z]/g, "")).filter((part) => part.length >= 3);
  return parts.some((part) => local.includes(part));
}

type Found = { name: string; role: string; line: number; roleLine: number };

/** Who a line names with a role: "Name, Role", "Role: Name", "founded by Name", "Name is the founder", or a name over its role. */
function personAt(lines: PageLine[], index: number): Found | null {
  const text = lines[index]!.text;
  if (!text || QUOTED.test(text) || text.length > MAX_LINE) return null;
  // A testimonial's author: the line after a quotation.
  if (/["”’]\s*$/.test(lines[index - 1]?.text ?? "")) return null;
  const founded = FOUNDED_BY.exec(text);
  if (founded) {
    const name = personName(founded[2]!);
    if (name) return { name, role: founded[1]!.toLowerCase() === "owned" ? "Owner" : "Founder", line: index, roleLine: index };
  }
  const is = IS_ROLE.exec(text);
  if (is) {
    const name = personName(is[1]!);
    if (name) return { name, role: roleOf(is[2]!) ?? is[2]!, line: index, roleLine: index };
  }
  if (text.length > 140) return null;
  const nameRole = SPLIT_NAME_ROLE.exec(text);
  if (nameRole) {
    const name = personName(nameRole[1]!);
    const role = name ? roleOf(nameRole[2]!) : null;
    if (name && role) return { name, role, line: index, roleLine: index };
  }
  const roleName = SPLIT_ROLE_NAME.exec(text);
  if (roleName) {
    const role = roleOf(roleName[1]!);
    const name = role ? personName(roleName[2]!) : null;
    if (name && role && role.length <= 40) return { name, role, line: index, roleLine: index };
  }
  const name = personName(text);
  if (!name) return null;
  for (let next = index + 1; next <= index + 2 && next < lines.length; next += 1) {
    const candidate = lines[next]!.text;
    if (!candidate) continue;
    const role = candidate.length <= 60 ? roleOf(candidate) : null;
    if (role) return { name, role, line: index, roleLine: next };
    // A qualification line may sit between the name and the role; anything else ends the card.
    if (!DEGREES.test(candidate)) break;
  }
  return null;
}

function peopleOf(lines: PageLine[], pageUrl: string): NamedPerson[] {
  const found: Found[] = [];
  for (let index = 0; index < lines.length && found.length < MAX_PEOPLE * 2; index += 1) {
    const person = personAt(lines, index);
    if (!person) continue;
    found.push(person);
    index = person.roleLine;
  }
  const out: NamedPerson[] = [];
  for (const [position, person] of found.entries()) {
    if (out.some((existing) => nameKey(existing.name) === nameKey(person.name))) continue;
    // Their card: from the name to a few lines after the role, never into the next person's.
    const end = Math.min(person.roleLine + 4, (found[position + 1]?.line ?? lines.length) - 1, lines.length - 1);
    let email: string | null = null;
    let linkedin: string | null = null;
    for (let index = person.line; index <= end; index += 1) {
      const line = lines[index]!;
      const addresses = [
        ...line.anchors.filter((anchor) => /^mailto:/i.test(anchor.href)).map((anchor) => cleanEmail(anchor.href)),
        ...[...line.text.matchAll(EMAIL_IN_LINE)].map((match) => cleanEmail(match[0])),
      ];
      email ??= addresses.find((address): address is string => Boolean(address) && ownAddress(address!, person.name)) ?? null;
      for (const anchor of line.anchors) {
        const profile = cleanLinkedinUrl(anchor.href);
        if (!linkedin && profile?.includes("/in/")) linkedin = profile;
      }
    }
    out.push({ name: person.name, role: person.role, email, linkedin, sourceUrl: pageUrl });
    if (out.length >= MAX_PEOPLE) break;
  }
  return out;
}

/** The people one page names with a role, each with only the contacts in their own card. */
export function namedPeople(html: string, pageUrl: string): NamedPerson[] {
  if (/testimonial|review/i.test(pageUrl)) return [];
  return peopleOf(scanPage(html).lines, pageUrl);
}

// ── A website ───────────────────────────────────────────────────────────────

/**
 * What the pages of one website show, in the order they were read (the home
 * page first), within the per-topic limits: from the responses the contact
 * reader already has, never a fetch of its own.
 */
export function readWebsite(pages: readonly { url: string; html: string }[], focus: OfferFocus, checkedAt: string): WebsiteProfile {
  const observations: Observation[] = [];
  const people: NamedPerson[] = [];
  const count: Record<ObservationTopic, number> = { booking: 0, contact: 0, hiring: 0, need: 0, context: 0 };
  for (const page of pages) {
    const scan = scanPage(page.html);
    for (const item of pageObservations(scan, page.html, page.url, focus)) {
      if (count[item.topic] >= PER_SITE[item.topic]) continue;
      const key = `${item.topic}:${item.text.toLowerCase()}`;
      if (observations.some((existing) => `${existing.topic}:${existing.text.toLowerCase()}` === key)) continue;
      observations.push(item);
      count[item.topic] += 1;
    }
    if (/testimonial|review/i.test(page.url)) continue;
    for (const person of peopleOf(scan.lines, page.url)) {
      if (people.length >= MAX_PEOPLE) break;
      const existing = people.find((item) => nameKey(item.name) === nameKey(person.name));
      if (existing) {
        existing.email ??= person.email;
        existing.linkedin ??= person.linkedin;
        continue;
      }
      people.push(person);
    }
  }
  return { checkedAt, pagesRead: pages.map((page) => page.url), observations, people };
}

export type WebsiteNotes = {
  /** For the lead's insights: observations, people, and an explicit request as a need. */
  signals: LeadSignal[];
  /** For the writers (the lead's facts): what was found, never what was not. */
  facts: Record<string, string>;
  /** The person whose own address the lead uses, when the website names them. */
  recipient: NamedPerson | null;
};

const SOURCE = "the business's website";

/**
 * A read website as a lead's signals and facts. `recipientEmail` is the
 * address the lead will be written to: when it is a named person's own
 * address, the lead is that person (and is not listed among the business's
 * other people); a general address leaves the lead the business.
 */
export function websiteNotes(profile: WebsiteProfile | null | undefined, recipientEmail: string | null): WebsiteNotes {
  if (!profile) return { signals: [], facts: {}, recipient: null };
  const recipientAddress = recipientEmail?.toLowerCase() ?? null;
  const recipient = recipientAddress ? profile.people.find((person) => person.email?.toLowerCase() === recipientAddress) ?? null : null;
  const signals: LeadSignal[] = profile.observations.map((item) => ({
    kind: item.topic === "need" ? "need" : "observation",
    topic: item.topic,
    text: item.text,
    sourceUrl: item.sourceUrl,
    source: SOURCE,
    at: null,
    observedAt: profile.checkedAt,
    uncertainty: item.uncertainty,
    relevance: item.relevance,
  }));
  for (const person of profile.people) {
    signals.push({
      kind: "observation",
      topic: "person",
      text: `${person.name} — ${person.role}`,
      sourceUrl: person.sourceUrl,
      source: SOURCE,
      at: null,
      observedAt: profile.checkedAt,
      uncertainty: person.email || person.linkedin
        ? "named with this role on their own website; the contact shown is the one beside their name"
        : "named with this role on their own website",
      relevance: null,
      person: { name: person.name, role: person.role, email: person.email, linkedin: person.linkedin },
    });
  }
  const facts: Record<string, string> = {};
  const others = profile.people.filter((person) => person !== recipient).slice(0, 2);
  if (others.length) facts.decisionMakers = clip(others.map((person) => `${person.name} (${person.role})`).join("; "));
  const texts = (topic: ObservationTopic, limit: number) => profile.observations.filter((item) => item.topic === topic).slice(0, limit).map((item) => item.text);
  const join = (values: string[]) => (values.length ? clip(values.join("; ")) : null);
  const entries: [string, string | null][] = [
    ["hiring", join(texts("hiring", 1))],
    ["booking", join(texts("booking", 2))],
    ["contactOptions", join(texts("contact", 3))],
    ["websiteSays", join(texts("context", 1))],
    ["websiteNeed", join(texts("need", 1))],
  ];
  for (const [key, value] of entries) if (value) facts[key] = value;
  return { signals, facts, recipient };
}

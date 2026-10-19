import type { BusinessProfile, LeadSignal } from "@/lib/assistant/schema";
import type { CanonicalPersonInput } from "@/lib/leads/records";
import { cleanString } from "@/lib/grid/sanitize";
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

/** The first `length` characters, never ending in half of a character (a lone surrogate jsonb refuses). */
function cut(text: string, length: number): string {
  const out = text.slice(0, length);
  return /[\uD800-\uDBFF]$/.test(out) ? out.slice(0, -1) : out;
}

function clip(text: string, limit = 200): string {
  if (text.length <= limit) return text;
  const head = cut(text, limit);
  const space = head.lastIndexOf(" ");
  return `${(space > limit / 2 ? head.slice(0, space) : head).replace(/[\s,;:–—-]+$/, "")}…`;
}

/** A link or an address in a line: such a line is a contact detail, never a finding or a role a writer may repeat. */
const LINKISH = /https?:\/\/|\bwww\.|[\w.+-]+@[\w-]+\.[\w.]+/i;

// ── Pages as lines ──────────────────────────────────────────────────────────

type Anchor = { href: string; text: string };
/** One line of a page: its text, its inline pieces (a card's name and role in two spans), and its links. */
export type PageLine = { text: string; parts: string[]; anchors: Anchor[] };
type PageScan = { lines: PageLine[]; description: string | null; contactForm: boolean };

/** Tags that end a line of text: a card's name and its role are separate lines. */
const BLOCK_TAGS = new Set(["p", "div", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "br", "hr", "tr", "td", "th", "table", "section", "article", "header", "footer", "nav", "aside", "main", "dt", "dd", "dl", "blockquote", "figcaption", "figure", "form", "label", "button", "address", "option", "select"]);
/** Inline elements whose edges separate a line's pieces: <span>Asha Kulkarni</span> <span>Founder</span>. */
const PIECE_TAGS = new Set(["span", "small", "strong", "b", "em", "i", "cite", "sup", "sub", "font", "mark", "time", "a"]);
const PIECE = "\u0001";
const MAX_PARTS = 20;
const TAG_NAME = /^(\/?)([a-zA-Z][a-zA-Z0-9]*)/;
const HREF_ATTRIBUTE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const CONTENT_ATTRIBUTE = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const DESCRIPTION_META = /\b(?:name|property)\s*=\s*["']?(?:og:)?description["'\s/>]/i;

function lineText(raw: string): string {
  // Tags are already gone: entities are decoded only where there are some.
  const plain = raw.includes(PIECE) ? raw.replaceAll(PIECE, " ") : raw;
  // An entity can decode to a NUL or a lone surrogate, which jsonb refuses: such text would fail every save of the job.
  const text = cleanString((/[&<]/.test(plain) ? visibleText(plain) : plain.replace(/\s+/g, " ")).trim());
  return text.length > MAX_LINE ? cut(text, MAX_LINE) : text;
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
    const parts = text.includes(PIECE) ? text.split(PIECE, MAX_PARTS).map(lineText).filter(Boolean) : value ? [value] : [];
    if (value || anchors.length) lines.push({ text: value, parts, anchors });
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
      text += PIECE;
      const href = closing ? null : HREF_ATTRIBUTE.exec(tag);
      if (href) open = { href: href[1] ?? href[2] ?? href[3] ?? "", from: text.length };
      continue;
    }
    if (name === "meta") {
      if (!description && DESCRIPTION_META.test(tag)) {
        const content = CONTENT_ATTRIBUTE.exec(tag);
        const value = content ? cleanString(visibleText(content[1] ?? content[2] ?? "").trim()) : "";
        if (value && !LINKISH.test(value)) description = clip(value);
      }
      continue;
    }
    // A form to write a message in; a newsletter or login form has no text area.
    if (name === "form") inForm = !closing;
    else if (inForm && !closing && name === "textarea") contactForm = true;
    if (BLOCK_TAGS.has(name)) flush();
    else text += PIECE_TAGS.has(name) ? PIECE : " ";
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
 * (unless `careers` is false) one careers page when the home page links
 * them, then the contact, about and imprint pages it always read.
 */
export function profilePageLinks(html: string, pageUrl: string, limit = 3, options: { careers?: boolean } = {}): string[] {
  const out: string[] = [];
  // A careers page is read only when hiring could matter to the offer (an organization with no saved offer has none to match).
  for (const path of options.careers === false ? [CONTACT_PATH, PEOPLE_PATH] : [CONTACT_PATH, PEOPLE_PATH, CAREERS_PATH]) {
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
/**
 * The business itself asking for suppliers: "we are seeking a vendor", "we
 * invite proposals", "tenders invited". Never a bare "request a quote", which
 * is how a supplier invites its own customers.
 */
const NEED_CUE = /\b(?:(?:we|we are|we['’]re|we are currently|we['’]re currently) (?:seeking|looking for|inviting|invite) (?:an? |new |qualified |reliable |external )?(?:vendors?|suppliers?|agenc(?:y|ies)|contractors?|service providers?|consultants?|bids?|quotations?|quotes?|proposals?|tenders?)|call for (?:suppliers|vendors|proposals|tenders)|tenders? (?:are )?invited|(?:issued|issuing|published|publishing) (?:an? |our )?(?:rfp|rfq|request for (?:proposals?|quotations?)))\b/i;
/** A question to the site's visitors, or its own reseller or affiliate programme: the site selling, not asking. */
const NOT_A_REQUEST = /\?|\b(?:resell|resellers?|affiliates?|franchise|referrals?|distributors?)\b/i;
/** Words that make a line a job: a hiring line or a careers-page listing must name one (messages.ts checks claims with them too). */
export const JOB_TITLES = String.raw`(?:receptionists?|assistants?|managers?|executives?|coordinators?|developers?|engineers?|nurses?|hygienists?|technicians?|associates?|specialists?|consultants?|officers?|interns?|internship|representatives?|agents?|clerks?|administrators?|accountants?|designers?|writers?|analysts?|supervisors?|operators?|drivers?|cooks?|chefs?|cleaners?|therapists?|physiotherapists?|dentists?|doctors?|teachers?|tutors?|trainers?|cashiers?|telecallers?|callers?|attendants?|helpers?|apprentices?|marketers?|salesperson|sales (?:executive|associate|representative|manager)|front desk|front office|back office)`;
const JOB_WORDS = new RegExp(`\\b${JOB_TITLES}\\b`, "i");
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
      // A page of the business on a booking service, not the service's own home page.
      const specific = url.pathname.replace(/\/+$/, "") !== "" || !/^(?:(?:www|book|meetings|app)\.)?[^.]+\.[^.]+$/.test(host);
      const booking = specific ? BOOKING_HOSTS.find(([pattern]) => pattern.test(host)) : undefined;
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
    if (QUOTED.test(text) || LINKISH.test(text)) return;
    const offerWords = matching(text, focus.offer);
    if (!offerWords.length) return;
    if (NEED_CUE.test(text) && !NOT_A_REQUEST.test(text)) {
      out.push({ topic: "need", text: clip(text, 240), sourceUrl: pageUrl, uncertainty: "stated on their website, undated; it may already be closed", relevance: relevanceText(offerWords) });
      return;
    }
    // A job: a line that says so, or on a careers page a short line soon after its "we're hiring"; either names one.
    const listedJob = careersPage && index - lastHiringCue <= 12 && text.length <= 100 && !NOT_PROSE.test(text);
    if ((cue || listedJob) && JOB_WORDS.test(text) && !NOT_PROSE.test(text.slice(0, 20))) {
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
/** Words that are never part of a person's name on a business's page: menus, headings, job titles. */
const NOT_NAME = new Set([
  "about", "academy", "account", "address", "all", "and", "appointment", "appointments", "assistant", "associate", "at", "award", "awards", "blog",
  "board", "book", "by", "call", "care", "career", "careers", "center", "centre", "ceo", "chairman", "chat", "clients", "clinic", "co", "college",
  "company", "conditions", "consultant", "contact", "cookie", "cookies", "coordinator", "copyright", "dental", "dentist", "designer", "desk",
  "developer", "director", "directions", "doctor", "doctors", "email", "engineer", "events", "executive", "faq", "for", "founder", "founders", "front",
  "full", "gallery", "get", "group", "head", "history", "home", "hospital", "hours", "hygienist", "in", "inc", "institute", "intern", "jobs", "junior",
  "lead", "leadership", "learn", "llc", "llp", "location", "locations", "login", "ltd", "management", "manager", "map", "marketing", "medical", "meet",
  "member", "members", "menu", "message", "mission", "more", "new", "news", "now", "nurse", "of", "office", "officer", "online", "opening", "openings",
  "our", "owner", "part", "partner", "partners", "people", "phone", "policy", "portfolio", "president", "pricing", "principal", "privacy", "private",
  "products", "profile", "pvt", "quote", "read", "receptionist", "register", "request", "reserved", "reviews", "rights", "salon", "sales", "school",
  "senior", "services", "share", "shop", "sign", "sitemap", "solutions", "spa", "specialist", "staff", "statement", "store", "studio", "subscribe",
  "support", "team", "technician", "technologies", "terms", "testimonials", "the", "therapist", "time", "today", "trust", "university", "us", "values",
  "view", "vision", "welcome", "with", "your",
]);
const ROLE = String.raw`(?:co-?founder|founder|owner|proprietor|ceo|chief executive(?: officer)?|chief [a-z]+ officer|cto|cfo|coo|cmo|managing director|medical director|clinical director|creative director|director|managing partner|senior partner|founding partner|partner|principal|president|vice president|head of (?!at\b)[a-z&]+(?: (?!at\b|of\b)[a-z&]+){0,2}|(?:practice|office|clinic|operations|general|marketing|sales|business|front desk|hospital|branch|store|studio|centre|center|restaurant|hotel|salon) manager)`;
/** A role at the start of a text, ending there as a word: never "Director's Message" or "Partnership". */
const ROLE_MATCH = new RegExp(`^(?:the |our )?${ROLE}(?![\\w'’])`, "i");
/** Roles that make a card on a page other than a team or about page worth reading: the business's owners. */
const OWNER_ROLES = /^(?:co-?founder|founder|owner|proprietor|ceo|chief executive|managing director|director|principal|president|managing partner|founding partner)\b/i;
/** What may follow a role after a comma: a profession ("Founder, Orthodontist"), never a company ("CEO, Acme Corp"). */
const PROFESSION = /^(?:lead |chief |senior |consultant |head )?(?:dentist|orthodontist|endodontist|periodontist|prosthodontist|doctor|physician|surgeon|consultant|lawyer|attorney|advocate|architect|engineer|designer|therapist|physiotherapist|coach|trainer|chef|pharmacist|veterinarian|accountant|chartered accountant)s?\b/i;
const NOT_A_ROLE = /\b(?:with us|join|contact|call|book|learn|read|view|apply)\b|\s@\s|https?:\/\/|\bwww\.|@/i;
const SPLIT_NAME_ROLE = /^(.{3,60}?)\s*(?:,|\s[-–—|]\s|\()\s*(.{3,80}?)\)?$/;
const SPLIT_ROLE_NAME = /^(.{3,40}?)\s*(?::|\s[-–—|]\s)\s*(.{3,60})$/;
const FOUNDED_BY = /\b([Ff]ounded|[Ss]tarted|[Ee]stablished|[Oo]wned)(?: in \d{4})? by ((?:(?:Dr|Mr|Mrs|Ms|Prof)\.?\s+)?[A-Z][a-zA-Z'’-]+(?:\s+[A-Z][a-zA-Z'’-]+){0,3})/;
const IS_ROLE = /^((?:(?:Dr|Mr|Mrs|Ms|Prof)\.?\s+)?[A-Z][a-zA-Z'’-]+(?:\s+[A-Z][a-zA-Z'’-]+){0,3}),? (?:is|was) (?:the |our |a )?(co-?founder|founder|owner|proprietor|managing director|director|ceo|principal|president|managing partner)\b(.{0,120})/;
/** "BDS, MDS", "MBA": qualifications between a name and its role. */
const DEGREES = /^[A-Z][A-Za-z.()]{1,6}(?:\s*[,&/]\s*[A-Z][A-Za-z.()]{1,6}){0,4}$/;
/** Local parts of a general inbox: never one person's address. */
const GENERIC_LOCAL = /^(?:info|contact|contacts|contactus|hello|hi|office|admin|reception|frontdesk|front\.desk|enquiry|enquiries|inquiry|inquiries|support|help|sales|appointment|appointments|booking|bookings|team|mail|care|customercare|service|services|clinic|accounts|billing|hr|careers|jobs|marketing|media|press|general|connect|ask|query|queries|feedback|orders?|admissions?)$/i;
const EMAIL_IN_LINE = /(?<![A-Z0-9._%+-])[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,24}/gi;
const THIS_BUSINESS = /^(?:this|the|our) (?:clinic|practice|company|business|firm|studio|salon|agency|centre|center|hospital|restaurant|store|shop|school|academy|team)\b/i;

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

/** Whether a company a page names ("of Lotus Yoga Studio") is the business whose site it is, by its domain. */
function sameBusiness(phrase: string, pageUrl: string): boolean {
  if (THIS_BUSINESS.test(phrase.trim())) return true;
  let host: string;
  try {
    host = new URL(pageUrl).hostname.replace(/^www\./, "");
  } catch {
    return false;
  }
  const label = host.split(".")[0]!.replace(/[^a-z0-9]/g, "");
  const letters = phrase.toLowerCase().replace(/[^a-z0-9]/g, "");
  const first = phrase.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)[0] ?? "";
  return label.length >= 3 && (letters.includes(label) || (first.length >= 4 && label.includes(first)));
}

/**
 * A role as written when the whole text is one ("Founder & Lead Dentist",
 * "Our Founder" → "Founder"), or null. A role at another company ("CEO, Acme
 * Corp", "Owner of Bloom Florists") is not this business's.
 */
function roleOf(raw: string, pageUrl: string): string | null {
  const text = raw.trim().replace(/[.;:,]+$/, "");
  if (!text || text.length > 80 || NOT_A_ROLE.test(text)) return null;
  const match = ROLE_MATCH.exec(text);
  if (!match) return null;
  const rest = text.slice(match[0].length);
  if (rest) {
    const joined = /^\s*(?:&|and|\/|\|)\s*(.{2,40})$/.exec(rest);
    const listed = /^\s*,\s*(.{2,40})$/.exec(rest);
    const at = /^\s+(?:of|at)\s+(.{2,60})$/.exec(rest);
    const fits = joined ? !/,|\b(?:of|at)\s+[A-Z]/.test(joined[1]!) : listed ? ROLE_MATCH.test(listed[1]!) || PROFESSION.test(listed[1]!) : at ? sameBusiness(at[1]!, pageUrl) : false;
    if (!fits) return null;
  }
  const role = text.replace(/^(?:the|our)\s+/i, "");
  return clip(`${role[0]!.toUpperCase()}${role.slice(1)}`, 60);
}

function nameKey(name: string): string {
  return name.toLowerCase().replace(/^(?:dr|mr|mrs|ms|miss|prof|er|adv)\.?\s+/, "");
}

/** A name's first and last name, without an honorific or initials ("Dr. Asha Kulkarni" → asha, kulkarni). */
function nameParts(name: string): { first: string; last: string } | null {
  const words = nameKey(name).split(" ").map((word) => word.replace(/[^a-z]/g, "")).filter((word) => word.length >= 2);
  return words.length ? { first: words[0]!, last: words.at(-1)! } : null;
}

/**
 * Whether an address is this person's own: not a general inbox, and built
 * from their name (tom@, tom.reid@, treid@, tomreid@, reid.t@), not merely
 * containing part of it (customerservice@ is not Tom's, tomas@ is not Tom's).
 */
function ownAddress(email: string, name: string): boolean {
  const local = email.split("@")[0]!.toLowerCase();
  if (GENERIC_LOCAL.test(local)) return false;
  const parts = nameParts(name);
  if (!parts) return false;
  const { first, last } = parts;
  const tokens = local.split(/[^a-z]+/).filter(Boolean);
  if (tokens.some((token) => token === first || token === last)) return true;
  const joined = tokens.join("");
  return [`${first}${last}`, `${last}${first}`, `${first[0]}${last}`, `${first}${last[0]}`, `${last}${first[0]}`].includes(joined);
}

/** Whether a LinkedIn profile is this person's: its address carries their first or last name (/in/asha-kulkarni-dds). */
function ownProfile(profileUrl: string, name: string): boolean {
  const parts = nameParts(name);
  const slug = profileUrl.split("/in/")[1]?.toLowerCase() ?? "";
  return Boolean(parts) && slug.split(/[^a-z]+/).some((token) => token === parts!.first || token === parts!.last);
}

type Found = { name: string; role: string; line: number; roleLine: number };
type PageKind = { people: boolean; pageUrl: string };

/**
 * Who a line names with a role: "Name, Role", "Role: Name", "founded by
 * Name", "Name is the founder", a name and a role side by side in one line,
 * or a card's name with its role on the line below or above it. On a page
 * that is not a team, about or contact page only an owner's card counts, and
 * never one right after a paragraph (a testimonial's author).
 */
function personAt(lines: PageLine[], index: number, page: PageKind, taken: ReadonlySet<number>): Found | null {
  const line = lines[index]!;
  const text = line.text;
  if (!text || QUOTED.test(text) || text.length > MAX_LINE) return null;
  // A testimonial's author: the line after a quotation.
  if (/["”’]\s*$/.test(lines[index - 1]?.text ?? "")) return null;
  const found = (name: string, role: string, roleLine = index): Found => ({ name, role, line: index, roleLine });
  const founded = FOUNDED_BY.exec(text);
  if (founded) {
    const name = personName(founded[2]!);
    if (name) return found(name, founded[1]!.toLowerCase() === "owned" ? "Owner" : "Founder");
  }
  const is = IS_ROLE.exec(text);
  if (is) {
    const name = personName(is[1]!);
    // "… is the founder of <company>": only of the business whose site this is.
    const of = /^\s+(?:of|at)\s+([^.,;]{2,80})/.exec(is[3] ?? "");
    if (name && (!of || sameBusiness(of[1]!, page.pageUrl))) return found(name, roleOf(is[2]!, page.pageUrl) ?? is[2]!);
  }
  if (text.length > 140) return null;
  for (let piece = 0; piece + 1 < line.parts.length; piece += 1) {
    const [first, second] = [line.parts[piece]!, line.parts[piece + 1]!];
    const nameFirst = personName(first);
    const roleSecond = nameFirst ? roleOf(second, page.pageUrl) : null;
    if (nameFirst && roleSecond && (page.people || OWNER_ROLES.test(roleSecond))) return found(nameFirst, roleSecond);
    const roleFirst = roleOf(first, page.pageUrl);
    const nameSecond = roleFirst ? personName(second) : null;
    if (nameSecond && roleFirst && (page.people || OWNER_ROLES.test(roleFirst))) return found(nameSecond, roleFirst);
  }
  const nameRole = SPLIT_NAME_ROLE.exec(text);
  if (nameRole) {
    const name = personName(nameRole[1]!);
    const role = name ? roleOf(nameRole[2]!, page.pageUrl) : null;
    if (name && role) return found(name, role);
  }
  const roleName = SPLIT_ROLE_NAME.exec(text);
  if (roleName) {
    const role = roleOf(roleName[1]!, page.pageUrl);
    const name = role ? personName(roleName[2]!) : null;
    if (name && role && role.length <= 40) return found(name, role);
  }
  const name = personName(text);
  if (!name) return null;
  const roleAt = (at: number): string | null => {
    const candidate = lines[at]?.text ?? "";
    return at >= 0 && !taken.has(at) && candidate && candidate.length <= 60 ? roleOf(candidate, page.pageUrl) : null;
  };
  let below: { role: string; at: number } | null = null;
  for (let next = index + 1; next <= index + 2 && next < lines.length; next += 1) {
    const role = roleAt(next);
    if (role) {
      below = { role, at: next };
      break;
    }
    // A qualification line may sit between the name and the role; anything else ends the card.
    if (!DEGREES.test(lines[next]!.text)) break;
  }
  const aboveRole = roleAt(index - 1);
  const above = aboveRole ? { role: aboveRole, at: index - 1 } : null;
  // Roles above names ("Founder / Asha / Practice Manager / Rohan"): the role below is the next card's when a name follows it.
  const pick = below && above ? (personName(lines[below.at + 1]?.text ?? "") ? above : below) : below ?? above;
  if (!pick) return null;
  if (!page.people) {
    const before = lines[Math.min(index, pick.at) - 1]?.text ?? "";
    if (!OWNER_ROLES.test(pick.role) || before.length > 80 || SENTENCE_END.test(before)) return null;
  }
  return found(name, pick.role, pick.at);
}

function peopleOf(lines: PageLine[], pageUrl: string): NamedPerson[] {
  let path = "";
  try {
    path = new URL(pageUrl).pathname;
  } catch {
    return [];
  }
  // A careers page lists jobs, a testimonials page other people.
  if (CAREERS_PATH.test(path) || /testimonial|review/i.test(path)) return [];
  const page: PageKind = { people: PEOPLE_PATH.test(path) || CONTACT_PATH.test(path), pageUrl };
  const found: Found[] = [];
  const taken = new Set<number>();
  for (let index = 0; index < lines.length && found.length < MAX_PEOPLE * 2; index += 1) {
    const person = personAt(lines, index, page, taken);
    if (!person) continue;
    found.push(person);
    taken.add(person.roleLine);
    index = Math.max(index, person.roleLine);
  }
  const out: NamedPerson[] = [];
  for (const [position, person] of found.entries()) {
    if (out.some((existing) => nameKey(existing.name) === nameKey(person.name))) continue;
    // Their card: from the name (or the role above it) to at most three lines after, ending where another name or role begins.
    const next = found[position + 1];
    const nextStart = next ? Math.min(next.line, next.roleLine) : lines.length;
    const first = Math.min(person.line, person.roleLine);
    let last = Math.max(person.line, person.roleLine);
    for (let at = last + 1; at <= last + 3 && at < nextStart; at += 1) {
      const text = lines[at]!.text;
      if (text && (personName(text) || (text.length <= 60 && roleOf(text, pageUrl)))) break;
      last = at;
    }
    let email: string | null = null;
    let linkedin: string | null = null;
    for (let index = first; index <= last; index += 1) {
      const line = lines[index]!;
      const addresses = [
        ...line.anchors.filter((anchor) => /^mailto:/i.test(anchor.href)).map((anchor) => cleanEmail(anchor.href)),
        ...[...line.text.matchAll(EMAIL_IN_LINE)].map((match) => cleanEmail(match[0])),
      ];
      email ??= addresses.find((address): address is string => Boolean(address) && ownAddress(address!, person.name)) ?? null;
      for (const anchor of line.anchors) {
        const profile = cleanLinkedinUrl(anchor.href);
        if (!linkedin && profile?.includes("/in/") && ownProfile(profile, person.name)) linkedin = profile;
      }
    }
    out.push({ name: person.name, role: person.role, email, linkedin, sourceUrl: pageUrl });
    if (out.length >= MAX_PEOPLE) break;
  }
  return out;
}

/** The people one page names with a role, each with only the contacts in their own card. */
export function namedPeople(html: string, pageUrl: string): NamedPerson[] {
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

/**
 * The name and title a lead's Person row takes from the person its website
 * names, when the lead's address is theirs: first and last name without the
 * honorific (a greeting reads "Asha", never "Dr."), and only what the row
 * does not have yet, so a contact the organization already named keeps its
 * own name and title.
 */
export function recipientFields(
  recipient: NamedPerson | null,
  existing: { fullName: string | null; firstName: string | null; lastName: string | null; title: string | null } | null,
): Pick<CanonicalPersonInput, "fullName" | "firstName" | "lastName" | "title"> {
  if (!recipient) return {};
  const out: Pick<CanonicalPersonInput, "fullName" | "firstName" | "lastName" | "title"> = {};
  if (!existing?.fullName?.trim() && !existing?.firstName?.trim() && !existing?.lastName?.trim()) {
    const words = recipient.name.split(" ").filter((word) => !HONORIFIC.test(word));
    out.fullName = recipient.name;
    out.firstName = words[0] ?? null;
    out.lastName = words.length > 1 ? words.slice(1).join(" ") : null;
  }
  if (!existing?.title?.trim()) out.title = recipient.role;
  return out;
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

/** The lead facts websiteNotes writes: what a site said, which never backs a link or a price in a message (messages.ts). */
export const WEBSITE_FACT_KEYS = ["decisionMakers", "hiring", "booking", "contactOptions", "websiteSays", "websiteNeed"] as const;

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

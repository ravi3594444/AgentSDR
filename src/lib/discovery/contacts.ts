import { isValidEmail, normalizeEmail } from "@/lib/email/recipients";

/**
 * Contact details found on a public web page, each tied to the page it came
 * from. Pure: the fetching is in websiteContacts.server.ts. Nothing here
 * guesses an address (no "info@<domain>" patterns): only what the page itself
 * publishes is returned, so every contact has a source a person can open.
 */

export type FoundContact = {
  kind: "email" | "phone" | "linkedin";
  value: string;
  /** The page the value was read from. */
  sourceUrl: string;
};

/** Addresses that appear on sites but are never the business's own inbox. */
const JUNK_EMAIL_DOMAINS = [
  "example.com", "example.org", "example.net", "domain.com", "yourdomain.com", "email.com",
  "sentry.io", "sentry-next.wixpress.com", "wixpress.com", "wix.com", "godaddy.com",
  "squarespace.com", "w3.org", "schema.org", "googleapis.com", "gstatic.com", "cloudflare.com",
];
const JUNK_EMAIL_LOCAL = /^(?:noreply|no-reply|donotreply|do-not-reply|mailer-daemon|postmaster|abuse|webmaster|user|username|name|email|your\.?name|yourname|test)$/i;
/** File names that look like addresses: logo@2x.png. */
const FILE_LIKE = /\.(?:png|jpe?g|gif|svg|webp|avif|css|js|ico|bmp|tiff?)$/i;

/** Characters cleanEmail trims from the end of a candidate ("info@acme.com."). */
const TRAILING_PUNCTUATION = new Set([">", ")", "\"", "'", ".", ",", ";", ":"]);

/** A usable public business address, normalized, or null. */
export function cleanEmail(raw: string): string | null {
  // Everything after "?" is a mailto query (subject, body), never the address:
  // cut it before decoding, so a long query costs nothing.
  let value = raw.trim().replace(/^mailto:/i, "").split("?")[0]!;
  try {
    value = decodeURIComponent(value);
  } catch {
    // keep as is
  }
  value = value.split("?")[0]!.trim().replace(/^[<("']+/, "");
  // Trailing punctuation, trimmed in one pass (a regex anchored at the end
  // retries from every character of a long punctuation run).
  let end = value.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(value[end - 1]!)) end -= 1;
  value = value.slice(0, end);
  const email = normalizeEmail(value);
  if (!isValidEmail(email) || FILE_LIKE.test(email)) return null;
  const [local, domain] = email.split("@") as [string, string];
  // RFC 5321 limits: a longer local part or domain is no deliverable address.
  if (local.length > 64 || domain.length > 253) return null;
  if (JUNK_EMAIL_LOCAL.test(local)) return null;
  if (JUNK_EMAIL_DOMAINS.some((junk) => domain === junk || domain.endsWith(`.${junk}`))) return null;
  // Hashes and tracking ids in the local part (e.g. Sentry DSNs): 24+ hex characters.
  if (/^[0-9a-f]{24,}$/i.test(local)) return null;
  return email;
}

/**
 * At most this much visible text (about 300 KB) is scanned for addresses
 * written as text. A page is read up to 1.5 MB, mostly markup and scripts;
 * a business writes its address in far less text than this, and the bound
 * keeps a hostile page from holding the event loop. mailto: and tel: links
 * are read from the whole page.
 */
export const MAX_TEXT_SCAN = 300_000;

/**
 * An address written in text. Every quantifier is bounded (local part 64,
 * domain 253, top-level domain 24) and a match starts only where a run of
 * address characters starts, so a page of one long word, of dots, of
 * hyphens or of '@'s is read in linear time instead of quadratic.
 */
const EMAIL_IN_TEXT = /(?<![A-Z0-9._%+-])[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,24}/gi;

/**
 * Addresses hidden from bots, decoded only when the hiding is unmistakable:
 * "info [at] acme [dot] com", "info(at)acme.com", "info {at} acme (dot) co
 * (dot) in", "info at acme dot com". Whitespace is allowed only around the
 * explicit tokens; a literal "." must have no space on either side, and
 * the bare word " at " goes only with " dot " (else "visit us at acme.in"
 * would become an address). So "Join our team (at) Pune. Com…" and "Visit
 * us (at) Mumbai. In 2024" stay sentences.
 */
const OBFUSCATION_LOCAL = String.raw`(?<![A-Z0-9._%+-])([A-Z0-9._%+-]{1,64})`;
const OBFUSCATION_LABEL = String.raw`[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?`;
const DOT_TOKEN = String.raw`(?:\s{0,2}[[({]\s{0,2}dot\s{0,2}[\])}]\s{0,2}|\s{1,2}dot\s{1,2})`;
const OBFUSCATED_BRACKETED = new RegExp(
  `${OBFUSCATION_LOCAL}\\s{0,2}[[({]\\s{0,2}at\\s{0,2}[\\])}]\\s{0,2}(${OBFUSCATION_LABEL}(?:(?:${DOT_TOKEN}|\\.)${OBFUSCATION_LABEL}){1,4})`,
  "gi",
);
const OBFUSCATED_WORDS = new RegExp(`${OBFUSCATION_LOCAL}\\s{1,2}at\\s{1,2}(${OBFUSCATION_LABEL}(?:${DOT_TOKEN}${OBFUSCATION_LABEL}){1,4})`, "gi");
const DOT_TOKEN_GLOBAL = new RegExp(DOT_TOKEN, "gi");

/** Generic top-level domains a business plausibly uses (any two letters are a country code). */
const GENERIC_TLDS = new Set([
  "com", "org", "net", "edu", "gov", "mil", "int", "info", "biz", "name", "pro", "mobi", "asia", "xyz", "online", "site",
  "store", "shop", "tech", "app", "dev", "clinic", "dental", "health", "care", "studio", "agency", "company", "business",
  "services", "solutions", "email", "life", "live", "world", "today", "club", "design", "media", "news", "blog", "space",
  "website", "global", "group", "center", "centre", "academy", "education", "school", "travel", "hotel", "restaurant",
  "cafe", "fitness", "salon", "spa", "law", "legal", "finance", "insurance", "realty", "consulting", "digital",
  "marketing", "network", "systems", "software", "cloud", "ltd", "llc", "inc", "works", "tools", "top", "art", "guru",
  "expert", "events", "photography", "doctor", "dentist", "hospital", "pharmacy", "coach", "yoga", "bike", "auto",
  "cars", "kitchen", "estate", "properties", "builders", "construction", "repair", "cleaning", "shopping", "fashion",
]);

/** A top-level domain written the way a domain is: letters in one case ("com", "COM"), never a capitalized word ("Com", "In"). */
function plausibleTld(label: string): boolean {
  if (!/^(?:[a-z]{2,24}|[A-Z]{2,24})$/.test(label)) return false;
  return label.length === 2 || GENERIC_TLDS.has(label.toLowerCase());
}

/** The addresses written in one of the hidden forms above, decoded and cleaned. */
function obfuscatedEmails(text: string): string[] {
  const out: string[] = [];
  for (const pattern of [OBFUSCATED_BRACKETED, OBFUSCATED_WORDS]) {
    for (const match of text.matchAll(pattern)) {
      const labels = match[2]!.replace(DOT_TOKEN_GLOBAL, ".").split(".");
      if (labels.length < 2 || !plausibleTld(labels.at(-1)!)) continue;
      const email = cleanEmail(`${match[1]}@${labels.join(".")}`);
      if (email) out.push(email);
    }
  }
  return out;
}

function decodeEntities(html: string): string {
  return html
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * The page without its <name>…</name> elements (each replaced by a space),
 * in one linear pass. A regex like /<script\b[\s\S]*?<\/script>/ retries
 * from every opening tag to the end of the page when the closing tag is
 * missing, which is quadratic on a hostile page. An element that is never
 * closed is left as that regex left it (only its tags are dropped later).
 */
export function withoutElements(html: string, names: readonly string[]): string {
  const open = new RegExp(`<(${names.join("|")})\\b`, "gi");
  const closes = new Map<string, RegExp>();
  /** For each name, a position from which no closing tag follows: every later search would fail too. */
  const unclosedFrom = new Map<string, number>();
  let out = "";
  let at = 0;
  for (let match = open.exec(html); match; match = open.exec(html)) {
    const name = match[1]!.toLowerCase();
    const from = open.lastIndex;
    if (from >= (unclosedFrom.get(name) ?? Infinity)) continue;
    let close = closes.get(name);
    if (!close) {
      close = new RegExp(`</${name}\\s*>`, "gi");
      closes.set(name, close);
    }
    close.lastIndex = from;
    const end = close.exec(html);
    if (!end) {
      unclosedFrom.set(name, from);
      continue;
    }
    out += `${html.slice(at, match.index)} `;
    at = end.index + end[0].length;
    open.lastIndex = at;
  }
  return out + html.slice(at);
}

/** Every tag (<…>) replaced by a space, in one pass; a "<" with no ">" after it stays text, as /<[^>]+>/g left it. */
function withoutTags(html: string): string {
  let out = "";
  let at = 0;
  for (;;) {
    const lt = html.indexOf("<", at);
    if (lt < 0) break;
    const gt = html.indexOf(">", lt + 1);
    // No ">" after this "<": none after any later "<" either.
    if (gt < 0) break;
    if (gt === lt + 1) {
      // "<>" is not a tag.
      out += html.slice(at, gt + 1);
    } else {
      out += `${html.slice(at, lt)} `;
    }
    at = gt + 1;
  }
  return out + html.slice(at);
}

/** Visible text of an HTML page (scripts and styles dropped), for reading addresses written as text. Linear in the page's size. */
export function visibleText(html: string): string {
  return decodeEntities(withoutTags(withoutElements(html, ["script", "style", "noscript"]))).replace(/\s+/g, " ");
}

function hrefs(html: string): string[] {
  const out: string[] = [];
  for (const match of html.matchAll(/href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value) out.push(decodeEntities(value.trim()));
  }
  return out;
}

/** A LinkedIn company or profile URL, canonical, or null. */
export function cleanLinkedinUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return null;
    const match = url.pathname.match(/^\/(company|in|school)\/([^/?#]+)/i);
    if (!match) return null;
    return `https://www.linkedin.com/${match[1]!.toLowerCase()}/${match[2]}`;
  } catch {
    return null;
  }
}

/**
 * Emails (mailto links, then addresses written in the text, including the
 * "[at]"/"[dot]" form), tel: links and LinkedIn links on one page. Linear
 * in the page's size: links are read from the whole page, text addresses
 * from the first MAX_TEXT_SCAN characters of its visible text.
 * Phones are returned as written; the caller normalizes them with the
 * country it knows.
 */
export function extractContacts(html: string, sourceUrl: string): FoundContact[] {
  const found = new Map<string, FoundContact>();
  const add = (kind: FoundContact["kind"], value: string | null) => {
    if (!value) return;
    const key = `${kind}:${value.toLowerCase()}`;
    if (!found.has(key)) found.set(key, { kind, value, sourceUrl });
  };

  for (const href of hrefs(html)) {
    if (/^mailto:/i.test(href)) add("email", cleanEmail(href));
    else if (/^tel:/i.test(href)) {
      const phone = href.replace(/^tel:/i, "").replace(/[^\d+]/g, "");
      if (phone.replace(/\D/g, "").length >= 6) add("phone", phone);
    } else if (/linkedin\.com/i.test(href)) add("linkedin", cleanLinkedinUrl(href));
  }

  const text = visibleText(html).slice(0, MAX_TEXT_SCAN);
  for (const match of text.matchAll(EMAIL_IN_TEXT)) add("email", cleanEmail(match[0]));
  for (const email of obfuscatedEmails(text)) add("email", email);
  return [...found.values()];
}

/**
 * The tel: and mailto: links of a page in page order, as "phone:<number>"
 * and "email:<address>" (the values extractContacts gives), repeats kept:
 * how often and where a contact appears tells a directory's own helpline
 * from its listings' numbers.
 */
export function contactLinkSequence(html: string): string[] {
  const out: string[] = [];
  for (const href of hrefs(html)) {
    if (/^mailto:/i.test(href)) {
      const email = cleanEmail(href);
      if (email) out.push(`email:${email}`);
    } else if (/^tel:/i.test(href)) {
      const phone = href.replace(/^tel:/i, "").replace(/[^\d+]/g, "");
      if (phone.replace(/\D/g, "").length >= 6) out.push(`phone:${phone.toLowerCase()}`);
    }
  }
  return out;
}

const CONTACT_LINK = /(?:contact|kontakt|contacto|contato|contatti|about|about-us|impressum|team|reach-us|get-in-touch)/i;

/**
 * Same-site pages worth reading for contact details (contact, about,
 * imprint), resolved against the page URL, at most `limit`.
 */
export function contactPageLinks(html: string, pageUrl: string, limit = 3): string[] {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const href of hrefs(html)) {
    if (!CONTACT_LINK.test(href) || /^(?:mailto|tel|javascript):/i.test(href)) continue;
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    if (url.hostname.replace(/^www\./, "") !== base.hostname.replace(/^www\./, "")) continue;
    if (!/^https?:$/.test(url.protocol)) continue;
    url.hash = "";
    const normalized = url.toString();
    if (normalized !== base.toString() && !out.includes(normalized)) out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

/** "https://www.Acme.com/path" → "acme.com"; null for anything that is not a web address. */
export function websiteDomain(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

/** Social and directory hosts: a "website" on one of these is not the business's own site. */
const NOT_OWN_SITE = /(?:^|\.)(?:facebook|instagram|twitter|x|linkedin|youtube|tiktok|wa|whatsapp|google|goo|bit|linktr|yelp|justdial|indiamart|sulekha|tripadvisor|zomato|swiggy|practo)\.(?:com|me|ly|ee|in|gl|co)$/i;

/** Whether an email belongs to the business's own website domain (or a subdomain). */
export function emailMatchesDomain(email: string, domain: string | null): boolean {
  if (!domain) return false;
  const host = email.split("@")[1] ?? "";
  return host === domain || host.endsWith(`.${domain}`);
}

/** The business's own site, or null when the listed "website" is a social profile or a directory page. */
export function ownWebsite(raw: string | null | undefined): string | null {
  const domain = websiteDomain(raw);
  if (!domain || NOT_OWN_SITE.test(domain)) return null;
  const value = raw!.trim();
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

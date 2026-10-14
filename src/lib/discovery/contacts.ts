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

/** A usable public business address, normalized, or null. */
export function cleanEmail(raw: string): string | null {
  let value = raw.trim().replace(/^mailto:/i, "");
  try {
    value = decodeURIComponent(value);
  } catch {
    // keep as is
  }
  value = value.split("?")[0]!.trim().replace(/^[<("']+|[>)"'.,;:]+$/g, "");
  const email = normalizeEmail(value);
  if (!isValidEmail(email) || FILE_LIKE.test(email)) return null;
  const [local, domain] = email.split("@") as [string, string];
  if (JUNK_EMAIL_LOCAL.test(local)) return null;
  if (JUNK_EMAIL_DOMAINS.some((junk) => domain === junk || domain.endsWith(`.${junk}`))) return null;
  // Hashes and tracking ids in the local part (e.g. Sentry DSNs): 24+ hex characters.
  if (/^[0-9a-f]{24,}$/i.test(local)) return null;
  return email;
}

const EMAIL_IN_TEXT = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/gi;
/** "info [at] acme [dot] com", "info(at)acme.com" — a common way sites hide addresses from bots. */
const OBFUSCATED = /([A-Z0-9._%+-]+)\s*[([{]\s*at\s*[)\]}]\s*([A-Z0-9-]+(?:\s*(?:[([{]\s*dot\s*[)\]}]|\.)\s*[A-Z0-9-]+)+)/gi;

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

/** Visible text of an HTML page (scripts and styles dropped), for reading addresses written as text. */
export function visibleText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ");
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
 * "[at]"/"[dot]" form), tel: links and LinkedIn links on one page.
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

  const text = visibleText(html);
  for (const match of text.matchAll(EMAIL_IN_TEXT)) add("email", cleanEmail(match[0]));
  for (const match of text.matchAll(OBFUSCATED)) {
    const domain = match[2]!.replace(/\s*[([{]\s*dot\s*[)\]}]\s*/gi, ".").replace(/\s+/g, "");
    add("email", cleanEmail(`${match[1]}@${domain}`));
  }
  return [...found.values()];
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

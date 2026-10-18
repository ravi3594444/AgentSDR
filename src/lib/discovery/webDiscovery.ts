import { contactLinkSequence, emailMatchesDomain, extractContacts, ownWebsite, visibleText, websiteDomain, withoutElements, type FoundContact } from "./contacts";

/**
 * Website and directory discovery, the pure half (the job is in
 * webDiscovery.server.ts): the search queries, what each URL a search
 * provider returned is, the business links on a directory page, why a lead
 * matched, and whether something a person wrote asks for help.
 *
 * Nothing here invents anything: a match reason only quotes the provider's
 * title and snippet and the query that found the page, and a signal is
 * "need" only when the words themselves ask for something.
 */

export type SourceKind = "own_site" | "directory" | "instagram_profile" | "instagram_post" | "social_other" | "unusable";

/** At most this many queries per discovery (each one is a paid provider search). */
export const MAX_SEARCH_QUERIES = 3;

function clip(value: string, limit: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

function languageName(code: string): string | null {
  if (!code || code === "en") return null;
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? null;
  } catch {
    return null;
  }
}

/**
 * The searches to run (2, or 3 with Instagram): the businesses' own
 * websites, local directories and lists of them, and, when Instagram can be
 * read, their public Instagram profiles and posts. `offer` keeps the search
 * from returning the owner's competitors (suppliers of the same thing).
 */
export function buildSearchQueries(input: { customers: string; offer?: string | null; where: string; language?: string | null; instagram?: boolean }): string[] {
  const customers = clip(input.customers, 160);
  const where = clip(input.where, 120);
  const offer = input.offer?.trim() ? clip(input.offer, 80) : null;
  const language = languageName((input.language ?? "en").toLowerCase());
  const pages = language ? ` Pages in ${language} or English.` : "";
  const queries = [
    `${customers} in ${where}: the businesses' own websites with their contact details${offer ? ` (businesses that could buy this, not suppliers of ${offer})` : ""}.${pages}`,
    `Local directories and lists of ${customers} in ${where} (business directories, association member lists, "top" lists) that link to each business.${pages}`,
  ];
  if (input.instagram) queries.push(`Public Instagram profiles and posts of ${customers} in ${where} (instagram.com pages).`);
  return queries.slice(0, MAX_SEARCH_QUERIES);
}

/**
 * The same searches as keywords, for a search engine (TinyFish) rather than
 * a model; index-aligned with buildSearchQueries, whose sentence then goes
 * along as the search's stated purpose.
 */
export function buildKeywordQueries(input: { customers: string; where: string; instagram?: boolean }): string[] {
  const customers = clip(input.customers, 120);
  const where = clip(input.where, 80);
  const queries = [`${customers} ${where}`, `${customers} ${where} directory list`];
  if (input.instagram) queries.push(`${customers} ${where} instagram`);
  return queries.slice(0, MAX_SEARCH_QUERIES);
}

/** Listing and directory sites: their pages list many businesses, not one. */
const DIRECTORY_HOST = /(?:^|\.)(?:justdial\.com|sulekha\.com|indiamart\.com|tradeindia\.com|exportersindia\.com|practo\.com|lybrate\.com|magicpin\.in|asklaila\.com|grotal\.com|zomato\.com|swiggy\.com|urbancompany\.com|yelp\.[a-z.]+|tripadvisor\.[a-z.]+|yellowpages\.[a-z.]+|yell\.com|foursquare\.com|hotfrog\.[a-z.]+|cylex(?:-[a-z]+)?\.[a-z.]+|manta\.com|bbb\.org|thumbtack\.com|angi\.com|houzz\.[a-z.]+|clutch\.co|goodfirms\.co|europages\.[a-z.]+|kompass\.com|trustpilot\.com|g2\.com|capterra\.com)$/i;
/** Social networks other than Instagram: they need a login and are not read. */
const SOCIAL_HOST = /(?:^|\.)(?:facebook\.com|fb\.com|fb\.me|x\.com|twitter\.com|linkedin\.com|youtube\.com|youtu\.be|tiktok\.com|threads\.net|pinterest\.[a-z.]+|reddit\.com|quora\.com|snapchat\.com|wa\.me|whatsapp\.com|t\.me|telegram\.me|linktr\.ee)$/i;
/** Never a business of its own: search engines, link shorteners, encyclopedias, app stores, site builders' own pages, web plumbing. */
const NOT_A_BUSINESS_HOST = /(?:^|\.)(?:google\.[a-z.]+|goo\.gl|g\.co|bing\.com|duckduckgo\.com|bit\.ly|tinyurl\.com|wikipedia\.org|wikimedia\.org|wikidata\.org|apple\.com|microsoft\.com|amazon\.[a-z.]+|gstatic\.com|googleapis\.com|doubleclick\.net|cloudflare\.com|amazonaws\.com|gravatar\.com|w3\.org|schema\.org|creativecommons\.org|addthis\.com|sharethis\.com)$/i;
/** Site builders' own home pages (a business's site lives on a subdomain, which stays usable). */
const PLATFORM_APEX = /^(?:www\.)?(?:wordpress\.(?:org|com)|wix\.com|wixsite\.com|squarespace\.com|godaddy\.com|shopify\.com|blogspot\.com|weebly\.com|webflow\.com|github\.com)$/i;
/** A list page on an ordinary site: "/top-10-dentists-in-pune", "/directory", "/list-of-…". */
const LIST_PATH = /(?:^|[/_-])(?:top|best)[-_]\d+(?:[-_/.]|$)|(?:^|[/_-])(?:directory|directories|list-of|listing|listings)(?:[-_/.]|$)/i;
const FILE_PATH = /\.(?:pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|pptx?|mp4|mp3)$/i;

const INSTAGRAM_HOST = /^(?:www\.|m\.)?(?:instagram\.com|instagr\.am)$/i;
const INSTAGRAM_USERNAME = /^[A-Za-z0-9._]{1,30}$/;
const INSTAGRAM_SHORTCODE = /^[A-Za-z0-9_-]{5,64}$/;
/** First path segments that are Instagram's own pages, never a username. */
const INSTAGRAM_RESERVED = new Set(["p", "reel", "reels", "tv", "explore", "accounts", "stories", "direct", "about", "legal", "developer", "developers", "web", "challenge", "privacy", "session", "emails", "graphql", "api", "static", "oauth", "ar", "invites", "lite", "directory"]);

export type InstagramTarget =
  | { kind: "instagram_profile"; username: string; url: string }
  | { kind: "instagram_post"; shortcode: string; url: string };

/**
 * An Instagram profile (instagram.com/<username>/) or post
 * (instagram.com/p/<shortcode>/, /reel/<shortcode>/, also under a username)
 * in its canonical form, or null for anything else on Instagram (explore,
 * stories, hashtags) and for other sites.
 */
export function instagramTarget(raw: string): InstagramTarget | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || !INSTAGRAM_HOST.test(url.hostname)) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  const postAt = segments.findIndex((segment) => ["p", "reel", "reels", "tv"].includes(segment.toLowerCase()));
  if (postAt >= 0 && postAt <= 1) {
    const shortcode = segments[postAt + 1];
    if (!shortcode || !INSTAGRAM_SHORTCODE.test(shortcode)) return null;
    if (postAt === 1 && (!INSTAGRAM_USERNAME.test(segments[0]!) || INSTAGRAM_RESERVED.has(segments[0]!.toLowerCase()))) return null;
    const path = segments[postAt]!.toLowerCase() === "p" ? "p" : segments[postAt]!.toLowerCase() === "tv" ? "tv" : "reel";
    return { kind: "instagram_post", shortcode, url: `https://www.instagram.com/${path}/${shortcode}/` };
  }
  const [first, second, ...rest] = segments;
  if (!first || rest.length || INSTAGRAM_RESERVED.has(first.toLowerCase()) || !INSTAGRAM_USERNAME.test(first)) return null;
  if (second && !["reels", "tagged", "guides", "following", "followers"].includes(second.toLowerCase())) return null;
  return { kind: "instagram_profile", username: first.toLowerCase(), url: `https://www.instagram.com/${first.toLowerCase()}/` };
}

/** What a URL returned by the search provider is, and so how it is read (or why it is not). */
export function classifySourceUrl(raw: string): SourceKind {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return "unusable";
  }
  if (!/^https?:$/.test(url.protocol)) return "unusable";
  const host = url.hostname.toLowerCase();
  if (INSTAGRAM_HOST.test(host)) return instagramTarget(url.toString())?.kind ?? "unusable";
  if (SOCIAL_HOST.test(host)) return "social_other";
  if (DIRECTORY_HOST.test(host)) return "directory";
  if (NOT_A_BUSINESS_HOST.test(host) || PLATFORM_APEX.test(host) || FILE_PATH.test(url.pathname)) return "unusable";
  if (!websiteDomain(url.toString())) return "unusable";
  if (LIST_PATH.test(url.pathname)) return "directory";
  return ownWebsite(url.toString()) ? "own_site" : "unusable";
}

/** Why a source of this kind is not read, for the job's record. */
export function unusableReason(kind: SourceKind, url: string): string | null {
  if (kind === "social_other") {
    let host = url;
    try {
      host = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      // keep the URL as it is
    }
    return `${host} needs a login and does not allow automated reading`;
  }
  if (kind === "unusable") return "not a business's own page, a directory or an Instagram profile or post";
  return null;
}

/** Anchor text that is not a name ("Visit website", "Click here"). */
const GENERIC_LINK_TEXT = /^(?:(?:visit|view|open|go to)\s+)?(?:(?:our|the|their)\s+)?(?:website|web ?site|site|homepage|home page)$|^(?:visit|click here|here|link|more|read more|view|details|open|go)$|^(?:www\.|https?:)/i;

const ANCHOR_OPEN = /<a\b/gi;
const ANCHOR_CLOSE = /<\/a\s*>/gi;
const HREF_ATTRIBUTE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

/**
 * Every <a href=…>…</a> on a page: its href and the markup inside it. One
 * linear pass (a page is read up to 1.5 MB): a single regex for the whole
 * anchor retries from every "<a" to the end of the page when no "</a>"
 * follows, which a hostile page turns into minutes. Same reading as that
 * regex: the href is taken from the opening tag (up to its first ">"), the
 * text runs to the first "</a>", and the scan resumes after it.
 */
function anchorsOf(html: string): { href: string; inner: string }[] {
  const out: { href: string; inner: string }[] = [];
  let cursor = 0;
  while (cursor < html.length) {
    ANCHOR_OPEN.lastIndex = cursor;
    const open = ANCHOR_OPEN.exec(html);
    if (!open) break;
    const tagEnd = html.indexOf(">", open.index + 2);
    if (tagEnd < 0) break;
    const attributes = HREF_ATTRIBUTE.exec(html.slice(open.index + 2, tagEnd));
    cursor = tagEnd + 1;
    if (!attributes) continue;
    ANCHOR_CLOSE.lastIndex = cursor;
    const close = ANCHOR_CLOSE.exec(html);
    // No "</a>" after this anchor: none after any later one either.
    if (!close) break;
    out.push({ href: attributes[1] ?? attributes[2] ?? attributes[3] ?? "", inner: html.slice(cursor, close.index) });
    cursor = close.index + close[0].length;
  }
  return out;
}

/**
 * Links on a directory or list page that look like the listed businesses'
 * own websites: other hosts than the directory itself, not social networks
 * or other directories, one per website, at most `limit`. The link text is
 * kept when it reads like a name.
 */
export function directoryBusinessLinks(html: string, pageUrl: string, limit = 20): { url: string; text: string | null }[] {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return [];
  }
  const pageDomain = websiteDomain(base.toString());
  const seen = new Set<string>();
  const out: { url: string; text: string | null }[] = [];
  for (const anchor of anchorsOf(html)) {
    const href = visibleText(anchor.href).trim();
    if (!href || /^(?:mailto|tel|javascript|#)/i.test(href)) continue;
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol)) continue;
    url.hash = "";
    const domain = websiteDomain(url.toString());
    if (!domain || domain === pageDomain || (pageDomain && (domain.endsWith(`.${pageDomain}`) || pageDomain.endsWith(`.${domain}`)))) continue;
    if (seen.has(domain) || classifySourceUrl(url.toString()) !== "own_site") continue;
    seen.add(domain);
    const text = visibleText(anchor.inner).trim();
    out.push({ url: url.toString(), text: text && text.length <= 120 && !GENERIC_LINK_TEXT.test(text) ? text : null });
    if (out.length >= limit) break;
  }
  return out;
}

/** A contact this many times on a directory page is the directory's own (a helpline beside each listing), not a listing's. */
const REPEATED_CONTACT_MIN = 3;
const MAX_LINKS_COMPARED = 2_000;

/**
 * The page without its own chrome — <header>, <nav> and <footer> — except
 * inside a listing (<article> or <li>), where a card's own header or footer
 * often carries the listing's phone. Linear: listing blocks are set aside,
 * the chrome is removed from the rest, and the blocks put back (those inside
 * removed chrome, such as a footer's link list, go with it).
 */
function withoutPageChrome(html: string): string {
  const blocks: string[] = [];
  const marked = replaceElements(html, ["article", "li"], (block) => {
    blocks.push(block);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  return withoutElements(marked, ["header", "nav", "footer"]).replace(/\u0000(\d+)\u0000/g, (_, index: string) => blocks[Number(index)] ?? " ");
}

/** `html` with each <name>…</name> element (outermost, first closing tag) replaced by `replace(element)`, in one pass. */
function replaceElements(html: string, names: readonly string[], replace: (element: string) => string): string {
  const open = new RegExp(`<(${names.join("|")})\\b`, "gi");
  const unclosedFrom = new Map<string, number>();
  let out = "";
  let at = 0;
  for (let match = open.exec(html); match; match = open.exec(html)) {
    const name = match[1]!.toLowerCase();
    if (open.lastIndex >= (unclosedFrom.get(name) ?? Infinity)) continue;
    const close = new RegExp(`</${name}\\s*>`, "gi");
    close.lastIndex = open.lastIndex;
    const end = close.exec(html);
    if (!end) {
      unclosedFrom.set(name, open.lastIndex);
      continue;
    }
    out += html.slice(at, match.index) + replace(html.slice(match.index, end.index + end[0].length));
    at = end.index + end[0].length;
    open.lastIndex = at;
  }
  return out + html.slice(at);
}

/**
 * The emails and phones on a directory or list page that belong to its
 * listings. Left out: the site's own header, navigation and footer (its
 * helpline, its support address) outside the listings; a number or address
 * shown at least three times on the page (a helpline beside each listing —
 * also when the directory hides the listings' own numbers); addresses on the
 * directory's own domain; and LinkedIn links. Chrome built from plain divs
 * is caught only by the repetition rule.
 */
export function directoryListingContacts(html: string, pageUrl: string): FoundContact[] {
  const listings = withoutPageChrome(html);
  // The first links are enough to tell (and keep a hostile page cheap).
  const counts = new Map<string, number>();
  for (const key of contactLinkSequence(html).slice(0, MAX_LINKS_COMPARED)) counts.set(key, (counts.get(key) ?? 0) + 1);
  const pageDomain = websiteDomain(pageUrl);
  return extractContacts(listings, pageUrl).filter((contact) => {
    if (contact.kind === "linkedin") return false;
    if ((counts.get(`${contact.kind}:${contact.value.toLowerCase()}`) ?? 0) >= REPEATED_CONTACT_MIN) return false;
    return !(contact.kind === "email" && emailMatchesDomain(contact.value, pageDomain));
  });
}

/** Free mail providers: an owner's mailbox there says nothing about which domain is theirs. */
const PUBLIC_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com", "rocketmail.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "rediffmail.com", "zoho.com", "zohomail.com",
  "zohomail.in", "gmx.com", "gmx.net", "mail.com", "yandex.com", "yandex.ru", "tutanota.com", "fastmail.com", "hey.com", "qq.com",
  "163.com", "126.com", "naver.com", "web.de", "inbox.com",
]);

/** The domain an owner's mailbox address says is theirs, or null for a free mail provider. */
export function ownerMailDomain(email: string): string | null {
  const domain = email.split("@")[1]?.trim().toLowerCase() ?? "";
  if (!domain || PUBLIC_MAIL_DOMAINS.has(domain) || /^(?:yahoo|hotmail|outlook|live|gmail|googlemail|rediff(?:mail)?)\.[a-z.]+$/.test(domain)) return null;
  return domain;
}

/** How a lead relates to the page the search returned, when it is not that page itself. */
export type MatchRelation = "linked_from" | "listed_on" | "commented_on" | "website_of";

export type MatchSource = {
  /** The search query that returned the page. */
  query: string;
  /** The page the provider returned. */
  url: string;
  /** Where that page redirected, when it did: the page actually read (never called a search result). */
  finalUrl?: string | null;
  /** The provider's title and snippet for it, as returned (null when it gave none). */
  title: string | null;
  snippet: string | null;
  via?: MatchRelation;
};

/**
 * Why a lead matched, in one sentence the owner can check: the query and
 * the provider's own title and snippet, quoted. Never a guess about the lead.
 */
export function matchReasonFor(source: MatchSource): string {
  const query = `“${clip(source.query, 200)}”`;
  const title = source.title?.trim() ? `“${clip(source.title, 140)}”` : null;
  const snippet = source.snippet?.trim() ? `“${clip(source.snippet, 220)}”` : null;
  const page = title ? `${title} (${source.url})` : source.url;
  const redirected = source.finalUrl && source.finalUrl !== source.url ? `, which redirected to ${source.finalUrl}, where it was read` : "";
  switch (source.via) {
    case "linked_from":
      return `Linked from ${page}, a page the web search for ${query} returned${redirected}.`;
    case "listed_on":
      return `Listed on ${page}, a page the web search for ${query} returned${redirected}.`;
    case "commented_on":
      return `Commented on the Instagram post ${source.url}, which the web search for ${query} returned.`;
    case "website_of":
      return `The website listed on the Instagram profile ${source.url}, which the web search for ${query} returned${title ? ` as ${title}` : ""}.`;
    default: {
      const quoted = [title, snippet].filter(Boolean).join(" — ");
      return `The web search for ${query} returned ${source.url}${quoted ? `: ${quoted}` : " (with no title or description)"}.`;
    }
  }
}

/**
 * Explicit asks, in English and common Hinglish. Each pattern needs the
 * words that ask; praise, thanks and tags never match.
 */
const NEED_PATTERNS: RegExp[] = [
  /\b(?:looking|searching) for\b/i,
  /\bin (?:search|need) of\b/i,
  /\bneeds? (?:a|an|some|someone|somebody|help|advice|recommendations?|suggestions?|to (?:find|buy|get|book|hire|fix|repair))\b/i,
  /\b\w+ (?:needed|required) (?:in|near|for|urgently|asap)\b/i,
  // "Anyone know / do you know …" asks only about a place, a person or a way
  // ("anyone know a good dentist", "do you know where…", "how to…"), never
  // "does anyone know how beautiful this is?".
  /\bany(?:one|body)? (?:recommend|suggest)\b/i,
  /\b(?:any(?:one|body)?|(?:does|do) (?:anyone|anybody|someone|somebody)|do you) knows? (?:a|an|any|of|where|who|whom|whether|if (?:you|they|there)|how (?:to|i|we|can|do)|someone|somebody|anyone|good|the best)\b/i,
  /\bcan (?:any(?:one|body)|some(?:one|body)|you) (?:recommend|suggest|help|tell)\b/i,
  /\bany (?:good )?(?:recommendations?|suggestions?|references?)\b/i,
  /\b(?:please|pls|plz) (?:recommend|suggest)\b/i,
  /\b(?:recommend|suggest) me\b/i,
  /\bwhere (?:can|do|should|could|would) (?:i|we|one) (?:get|find|buy|go|book)\b/i,
  /\bwhere to (?:get|find|buy|book)\b/i,
  /\bhow (?:do|can|could|to) (?:i |we )?(?:book|order|buy|get|contact|reach|hire|join|enrol|enroll)\b/i,
  // "How much" asks a price only as a question that opens with it ("how
  // much for a cleaning?", "and how much is it?") or next to a price word;
  // "I love how much this place has grown" is praise.
  // "how much" asks a price only as "how much is/for/does/would…?" or next
  // to a price word; "how much fun was this?!" and "I love how much you pay
  // attention" are praise.
  /\bhow much (?:is|are|does|do|did|for|would|will|to (?:book|buy|get|order|hire|rent|join|enrol|enroll)|per|each|cost|costs|charge|charges)\b[^.!?]{0,80}\?/i,
  /\bhow much\b[^.!?]{0,60}(?:\b(?:price|prices|pricing|cost|costs|charge|charges|charged|fee|fees|rate|rates|rs|rupees|inr|budget)\b|[₹$])/i,
  /\bwhat(?:'s| is| are)(?: the| your)? (?:price|prices|cost|costs|rate|rates|fee|fees|charges?)\b/i,
  /\b(?:price|prices|pricing|cost|rate|rates|fees?|charges?|quote|quotation)\s*\?/i,
  /\b(?:price|rate|cost|details) (?:please|pls|plz)\b/i,
  /\b(?:send|share|dm|tell)(?: me)?(?: the| your)? (?:price|prices|pricing|rates?|quote|quotation|details)\b/i,
  /\b(?:get|need|want|request) (?:a )?(?:quote|quotation|estimate)\b/i,
  /\b(?:is (?:it|this)|are you) available\b[^.!]*\?/i,
  /\bdo you (?:deliver|ship|provide|offer|have(?! (?:any |an |no )?idea)|do|serve|take)\b[^.!]*\?/i,
  // Hinglish: chahiye (want/need), kahan/kaha milega (where can I get),
  // kitne ka / kitna lagega (how much), koi bata/suggest (someone tell/suggest),
  // price kya hai / kya rate (what is the price).
  // "chahiye" (want/need) asks only with someone asking ("mujhe … chahiye")
  // or as a question; "aisa hi pyaar chahiye 😍" is praise.
  /\b(?:mujhe|muje|mujhko|mereko|mujhe bhi|hume|humein|hamein|hamko|humko)\b[^.!?]{0,60}\b(?:chahiye|chahie|chaiye)\b/i,
  /\b(?:chahiye|chahie|chaiye)\b[^.!]{0,40}\?/i,
  /\bkah?a+n? (?:mile(?:ga|gi)?|milta|milti)\b/i,
  /\bkitn[aei] (?:ka|ki|ke|lagega|lagegi|lagta|lagti|hoga|hogi|price|rate|charges?|paisa|paise|rs|rupees?)\b|\bkitn[aei](?: hai)?\s*\?/i,
  /\bkoi (?:bata|batao|bataye|batayein|btao|suggest|recommend)\b/i,
  /\b(?:price|rate|charges?|fees?) (?:kya|batao|bata|bta|btao)\b/i,
  /\bkya (?:price|rate|charges?|fees?)\b/i,
];

/**
 * Words that turn an ask into its opposite: "no need to look further", "not
 * looking for", and in Hindi/Hinglish "mujhe nahi chahiye", "mat chahiye",
 * "need nahi hai".
 */
const NEGATED = /\b(?:no|not|don['’]?t|dont|do not|doesn['’]?t|never|nobody|no one|nahi|nahin|nhi|nai)\s+(?:\w+\s+)?(?:need|needs|looking|searching|chahiye|chahie|chaiye)\b|\b(?:mat|na)\s+(?:chahiye|chahie|chaiye)\b|\b(?:need|chahiye|chahie|chaiye)\s+(?:hi\s+|bhi\s+)?(?:nahi|nahin|nhi|nai)\b/gi;

/**
 * Whether something a person wrote asks for help ("need") or is only
 * engagement. Conservative: "need" only for explicit asks — looking for,
 * recommendations, "need a …", "anyone know", "where can I", "how much …?",
 * price or quote questions, and their common Hinglish forms; a negated ask
 * ("not looking", "nahi chahiye") is none. Emojis, praise,
 * "nice", "follow back" and tagging friends are engagement; a tag without a
 * question is engagement too. A like, follow or generic comment is never a
 * need.
 */
export function needSignal(text: string): "need" | "engagement" {
  const value = text.replace(/\s+/g, " ").trim();
  if (!value || !/\p{L}/u.test(value)) return "engagement";
  const tagsFriends = /(?:^|\s)@[A-Za-z0-9._]{2,30}\b/.test(value);
  if (tagsFriends && !value.includes("?")) return "engagement";
  const words = value.replace(NEGATED, " ");
  return NEED_PATTERNS.some((pattern) => pattern.test(words)) ? "need" : "engagement";
}

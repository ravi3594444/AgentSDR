import { createHash } from "node:crypto";
import { cleanEmail, ownWebsite } from "@/lib/discovery/contacts";
import type { BrightdataDatasetKey, BrightdataPlatform } from "./catalog";
import { BRIGHTDATA_DATASETS } from "./catalog";
import { redditUserUrl, xProfileUrl } from "./urls";

/**
 * Pure parts of Bright Data research: what a collection's records are as
 * findings, what a snapshot's progress means, and the key that recognises
 * the same collection asked twice. Nothing here invents a value: a field the
 * record does not carry stays empty, every finding keeps the URL it was read
 * from and the time Bright Data read it, and a record for an input Bright
 * Data could not read becomes a failure with its reason, not a finding.
 */

type Json = Record<string, unknown>;

/** Someone a finding is by, as the record names them. */
export type SocialAuthor = { name: string | null; username: string | null; profileUrl: string | null };

/** What a profile or page publishes about itself. Each contact is what the record carries, never guessed. */
export type SocialIdentity = {
  name: string | null;
  username: string | null;
  bio: string | null;
  category: string | null;
  location: string | null;
  isBusiness: boolean | null;
  /** Websites it links to (its own site, link-in-bio pages), cleaned to a site URL. */
  websites: string[];
  /** Other profiles it links to (Instagram, X, Facebook, …), as given. */
  socialLinks: string[];
  emails: string[];
  phones: string[];
};

export type SocialFinding = {
  platform: BrightdataPlatform;
  dataset: BrightdataDatasetKey;
  kind: "post" | "comment" | "profile" | "page";
  /** The post, comment, profile or page itself. */
  url: string;
  /** The words that make it relevant: a post's title and body, a comment, a profile's bio. */
  text: string | null;
  title: string | null;
  author: SocialAuthor | null;
  /** The subreddit, for Reddit. */
  community: string | null;
  /** The post this comment is on. */
  parentUrl: string | null;
  postedAt: string | null;
  /** When Bright Data read it (the record's timestamp). */
  retrievedAt: string | null;
  identity: SocialIdentity | null;
  /** What found it: the keyword or the URL sent. */
  input: string | null;
};

export type SocialFailure = { input: string | null; code: string | null; reason: string };

function text(value: unknown, limit = 4_000): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/\u0000/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return clean ? clean.slice(0, limit) : null;
}

function iso(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function strings(value: unknown): string[] {
  return array(value).flatMap((item) => {
    if (typeof item === "string") return [item];
    if (item && typeof item === "object") {
      const link = (item as Json).url ?? (item as Json).link ?? (item as Json).value ?? (item as Json).href;
      return typeof link === "string" ? [link] : [];
    }
    return [];
  });
}

function inputOf(record: Json): string | null {
  const discovery = record.discovery_input as Json | undefined;
  if (discovery && typeof discovery.keyword === "string") return discovery.keyword;
  const input = record.input as Json | undefined;
  if (input && typeof input.url === "string") return input.url;
  if (input && typeof input.keyword === "string") return input.keyword;
  return null;
}

const SOCIAL_HOST = /(?:^|\.)(?:instagram|facebook|fb|x|twitter|tiktok|youtube|youtu|linkedin|reddit|threads|pinterest|snapchat|t|wa|whatsapp|discord|twitch)\.(?:com|me|gg|be|net)$/i;
const LINK_IN_BIO = /(?:^|\.)(?:linktr\.ee|beacons\.ai|bio\.link|lnk\.bio|carrd\.co|campsite\.bio|linkin\.bio|tap\.bio|msha\.ke)$/i;

/** A link's role: a website of its own, another social profile, or neither. Link-in-bio pages count as websites (they are read like one). */
function splitLinks(links: readonly string[]): { websites: string[]; socialLinks: string[] } {
  const websites: string[] = [];
  const socialLinks: string[] = [];
  for (const raw of links) {
    let host: string;
    try {
      host = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      continue;
    }
    if (SOCIAL_HOST.test(host)) {
      if (!socialLinks.includes(raw.trim())) socialLinks.push(raw.trim());
      continue;
    }
    const site = LINK_IN_BIO.test(host) ? raw.trim().replace(/^(?!https?:\/\/)/i, "https://") : ownWebsite(raw);
    if (site && !websites.includes(site)) websites.push(site);
  }
  return { websites, socialLinks };
}

/** Emails a bio writes out in full; nothing reconstructed from "name at domain". */
function bioEmails(bio: string | null): string[] {
  if (!bio) return [];
  const found = bio.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
  return [...new Set(found.map((email) => cleanEmail(email)).filter((email): email is string => Boolean(email)))];
}

function identity(input: Omit<SocialIdentity, "websites" | "socialLinks" | "emails"> & { links: string[]; emails: string[] }): SocialIdentity {
  const { websites, socialLinks } = splitLinks(input.links);
  const emails = [...new Set([...input.emails.map((email) => cleanEmail(email)).filter((email): email is string => Boolean(email)), ...bioEmails(input.bio)])];
  return { name: input.name, username: input.username, bio: input.bio, category: input.category, location: input.location, isBusiness: input.isBusiness, websites, socialLinks, emails, phones: [...new Set(input.phones)] };
}

/** A record Bright Data returned for an input it could not read (include_errors). */
export function failureOf(record: unknown): SocialFailure | null {
  if (!record || typeof record !== "object") return { input: null, code: null, reason: "Bright Data returned an empty record" };
  const json = record as Json;
  if (json.error === undefined && json.error_code === undefined) return null;
  return {
    input: inputOf(json),
    code: typeof json.error_code === "string" ? json.error_code : null,
    reason: text(json.error, 300) ?? (typeof json.error_code === "string" ? json.error_code.replace(/_/g, " ") : "Bright Data could not read it"),
  };
}

// ── Reddit ───────────────────────────────────────────────────────────────────

function redditPost(record: Json): SocialFinding[] {
  const url = text(record.url, 500);
  if (!url) return [];
  const username = text(record.user_posted, 60);
  const retrievedAt = iso(record.timestamp);
  const community = text(record.community_name, 80);
  const title = text(record.title, 300);
  const body = text(record.description, 4_000);
  const post: SocialFinding = {
    platform: "reddit",
    dataset: "reddit_posts",
    kind: "post",
    url,
    text: [title, body].filter(Boolean).join("\n\n") || null,
    title,
    author: username ? { name: null, username, profileUrl: redditUserUrl(username) } : null,
    community,
    parentUrl: null,
    postedAt: iso(record.date_posted),
    retrievedAt,
    identity: null,
    input: inputOf(record),
  };
  const comments: SocialFinding[] = [];
  const walk = (items: unknown[], depth: number) => {
    for (const item of items) {
      if (!item || typeof item !== "object" || comments.length >= 100) continue;
      const comment = item as Json;
      const words = text(comment.comment, 2_000);
      const user = text(comment.user_commenting, 60);
      const commentUrl = text(comment.url, 500);
      if (words && commentUrl) {
        comments.push({
          platform: "reddit",
          dataset: "reddit_posts",
          kind: "comment",
          url: commentUrl,
          text: words,
          title: null,
          // Bright Data's user_url for commenters is malformed (…/svc/shreddit/…/undefined); the profile URL is built from the name.
          author: user ? { name: null, username: user, profileUrl: redditUserUrl(user) } : null,
          community,
          parentUrl: url,
          postedAt: iso(comment.date_of_comment),
          retrievedAt,
          identity: null,
          input: post.input,
        });
      }
      if (depth < 3) walk(array(comment.replies), depth + 1);
    }
  };
  walk(array(record.comments), 0);
  return [post, ...comments];
}

function redditProfile(record: Json): SocialFinding[] {
  const url = text(record.url, 500);
  if (!url) return [];
  const name = text(record.name, 120);
  const bio = text(record.description, 1_000);
  return [{
    platform: "reddit",
    dataset: "reddit_profiles",
    kind: "profile",
    url,
    text: bio,
    title: null,
    author: null,
    community: null,
    parentUrl: null,
    postedAt: null,
    retrievedAt: iso(record.timestamp),
    identity: identity({ name, username: name, bio, category: null, location: null, isBusiness: null, links: strings(record.social_links), emails: [], phones: [] }),
    input: inputOf(record),
  }];
}

// ── X ────────────────────────────────────────────────────────────────────────

function xPost(record: Json): SocialFinding[] {
  const url = text(record.url, 500);
  const words = text(record.description, 4_000);
  if (!url || !words) return [];
  const username = text(record.user_posted, 30);
  return [{
    platform: "x",
    dataset: "x_posts",
    kind: "post",
    url,
    text: words,
    title: null,
    author: username ? { name: text(record.name, 120), username, profileUrl: xProfileUrl(username) } : null,
    community: null,
    parentUrl: null,
    postedAt: iso(record.date_posted),
    retrievedAt: iso(record.timestamp),
    identity: null,
    input: inputOf(record),
  }];
}

function xProfile(record: Json): SocialFinding[] {
  const url = text(record.url, 500);
  if (!url) return [];
  const handle = text(record.id, 30) ?? text(record.profile_name, 30);
  const bio = text(record.biography, 1_000);
  const categories = strings(record.category_name);
  return [{
    platform: "x",
    dataset: "x_profiles",
    kind: "profile",
    url,
    text: bio,
    title: null,
    author: null,
    community: null,
    parentUrl: null,
    postedAt: null,
    retrievedAt: iso(record.timestamp),
    identity: identity({
      name: text(record.profile_name, 120),
      username: handle,
      bio,
      category: categories[0] ?? null,
      location: text(record.location, 120),
      isBusiness: typeof record.is_business_account === "boolean" ? record.is_business_account : null,
      links: [text(record.external_link, 500)].filter((link): link is string => Boolean(link)),
      emails: [],
      phones: [],
    }),
    input: inputOf(record),
  }];
}

// ── Instagram ────────────────────────────────────────────────────────────────

function instagramProfile(record: Json): SocialFinding[] {
  const url = text(record.profile_url, 500) ?? text(record.url, 500);
  const username = text(record.account, 60);
  if (!url || !username) return [];
  const bio = text(record.biography, 1_000);
  return [{
    platform: "instagram",
    dataset: "instagram_profiles",
    kind: "profile",
    url,
    text: bio,
    title: null,
    author: null,
    community: null,
    parentUrl: null,
    postedAt: null,
    retrievedAt: iso(record.timestamp),
    identity: identity({
      name: text(record.full_name, 120) ?? text(record.profile_name, 120),
      username,
      bio,
      category: null,
      location: null,
      isBusiness: null,
      links: [text(record.external_url, 500), ...strings(record.external_urls)].filter((link): link is string => Boolean(link)),
      emails: [text(record.email_address, 200)].filter((email): email is string => Boolean(email)),
      phones: [],
    }),
    input: inputOf(record),
  }];
}

function instagramPost(record: Json): SocialFinding[] {
  const url = text(record.url, 500);
  if (!url) return [];
  const username = text(record.user_posted, 60);
  const retrievedAt = iso(record.timestamp);
  const post: SocialFinding = {
    platform: "instagram",
    dataset: "instagram_posts",
    kind: "post",
    url,
    text: text(record.description, 4_000),
    title: null,
    author: username ? { name: null, username, profileUrl: text(record.profile_url, 500) ?? `https://www.instagram.com/${username.toLowerCase()}/` } : null,
    community: text(record.location, 120),
    parentUrl: null,
    postedAt: iso(record.date_posted),
    retrievedAt,
    identity: null,
    input: inputOf(record),
  };
  const comments = array(record.latest_comments).flatMap((item): SocialFinding[] => {
    if (!item || typeof item !== "object") return [];
    const comment = item as Json;
    const words = text(comment.comments ?? comment.comment ?? comment.text, 2_000);
    const user = text(comment.user_commenting ?? comment.username ?? comment.user, 60);
    if (!words || !user) return [];
    return [{
      platform: "instagram",
      dataset: "instagram_posts",
      kind: "comment",
      url,
      text: words,
      title: null,
      author: { name: null, username: user, profileUrl: `https://www.instagram.com/${user.toLowerCase()}/` },
      community: post.community,
      parentUrl: url,
      postedAt: iso(comment.date ?? comment.date_of_comment),
      retrievedAt,
      identity: null,
      input: post.input,
    }];
  });
  return [post, ...comments];
}

// ── Facebook ─────────────────────────────────────────────────────────────────

function facebookPage(record: Json): SocialFinding[] {
  const url = text(record.url, 500);
  if (!url) return [];
  // The contacts are top-level in Bright Data's schema, and nested under contact_and_basic_info in the records it returned live.
  const nested = ((record.contact_and_basic_info as Json | undefined)?.contact_info ?? {}) as Json;
  const listed = (key: string) => [...strings(record[key]), ...strings(nested[key])];
  const name = text(record.page_name, 160);
  const summary = text(record.summary_text, 1_000);
  return [{
    platform: "facebook",
    dataset: "facebook_pages",
    kind: "page",
    url,
    text: summary,
    title: name,
    author: null,
    community: null,
    parentUrl: null,
    postedAt: null,
    retrievedAt: iso(record.timestamp),
    identity: identity({
      name,
      username: text(record.username, 80),
      bio: summary,
      category: text(record.primary_category, 120),
      location: text(record.address, 200) ?? text(record.current_city, 120),
      isBusiness: text(record.entity_type, 40)?.toLowerCase() === "page" ? true : null,
      links: [...new Set(listed("websites"))],
      emails: [...new Set(listed("emails"))],
      phones: [...new Set(listed("phones"))],
    }),
    input: inputOf(record),
  }];
}

function facebookPost(record: Json): SocialFinding[] {
  const url = text(record.url, 500);
  const words = text(record.content, 4_000);
  if (!url || !words) return [];
  const pageUrl = text(record.page_url, 500) ?? text(record.user_url, 500);
  return [{
    platform: "facebook",
    dataset: "facebook_posts",
    kind: "post",
    url,
    text: words,
    title: null,
    author: { name: text(record.user_username_raw, 160), username: text(record.profile_handle, 80) ?? text(record.user_handle, 80), profileUrl: pageUrl },
    community: null,
    parentUrl: null,
    postedAt: iso(record.date_posted),
    retrievedAt: iso(record.timestamp),
    identity: null,
    input: inputOf(record),
  }];
}

const MAPPERS: Record<BrightdataDatasetKey, (record: Json) => SocialFinding[]> = {
  reddit_posts: redditPost,
  reddit_profiles: redditProfile,
  x_posts: xPost,
  x_profiles: xProfile,
  instagram_posts: instagramPost,
  instagram_profiles: instagramProfile,
  facebook_pages: facebookPage,
  facebook_posts: facebookPost,
};

/** A snapshot's records as findings, and the inputs Bright Data could not read, with why. */
export function readRecords(dataset: BrightdataDatasetKey, records: readonly unknown[]): { findings: SocialFinding[]; failures: SocialFailure[] } {
  const findings: SocialFinding[] = [];
  const failures: SocialFailure[] = [];
  for (const record of records) {
    const failure = failureOf(record);
    if (failure) {
      failures.push(failure);
      continue;
    }
    findings.push(...MAPPERS[dataset](record as Json));
  }
  return { findings, failures };
}

// ── Collections ──────────────────────────────────────────────────────────────

/** What a snapshot's progress means for the job. */
export function progressOutcome(status: string): "running" | "ready" | "failed" {
  const value = status.toLowerCase();
  if (value === "ready") return "ready";
  if (value === "failed" || value === "canceled" || value === "cancelled") return "failed";
  return "running";
}

/**
 * Credits a collection used, as far as AgentSDR can tell: every record
 * delivered plus every input that failed (Bright Data bills both), never
 * less than the records actually downloaded.
 */
export function creditsUsed(progress: { records: number | null; errors: number | null }, downloaded: number | null): number {
  const reported = (progress.records ?? 0) + (progress.errors ?? 0);
  return Math.max(reported, downloaded ?? 0);
}

/** The key that recognises the same collection asked twice: its dataset, method and inputs (order kept). */
export function collectionKey(dataset: BrightdataDatasetKey, discoverBy: string | null, inputs: readonly Record<string, unknown>[], limitPerInput: number | null): string {
  const body = JSON.stringify({ d: BRIGHTDATA_DATASETS[dataset].datasetId, m: discoverBy, i: inputs, l: limitPerInput });
  return createHash("sha256").update(body).digest("hex").slice(0, 32);
}

/** The most credits a collection can take: its limit per input for discovery, one per URL otherwise. */
export function reservedCredits(discoverBy: string | null, inputs: readonly Record<string, unknown>[], limitPerInput: number | null): number {
  return discoverBy ? inputs.length * Math.max(1, limitPerInput ?? 1) : inputs.length;
}

/** What Bright Data's 429 or a full account means: wait (rate limit) or stop (credits, plan, key). */
export function errorKind(status: number | null, message: string): "wait" | "exhausted" | "rejected" | "lost" | "failed" {
  if (status === null || status >= 500) return "lost";
  if (status === 429) return "wait";
  if (status === 401 || status === 403) return /balance|credit|limit|payment|quota|insufficient/i.test(message) ? "exhausted" : "rejected";
  if (status === 402) return "exhausted";
  return /balance|credit|insufficient funds|payment required|quota/i.test(message) ? "exhausted" : "failed";
}

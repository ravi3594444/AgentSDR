import { getUnipileClient } from "@/services/unipile.service";

/**
 * Unipile's Instagram reads for website and directory discovery
 * (src/lib/discovery/webDiscovery.server.ts), API v1 through the SDK, with
 * the organization's linked Instagram account. Read-only, three calls:
 *
 *   GET /api/v1/users/{username}?account_id=…               a public profile
 *   GET /api/v1/posts/{shortcode}?account_id=…              a post, for its provider id
 *   GET /api/v1/posts/{provider_id}/comments?account_id=…&limit=…  its comments
 *
 * Nothing here follows, likes, comments or messages: discovery never acts on
 * Instagram. Kept apart from the LinkedIn, WhatsApp and email services.
 *
 * The response fields are read defensively: the installed SDK (1.9.3)
 * declares an Instagram profile (username, full_name, biography,
 * is_business, is_private, …) but no website field, and declares only
 * LinkedIn's post shape. Several names are tried for each value, and a value
 * that is missing is left empty — never guessed. Not verified against a live
 * Unipile account (docs/product/INSTAGRAM_INTAKE_DISCOVERY.md).
 */

/** The SDK's fetch has no deadline of its own; a call that hangs is abandoned after this. */
const CALL_TIMEOUT_MS = 30_000;
const USERNAME = /^[A-Za-z0-9._]{1,30}$/;
const POST_ID = /^[A-Za-z0-9_:-]{1,128}$/;

export type InstagramProfileRead = {
  username: string;
  /** Instagram's id for the account, when Unipile gives one. */
  providerId: string | null;
  fullName: string | null;
  biography: string | null;
  /** The external website the profile lists, as given. */
  website: string | null;
  /** Contact buttons a business profile shows publicly, when Unipile returns them. */
  publicEmail: string | null;
  publicPhone: string | null;
  isBusiness: boolean | null;
  isPrivate: boolean | null;
};

export type InstagramPostRead = {
  /** The id the comments call takes (Unipile's `provider_id`, else its `social_id` or `id`). */
  providerId: string;
  text: string | null;
  /** The post's author, when given, so their own replies are not taken for leads. */
  authorUsername: string | null;
};

export type InstagramCommentRead = {
  id: string;
  text: string;
  /** ISO date, when given. */
  date: string | null;
  authorName: string | null;
  authorUsername: string | null;
  authorProfileUrl: string | null;
};

function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Unipile did not answer ${what} within ${CALL_TIMEOUT_MS / 1000} s`)), CALL_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

function str(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function first(...values: unknown[]): string | null {
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = str(item) ?? (item && typeof item === "object" ? str((item as Record<string, unknown>).url) : null);
        if (found) return found;
      }
      continue;
    }
    const found = str(value);
    if (found) return found;
  }
  return null;
}

/** "https://www.instagram.com/priya.k/" → "priya.k". */
function usernameFromUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!/(^|\.)instagram\.com$/i.test(url.hostname)) return null;
    const segment = url.pathname.split("/").filter(Boolean)[0];
    return segment && USERNAME.test(segment) ? segment.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** A profile response, read field by field. Exported for tests. */
export function instagramProfileFrom(raw: unknown, requested: string): InstagramProfileRead {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const phoneCode = str(body.public_phone_country_code);
  const phone = first(body.public_phone_number, body.contact_phone_number, body.business_phone_number);
  return {
    username: (first(body.username, body.public_identifier) ?? requested).toLowerCase(),
    providerId: first(body.provider_id, body.pk, body.id),
    fullName: first(body.full_name, body.name),
    biography: first(body.biography, body.bio),
    website: first(body.external_url, body.website, body.websites, body.bio_links),
    publicEmail: first(body.public_email, body.business_email, body.contact_email),
    publicPhone: phone ? (phoneCode && !phone.startsWith("+") ? `+${phoneCode.replace(/\D/g, "")}${phone}` : phone) : null,
    isBusiness: bool(body.is_business) ?? bool(body.is_business_account),
    isPrivate: bool(body.is_private),
  };
}

/** A post response; null when it carries no id the comments call can take. Exported for tests. */
export function instagramPostFrom(raw: unknown): InstagramPostRead | null {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const providerId = first(body.provider_id, body.social_id, body.id);
  if (!providerId || !POST_ID.test(providerId)) return null;
  const author = (body.author && typeof body.author === "object" ? body.author : {}) as Record<string, unknown>;
  const details = (body.author_details && typeof body.author_details === "object" ? body.author_details : {}) as Record<string, unknown>;
  const authorUsername = first(author.username, author.public_identifier, details.username, details.public_identifier)
    ?? usernameFromUrl(first(author.profile_url, details.profile_url));
  return { providerId, text: first(body.text, body.caption), authorUsername: authorUsername?.toLowerCase() ?? null };
}

/** The comments of a comment-list response, each with its author as given. Exported for tests. */
export function instagramCommentsFrom(raw: unknown): InstagramCommentRead[] {
  const items = (raw && typeof raw === "object" ? (raw as { items?: unknown }).items : null);
  if (!Array.isArray(items)) return [];
  const out: InstagramCommentRead[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const comment = item as Record<string, unknown>;
    const text = typeof comment.text === "string" ? comment.text.trim() : "";
    const id = str(comment.id);
    if (!id || !text) continue;
    const details = (comment.author_details && typeof comment.author_details === "object" ? comment.author_details : {}) as Record<string, unknown>;
    const author = comment.author && typeof comment.author === "object" ? comment.author as Record<string, unknown> : null;
    const profileUrl = first(details.profile_url, author?.profile_url);
    const username = first(details.username, details.public_identifier, author?.username, author?.public_identifier) ?? usernameFromUrl(profileUrl);
    const date = str(comment.date);
    out.push({
      id,
      text,
      date: date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : null,
      authorName: typeof comment.author === "string" ? str(comment.author) : first(author?.name, details.name),
      authorUsername: username && USERNAME.test(username) ? username.toLowerCase() : null,
      authorProfileUrl: profileUrl,
    });
  }
  return out;
}

/** GET /api/v1/users/{username}?account_id= — a public Instagram profile. */
export async function getInstagramProfile(accountId: string, username: string): Promise<InstagramProfileRead> {
  if (!USERNAME.test(username)) throw new Error(`“${username}” is not an Instagram username`);
  const client = await getUnipileClient();
  const raw = await withTimeout(client.users.getProfile({ account_id: accountId, identifier: username }), "the profile request");
  return instagramProfileFrom(raw, username);
}

/** GET /api/v1/posts/{shortcode}?account_id= — one post, for the id its comments are listed by. */
export async function getInstagramPost(accountId: string, shortcode: string): Promise<InstagramPostRead | null> {
  if (!POST_ID.test(shortcode)) throw new Error(`“${shortcode}” is not an Instagram post code`);
  const client = await getUnipileClient();
  const raw = await withTimeout(client.users.getPost({ account_id: accountId, post_id: shortcode }), "the post request");
  return instagramPostFrom(raw);
}

/** GET /api/v1/posts/{provider_id}/comments?account_id=&limit= — the first page of a post's comments. */
export async function listInstagramPostComments(accountId: string, providerId: string, limit: number): Promise<InstagramCommentRead[]> {
  if (!POST_ID.test(providerId)) throw new Error(`“${providerId}” is not an Instagram post id`);
  const client = await getUnipileClient();
  const raw = await withTimeout(
    client.users.getAllPostComments({ account_id: accountId, post_id: providerId, limit: Math.max(1, Math.min(100, Math.round(limit))) }),
    "the comments request",
  );
  return instagramCommentsFrom(raw);
}

/** The HTTP status of a failed Unipile call, when it carries one. */
export function unipileFailureStatus(error: unknown): number | null {
  const body = (error as { body?: { status?: unknown } } | null)?.body;
  const status = body?.status ?? (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

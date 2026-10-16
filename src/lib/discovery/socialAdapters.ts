/**
 * Optional keyword and hashtag discovery on social networks, as adapters a
 * future setting could turn on. Unipile has no Instagram keyword, hashtag or
 * people search (docs/product/INSTAGRAM_INTAKE_DISCOVERY.md), so hashtag
 * discovery needs a provider of its own. None is configured: nothing in the
 * app, no job and no page constructs or calls an adapter, and none was
 * called during development (no account was created, no paid call made).
 *
 * The one adapter here is Meta's Instagram Graph API hashtag search, built
 * only from credentials passed to it explicitly:
 *
 *   GET https://graph.facebook.com/{version}/ig_hashtag_search?user_id={ig-user-id}&q={hashtag}
 *     → { data: [{ id }] }
 *   GET https://graph.facebook.com/{version}/{ig-hashtag-id}/recent_media?user_id={ig-user-id}&fields=…&limit=50
 *     → { data: [{ id, caption, media_type, permalink, timestamp, like_count, comments_count }], paging }
 *
 * Meta's requirements: an Instagram Business or Creator account linked to a
 * Facebook Page, an app approved in App Review for Instagram Public Content
 * Access (with instagram_basic), and a user access token. Limits: 30 unique
 * hashtags per account per rolling 7 days; recent_media covers the last 24
 * hours, at most 50 per page, and returns no usernames. Meta states no fee.
 */

export type SocialMediaItem = {
  id: string;
  caption: string | null;
  mediaType: string | null;
  permalink: string | null;
  timestamp: string | null;
  likeCount: number | null;
  commentsCount: number | null;
};

export interface SocialKeywordAdapter {
  key: string;
  label: string;
  /** What it needs before it can run, one requirement per entry. */
  requirements: string[];
  /** What it costs, as the provider states it. */
  cost: string;
  /** Whether it has what it needs to make a call. */
  configured(): boolean;
  /** Recent public posts with the hashtag (with or without "#"). */
  searchHashtag(tag: string): Promise<{ hashtagId: string | null; media: SocialMediaItem[] }>;
}

export type MetaGraphCredentials = {
  /** A user access token with instagram_basic and Instagram Public Content Access. */
  accessToken: string;
  /** The Instagram Business or Creator account's user id (the `user_id` both calls take). */
  instagramUserId: string;
  /** Graph API version, e.g. "v23.0". */
  apiVersion?: string;
  /** Tests substitute a stand-in. */
  fetchImpl?: typeof fetch;
};

const GRAPH = "https://graph.facebook.com";
const DEFAULT_VERSION = "v23.0";
const TIMEOUT_MS = 20_000;
const RECENT_MEDIA_FIELDS = "id,caption,media_type,permalink,timestamp,like_count,comments_count";

/** "#Dentist Pune" → null; "#DentistPune" → "dentistpune". Meta takes one word, letters, digits and underscores. */
export function normalizeHashtag(tag: string): string | null {
  const value = tag.trim().replace(/^#+/, "").toLowerCase();
  return /^[\p{L}\p{N}_]{1,100}$/u.test(value) ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function metaGraphHashtagAdapter(credentials: MetaGraphCredentials): SocialKeywordAdapter {
  const version = credentials.apiVersion?.trim() || DEFAULT_VERSION;
  const doFetch = credentials.fetchImpl ?? fetch;

  async function graph(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const url = new URL(`${GRAPH}/${version}/${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    // Meta documents the token as the access_token parameter.
    url.searchParams.set("access_token", credentials.accessToken);
    const response = await doFetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: "application/json" } });
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok || !body || body.error) {
      const error = (body?.error ?? {}) as { message?: unknown; code?: unknown };
      throw new Error(`Meta Graph API ${path.split("?")[0]} failed (HTTP ${response.status}${typeof error.code === "number" ? `, code ${error.code}` : ""}): ${typeof error.message === "string" ? error.message : "no details"}`);
    }
    return body;
  }

  const configured = () => Boolean(credentials.accessToken.trim() && credentials.instagramUserId.trim());

  return {
    key: "meta_instagram_hashtag",
    label: "Instagram hashtag search (Meta Graph API)",
    requirements: [
      "An Instagram Business or Creator account linked to a Facebook Page.",
      "A Meta app approved in App Review for Instagram Public Content Access and instagram_basic.",
      "A user access token for that account.",
      "At most 30 unique hashtags per account in a rolling 7 days; only the last 24 hours of posts, without usernames.",
    ],
    cost: "No fee stated by Meta.",
    configured,
    async searchHashtag(tag) {
      const hashtag = normalizeHashtag(tag);
      if (!hashtag) throw new Error(`“${tag}” is not a hashtag (one word: letters, digits, underscores)`);
      if (!configured()) throw new Error("The Meta Graph API adapter has no access token or Instagram user id.");
      const search = await graph("ig_hashtag_search", { user_id: credentials.instagramUserId, q: hashtag });
      const hashtagId = Array.isArray(search.data) ? str((search.data[0] as { id?: unknown } | undefined)?.id) : null;
      if (!hashtagId) return { hashtagId: null, media: [] };
      const recent = await graph(`${encodeURIComponent(hashtagId)}/recent_media`, { user_id: credentials.instagramUserId, fields: RECENT_MEDIA_FIELDS, limit: "50" });
      const media = (Array.isArray(recent.data) ? recent.data : []).flatMap((item): SocialMediaItem[] => {
        const row = (item ?? {}) as Record<string, unknown>;
        const id = str(row.id);
        return id
          ? [{ id, caption: str(row.caption), mediaType: str(row.media_type), permalink: str(row.permalink), timestamp: str(row.timestamp), likeCount: num(row.like_count), commentsCount: num(row.comments_count) }]
          : [];
      });
      return { hashtagId, media };
    },
  };
}

/**
 * The adapters an organization has configured: none. There is no
 * configuration source yet (no settings page, no stored credentials), so
 * nothing can be configured and discovery never calls one. When a setting
 * exists, this is where its credentials become adapters.
 */
export function configuredSocialAdapters(): SocialKeywordAdapter[] {
  return [];
}

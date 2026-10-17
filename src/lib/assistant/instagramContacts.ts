/** Direct recipient input, not keyword discovery: preserve the owner's exact handle. */
const HANDLE = /^[a-z0-9._]{1,30}$/i;
const RESERVED = new Set([
  "accounts",
  "about",
  "developer",
  "direct",
  "directory",
  "explore",
  "p",
  "reel",
  "reels",
  "stories",
  "tv",
]);
export const MAX_INSTAGRAM_CHAT_CONTACTS = 50;

export function instagramContactUsername(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 1000) return null;
  let handle = value.trim();
  if (/^(?:https?:\/\/)?(?:www\.)?instagram\.com(?:\/|$)/i.test(handle)) {
    try {
      const url = new URL(
        /^https?:\/\//i.test(handle) ? handle : `https://${handle}`,
      );
      if (
        !["instagram.com", "www.instagram.com"].includes(
          url.hostname.toLowerCase(),
        ) ||
        url.username ||
        url.password ||
        url.port
      )
        return null;
      const segments = url.pathname.split("/").filter(Boolean);
      if (segments.length !== 1) return null;
      handle = decodeURIComponent(segments[0]!);
    } catch {
      return null;
    }
  }
  handle = handle.replace(/^@/, "").toLowerCase();
  return HANDLE.test(handle) && !RESERVED.has(handle) ? handle : null;
}

export function parseInstagramContacts(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > MAX_INSTAGRAM_CHAT_CONTACTS
  ) {
    throw new Error(
      `usernames must contain 1–${MAX_INSTAGRAM_CHAT_CONTACTS} Instagram handles or profile URLs`,
    );
  }
  const usernames = value.map((input) => {
    const username = instagramContactUsername(input);
    if (!username)
      throw new Error(
        `Invalid Instagram recipient: ${String(input).slice(0, 100)}. Use a username, @username or Instagram profile URL`,
      );
    return username;
  });
  return [...new Set(usernames)];
}

/** Whole handles only: dev__ravi_35 cannot be shortened to ravi or changed to dev_ravi_35. */
export function ungroundedInstagramContacts(
  value: unknown,
  corpus: string,
): string[] {
  if (!Array.isArray(value)) return [];
  const urls =
    corpus.match(/(?:https?:\/\/)?(?:www\.)?instagram\.com\/[^\s<>"']+/gi) ??
    [];
  const knownUrls = new Set(urls.map((url) => instagramContactUsername(url)));
  return value
    .filter((input) => {
      const username = instagramContactUsername(input);
      if (!username) return true;
      const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return (
        !knownUrls.has(username) &&
        !new RegExp(
          `(^|[^a-z0-9._])@?${escaped}(?=$|[^a-z0-9._]|[.](?:\\s|$))`,
          "i",
        ).test(corpus)
      );
    })
    .map(String);
}

/** Current capability wins over old inbox-only assistant messages in a thread. */
export function instagramCapabilityProblem(message: string): string | null {
  const outdated =
    /\b(?:never|does not|doesn't)\s+(?:start|starts|initiate|initiates)\s+(?:a\s+)?(?:new\s+)?instagram\s+(?:chats?|conversations?)/i.test(
      message,
    ) ||
    /\binstagram\s+(?:outreach|messaging)\s+(?:is\s+)?(?:unsupported|not supported|inbound.only|replies.only)/i.test(
      message,
    );
  return outdated
    ? "Instagram supports approved initial DMs. For a supplied handle/profile use add_instagram_contacts; report the actual account or approval gate instead of repeating old inbox-only restrictions."
    : null;
}

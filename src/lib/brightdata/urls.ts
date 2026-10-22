import { instagramTarget } from "@/lib/discovery/webDiscovery";
import type { BrightdataDatasetKey } from "./catalog";

/**
 * Which Bright Data dataset reads a URL, and the URL in the form it is
 * sent. Bright Data bills a record for an input that fails, so only URLs
 * that are plainly a post, profile or page of the platform go out: a search
 * page, a login wall or a share link returns null and is never sent.
 */

export type DatasetUrl = { dataset: BrightdataDatasetKey; url: string; handle: string | null };

function parse(raw: string): URL | null {
  try {
    const url = new URL(raw.trim());
    return /^https?:$/.test(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

const REDDIT_HOST = /^(?:www\.|old\.|new\.|m\.)?reddit\.com$/i;
const REDDIT_NAME = /^[A-Za-z0-9_-]{2,40}$/;
const X_HOST = /^(?:www\.|mobile\.)?(?:x|twitter)\.com$/i;
const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const X_RESERVED = new Set(["home", "search", "explore", "i", "settings", "hashtag", "intent", "share", "messages", "notifications", "login", "signup", "tos", "privacy", "compose"]);
const FACEBOOK_HOST = /^(?:www\.|m\.|web\.|business\.)?facebook\.com$/i;
const FACEBOOK_NAME = /^[A-Za-z0-9.\-]{3,80}$/;
/** A page's newer address, /p/<Name>-<page id>/: the name part, then the numeric id. */
const FACEBOOK_P_PAGE = /^[A-Za-z0-9.%_-]{1,150}-\d{5,25}$/;
const FACEBOOK_RESERVED = new Set([
  "groups", "events", "watch", "marketplace", "login", "login.php", "sharer", "sharer.php", "share", "photo", "photo.php", "photos", "videos",
  "reel", "reels", "stories", "hashtag", "search", "help", "policies", "privacy", "pages", "gaming", "business", "ads", "settings", "notifications",
  "messages", "friends", "people", "public", "dialog", "plugins", "l.php", "home.php", "story.php", "permalink.php", "media", "fundraisers",
]);

export function redditUserUrl(username: string | null | undefined): string | null {
  const name = username?.replace(/^u\//i, "").trim();
  if (!name || !REDDIT_NAME.test(name) || /^\[?deleted\]?$/i.test(name) || name.toLowerCase() === "automoderator") return null;
  return `https://www.reddit.com/user/${name}/`;
}

export function xProfileUrl(handle: string | null | undefined): string | null {
  const name = handle?.replace(/^@/, "").trim();
  return name && X_HANDLE.test(name) && !X_RESERVED.has(name.toLowerCase()) ? `https://x.com/${name}` : null;
}

/** The dataset that reads `raw`, with the URL as sent; null for anything else. */
export function datasetForUrl(raw: string): DatasetUrl | null {
  const url = parse(raw);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);
  if (REDDIT_HOST.test(host)) {
    // /r/<sub>/comments/<id>/<slug?>
    if (segments[0]?.toLowerCase() === "r" && segments[2]?.toLowerCase() === "comments" && segments[1] && /^[a-z0-9]{3,12}$/i.test(segments[3] ?? "")) {
      return { dataset: "reddit_posts", url: `https://www.reddit.com/r/${segments[1]}/comments/${segments[3]}/${segments[4] ? `${segments[4]}/` : ""}`, handle: null };
    }
    if ((segments[0]?.toLowerCase() === "user" || segments[0]?.toLowerCase() === "u") && segments[1]) {
      const profile = redditUserUrl(segments[1]);
      return profile ? { dataset: "reddit_profiles", url: profile, handle: segments[1] } : null;
    }
    return null;
  }
  if (X_HOST.test(host)) {
    const handle = segments[0];
    if (!handle || !X_HANDLE.test(handle) || X_RESERVED.has(handle.toLowerCase())) return null;
    if (segments[1]?.toLowerCase() === "status" && /^\d{5,25}$/.test(segments[2] ?? "")) return { dataset: "x_posts", url: `https://x.com/${handle}/status/${segments[2]}`, handle };
    if (segments.length === 1) return { dataset: "x_profiles", url: `https://x.com/${handle}`, handle };
    return null;
  }
  const instagram = instagramTarget(url.toString());
  if (instagram) {
    return instagram.kind === "instagram_post"
      ? { dataset: "instagram_posts", url: instagram.url, handle: null }
      : { dataset: "instagram_profiles", url: instagram.url, handle: instagram.username };
  }
  if (FACEBOOK_HOST.test(host)) {
    const first = segments[0];
    if (!first) return null;
    if (first.toLowerCase() === "profile.php") {
      const id = url.searchParams.get("id");
      return id && /^\d{5,25}$/.test(id) ? { dataset: "facebook_pages", url: `https://www.facebook.com/profile.php?id=${id}`, handle: null } : null;
    }
    if (first.toLowerCase() === "p") {
      const page = segments[1];
      return page && segments.length === 2 && FACEBOOK_P_PAGE.test(page) ? { dataset: "facebook_pages", url: `https://www.facebook.com/p/${page}/`, handle: null } : null;
    }
    if (FACEBOOK_RESERVED.has(first.toLowerCase()) || !FACEBOOK_NAME.test(first)) return null;
    if (segments[1]?.toLowerCase() === "posts" && segments[2] && /^[A-Za-z0-9]{5,60}$/.test(segments[2])) {
      return { dataset: "facebook_posts", url: `https://www.facebook.com/${first}/posts/${segments[2]}`, handle: first };
    }
    if (segments.length === 1 || (segments.length === 2 && ["about", "about_contact_and_basic_info"].includes(segments[1]!.toLowerCase()))) {
      return { dataset: "facebook_pages", url: `https://www.facebook.com/${first}`, handle: first };
    }
    return null;
  }
  return null;
}

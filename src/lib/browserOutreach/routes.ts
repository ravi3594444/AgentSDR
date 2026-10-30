/**
 * A person's browser contact route: their own profile on a site where the
 * owner, signed in in their connected Chrome, can message them directly
 * (X, Instagram, Facebook, LinkedIn). Pure and client-safe.
 *
 * A route is only an address until it is verified in the owner's browser:
 * the profile opened there, signed in as the owner, offered a way to message
 * that person (browserOutreach/verify). Its state is recorded per person and
 * site (browser_contact_routes), and only a verified or not-yet-checked
 * route goes into a plan; one found unable to receive a message is a
 * blocker said plainly, never a send.
 */

import { parsePhoneNumberFromString } from "libphonenumber-js";

export const MESSAGING_SITES = ["x", "instagram", "facebook", "linkedin"] as const;
export type MessagingSite = (typeof MESSAGING_SITES)[number];

export const MESSAGING_SITE_NAMES: Record<MessagingSite, string> = { x: "X", instagram: "Instagram", facebook: "Facebook", linkedin: "LinkedIn" };

export function isMessagingSite(value: unknown): value is MessagingSite {
  return typeof value === "string" && (MESSAGING_SITES as readonly string[]).includes(value);
}

export type ProfileRoute = { site: MessagingSite; handle: string; profileUrl: string };

/** Path segments that are a site's own pages, never a person's profile. */
const RESERVED: Record<MessagingSite, ReadonlySet<string>> = {
  x: new Set(["home", "explore", "search", "i", "messages", "settings", "notifications", "compose", "intent", "hashtag", "login", "logout", "signup", "tos", "privacy", "share", "lists"]),
  instagram: new Set(["p", "reel", "reels", "explore", "accounts", "direct", "stories", "tv", "about", "legal", "developer", "web"]),
  facebook: new Set(["groups", "events", "watch", "marketplace", "messages", "settings", "hashtag", "share", "sharer", "story.php", "login", "photo", "photos", "reel", "gaming", "help", "policies", "search", "notifications", "friends", "bookmarks", "pages"]),
  linkedin: new Set([]),
};

/** A person's profile on a messaging site, from its address; null for anything else (a post, a search, a company page). */
export function profileRoute(raw: string): ProfileRoute | null {
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(?:www\.|m\.|mobile\.)/, "");
  const parts = url.pathname.split("/").filter(Boolean);
  const first = parts[0] ?? "";
  if (host === "x.com" || host === "twitter.com") {
    if (!/^[A-Za-z0-9_]{1,15}$/.test(first) || RESERVED.x.has(first.toLowerCase()) || parts.length > 1) return null;
    return { site: "x", handle: first.toLowerCase(), profileUrl: `https://x.com/${first}` };
  }
  if (host === "instagram.com") {
    if (!/^[A-Za-z0-9._]{1,30}$/.test(first) || RESERVED.instagram.has(first.toLowerCase()) || parts.length > 1) return null;
    return { site: "instagram", handle: first.toLowerCase(), profileUrl: `https://www.instagram.com/${first.toLowerCase()}/` };
  }
  if (host === "facebook.com" || host === "fb.com") {
    if (first === "profile.php") {
      const id = url.searchParams.get("id");
      return id && /^\d{3,30}$/.test(id) ? { site: "facebook", handle: id, profileUrl: `https://www.facebook.com/profile.php?id=${id}` } : null;
    }
    if (!/^[A-Za-z0-9.]{3,80}$/.test(first) || RESERVED.facebook.has(first.toLowerCase()) || parts.length > 1) return null;
    return { site: "facebook", handle: first.toLowerCase(), profileUrl: `https://www.facebook.com/${first}` };
  }
  if (host === "linkedin.com" && first === "in" && parts[1] && /^[A-Za-z0-9\-_%]{2,100}$/.test(parts[1])) {
    return { site: "linkedin", handle: decodeURIComponent(parts[1]).toLowerCase(), profileUrl: `https://www.linkedin.com/in/${parts[1]}/` };
  }
  return null;
}

/** A recipient as the model names it: an email address, a profile address, "@handle on site", or a name. */
export type RecipientRef = { email: string | null; route: ProfileRoute | null; name: string; phone?: string };

export function looksLikePhoneRecipient(raw: string): boolean {
  return /^\+?[\d\s().-]+$/.test(raw.trim()) && raw.replace(/\D/g, "").length >= 7;
}

/** No default country, truncation or guessing: the requested international destination must be valid. */
export function recipientPhone(raw: string): string | null {
  if (!looksLikePhoneRecipient(raw)) return null;
  const digits = raw.trim().startsWith("+") ? raw.replace(/\D/g, "") : raw.replace(/\D/g, "").replace(/^00/, "");
  const phone = parsePhoneNumberFromString(`+${digits}`);
  return phone?.isValid() ? phone.number : null;
}

const SITE_WORDS: Record<string, MessagingSite> = { x: "x", twitter: "x", instagram: "instagram", ig: "instagram", facebook: "facebook", fb: "facebook", linkedin: "linkedin" };
const SITE_PROFILE: Record<MessagingSite, (handle: string) => string> = {
  x: (handle) => `https://x.com/${handle}`,
  instagram: (handle) => `https://www.instagram.com/${handle}/`,
  facebook: (handle) => `https://www.facebook.com/${handle}`,
  linkedin: (handle) => `https://www.linkedin.com/in/${handle}/`,
};

export function recipientRef(raw: string): RecipientRef {
  const text = raw.trim().slice(0, 300);
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text.toLowerCase() : null;
  if (email) return { email, route: null, name: text };
  const phone = recipientPhone(text);
  if (phone) return { email: null, route: null, name: text, phone };
  const said = /^@?([A-Za-z0-9_.-]{2,80})\s+(?:on|at)\s+(x|twitter|instagram|ig|facebook|fb|linkedin)\b/i.exec(text);
  const route = profileRoute(text) ?? (said ? profileRoute(SITE_PROFILE[SITE_WORDS[said[2]!.toLowerCase()]!](said[1]!)) : null);
  return { email: null, route, name: text };
}

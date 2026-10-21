/**
 * Old addresses and where they open now. Bookmarks, notification emails and
 * links in older chats still point at the pages the navigation rework
 * folded together (docs/plans/NAVIGATION_REWORK_2026-10-20.md), so each one
 * redirects with its ids and filters intact.
 *
 * `next.config.ts` serves this table as its `redirects()`. Next passes the
 * request's query string on and lets the destination's own query win for a
 * key both name, which is how `?view=replies&channel=whatsapp` becomes
 * `?view=all&channel=whatsapp`. Rules are tried in order and the first match
 * wins, so a rule with a `has` condition sits above the plain one for the
 * same path. Deliberately not permanent: a 308 is cached by the browser
 * indefinitely, which would be painful to undo.
 *
 * Kept free of imports so next.config.ts can load it.
 */

export type LegacyRedirect = {
  source: string;
  destination: string;
  permanent: false;
  has?: { type: "query"; key: string; value?: string }[];
};

const to = (source: string, destination: string, has?: LegacyRedirect["has"]): LegacyRedirect => ({ source, destination, permanent: false, ...(has ? { has } : {}) });

export const LEGACY_REDIRECTS: LegacyRedirect[] = [
  // Action required and its Needs you / All replies views are the Inbox's two views.
  to("/crm/actions", "/inbox?view=all", [{ type: "query", key: "view", value: "replies" }]),
  to("/crm/actions", "/inbox?view=needs_you"),
  // Activity's Replies tab is the Inbox's All conversations; its work list is Outreach's Requests.
  to("/activity", "/inbox?view=all", [{ type: "query", key: "view", value: "replies" }]),
  to("/activity", "/assistant/requests"),
  // The pipeline board lives inside Leads.
  to("/crm/pipeline", "/leads?view=board"),
  // Analytics is Reports' By channel section, with the same ?view, ?range and ?tz.
  // (Overview, /assistant/results, is a page that reads its #needs-you fragment.)
  to("/analytics", "/assistant/reports"),

  // Section overviews retired earlier; once page redirects, which dropped the query.
  to("/crm", "/assistant/reports"),
  to("/calling", "/assistant/reports?view=whatsapp"),
  to("/linkedin", "/assistant/reports?view=linkedin"),
  // Instagram's one page; ?chat= opens that conversation.
  to("/instagram", "/instagram/messages"),
  // The retired LinkedIn-only lead directory.
  to("/linkedin/leads", "/leads"),
];

/**
 * Where `url` (a path with an optional query) is redirected, the way Next
 * applies LEGACY_REDIRECTS: the first rule whose path and `has` conditions
 * match, the request's query merged under the destination's. Null when no
 * rule matches. Used by the tests and by `withQuery` callers to check a link
 * before printing it.
 */
export function resolveLegacyRoute(url: string, rules: readonly LegacyRedirect[] = LEGACY_REDIRECTS): string | null {
  const parsed = new URL(url, "http://local");
  const path = parsed.pathname.replace(/\/+$/, "") || "/";
  const query = Object.fromEntries(parsed.searchParams);
  for (const rule of rules) {
    if (rule.source !== path) continue;
    const matches = (rule.has ?? []).every((condition) => {
      const value = query[condition.key];
      return value !== undefined && (condition.value === undefined || new RegExp(`^${condition.value}$`).test(value));
    });
    if (!matches) continue;
    const destination = new URL(rule.destination, "http://local");
    const merged = new URLSearchParams({ ...query, ...Object.fromEntries(destination.searchParams) });
    const search = merged.toString();
    return `${destination.pathname}${search ? `?${search}` : ""}${parsed.hash}`;
  }
  return null;
}

/** `path` with `searchParams` appended (the page-level redirect()s that must not drop a query). */
export function withQuery(path: string, searchParams: Record<string, string | string[] | undefined> | URLSearchParams): string {
  const params = new URLSearchParams();
  const entries = searchParams instanceof URLSearchParams ? [...searchParams.entries()] : Object.entries(searchParams);
  for (const [key, value] of entries) {
    for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) params.append(key, one);
  }
  const search = params.toString();
  if (!search) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${search}`;
}

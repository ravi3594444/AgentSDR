import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { people } from "@/lib/leads/schema";
import { instagramUsername } from "@/lib/instagram/parse";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { profileRoute, type MessagingSite, type ProfileRoute } from "./routes";
import { browserContactRoutes, type RouteState } from "./schema";

/**
 * Where each person can be messaged through the owner's browser: the
 * profiles recorded for them (browser_contact_routes) and the ones their
 * lead already holds (a LinkedIn profile, an Instagram username). A route
 * the browser found unable to take a message (not_messageable, not_found)
 * is left out; one not yet checked is in, and is checked when it is used.
 */

let ready: { exists: boolean; checkedAt: number } | null = null;
/** Whether scripts/add-browser-outreach.ts has run: before it, nobody has a browser route. */
export async function browserOutreachReady(): Promise<boolean> {
  if (ready && (ready.exists || Date.now() - ready.checkedAt < 60_000)) return ready.exists;
  const [row] = await db.execute<{ ready: boolean }>(sql`select to_regclass('public.browser_outreach_sends') is not null as ready`);
  ready = { exists: Boolean(row?.ready), checkedAt: Date.now() };
  return ready.exists;
}

export type BrowserRoute = ProfileRoute & { id: string | null; state: RouteState; detail: string | null };

const UNUSABLE: ReadonlySet<RouteState> = new Set(["not_messageable", "not_found"]);

/** The usable routes per person, recorded ones first (checked ones before unchecked), then those their lead holds. */
export async function browserRoutesFor(personIds: readonly string[]): Promise<Map<string, BrowserRoute[]>> {
  const out = new Map<string, BrowserRoute[]>();
  if (!personIds.length || !(await browserOutreachReady())) return out;
  const ids = [...new Set(personIds)];
  const recorded = await db.select().from(browserContactRoutes)
    .where(and(inOrg(browserContactRoutes), inArray(browserContactRoutes.personId, ids)));
  const rows = await db.select({ id: people.id, linkedinUrl: people.linkedinUrl, raw: people.raw })
    .from(people).where(and(inOrg(people), inArray(people.id, ids)));
  const known = new Set(recorded.map((route) => `${route.site}:${route.handle}`));
  for (const route of recorded.sort((a, b) => Number(b.state === "messageable") - Number(a.state === "messageable"))) {
    if (UNUSABLE.has(route.state)) continue;
    const list = out.get(route.personId) ?? [];
    list.push({ id: route.id, site: route.site, handle: route.handle, profileUrl: route.profileUrl, state: route.state, detail: route.detail });
    out.set(route.personId, list);
  }
  for (const row of rows) {
    const held: ProfileRoute[] = [];
    if (row.linkedinUrl) {
      const route = profileRoute(/^https?:/i.test(row.linkedinUrl) ? row.linkedinUrl : `https://www.linkedin.com/in/${row.linkedinUrl.replace(/^.*\/in\//, "")}`);
      if (route) held.push(route);
    }
    const instagram = instagramUsername((row.raw?.instagram as { username?: unknown } | undefined)?.username);
    if (instagram) {
      const route = profileRoute(`https://www.instagram.com/${instagram}/`);
      if (route) held.push(route);
    }
    for (const route of held) {
      // A recorded route for the same profile decides (a bad one stays out).
      if (known.has(`${route.site}:${route.handle}`)) continue;
      const list = out.get(row.id) ?? [];
      list.push({ ...route, id: null, state: "unverified", detail: null });
      out.set(row.id, list);
    }
  }
  return out;
}

/** The sites each person can be messaged on through the browser. */
export async function browserSitesFor(personIds: readonly string[]): Promise<Map<string, MessagingSite[]>> {
  const routes = await browserRoutesFor(personIds);
  return new Map([...routes.entries()].map(([personId, list]) => [personId, [...new Set(list.map((route) => route.site))]]));
}

/**
 * Records `route` as `personId`'s, once. A profile already recorded for
 * someone else in this workspace stays theirs: null, and nothing changes.
 */
export async function recordRoute(personId: string, route: ProfileRoute, sourceUrl: string | null): Promise<typeof browserContactRoutes.$inferSelect | null> {
  const [inserted] = await db.insert(browserContactRoutes).values({
    organizationId: currentOrganizationId(), personId, site: route.site, handle: route.handle, profileUrl: route.profileUrl, sourceUrl,
  }).onConflictDoNothing({ target: [browserContactRoutes.organizationId, browserContactRoutes.site, browserContactRoutes.handle] }).returning();
  if (inserted) return inserted;
  const [existing] = await db.select().from(browserContactRoutes)
    .where(and(inOrg(browserContactRoutes), eq(browserContactRoutes.site, route.site), eq(browserContactRoutes.handle, route.handle))).limit(1);
  return existing && existing.personId === personId ? existing : null;
}

/** What the owner's browser found on a route's profile: it can take a message, or why not. */
export async function setRouteState(routeId: string, state: RouteState, detail: string | null): Promise<void> {
  await db.update(browserContactRoutes).set({ state, detail: detail?.slice(0, 300) ?? null, checkedAt: new Date(), updatedAt: new Date() })
    .where(and(inOrg(browserContactRoutes), eq(browserContactRoutes.id, routeId)));
}

/** The person a recorded profile belongs to, if any. */
export async function personOfRoute(site: MessagingSite, handle: string): Promise<string | null> {
  if (!(await browserOutreachReady())) return null;
  const [row] = await db.select({ personId: browserContactRoutes.personId }).from(browserContactRoutes)
    .where(and(inOrg(browserContactRoutes), eq(browserContactRoutes.site, site), eq(browserContactRoutes.handle, handle))).limit(1);
  return row?.personId ?? null;
}

/**
 * A lead known only by their profile on X, Instagram, Facebook or LinkedIn
 * (add_contacts with profileUrl): the person the profile is already
 * recorded for, or a new person with it as their browser route. An
 * Instagram profile also becomes the lead's Instagram username, and a
 * LinkedIn one their LinkedIn profile, so every channel can use them.
 */
export async function saveProfileContact(input: { route: ProfileRoute; name: string | null; company: string | null; sourceUrl: string | null }): Promise<{ personId: string; created: boolean } | null> {
  const existing = await personOfRoute(input.route.site, input.route.handle);
  if (existing) return { personId: existing, created: false };
  const raw: Record<string, unknown> = { addedVia: "assistant chat", profiles: { [input.route.site]: input.route.profileUrl } };
  if (input.company) raw.businessName = input.company;
  if (input.route.site === "instagram") raw.instagram = { username: input.route.handle };
  const [person] = await db.insert(people).values({
    organizationId: currentOrganizationId(),
    fullName: input.name?.slice(0, 200) ?? null,
    linkedinUrl: input.route.site === "linkedin" ? input.route.handle : null,
    source: "assistant-chat",
    raw,
  }).onConflictDoNothing().returning({ id: people.id });
  if (!person) return null;
  const route = await recordRoute(person.id, input.route, input.sourceUrl);
  return route ? { personId: person.id, created: true } : null;
}

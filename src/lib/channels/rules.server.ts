import "server-only";

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import type { WeeklyHours } from "@/lib/outreach/workingHours";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { mergeStoredRules, resolveValues, rulesOf, validateValues, type Channel, type ChannelRuleValues } from "./rules";
import { channelSettings } from "./schema";

/**
 * The organization's sending rules, resolved over the defaults. The engines
 * call this on hot paths (every send, every run), so reads are cached per
 * (organization, channel) for CACHE_TTL_MS; saving clears this process's
 * entry, and other instances see the change within the TTL.
 */
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { values: Record<string, unknown>; expires: number }>();

function cacheKey(channel: Channel): string {
  return `${currentOrganizationId()}:${channel}`;
}

async function stored(channel: Channel): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ values: channelSettings.values })
    .from(channelSettings)
    .where(and(inOrg(channelSettings), eq(channelSettings.channel, channel)))
    .limit(1);
  return row?.values ?? {};
}

/**
 * Sending hours were removed: sending is always on. The delivery diagnostics
 * (src/lib/assistant/deliveryDiagnostics.server.ts) still read the retired
 * keys until they are rewritten, so the resolved values carry them as null,
 * "any time". Nothing stores or accepts them (RETIRED_RULE_KEYS); delete this
 * once no reader is left.
 */
const RETIRED_HOURS: { [C in Channel]: RetiredHours<C> } = { email: {}, linkedin: { workingHours: null }, whatsapp: { sendingHours: null }, instagram: { sendingHours: null }, general: {} };
type RetiredHours<C extends Channel> = C extends "linkedin" ? { workingHours: WeeklyHours | null }
  : C extends "whatsapp" | "instagram" ? { sendingHours: WeeklyHours | null }
  : Record<never, never>;

/** Resolved rules for one channel, in the organization in scope. */
export async function channelRules<C extends Channel>(channel: C): Promise<ChannelRuleValues<C> & RetiredHours<C>> {
  const key = cacheKey(channel);
  const hit = cache.get(key);
  let values = hit && hit.expires > Date.now() ? hit.values : null;
  if (!values) {
    values = await stored(channel);
    cache.set(key, { values, expires: Date.now() + CACHE_TTL_MS });
  }
  return { ...resolveValues(channel, values), ...RETIRED_HOURS[channel] } as ChannelRuleValues<C> & RetiredHours<C>;
}

/** What the settings page shows: every value, and which ones differ from the default. */
export async function channelRulesForSettings(channel: Channel): Promise<{ values: Record<string, unknown>; customized: string[] }> {
  const raw = await stored(channel);
  const values = resolveValues(channel, raw) as Record<string, unknown>;
  const customized = rulesOf(channel)
    .filter((rule) => raw[rule.key] !== undefined && JSON.stringify(raw[rule.key]) === JSON.stringify(values[rule.key]))
    .map((rule) => rule.key);
  return { values, customized };
}

/**
 * Save a channel's rules. Values equal to their default are not stored, so
 * a default improved later reaches every organization that never changed it.
 */
export async function saveChannelRules(channel: Channel, input: Record<string, unknown>, userId: string | null) {
  const result = validateValues(channel, input);
  if (!result.ok) throw new Error(result.error);

  // Only the submitted rules change: a page showing part of a channel's rules leaves the rest as stored.
  const next = mergeStoredRules(channel, await stored(channel), result.values);

  await db
    .insert(channelSettings)
    .values({ organizationId: currentOrganizationId(), channel, values: next, updatedBy: userId, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [channelSettings.organizationId, channelSettings.channel],
      set: { values: next, updatedBy: userId, updatedAt: new Date() },
    });
  cache.delete(cacheKey(channel));
  return channelRulesForSettings(channel);
}

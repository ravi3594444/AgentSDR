import "server-only";

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
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

/** Resolved rules for one channel, in the organization in scope. Sending hours were removed: no channel has them. */
export async function channelRules<C extends Channel>(channel: C): Promise<ChannelRuleValues<C>> {
  const key = cacheKey(channel);
  const hit = cache.get(key);
  let values = hit && hit.expires > Date.now() ? hit.values : null;
  if (!values) {
    values = await stored(channel);
    cache.set(key, { values, expires: Date.now() + CACHE_TTL_MS });
  }
  return resolveValues(channel, values);
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

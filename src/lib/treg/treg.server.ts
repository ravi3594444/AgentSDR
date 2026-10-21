import "server-only";

import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { featureEnabled, isMissingTable } from "@/lib/features/flags.server";
import { decryptIntegrationCredential, encryptIntegrationCredential } from "@/lib/integrations/credentials";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { callTreg, getTregEndpoint, searchTregCatalog, TregError, verifyTregKey } from "@/services/treg";
import { callCeilingUsd, callProblem, isCatalogId, minimumCostUsd, parseEndpoint, parseSearch, TREG_LIMITS, type TregEndpoint, type TregSettingsView } from "./catalog";
import { tregCalls, tregSettings } from "./schema";
import type { SpendGuard } from "@/lib/assistant/objective.server";

/**
 * The organization's Treg key and its calls. A paid call is recorded in
 * treg_calls before Treg is called (status "calling", its ceiling counted
 * as reserved), under the organization's advisory lock, so two calls
 * cannot both take the last of the day's cap; the ceiling also goes to
 * Treg as `X-Treg-Route-Max-Cost`, so Treg refuses anything above it. The
 * day is the last 24 hours. Nothing here tops up or changes the Treg
 * account.
 */

export class TregSettingsError extends Error {}

const DAY_MS = 24 * 60 * 60 * 1000;

type SettingsRow = typeof tregSettings.$inferSelect;

async function settingsRow(): Promise<SettingsRow | null> {
  try {
    const [row] = await db.select().from(tregSettings).where(inOrg(tregSettings)).limit(1);
    return row ?? null;
  } catch (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
}

/** Spend in the last 24 hours: what Treg reported for finished calls, and the ceilings of calls still open. */
async function daySpendUsd(executor: Pick<typeof db, "select"> = db): Promise<number> {
  try {
    const [row] = await executor.select({
      spent: sql<number>`coalesce(sum(case when ${tregCalls.status} = 'calling' then ${tregCalls.ceilingUsd} else coalesce(${tregCalls.costUsd}, 0) end), 0)::float8`,
    }).from(tregCalls).where(and(inOrg(tregCalls), gte(tregCalls.createdAt, new Date(Date.now() - DAY_MS))));
    return Number(row?.spent ?? 0);
  } catch (error) {
    if (isMissingTable(error)) return 0;
    throw error;
  }
}

export async function tregSettingsView(): Promise<TregSettingsView> {
  const row = await settingsRow();
  return {
    connected: Boolean(row?.encryptedKey),
    keyHint: row?.keyHint ?? null,
    team: row?.team ?? null,
    dailyCapUsd: row?.dailyCapUsd ?? TREG_LIMITS.defaultDailyCapUsd,
    spentTodayUsd: Math.round((await daySpendUsd()) * 10_000) / 10_000,
  };
}

/** Saves the key and the daily cap. A new key is checked with Treg first; an empty key disconnects. */
export async function saveTregSettings(input: { key?: unknown; dailyCapUsd?: unknown }, userId: string | null): Promise<TregSettingsView> {
  const current = await settingsRow();
  let dailyCapUsd = current?.dailyCapUsd ?? TREG_LIMITS.defaultDailyCapUsd;
  if (input.dailyCapUsd !== undefined) {
    const cap = Number(input.dailyCapUsd);
    if (!Number.isFinite(cap) || cap < 0 || cap > TREG_LIMITS.maxDailyCapUsd) throw new TregSettingsError(`The daily spend cap must be between $0 and $${TREG_LIMITS.maxDailyCapUsd}`);
    dailyCapUsd = Math.round(cap * 10_000) / 10_000;
  }
  let encryptedKey = current?.encryptedKey ?? null;
  let keyHint = current?.keyHint ?? null;
  let team = current?.team ?? null;
  if (typeof input.key === "string") {
    const key = input.key.trim();
    if (!key) {
      encryptedKey = null;
      keyHint = null;
      team = null;
    } else {
      if (key.length > 500 || /\s/.test(key)) throw new TregSettingsError("That does not look like a Treg key.");
      try {
        team = (await verifyTregKey(key)).team;
      } catch (error) {
        throw new TregSettingsError(error instanceof TregError && (error.status === 401 || error.status === 403) ? "Treg rejected this key." : `The key could not be checked: ${error instanceof Error ? error.message : String(error)}`);
      }
      encryptedKey = encryptIntegrationCredential(key);
      keyHint = `…${key.slice(-4)}`;
    }
  }
  const values = { encryptedKey, keyHint, team, dailyCapUsd, updatedBy: userId, updatedAt: new Date() };
  await db.insert(tregSettings).values({ organizationId: currentOrganizationId(), ...values })
    .onConflictDoUpdate({ target: tregSettings.organizationId, set: values });
  return tregSettingsView();
}

/** Treg cannot be used now, and why (said to the owner as is). */
export class TregUnavailableError extends Error {}

async function readyKey(): Promise<{ key: string; dailyCapUsd: number }> {
  if (!(await featureEnabled("treg"))) throw new TregUnavailableError("Treg tools are off for this organization; an owner or admin can turn them on in Settings → Providers & features.");
  const row = await settingsRow();
  if (!row?.encryptedKey) throw new TregUnavailableError("No Treg key is saved; an owner or admin adds one in Settings → Providers & features → Treg.");
  return { key: decryptIntegrationCredential(row.encryptedKey), dailyCapUsd: row.dailyCapUsd };
}

/** The catalog endpoints that best match a task (Treg's public search; free). */
export async function searchTreg(task: string, limit = 6): Promise<TregEndpoint[]> {
  await readyKey();
  return parseSearch(await searchTregCatalog(task.slice(0, 300), Math.min(10, Math.max(1, limit))), limit);
}

export type TregCallOutcome =
  | { ok: true; endpoint: TregEndpoint; body: unknown; costUsd: number; leftTodayUsd: number }
  | { ok: false; endpoint: TregEndpoint | null; reason: string; costUsd: number };

/** Why Treg refused, in words an owner can act on. */
function refusal(error: TregError, ceilingUsd: number): string {
  if (error.status === 402 && error.code === "route_max_cost") return `it would cost more than the $${ceilingUsd} this call may spend (the rest of today's cap, at most $${TREG_LIMITS.maxUsdPerCall} a call); nothing was charged`;
  if (error.status === 402) return `the Treg balance is too low; top it up in Treg (Team → Billing) — AgentSDR never tops it up. Nothing was charged`;
  if (error.status === 401 || error.status === 403) return "Treg rejected the saved key; an owner or admin saves a new one in Settings → Providers & features → Treg";
  if (error.status === 429) return `Treg is busy or a free allowance is used up (${error.message}); try again later`;
  return `${error.message}${error.status ? ` (HTTP ${error.status})` : ""}`;
}

/**
 * One paid call to a catalog endpoint. Its price and method come from
 * Treg's own catalog page, never from the caller; it is refused without a
 * published price, above the per-call limit, or past the day's cap.
 */
export async function callTregEndpoint(input: {
  endpointId: unknown;
  query: Record<string, string | string[]>;
  body: Record<string, unknown> | null;
  threadId: string | null;
  /** The owner's request the call serves (kept on the call, so the request's spend counts it). */
  requestId?: string | null;
  /** The request's own spend cap (objective.server.ts), checked under the same lock as the day's cap. */
  spendGuard?: SpendGuard;
}): Promise<TregCallOutcome> {
  if (!isCatalogId(input.endpointId)) return { ok: false, endpoint: null, reason: "endpointId must be a Treg catalog id from treg_search (like treg.people.email.find), never a URL", costUsd: 0 };
  const { key, dailyCapUsd } = await readyKey();
  const endpointId = input.endpointId;
  const endpoint = await getTregEndpoint(endpointId).then(parseEndpoint, (error: unknown) => {
    if (error instanceof TregError && error.status === 404) return null;
    throw error;
  });
  if (!endpoint) return { ok: false, endpoint: null, reason: `${endpointId} is not in Treg's catalog; find one with treg_search`, costUsd: 0 };
  const missing = endpoint.params.filter((param) => param.required && (param.where === "query" ? input.query[param.name] === undefined : input.body?.[param.name] === undefined));
  if (missing.length) return { ok: false, endpoint, reason: `missing required parameter${missing.length === 1 ? "" : "s"}: ${missing.map((param) => `${param.name} (${param.where})`).join(", ")}`, costUsd: 0 };

  const reserved = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`treg-call:${currentOrganizationId()}`}, 0))`);
    const spent = await daySpendUsd(tx);
    const problem = callProblem(endpoint, spent, dailyCapUsd);
    if (problem) return { problem } as const;
    let ceilingUsd = callCeilingUsd(spent, dailyCapUsd);
    if (input.spendGuard) {
      // The request's cap, read again with every open reservation: refused, held, or the ceiling lowered to what it has left.
      const least = minimumCostUsd(endpoint) ?? 0;
      const room = await input.spendGuard(tx, least);
      if (!room.ok) return { problem: room.wait ? `${room.reason}; try again once it has` : room.reason } as const;
      ceilingUsd = Math.floor(Math.min(ceilingUsd, room.maxUsd) * 1_000_000) / 1_000_000;
      if (least > ceilingUsd) return { problem: `this request's spend cap leaves $${ceilingUsd}, less than the $${least} this call costs at least` } as const;
    }
    const [row] = await tx.insert(tregCalls).values({ organizationId: currentOrganizationId(), threadId: input.threadId, requestId: input.requestId ?? null, endpointId: endpoint.id, status: "calling", ceilingUsd }).returning({ id: tregCalls.id });
    return { id: row!.id, ceilingUsd, spent } as const;
  });
  if (reserved.problem !== undefined) return { ok: false, endpoint, reason: reserved.problem, costUsd: 0 };

  const finish = (values: Partial<typeof tregCalls.$inferInsert>) =>
    db.update(tregCalls).set({ ...values, finishedAt: new Date() }).where(and(inOrg(tregCalls), eq(tregCalls.id, reserved.id)));
  let result;
  try {
    result = await callTreg(key, endpoint, { query: input.query, body: endpoint.method === "POST" ? input.body ?? {} : null }, { ceilingUsd: reserved.ceilingUsd, idempotencyKey: reserved.id });
  } catch (error) {
    // The request may have reached Treg: its ceiling stays counted, so the cap never under-counts.
    const message = error instanceof Error ? error.message : String(error);
    await finish({ status: "failed", costUsd: reserved.ceilingUsd, error: message.slice(0, 500) });
    return { ok: false, endpoint, reason: `${message}; up to $${reserved.ceilingUsd} is counted against today's cap in case it was charged`, costUsd: reserved.ceilingUsd };
  }
  // A success without a reported price counts its listed minimum; Treg charges nothing for a refusal or a provider's error.
  const costUsd = result.costUsd ?? (result.ok ? Math.min(reserved.ceilingUsd, minimumCostUsd(endpoint) ?? reserved.ceilingUsd) : 0);
  await finish({ status: result.ok ? "succeeded" : "failed", costUsd, httpStatus: result.httpStatus, tregCallId: result.callId, error: result.error?.message.slice(0, 500) ?? null });
  if (!result.ok) return { ok: false, endpoint, reason: refusal(result.error!, reserved.ceilingUsd), costUsd };
  return { ok: true, endpoint, body: result.body, costUsd, leftTodayUsd: Math.max(0, Math.round((dailyCapUsd - reserved.spent - costUsd) * 10_000) / 10_000) };
}

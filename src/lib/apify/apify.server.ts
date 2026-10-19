import "server-only";

import { and, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { featureEnabled, isMissingTable } from "@/lib/features/flags.server";
import { decryptIntegrationCredential, encryptIntegrationCredential } from "@/lib/integrations/credentials";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import {
  ApifyError,
  getApifyAccountLimits,
  getApifyRun,
  listApifyDatasetItems,
  startApifyRun,
  verifyApifyToken,
  type ApifyRun,
} from "@/services/apify";
import { APIFY_ACTORS, APIFY_LIMITS, isApifyActorKey, type ApifyActorKey, type ApifySettingsView } from "./catalog";
import { apifyAllowance, looksExhausted, runOutcome } from "./mapping";
import { apifyRuns, apifySettings, type ApifyRunRow } from "./schema";
import type { SpendGuard } from "@/lib/assistant/objective.server";

/**
 * The organization's Apify connection and its runs. Every run is recorded
 * in apify_runs before Apify is called (status "starting", its cap counted
 * as reserved), so a crash never loses one and the month's spend is always
 * the sum of what Apify reported plus the caps of runs still open. Starting
 * is serialized per organization (an advisory lock), so two jobs cannot
 * both take the last of a budget.
 */

export class ApifySettingsError extends Error {}

type SettingsRow = typeof apifySettings.$inferSelect;

async function settingsRow(): Promise<SettingsRow | null> {
  try {
    const [row] = await db.select().from(apifySettings).where(inOrg(apifySettings)).limit(1);
    return row ?? null;
  } catch (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
}

function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** This month's spend (UTC): reported usage of finished runs, and the caps of runs still open. */
async function monthUsage(executor: Pick<typeof db, "select"> = db): Promise<{ spentUsd: number; reservedUsd: number; openRuns: number }> {
  const [row] = await executor.select({
    spent: sql<number>`coalesce(sum(case when ${apifyRuns.status} in ('starting', 'running') then 0 else coalesce(${apifyRuns.usageUsd}, 0) end), 0)::float8`,
    reserved: sql<number>`coalesce(sum(case when ${apifyRuns.status} in ('starting', 'running') then ${apifyRuns.maxChargeUsd} else 0 end), 0)::float8`,
    open: sql<number>`count(*) filter (where ${apifyRuns.status} in ('starting', 'running'))::int`,
  }).from(apifyRuns).where(and(inOrg(apifyRuns), gte(apifyRuns.createdAt, monthStart())));
  return { spentUsd: Number(row?.spent ?? 0), reservedUsd: Number(row?.reserved ?? 0), openRuns: Number(row?.open ?? 0) };
}

export async function apifySettingsView(): Promise<ApifySettingsView> {
  const row = await settingsRow();
  const usage = row ? await monthUsage() : { spentUsd: 0, reservedUsd: 0, openRuns: 0 };
  return {
    connected: Boolean(row?.encryptedToken),
    tokenHint: row?.tokenHint ?? null,
    approvedActors: (row?.approvedActors ?? []).filter(isApifyActorKey),
    monthlyBudgetUsd: row?.monthlyBudgetUsd ?? APIFY_LIMITS.monthlyBudgetUsd.default,
    maxChargePerRunUsd: row?.maxChargePerRunUsd ?? APIFY_LIMITS.maxChargePerRunUsd.default,
    maxResultsPerRun: row?.maxResultsPerRun ?? APIFY_LIMITS.maxResultsPerRun.default,
    spentThisMonthUsd: Math.round(usage.spentUsd * 10_000) / 10_000,
    reservedUsd: Math.round(usage.reservedUsd * 10_000) / 10_000,
  };
}

function bounded(value: unknown, limit: { min: number; max: number }, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < limit.min || number > limit.max) throw new ApifySettingsError(`${label} must be between ${limit.min} and ${limit.max}`);
  return number;
}

/** Saves the connection. A new token is checked with Apify first; an empty token disconnects. */
export async function saveApifySettings(
  input: { token?: unknown; approvedActors?: unknown; monthlyBudgetUsd?: unknown; maxChargePerRunUsd?: unknown; maxResultsPerRun?: unknown },
  userId: string | null,
): Promise<ApifySettingsView> {
  const current = await settingsRow();
  const approved = Array.isArray(input.approvedActors) ? [...new Set(input.approvedActors.filter(isApifyActorKey))] : (current?.approvedActors ?? []).filter(isApifyActorKey);
  const monthlyBudgetUsd = input.monthlyBudgetUsd === undefined ? current?.monthlyBudgetUsd ?? APIFY_LIMITS.monthlyBudgetUsd.default : bounded(input.monthlyBudgetUsd, APIFY_LIMITS.monthlyBudgetUsd, "The monthly budget (USD)");
  const maxChargePerRunUsd = input.maxChargePerRunUsd === undefined ? current?.maxChargePerRunUsd ?? APIFY_LIMITS.maxChargePerRunUsd.default : bounded(input.maxChargePerRunUsd, APIFY_LIMITS.maxChargePerRunUsd, "The most one run may spend (USD)");
  const maxResultsPerRun = Math.round(input.maxResultsPerRun === undefined ? current?.maxResultsPerRun ?? APIFY_LIMITS.maxResultsPerRun.default : bounded(input.maxResultsPerRun, APIFY_LIMITS.maxResultsPerRun, "The most results per run"));
  let encryptedToken = current?.encryptedToken ?? null;
  let tokenHint = current?.tokenHint ?? null;
  if (typeof input.token === "string") {
    const token = input.token.trim();
    if (!token) {
      encryptedToken = null;
      tokenHint = null;
    } else {
      try {
        await verifyApifyToken(token);
      } catch (error) {
        throw new ApifySettingsError(error instanceof ApifyError && (error.status === 401 || error.status === 403) ? "Apify rejected this token." : `The token could not be checked: ${error instanceof Error ? error.message : String(error)}`);
      }
      encryptedToken = encryptIntegrationCredential(token);
      tokenHint = `…${token.slice(-4)}`;
    }
  }
  const values = { encryptedToken, tokenHint, approvedActors: approved, monthlyBudgetUsd, maxChargePerRunUsd, maxResultsPerRun, updatedBy: userId, updatedAt: new Date() };
  await db.insert(apifySettings).values({ organizationId: currentOrganizationId(), ...values })
    .onConflictDoUpdate({ target: apifySettings.organizationId, set: values });
  return apifySettingsView();
}

type AccountLimits = { maxMonthlyUsageUsd: number | null; monthlyUsageUsd: number | null };

export type ApifyReadiness =
  | { usable: true; token: string; maxChargeUsd: number; maxItems: number; settings: SettingsRow; account: AccountLimits }
  | { usable: false; exhausted: boolean; slotsFull?: boolean; reason: string };

/**
 * Whether `actor` may run now, and within what: the feature on, a token,
 * the Actor approved, and allowance left (the owner's monthly budget here
 * and the Apify account's own limit, read live). Writes nothing but the
 * closing of stale runs (sweepStaleRuns), which would otherwise hold a slot.
 */
export async function apifyReadiness(actor: ApifyActorKey, wantedItems: number): Promise<ApifyReadiness> {
  if (!(await featureEnabled("apify_discovery"))) return { usable: false, exhausted: false, reason: "Apify discovery is off for this organization" };
  const row = await settingsRow();
  if (!row?.encryptedToken) return { usable: false, exhausted: false, reason: "no Apify token is saved" };
  if (!row.approvedActors.includes(actor)) return { usable: false, exhausted: false, reason: `the ${APIFY_ACTORS[actor].label} is not approved in Settings → Organization → Apify` };
  const token = decryptIntegrationCredential(row.encryptedToken);
  await sweepStaleRuns();
  const usage = await monthUsage();
  let account: AccountLimits | null = null;
  try {
    account = await getApifyAccountLimits(token);
  } catch (error) {
    if (error instanceof ApifyError && looksExhausted({ httpStatus: error.status, type: error.type, message: error.message })) {
      return { usable: false, exhausted: true, reason: `Apify refused: ${error.message}` };
    }
    account = null;
  }
  const allowance = apifyAllowance({
    monthlyBudgetUsd: row.monthlyBudgetUsd,
    maxChargePerRunUsd: row.maxChargePerRunUsd,
    spentThisMonthUsd: usage.spentUsd,
    reservedUsd: usage.reservedUsd,
    openRuns: usage.openRuns,
    account,
  });
  if (!allowance.ok) return { usable: false, exhausted: allowance.exhausted, slotsFull: allowance.slotsFull, reason: allowance.reason };
  return { usable: true, token, maxChargeUsd: allowance.maxChargeUsd, maxItems: Math.max(1, Math.min(wantedItems, row.maxResultsPerRun)), settings: row, account: account! };
}

/** The token of the organization's saved connection (for polling a run already started). */
async function savedToken(): Promise<string | null> {
  const row = await settingsRow();
  return row?.encryptedToken ? decryptIntegrationCredential(row.encryptedToken) : null;
}

/** `budget`: the request's own spend cap refused it (objective.server.ts), so no other paid provider should take it either. */
export type StartedRun = { started: true; row: ApifyRunRow } | { started: false; exhausted: boolean; slotsFull?: boolean; budget?: boolean; reason: string };

/**
 * Runs nothing polls any more hold a run slot and their reserved cap until
 * the month ends. A run still "starting" ten minutes on (the process died
 * between reserving and calling Apify) or "running" well past Apify's own
 * timeout is closed as failed, its reserved cap kept as spent: it may have
 * run and been charged, so it is never refunded to the budget.
 */
export async function sweepStaleRuns(): Promise<number> {
  const runningCutoff = new Date(Date.now() - (APIFY_LIMITS.runTimeoutSeconds + 15 * 60) * 1_000);
  const startingCutoff = new Date(Date.now() - 10 * 60_000);
  const swept = await db.update(apifyRuns)
    .set({ status: "failed", error: "No longer tracked: the job that started it stopped polling; its reserved cap stays counted.", finishedAt: new Date(), usageUsd: sql`coalesce(${apifyRuns.usageUsd}, ${apifyRuns.maxChargeUsd})` })
    .where(and(inOrg(apifyRuns), or(
      and(eq(apifyRuns.status, "starting"), lt(apifyRuns.createdAt, startingCutoff)),
      and(eq(apifyRuns.status, "running"), lt(apifyRuns.createdAt, runningCutoff)),
    )))
    .returning({ id: apifyRuns.id });
  return swept.length;
}

/** The run a job already started for `actor` and is still open, so a retried step polls it instead of paying for another. */
export async function openRunForJob(jobId: string, actor: ApifyActorKey): Promise<ApifyRunRow | null> {
  const [row] = await db.select().from(apifyRuns)
    .where(and(inOrg(apifyRuns), eq(apifyRuns.jobId, jobId), eq(apifyRuns.actorKey, actor), inArray(apifyRuns.status, ["starting", "running"])))
    .limit(1);
  return row ?? null;
}

/**
 * Starts one run under the organization's lock: readiness checked again, the
 * row reserved, then Apify called. A refusal (credits, limits, a rejected
 * token) leaves the row "refused" with the reason.
 */
export async function startTrackedRun(input: {
  actor: ApifyActorKey;
  /** The Actor's input, given the most items this run may produce. */
  input: (maxItems: number) => Record<string, unknown>;
  wantedItems: number;
  jobId: string | null;
  /** The owner's request the job serves (kept on the run). */
  requestId: string | null;
  /**
   * The request's own spend cap (objective.server.ts), checked under the
   * same lock as the organization's budget: it may refuse the run, hold it
   * while the request's other paid work settles, or lower the run's cap to
   * what the request has left.
   */
  spendGuard?: SpendGuard;
}): Promise<StartedRun> {
  // A retried step finds the run its first attempt started rather than paying for a second.
  if (input.jobId) {
    const open = await openRunForJob(input.jobId, input.actor);
    if (open?.status === "running") return { started: true, row: open };
    // Reserved, then the answer was lost (the process stopped while starting it): Apify may have started it.
    // It is never started a second time; its reserved cap stays counted until it is swept as spent.
    if (open?.status === "starting") {
      return { started: false, exhausted: false, reason: "an earlier attempt to start this Apify run lost its answer, so it may have run; it is not started again, and its reserved cap stays counted" };
    }
  }
  // The account's allowance is read first (a network call, outside any transaction)…
  const readiness = await apifyReadiness(input.actor, input.wantedItems);
  if (!readiness.usable) return { started: false, exhausted: readiness.exhausted, slotsFull: readiness.slotsFull, reason: readiness.reason };
  const reserved = await db.transaction(async (tx) => {
    // …then the owner's budget is checked again and the run reserved under the organization's lock.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`apify-start:${currentOrganizationId()}`}, 0))`);
    const usage = await monthUsage(tx);
    const allowance = apifyAllowance({
      monthlyBudgetUsd: readiness.settings.monthlyBudgetUsd,
      maxChargePerRunUsd: readiness.settings.maxChargePerRunUsd,
      spentThisMonthUsd: usage.spentUsd,
      reservedUsd: usage.reservedUsd,
      openRuns: usage.openRuns,
      account: readiness.account,
    });
    if (!allowance.ok) return { usable: false as const, exhausted: allowance.exhausted, slotsFull: allowance.slotsFull, reason: allowance.reason };
    // The request's cap, read again with every open reservation, after the organization's lock.
    const room = input.spendGuard ? await input.spendGuard(tx, 0.01) : null;
    if (room && !room.ok) return { usable: false as const, exhausted: false, slotsFull: room.wait, budget: !room.wait, reason: room.reason };
    const maxChargeUsd = room ? Math.floor(Math.min(allowance.maxChargeUsd, room.maxUsd) * 100) / 100 : allowance.maxChargeUsd;
    if (maxChargeUsd <= 0) return { usable: false as const, exhausted: false, slotsFull: false, budget: true, reason: "this request's spend cap leaves less than a cent for an Apify run" };
    const [row] = await tx.insert(apifyRuns).values({
      organizationId: currentOrganizationId(),
      jobId: input.jobId,
      requestId: input.requestId,
      actorKey: input.actor,
      actorId: APIFY_ACTORS[input.actor].actorId,
      status: "starting",
      maxChargeUsd,
      maxItems: readiness.maxItems,
    }).returning();
    return { usable: true as const, row: row!, token: readiness.token };
  });
  if (!reserved.usable) return { started: false, exhausted: reserved.exhausted, slotsFull: reserved.slotsFull, budget: "budget" in reserved ? reserved.budget : undefined, reason: reserved.reason };
  const { row, token } = reserved;
  try {
    const run = await startApifyRun(token, row.actorId, input.input(row.maxItems), {
      maxTotalChargeUsd: row.maxChargeUsd,
      maxItems: row.maxItems,
      timeoutSeconds: APIFY_LIMITS.runTimeoutSeconds,
      memoryMbytes: APIFY_LIMITS.memoryMbytes,
    });
    const [updated] = await db.update(apifyRuns)
      .set({ apifyRunId: run.id, datasetId: run.defaultDatasetId, status: "running" })
      .where(and(inOrg(apifyRuns), eq(apifyRuns.id, row.id))).returning();
    return { started: true, row: updated ?? row };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // No answer (a timeout, a dropped connection) or a server error: Apify may have started the run and be charging it.
    // It stays "starting", its cap counted, never started again; the sweeper later counts it as spent.
    if (error instanceof ApifyError && (error.status === null || error.status >= 500)) {
      await db.update(apifyRuns).set({ error: `The answer to starting it was lost: ${message}`.slice(0, 500) })
        .where(and(inOrg(apifyRuns), eq(apifyRuns.id, row.id)));
      return { started: false, exhausted: false, reason: `starting this Apify run lost its answer (${message}), so it may have run; it is not started again, and its reserved cap stays counted` };
    }
    const exhausted = error instanceof ApifyError && looksExhausted({ httpStatus: error.status, type: error.type, message });
    await db.update(apifyRuns).set({ status: "refused", error: message.slice(0, 500), finishedAt: new Date(), usageUsd: 0 })
      .where(and(inOrg(apifyRuns), eq(apifyRuns.id, row.id)));
    return { started: false, exhausted, reason: `Apify did not start the run: ${message}` };
  }
}

export async function trackedRun(rowId: string): Promise<ApifyRunRow | null> {
  const [row] = await db.select().from(apifyRuns).where(and(inOrg(apifyRuns), eq(apifyRuns.id, rowId))).limit(1);
  return row ?? null;
}

export type PolledRun =
  | { state: "running" }
  | { state: "finished"; items: unknown[]; partial: boolean; exhausted: boolean; note: string | null; row: ApifyRunRow };

/**
 * Polls a recorded run. While Apify works: "running". Once it ends — done,
 * failed, aborted, timed out, or stopped by its spending cap — the items it
 * wrote are read (at most its maxItems), so a run cut short still yields
 * what it found ("partial"), and the row records the cost Apify reported.
 */
export async function pollTrackedRun(rowId: string, options: { stopWaiting?: boolean } = {}): Promise<PolledRun> {
  const row = await trackedRun(rowId);
  if (!row?.apifyRunId) throw new ApifyError(null, null, "The Apify run was not recorded");
  const token = await savedToken();
  if (!token) {
    await finishRow(row, { status: "failed", error: "The Apify token was removed while the run was open", usageUsd: row.usageUsd, itemsRead: 0, partial: true });
    return { state: "finished", items: [], partial: true, exhausted: false, note: "The Apify token was removed while the run was open.", row };
  }
  let run: ApifyRun;
  try {
    run = await getApifyRun(token, row.apifyRunId);
  } catch (error) {
    if (!(error instanceof ApifyError) || error.status === null || error.status >= 500) return { state: "running" };
    throw error;
  }
  const outcome = runOutcome(run.status);
  if (outcome === "running" && !options.stopWaiting) return { state: "running" };
  const items: unknown[] = [];
  const datasetId = run.defaultDatasetId ?? row.datasetId;
  if (datasetId) {
    for (let offset = 0; offset < row.maxItems; offset += 250) {
      const page = await listApifyDatasetItems(token, datasetId, offset, Math.min(250, row.maxItems - offset));
      items.push(...page);
      if (page.length < Math.min(250, row.maxItems - offset)) break;
    }
  }
  const partial = outcome !== "succeeded";
  const reason = run.statusMessage ?? run.status;
  const exhausted = partial && looksExhausted({ message: `${run.status} ${reason}` });
  const note = partial
    ? `The Apify run ended early (${run.status}${run.statusMessage ? `: ${run.statusMessage}` : ""}); ${items.length} result${items.length === 1 ? "" : "s"} it had already found ${items.length === 1 ? "was" : "were"} kept.`
    : null;
  const finished = await finishRow(row, {
    status: partial ? (items.length ? "partial" : "failed") : "succeeded",
    error: partial ? reason.slice(0, 500) : null,
    usageUsd: run.usageTotalUsd,
    itemsRead: items.length,
    partial,
  });
  return { state: "finished", items, partial, exhausted, note, row: finished };
}

async function finishRow(row: ApifyRunRow, update: { status: ApifyRunRow["status"]; error: string | null; usageUsd: number | null; itemsRead: number; partial: boolean }): Promise<ApifyRunRow> {
  const [updated] = await db.update(apifyRuns).set({
    status: update.status,
    error: update.error,
    // Unknown cost: the cap is counted, so the budget never under-counts.
    usageUsd: update.usageUsd ?? row.maxChargeUsd,
    itemsRead: update.itemsRead,
    partial: update.partial,
    finishedAt: new Date(),
  }).where(and(inOrg(apifyRuns), eq(apifyRuns.id, row.id), inArray(apifyRuns.status, ["starting", "running"]))).returning();
  return updated ?? row;
}

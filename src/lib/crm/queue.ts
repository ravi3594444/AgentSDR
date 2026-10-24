import { and, asc, desc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { clippedString } from "@/lib/grid/sanitize";
import { REPLY_BUDGET_PAYLOAD_KEY } from "./ai/budget";
import { crmJobs, type CrmJobKind } from "./schema";
import { CrmConflictError, type CrmExecutor, type CrmTransaction } from "./repository";
import { currentOrganizationId } from "@/lib/tenancy/scope";

export type CrmJob = typeof crmJobs.$inferSelect;
export type CrmJobEntityType = CrmJob["entityType"];

const DEFAULT_STALE_LOCK_MS = 5 * 60 * 1_000;
const DEFAULT_RETRY_BASE_MS = 2_000;
const DEFAULT_RETRY_CAP_MS = 5 * 60 * 1_000;

const ENTITY_TYPE_BY_KIND: Readonly<Record<CrmJobKind, CrmJobEntityType>> = {
  classification: "message",
  initial_draft: "classification",
  due_followup_draft: "sequence_step_run",
  auto_send: "draft",
};

export class CrmJobClaimLostError extends Error {
  constructor(jobId: string) {
    super(`CRM job ${jobId} is no longer owned by this worker`);
    this.name = "CrmJobClaimLostError";
  }
}

export function crmJobIdentity(
  kind: CrmJobKind,
  entityId: string,
): { entityType: CrmJobEntityType; idempotencyKey: string } {
  const cleanEntityId = entityId.trim();
  if (!cleanEntityId) throw new Error("CRM job entity ID is required");
  const entityType = ENTITY_TYPE_BY_KIND[kind];
  return {
    entityType,
    idempotencyKey: `crm:${kind}:${entityType}:${cleanEntityId}`,
  };
}

export function crmJobRetryDelayMs(
  attempts: number,
  options: { baseMs?: number; capMs?: number } = {},
): number {
  const baseMs = Math.max(1, Math.floor(options.baseMs ?? DEFAULT_RETRY_BASE_MS));
  const capMs = Math.max(baseMs, Math.floor(options.capMs ?? DEFAULT_RETRY_CAP_MS));
  const safeAttempts = Number.isFinite(attempts) ? Math.floor(attempts) : 1;
  const exponent = Math.max(0, safeAttempts - 1);
  return Math.min(capMs, baseMs * (2 ** exponent));
}

export function shouldRetryCrmJob(
  job: Pick<CrmJob, "attempts" | "maxAttempts">,
  permanent = false,
): boolean {
  return !permanent && job.attempts < job.maxAttempts;
}

/**
 * How often a running job renews its claim: three renewals inside the stale
 * window, so live work is never mistaken for a dead worker, capped so renewal
 * itself never becomes load.
 */
export function crmJobClaimRenewIntervalMs(staleLockMs: number): number {
  const stale = Number.isFinite(staleLockMs)
    ? Math.max(1, Math.floor(staleLockMs))
    : DEFAULT_STALE_LOCK_MS;
  return Math.max(250, Math.min(60_000, Math.floor(stale / 3)));
}

export type EnqueueCrmJobInput = {
  kind: CrmJobKind;
  entityId: string;
  idempotencyKey?: string;
  payload?: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
  runAfter?: Date;
  /**
   * Put a succeeded or failed job for the same entity back on the queue with
   * this payload instead of returning it untouched. Needed where the entity
   * legitimately needs the work done again — a classification row that a
   * human re-applies keeps its id, so its initial_draft job already "ran".
   */
  requeueCompleted?: boolean;
  /**
   * The job's organization. Defaults to the one in scope; a global sweep
   * (enqueueDueFollowupJobs) passes each row's own, since it runs in none.
   */
  organizationId?: string;
};

export async function enqueueCrmJobInTransaction(
  tx: CrmTransaction,
  input: EnqueueCrmJobInput,
): Promise<{ job: CrmJob; created: boolean }> {
  const identity = crmJobIdentity(input.kind, input.entityId);
  const organizationId = input.organizationId ?? currentOrganizationId();
  const idempotencyKey = input.idempotencyKey?.trim() || identity.idempotencyKey;
  const maxAttempts = Math.floor(input.maxAttempts ?? 3);
  if (maxAttempts < 1 || maxAttempts > 100) {
    throw new Error("CRM job maxAttempts must be between 1 and 100");
  }

  const [created] = await tx
    .insert(crmJobs)
    .values({
      organizationId,
      kind: input.kind,
      entityType: identity.entityType,
      entityId: input.entityId.trim(),
      idempotencyKey,
      payload: input.payload ?? {},
      priority: Math.floor(input.priority ?? 0),
      maxAttempts,
      runAfter: input.runAfter ?? new Date(),
    })
    .onConflictDoNothing()
    .returning();
  if (created) return { job: created, created: true };

  const matches = await tx
    .select()
    .from(crmJobs)
    .where(and(
      eq(crmJobs.organizationId, organizationId),
      or(
        eq(crmJobs.idempotencyKey, idempotencyKey),
        and(
          eq(crmJobs.kind, input.kind),
          eq(crmJobs.entityType, identity.entityType),
          eq(crmJobs.entityId, input.entityId.trim()),
        ),
      ),
    ))
    .limit(2);
  if (new Set(matches.map((job) => job.id)).size !== 1) {
    throw new CrmConflictError("CRM job idempotency key belongs to a different entity");
  }
  const [existing] = matches;
  if (
    !existing
    || existing.kind !== input.kind
    || existing.entityType !== identity.entityType
    || existing.entityId !== input.entityId.trim()
    || existing.idempotencyKey !== idempotencyKey
  ) {
    throw new CrmConflictError("CRM job idempotency key belongs to a different entity");
  }
  if (input.requeueCompleted && (existing.status === "succeeded" || existing.status === "failed")) {
    const [requeued] = await tx
      .update(crmJobs)
      .set({
        status: "queued",
        payload: input.payload ?? {},
        priority: Math.floor(input.priority ?? 0),
        attempts: 0,
        maxAttempts,
        runAfter: input.runAfter ?? new Date(),
        lockedAt: null,
        lockedBy: null,
        startedAt: null,
        completedAt: null,
        failedAt: null,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(crmJobs.id, existing.id))
      .returning();
    if (!requeued) throw new Error("CRM job requeue did not return a row");
    return { job: requeued, created: true };
  }
  return { job: existing, created: false };
}

export function enqueueCrmJob(input: EnqueueCrmJobInput) {
  return db.transaction((tx) => enqueueCrmJobInTransaction(tx, input));
}

export async function claimCrmJobs(
  limit: number,
  workerId: string,
  kinds: readonly CrmJobKind[],
): Promise<CrmJob[]> {
  const cleanWorkerId = workerId.trim();
  if (!cleanWorkerId) throw new Error("CRM worker ID is required");
  const boundedLimit = Math.min(100, Math.max(0, Math.floor(limit)));
  const uniqueKinds = [...new Set(kinds)];
  if (!boundedLimit || !uniqueKinds.length) return [];

  return db.transaction(async (tx) => {
    const now = new Date();
    const locked = await tx
      .select({ id: crmJobs.id })
      .from(crmJobs)
      .where(and(
        eq(crmJobs.status, "queued"),
        lte(crmJobs.runAfter, now),
        inArray(crmJobs.kind, uniqueKinds),
        sql`${crmJobs.attempts} < ${crmJobs.maxAttempts}`,
      ))
      .orderBy(desc(crmJobs.priority), asc(crmJobs.createdAt))
      .limit(boundedLimit)
      .for("update", { skipLocked: true });
    if (!locked.length) return [];

    return tx
      .update(crmJobs)
      .set({
        status: "running",
        attempts: sql`${crmJobs.attempts} + 1`,
        lockedAt: now,
        lockedBy: cleanWorkerId,
        startedAt: now,
        completedAt: null,
        failedAt: null,
        updatedAt: now,
      })
      .where(inArray(crmJobs.id, locked.map(({ id }) => id)))
      .returning();
  });
}

/**
 * One execution of a claimed job, bound to the exact claim (worker +
 * attempt) that started it. Handlers receive it from the worker — or make
 * one from the claimed job when called directly — and check it at their
 * effect boundaries: creating a draft, reserving a send, sending. Losing
 * the claim aborts the signal, so model work that honours a signal stops
 * too; the checks are what stop work that cannot be interrupted.
 *
 * A job that was never claimed (status is not "running", no lock owner —
 * a person or a script invoking a handler directly) has no execution:
 * there is no claim to lose, and the caller is the execution.
 */
export class CrmJobExecution {
  private readonly controller = new AbortController();
  private lost = false;

  constructor(readonly job: CrmJob) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get claimLost(): boolean {
    return this.lost || this.controller.signal.aborted;
  }

  markClaimLost(reason?: unknown): void {
    if (this.lost) return;
    this.lost = true;
    this.controller.abort(
      reason instanceof Error ? reason : new CrmJobClaimLostError(this.job.id),
    );
  }

  /**
   * Throws CrmJobClaimLostError unless the database still shows this exact
   * claim. Pass the transaction when the check must be atomic with the
   * effect it guards (the draft/reservation insert in the same tx).
   */
  async assertOwned(executor: CrmExecutor = db): Promise<void> {
    if (this.claimLost) {
      this.markClaimLost();
      throw new CrmJobClaimLostError(this.job.id);
    }
    const rows = await executor
      .select({ id: crmJobs.id })
      .from(crmJobs)
      .where(and(
        eq(crmJobs.id, this.job.id),
        eq(crmJobs.status, "running"),
        eq(crmJobs.lockedBy, claimOwner(this.job)),
        eq(crmJobs.attempts, this.job.attempts),
      ))
      .limit(1)
      .for("update");
    if (!rows.length) {
      this.markClaimLost();
      throw new CrmJobClaimLostError(this.job.id);
    }
  }
}

/** The execution for a claimed job, or null when the job holds no claim. */
export function crmJobExecutionFor(job: CrmJob): CrmJobExecution | null {
  return job.status === "running" && job.lockedBy ? new CrmJobExecution(job) : null;
}

function claimOwner(job: CrmJob): string {
  if (job.status !== "running" || !job.lockedBy) {
    throw new CrmJobClaimLostError(job.id);
  }
  return job.lockedBy;
}

/**
 * Renews a running job's claim so the stale sweep only ever reclaims work
 * whose worker actually stopped. Ownership is the claim predicate shared with
 * completion and failure — same worker, same attempt — never the timestamp
 * alone: a worker whose claim was reclaimed gets CrmJobClaimLostError and
 * must stop renewing.
 */
export async function renewCrmJobClaim(job: CrmJob): Promise<void> {
  const now = new Date();
  const updated = await db
    .update(crmJobs)
    .set({ lockedAt: now, updatedAt: now })
    .where(and(
      eq(crmJobs.id, job.id),
      eq(crmJobs.status, "running"),
      eq(crmJobs.lockedBy, claimOwner(job)),
      eq(crmJobs.attempts, job.attempts),
    ))
    .returning({ id: crmJobs.id });
  if (!updated.length) throw new CrmJobClaimLostError(job.id);
}

export async function completeCrmJob(job: CrmJob): Promise<void> {
  const now = new Date();
  const updated = await db
    .update(crmJobs)
    .set({
      status: "succeeded",
      lockedAt: null,
      lockedBy: null,
      completedAt: now,
      failedAt: null,
      lastError: null,
      updatedAt: now,
    })
    .where(and(
      eq(crmJobs.id, job.id),
      eq(crmJobs.status, "running"),
      eq(crmJobs.lockedBy, claimOwner(job)),
      eq(crmJobs.attempts, job.attempts),
    ))
    .returning({ id: crmJobs.id });
  if (!updated.length) throw new CrmJobClaimLostError(job.id);
}

export async function failCrmJob(
  job: CrmJob,
  error: string,
  options: { permanent?: boolean; now?: Date; retryAt?: Date } = {},
): Promise<{ willRetry: boolean; runAfter: Date | null }> {
  const cleanError = clippedString(error, 2_000).trim() || "Unknown CRM job failure";
  const now = options.now ?? new Date();
  // A job that could not run yet (retryAt) is requeued for then, whatever its attempts.
  const willRetry = options.retryAt ? true : shouldRetryCrmJob(job, options.permanent);
  const runAfter = options.retryAt ?? (willRetry
    ? new Date(now.getTime() + crmJobRetryDelayMs(job.attempts))
    : null);
  const updated = await db
    .update(crmJobs)
    .set(willRetry ? {
      status: "queued",
      // Waiting for another worker's claim (retryAt) is not a failed attempt: the claim's attempt is given back,
      // so a job put back on its last attempt can still be claimed.
      ...(options.retryAt ? { attempts: Math.max(0, job.attempts - 1) } : {}),
      lockedAt: null,
      lockedBy: null,
      runAfter: runAfter!,
      completedAt: null,
      failedAt: null,
      lastError: cleanError,
      updatedAt: now,
    } : {
      status: "failed",
      lockedAt: null,
      lockedBy: null,
      completedAt: now,
      failedAt: now,
      lastError: cleanError,
      updatedAt: now,
    })
    .where(and(
      eq(crmJobs.id, job.id),
      eq(crmJobs.status, "running"),
      eq(crmJobs.lockedBy, claimOwner(job)),
      eq(crmJobs.attempts, job.attempts),
    ))
    .returning({ id: crmJobs.id });
  if (!updated.length) throw new CrmJobClaimLostError(job.id);
  return { willRetry, runAfter };
}

/**
 * Replaces a running job's payload under the claim's ownership, so state a
 * handler accumulates (the reply budget) survives the job being retried or
 * the process restarting. A worker that lost its claim cannot write.
 */
export async function saveCrmJobPayload(job: CrmJob, payload: Record<string, unknown>): Promise<void> {
  const updated = await db
    .update(crmJobs)
    .set({ payload, updatedAt: new Date() })
    .where(and(
      eq(crmJobs.id, job.id),
      eq(crmJobs.status, "running"),
      eq(crmJobs.lockedBy, claimOwner(job)),
      eq(crmJobs.attempts, job.attempts),
    ))
    .returning({ id: crmJobs.id });
  if (!updated.length) throw new CrmJobClaimLostError(job.id);
}

/** Requeues only a visible terminal failure; successful jobs stay immutable. */
export async function requeueFailedCrmJob(jobId: string): Promise<CrmJob> {
  const now = new Date();
  const [existing] = await db
    .select({ payload: crmJobs.payload })
    .from(crmJobs)
    .where(and(eq(crmJobs.id, jobId), eq(crmJobs.status, "failed")))
    .limit(1);
  if (!existing) throw new CrmConflictError("Only a failed CRM job can be requeued");
  // A manual requeue is new work: the spent reply budget does not carry over,
  // or the fresh attempt would inherit an expired deadline and fail at once.
  const payload = { ...(existing.payload ?? {}) };
  delete payload[REPLY_BUDGET_PAYLOAD_KEY];
  const [job] = await db
    .update(crmJobs)
    .set({
      status: "queued",
      attempts: 0,
      payload,
      runAfter: now,
      lockedAt: null,
      lockedBy: null,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      lastError: null,
      updatedAt: now,
    })
    .where(and(eq(crmJobs.id, jobId), eq(crmJobs.status, "failed")))
    .returning();
  if (!job) throw new CrmConflictError("Only a failed CRM job can be requeued");
  return job;
}

/** Recovers dead claims and retains exhausted jobs as visible terminal failures. */
export async function recoverStaleCrmJobs(
  staleAfterMs = DEFAULT_STALE_LOCK_MS,
): Promise<{ requeued: number; failed: number }> {
  const ageMs = Math.max(1_000, Math.floor(staleAfterMs));
  return db.transaction(async (tx) => {
    const stale = await tx
      .select()
      .from(crmJobs)
      .where(and(
        eq(crmJobs.status, "running"),
        sql`${crmJobs.lockedAt} < now() - ${`${ageMs} milliseconds`}::interval`,
      ))
      .for("update", { skipLocked: true });
    if (!stale.length) return { requeued: 0, failed: 0 };

    const failedIds = stale
      .filter((job) => job.attempts >= job.maxAttempts)
      .map((job) => job.id);
    const queuedIds = stale
      .filter((job) => job.attempts < job.maxAttempts)
      .map((job) => job.id);
    const now = new Date();

    if (queuedIds.length) {
      await tx
        .update(crmJobs)
        .set({
          status: "queued",
          lockedAt: null,
          lockedBy: null,
          runAfter: now,
          updatedAt: now,
        })
        .where(inArray(crmJobs.id, queuedIds));
    }
    if (failedIds.length) {
      await tx
        .update(crmJobs)
        .set({
          status: "failed",
          lockedAt: null,
          lockedBy: null,
          completedAt: now,
          failedAt: now,
          lastError: sql`coalesce(nullif(btrim(${crmJobs.lastError}), ''), 'CRM worker claim expired after the final attempt')`,
          updatedAt: now,
        })
        .where(inArray(crmJobs.id, failedIds));
    }
    return { requeued: queuedIds.length, failed: failedIds.length };
  });
}

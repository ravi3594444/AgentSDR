import "server-only";

import { randomUUID } from "node:crypto";
import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { cleanJson, clippedString, savedErrorText } from "@/lib/grid/sanitize";
import { maybeCurrentOrganizationId, runInOrganization } from "@/lib/tenancy/scope";
import { assistantJobs, type AssistantJobKind } from "./schema";

/**
 * The assistant's background worker: lead discoveries and the start of an
 * approved outreach run. A job is a small state machine (`stage`); each pass
 * claims one due job with SKIP LOCKED, runs one stage step in the job's
 * organization, and stores where it got to, so a restart resumes instead of
 * starting over. A running job's heartbeat keeps a long step from being
 * claimed twice; a job whose heartbeat is older than STALE_MS is taken over.
 * It never sends a message itself: an outreach start hands the leads to
 * the existing campaign engines, which send under their own rules.
 *
 * A job that finishes owes its chat one report. Its terminal status is
 * written with a report key; the report is posted in the same transaction
 * that marks it reported (claimJobReport), so a duplicate callback posts
 * nothing; and the loop reposts reports a stop between the two lost
 * (reconcileAssistantJobReports), and hands back a reported job whose
 * follow-up a stop left undone (followUpDue).
 *
 * Every write is bounded. What a step returns is cleaned before it is saved
 * (NUL and lone surrogates, which Postgres refuses; errors clipped). A step
 * whose result the database still refuses runs again with backoff, keeping
 * the payload earlier steps saved, and the job fails after
 * MAX_STEP_FAILURES saying why. A job claimed again and again without any
 * step's result being saved (its process stopped mid-step, or every write
 * was refused) fails at the claim ceiling without running its step again.
 */

export type AssistantJob = typeof assistantJobs.$inferSelect;

/** What a stage step decided: wait and come back, move to another stage, or finish. */
export type StepOutcome =
  | { next: "wait"; delayMs: number; progress?: Record<string, unknown>; payload?: Record<string, unknown> }
  | { next: "stage"; stage: string; progress?: Record<string, unknown>; payload?: Record<string, unknown>; externalId?: string | null }
  | { next: "done"; result: Record<string, unknown>; progress?: Record<string, unknown> }
  | { next: "failed"; error: string; progress?: Record<string, unknown> };

export type StepHandler = (job: AssistantJob, heartbeat: () => Promise<void>) => Promise<StepOutcome>;

const POLL_MS = Number(process.env.ASSISTANT_WORKER_POLL_MS ?? 3_000);
const STALE_MS = 3 * 60_000;
const MAX_STEP_FAILURES = 5;
/** The longest error a job keeps. */
const MAX_ERROR_CHARS = 2_000;
/** How often the loop looks for reports a stop lost, how long it leaves the normal path to post one, and how far back. */
const RECONCILE_MS = 60_000;
const REPORT_GRACE_MS = 30_000;
const REPORT_WINDOW_MS = 24 * 60 * 60_000;

const handlers = new Map<AssistantJobKind, StepHandler>();
/**
 * Called when a job finishes or fails, to tell the chat; called again for a
 * finished job whose report was never posted. It posts through
 * claimJobReport, which makes the second call a no-op.
 */
let onFinished: ((job: AssistantJob) => Promise<void>) | null = null;

export function registerAssistantJobHandler(kind: AssistantJobKind, handler: StepHandler): void {
  handlers.set(kind, handler);
}

export function onAssistantJobFinished(listener: (job: AssistantJob) => Promise<void>): void {
  onFinished = listener;
}

const workerId = `assistant-${process.pid}-${randomUUID().slice(0, 8)}`;

/** Claims the next due job (or, given an id, that job when it is due). */
async function claim(jobId?: string): Promise<AssistantJob | null> {
  const staleBefore = new Date(Date.now() - STALE_MS);
  const only = jobId ? sql`id = ${jobId}::uuid and ` : sql``;
  const rows = await db.execute<{ id: string }>(sql`
    update assistant_jobs set status = 'running', locked_by = ${workerId}, heartbeat_at = now(), attempts = attempts + 1
    where id = (
      select id from assistant_jobs
      where ${only}((status = 'queued' and run_after <= now())
         or (status = 'running' and heartbeat_at < ${staleBefore.toISOString()}::timestamptz))
      order by run_after asc
      for update skip locked
      limit 1
    )
    returning id`);
  const id = rows[0]?.id;
  if (!id) return null;
  const [job] = await db.select().from(assistantJobs).where(eq(assistantJobs.id, id)).limit(1);
  return job ?? null;
}

/**
 * A step's progress over the job's. A wait (`waiting`) reported earlier is
 * dropped unless this step reports it again, as every waiting step does:
 * otherwise a search that has started still reads as waiting for a slot.
 * An earlier step's error (`lastError`) is dropped once a step completes
 * without one, so the job no longer reads as retrying; a failed step keeps it.
 */
export function mergeJobProgress(prior: Record<string, unknown>, next: Record<string, unknown> | undefined, options: { stepFailed?: boolean } = {}): Record<string, unknown> {
  let base = prior;
  if (!options.stepFailed && "lastError" in prior) {
    base = { ...prior };
    delete base.lastError;
  }
  if (!next) return base;
  const kept = { ...base };
  delete kept.waiting;
  return { ...kept, ...next };
}

/** A step's error as a job keeps it and its chat report shows it (savedErrorText: never a failed query's values). */
export function jobErrorText(error: unknown): string {
  return savedErrorText(error, MAX_ERROR_CHARS);
}

/** How long a job waits before its step runs again, after `attempts` tries in a row that saved nothing. */
export function retryDelayMs(attempts: number): number {
  return Math.min(60_000, 5_000 * 2 ** attempts);
}

/**
 * True when a job has been claimed this often without a step's result being
 * saved. Failed steps and refused saves end the job at MAX_STEP_FAILURES on
 * their own; only claims that never got that far (the process stopped
 * mid-step, or the fallback write was refused too) reach this.
 */
export function pastClaimCeiling(attempts: number): boolean {
  return attempts > MAX_STEP_FAILURES + 2;
}

function owned(job: AssistantJob) {
  return and(eq(assistantJobs.id, job.id), eq(assistantJobs.lockedBy, workerId));
}

async function release(job: AssistantJob, outcome: StepOutcome, stepFailed = false): Promise<AssistantJob | null> {
  const base = { lockedBy: null, heartbeatAt: null, attempts: 0 };
  const progress = cleanJson(mergeJobProgress(job.progress, outcome.progress, { stepFailed }));
  if (outcome.next === "wait") {
    await db.update(assistantJobs).set({
      ...base, status: "queued", progress, runAfter: new Date(Date.now() + outcome.delayMs),
      ...(outcome.payload ? { payload: cleanJson({ ...job.payload, ...outcome.payload }) } : {}),
    }).where(owned(job));
    return null;
  }
  if (outcome.next === "stage") {
    await db.update(assistantJobs).set({
      ...base, status: "queued", stage: outcome.stage, progress, runAfter: new Date(),
      ...(outcome.payload ? { payload: cleanJson({ ...job.payload, ...outcome.payload }) } : {}),
      ...(outcome.externalId !== undefined ? { externalId: outcome.externalId } : {}),
    }).where(owned(job));
    return null;
  }
  const status = outcome.next === "done" ? "succeeded" : "failed";
  const [finished] = await db.update(assistantJobs).set({
    ...base,
    status,
    stage: outcome.next === "done" ? "done" : job.stage,
    progress,
    result: outcome.next === "done" ? cleanJson(outcome.result) : job.result,
    error: outcome.next === "failed" ? clippedString(outcome.error, MAX_ERROR_CHARS) : null,
    finishedAt: new Date(),
    // Written with the terminal status: from here this outcome is owed one report.
    reportKey: jobReportKey(job.id, status),
    reportedAt: null,
  }).where(owned(job)).returning();
  return finished ?? null;
}

/** Puts a job back for its step to run again after a backoff, keeping its attempt count and everything saved. */
async function retryLater(job: AssistantJob, lastError: string): Promise<void> {
  await db.update(assistantJobs).set({
    lockedBy: null, heartbeatAt: null, status: "queued", runAfter: new Date(Date.now() + retryDelayMs(job.attempts)),
    progress: { ...job.progress, lastError: clippedString(lastError, MAX_ERROR_CHARS) },
  }).where(owned(job));
}

/** Ends a job as failed without anything its last step returned: payload, stage and result stay as last saved. */
async function failAsSaved(job: AssistantJob, error: string): Promise<AssistantJob | null> {
  const [finished] = await db.update(assistantJobs).set({
    lockedBy: null, heartbeatAt: null, status: "failed",
    error: clippedString(error, MAX_ERROR_CHARS),
    finishedAt: new Date(),
    reportKey: jobReportKey(job.id, "failed"),
    reportedAt: null,
  }).where(owned(job)).returning();
  return finished ?? null;
}

/**
 * A step ran but its result could not be saved (the database refused it,
 * or it could not be written at all). Nothing of the result is kept, so
 * what earlier steps saved stays: the step runs again after a backoff, and
 * after MAX_STEP_FAILURES tries the job fails saying why. If even this
 * write is refused the job stays claimed until its heartbeat goes stale,
 * and the claim ceiling ends it.
 */
async function recoverUnsaved(job: AssistantJob, reason: string): Promise<AssistantJob | null> {
  try {
    if (job.attempts >= MAX_STEP_FAILURES) {
      return await failAsSaved(job, `Stopped: its result could not be saved after ${job.attempts} attempts (${reason}). Work saved before this step is kept.`);
    }
    await retryLater(job, `Its result could not be saved: ${reason}`);
  } catch (error) {
    console.error(`[assistant/worker] ${job.kind} ${job.id}: recording that its result could not be saved failed too; it is retried when its claim goes stale:`, error);
  }
  return null;
}

/** The report key of a job's terminal outcome. */
export function jobReportKey(jobId: string, status: "succeeded" | "failed"): string {
  return `assistant_job:${jobId}:${status}`;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Posts a finished job's report once. In one transaction it marks the job
 * reported, only if it was not, and runs `post` with that transaction (the
 * chat event is written there): the report and its mark commit together or
 * not at all. False when it was reported already — a duplicate callback,
 * or the reconciler or another instance got there first — or the job owes
 * no report; the caller then does nothing more.
 */
export async function claimJobReport(job: Pick<AssistantJob, "id" | "organizationId">, post: (tx: Tx) => Promise<void>): Promise<boolean> {
  return db.transaction(async (tx) => {
    const claimed = await tx.update(assistantJobs).set({ reportedAt: new Date() })
      .where(and(eq(assistantJobs.id, job.id), eq(assistantJobs.organizationId, job.organizationId), isNotNull(assistantJobs.reportKey), isNull(assistantJobs.reportedAt)))
      .returning({ id: assistantJobs.id });
    if (!claimed.length) return false;
    await post(tx);
    return true;
  });
}

/**
 * What follows a job's report (the plan a "find and contact" search
 * promised, register.server.ts) is kept in the job's progress: `followUp`
 * is "owed" from the report's own commit, "preparing" while a process
 * works on it under a lease (`followUpAt`, renewed every minute), and
 * "done" once made. A lease older than this was left by a process that
 * stopped: the reconciliation hands the job back, and the next taker
 * resumes it.
 */
export const FOLLOW_UP_LEASE_MS = 5 * 60_000;

/** A follow-up nobody is working on: owed, or its lease is stale. */
export function followUpDue(now = new Date()): SQL {
  const stale = new Date(now.getTime() - FOLLOW_UP_LEASE_MS).toISOString();
  return sql`(${assistantJobs.progress} ->> 'followUp' = 'owed' OR (${assistantJobs.progress} ->> 'followUp' = 'preparing' AND (${assistantJobs.progress} ->> 'followUpAt')::timestamptz < ${stale}::timestamptz))`;
}

/**
 * Hands every finished job of the last 24 hours that owes its chat a
 * report and has none (the process stopped, or posting failed, between
 * finishing it and posting) to the finished-job listener again, each in
 * its organization, and every reported one whose follow-up is due (the
 * process stopped after the report, before what follows it was done).
 * Jobs finished in the last `graceMs` are left to the normal path. Returns
 * how many were handed over; the listener's claims keep each report and
 * each follow-up single. The worker runs it outside any organization scope;
 * called inside one, it takes only that organization's jobs (another's
 * could not run there, and would only crowd its own out of the batch).
 */
export async function reconcileAssistantJobReports(graceMs = REPORT_GRACE_MS, now = new Date()): Promise<number> {
  if (!onFinished) return 0;
  const scoped = maybeCurrentOrganizationId();
  const recent = and(
    scoped ? eq(assistantJobs.organizationId, scoped) : undefined,
    isNotNull(assistantJobs.threadId),
    gte(assistantJobs.finishedAt, new Date(now.getTime() - REPORT_WINDOW_MS)),
    lt(assistantJobs.finishedAt, new Date(now.getTime() - graceMs)),
  );
  const [unreported, followUps] = await Promise.all([
    db.select().from(assistantJobs).where(and(
      inArray(assistantJobs.status, ["succeeded", "failed"]),
      isNotNull(assistantJobs.reportKey),
      isNull(assistantJobs.reportedAt),
      recent,
    )).orderBy(asc(assistantJobs.finishedAt)).limit(20),
    db.select().from(assistantJobs).where(and(
      eq(assistantJobs.status, "succeeded"),
      isNotNull(assistantJobs.reportedAt),
      followUpDue(now),
      recent,
    )).orderBy(asc(assistantJobs.finishedAt)).limit(20),
  ]);
  const due = [...unreported, ...followUps];
  let handed = 0;
  for (const job of due) {
    try {
      await runInOrganization(job.organizationId, () => onFinished!(job));
      handed += 1;
    } catch (error) {
      console.error(`[assistant/worker] could not report ${job.kind} ${job.id} on reconcile:`, error);
    }
  }
  return handed;
}

let lastReconcile = 0;

/**
 * Claims and runs one step of one due job; false when nothing was due.
 * `jobId` limits it to that job (scripts drive one job without taking
 * another organization's).
 */
export async function runOneAssistantStep(options: { jobId?: string } = {}): Promise<boolean> {
  const job = await claim(options.jobId);
  if (!job) return false;
  let finished: AssistantJob | null = null;
  if (pastClaimCeiling(job.attempts)) {
    console.error(`[assistant/worker] ${job.kind} ${job.id} stage ${job.stage}: claimed ${job.attempts} times without a step finishing; stopping it`);
    finished = await failAsSaved(job, `Stopped: it was picked up ${job.attempts - 1} times without its step finishing (the server stopped or could not save during the step). Work saved before this step is kept.`)
      .catch((error) => { console.error(`[assistant/worker] could not stop ${job.kind} ${job.id}:`, error); return null; });
    await report(finished);
    return true;
  }
  const handler = handlers.get(job.kind);
  const heartbeat = async () => {
    await db.update(assistantJobs).set({ heartbeatAt: new Date() })
      .where(and(eq(assistantJobs.id, job.id), eq(assistantJobs.lockedBy, workerId)));
  };
  let outcome: StepOutcome;
  let stepFailed = false;
  try {
    outcome = handler
      ? await runInOrganization(job.organizationId, () => handler(job, heartbeat))
      : { next: "failed", error: `No handler for ${job.kind} jobs in this server` };
  } catch (error) {
    stepFailed = true;
    const message = jobErrorText(error);
    console.error(`[assistant/worker] ${job.kind} ${job.id} stage ${job.stage} failed:`, error);
    // An unexpected error retries the same stage with backoff, a few times, keeping the attempt count.
    if (job.attempts < MAX_STEP_FAILURES) {
      await retryLater(job, message).catch((retryError) => console.error(`[assistant/worker] ${job.kind} ${job.id}: could not queue its retry:`, retryError));
      return true;
    }
    outcome = { next: "failed", error: message };
  }
  try {
    finished = await release(job, outcome, stepFailed);
  } catch (error) {
    console.error(`[assistant/worker] ${job.kind} ${job.id} stage ${job.stage}: its result could not be saved:`, error);
    finished = await recoverUnsaved(job, jobErrorText(error));
  }
  await report(finished);
  return true;
}

/** Tells the chat about a job that just finished (its report is posted once, see claimJobReport). */
async function report(finished: AssistantJob | null): Promise<void> {
  if (!finished || !onFinished) return;
  await runInOrganization(finished.organizationId, () => onFinished!(finished)).catch((error) => {
    console.error(`[assistant/worker] could not report ${finished.kind} ${finished.id}:`, error);
  });
}

let draining = false;
async function drain() {
  if (draining) return;
  draining = true;
  try {
    // First pass after a start, then once a minute: reports a stop lost.
    if (Date.now() - lastReconcile >= RECONCILE_MS) {
      lastReconcile = Date.now();
      await reconcileAssistantJobReports().catch((error) => console.error("[assistant/worker] report reconciliation failed:", error));
    }
    for (let index = 0; index < 20; index += 1) {
      if (!(await runOneAssistantStep())) break;
    }
  } catch (error) {
    console.error("[assistant/worker] drain failed:", error);
  } finally {
    draining = false;
  }
}

const STATE_KEY = Symbol.for("agentsdr.assistantWorker");
type WorkerState = { timer: ReturnType<typeof setInterval> };
const globalState = globalThis as unknown as Record<symbol, WorkerState | undefined>;

/** Starts one HMR-safe worker loop per process. */
export function startAssistantWorker(): void {
  const previous = globalState[STATE_KEY];
  if (previous) clearInterval(previous.timer);
  console.log(`[assistant/worker] starting — poll ${POLL_MS}ms`);
  const timer = setInterval(() => void drain(), POLL_MS);
  globalState[STATE_KEY] = { timer };
  void drain();
}

/** Jobs of the organization in scope that are not finished yet. */
export function openJobsCondition() {
  return or(eq(assistantJobs.status, "queued"), eq(assistantJobs.status, "running"));
}


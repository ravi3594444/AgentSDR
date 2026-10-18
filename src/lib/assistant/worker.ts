import "server-only";

import { randomUUID } from "node:crypto";
import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { runInOrganization } from "@/lib/tenancy/scope";
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

async function claim(): Promise<AssistantJob | null> {
  const staleBefore = new Date(Date.now() - STALE_MS);
  const rows = await db.execute<{ id: string }>(sql`
    update assistant_jobs set status = 'running', locked_by = ${workerId}, heartbeat_at = now(), attempts = attempts + 1
    where id = (
      select id from assistant_jobs
      where (status = 'queued' and run_after <= now())
         or (status = 'running' and heartbeat_at < ${staleBefore.toISOString()}::timestamptz)
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

async function release(job: AssistantJob, outcome: StepOutcome): Promise<AssistantJob | null> {
  const base = { lockedBy: null, heartbeatAt: null, attempts: 0 };
  const progress = outcome.progress ? { ...job.progress, ...outcome.progress } : job.progress;
  const owned = and(eq(assistantJobs.id, job.id), eq(assistantJobs.lockedBy, workerId));
  if (outcome.next === "wait") {
    await db.update(assistantJobs).set({
      ...base, status: "queued", progress, runAfter: new Date(Date.now() + outcome.delayMs),
      ...(outcome.payload ? { payload: { ...job.payload, ...outcome.payload } } : {}),
    }).where(owned);
    return null;
  }
  if (outcome.next === "stage") {
    await db.update(assistantJobs).set({
      ...base, status: "queued", stage: outcome.stage, progress, runAfter: new Date(),
      ...(outcome.payload ? { payload: { ...job.payload, ...outcome.payload } } : {}),
      ...(outcome.externalId !== undefined ? { externalId: outcome.externalId } : {}),
    }).where(owned);
    return null;
  }
  const status = outcome.next === "done" ? "succeeded" : "failed";
  const [finished] = await db.update(assistantJobs).set({
    ...base,
    status,
    stage: outcome.next === "done" ? "done" : job.stage,
    progress,
    result: outcome.next === "done" ? outcome.result : job.result,
    error: outcome.next === "failed" ? outcome.error : null,
    finishedAt: new Date(),
    // Written with the terminal status: from here this outcome is owed one report.
    reportKey: jobReportKey(job.id, status),
    reportedAt: null,
  }).where(owned).returning();
  return finished ?? null;
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
 * each follow-up single.
 */
export async function reconcileAssistantJobReports(graceMs = REPORT_GRACE_MS, now = new Date()): Promise<number> {
  if (!onFinished) return 0;
  const recent = and(
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

/** Claims and runs one step of one due job; false when nothing was due. */
export async function runOneAssistantStep(): Promise<boolean> {
  const job = await claim();
  if (!job) return false;
  const handler = handlers.get(job.kind);
  const heartbeat = async () => {
    await db.update(assistantJobs).set({ heartbeatAt: new Date() })
      .where(and(eq(assistantJobs.id, job.id), eq(assistantJobs.lockedBy, workerId)));
  };
  let outcome: StepOutcome;
  try {
    outcome = handler
      ? await runInOrganization(job.organizationId, () => handler(job, heartbeat))
      : { next: "failed", error: `No handler for ${job.kind} jobs in this server` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[assistant/worker] ${job.kind} ${job.id} stage ${job.stage} failed:`, error);
    // An unexpected error retries the same stage with backoff, a few times.
    outcome = job.attempts >= MAX_STEP_FAILURES
      ? { next: "failed", error: message }
      : { next: "wait", delayMs: Math.min(60_000, 5_000 * 2 ** job.attempts), progress: { lastError: message } };
    if (outcome.next === "wait") {
      // Keep the attempt count across the retry (release resets it on progress).
      await db.update(assistantJobs).set({ lockedBy: null, heartbeatAt: null, status: "queued", runAfter: new Date(Date.now() + outcome.delayMs), progress: { ...job.progress, lastError: message } })
        .where(and(eq(assistantJobs.id, job.id), eq(assistantJobs.lockedBy, workerId)));
      return true;
    }
  }
  const finished = await release(job, outcome);
  if (finished && onFinished) {
    await runInOrganization(finished.organizationId, () => onFinished!(finished)).catch((error) => {
      console.error(`[assistant/worker] could not report ${finished.kind} ${finished.id}:`, error);
    });
  }
  return true;
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


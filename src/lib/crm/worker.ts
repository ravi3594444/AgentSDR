import { runInOrganization } from "@/lib/tenancy/scope";
import { savedErrorText } from "@/lib/grid/sanitize";
import type { CrmJobKind } from "./schema";
import {
  CrmJobClaimLostError,
  claimCrmJobs,
  completeCrmJob,
  crmJobClaimRenewIntervalMs,
  failCrmJob,
  recoverStaleCrmJobs,
  renewCrmJobClaim,
  type CrmJob,
} from "./queue";

export function crmWorkerPositiveInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
}

const POLL_INTERVAL_MS = crmWorkerPositiveInteger(process.env.CRM_WORKER_POLL_MS, 1_000, 100);
const CONCURRENCY = crmWorkerPositiveInteger(process.env.CRM_WORKER_CONCURRENCY, 4, 1);
/** How long a running job may go without renewing its claim before it is taken for dead and requeued. */
export const STALE_LOCK_MS = crmWorkerPositiveInteger(
  process.env.CRM_WORKER_STALE_LOCK_MS,
  5 * 60 * 1_000,
  1_000,
);
/** How often a running job renews its claim; derived from the stale window unless set explicitly. */
const CLAIM_RENEW_MS = crmWorkerPositiveInteger(
  process.env.CRM_WORKER_CLAIM_RENEW_MS,
  crmJobClaimRenewIntervalMs(STALE_LOCK_MS),
  100,
);
const STALE_SWEEP_EVERY = 60;
const WORKER_STATE_KEY = Symbol.for("agentsdr.crm-worker-state");
const HANDLER_STATE_KEY = Symbol.for("agentsdr.crm-worker-handlers");

export type CrmJobHandler = (job: CrmJob) => Promise<void>;

export class PermanentCrmJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentCrmJobError";
  }
}

/**
 * The job cannot run yet and must not be failed: it is requeued for
 * `retryAt` without counting against its attempts (for example, a claim
 * another worker may still hold until its lock window ends).
 */
export class RetryCrmJobLaterError extends Error {
  constructor(message: string, readonly retryAt: Date) {
    super(message);
    this.name = "RetryCrmJobLaterError";
  }
}

type WorkerState = {
  owner: symbol;
  timer: ReturnType<typeof setInterval>;
};

type WorkerGlobal = typeof globalThis & {
  [WORKER_STATE_KEY]?: WorkerState;
  [HANDLER_STATE_KEY]?: Map<CrmJobKind, CrmJobHandler>;
};

const workerGlobal = globalThis as WorkerGlobal;
const handlers = workerGlobal[HANDLER_STATE_KEY] ?? new Map<CrmJobKind, CrmJobHandler>();
workerGlobal[HANDLER_STATE_KEY] = handlers;

let started = false;
let draining = false;
let inFlight = 0;
let ticks = STALE_SWEEP_EVERY - 1;
const workerOwner = Symbol("crm-worker-generation");
const workerId = `crm:${process.pid}:${Math.random().toString(36).slice(2)}`;

export function registerCrmJobHandler(
  kind: CrmJobKind,
  handler: CrmJobHandler,
): () => void {
  handlers.set(kind, handler);
  return () => {
    if (handlers.get(kind) === handler) handlers.delete(kind);
  };
}

export function registerCrmJobHandlers(input: {
  classification?: CrmJobHandler;
  initialDraft?: CrmJobHandler;
  dueFollowupDraft?: CrmJobHandler;
  /** The reply autopilot (autopilot.server.ts): the one job kind that sends. */
  autoSend?: CrmJobHandler;
}): () => void {
  const unregister = [
    input.classification && registerCrmJobHandler("classification", input.classification),
    input.initialDraft && registerCrmJobHandler("initial_draft", input.initialDraft),
    input.dueFollowupDraft && registerCrmJobHandler("due_followup_draft", input.dueFollowupDraft),
    input.autoSend && registerCrmJobHandler("auto_send", input.autoSend),
  ].filter((value): value is () => void => Boolean(value));
  return () => unregister.forEach((remove) => remove());
}

export function registeredCrmJobKinds(): CrmJobKind[] {
  return [...handlers.keys()];
}

async function runJob(job: CrmJob): Promise<void> {
  const handler = handlers.get(job.kind);
  if (!handler) {
    await failCrmJob(job, `No handler is registered for CRM job kind ${job.kind}`, {
      permanent: false,
    });
    return;
  }

  // Renew the claim while the handler runs, so slow live work is never
  // reclaimed as stale. Losing the claim stops renewal; completion and
  // failure below re-check the same ownership, so a worker that lost its
  // claim cannot overwrite the newer attempt's result.
  const renewal = setInterval(() => {
    void renewCrmJobClaim(job).catch((error) => {
      if (error instanceof CrmJobClaimLostError) clearInterval(renewal);
    });
  }, CLAIM_RENEW_MS);
  try {
    // Jobs are claimed across organizations; each one runs as its own.
    await runInOrganization(job.organizationId, () => handler(job));
    await completeCrmJob(job);
  } catch (error) {
    if (error instanceof CrmJobClaimLostError) return;
    const message = savedErrorText(error, 2_000);
    const { willRetry } = await failCrmJob(job, message, {
      // A spent reply budget never refills for this job: retrying the claim
      // would only fail at the first model call again.
      permanent: error instanceof PermanentCrmJobError
        || (error instanceof Error && error.name === "StructuredBudgetExhaustedError"),
      retryAt: error instanceof RetryCrmJobLaterError ? error.retryAt : undefined,
    });
    if (!willRetry) {
      console.warn(`[crm/worker] ${job.kind} job ${job.id} failed: ${message}`);
    }
  } finally {
    clearInterval(renewal);
  }
}

async function drain(): Promise<void> {
  if (draining) return;
  const kinds = registeredCrmJobKinds();
  if (!kinds.length) return;
  draining = true;
  try {
    // Materialize due follow-up drafting work before claiming. The enqueuer
    // and queue identities are idempotent, so overlapping instances are safe.
    const { enqueueDueFollowupJobs } = await import("./sequences");
    await enqueueDueFollowupJobs(Math.max(100, CONCURRENCY * 4));

    if (++ticks % STALE_SWEEP_EVERY === 0) {
      const recovered = await recoverStaleCrmJobs(STALE_LOCK_MS);
      if (recovered.requeued || recovered.failed) {
        console.log(
          `[crm/worker] recovered ${recovered.requeued} stale job(s); ${recovered.failed} exhausted`,
        );
      }
    }

    const capacity = CONCURRENCY - inFlight;
    if (capacity <= 0) return;
    const jobs = await claimCrmJobs(capacity, workerId, kinds);
    if (!jobs.length) return;

    inFlight += jobs.length;
    try {
      await Promise.all(jobs.map((job) => runJob(job).catch((error) => {
        console.error("[crm/worker] job threw outside its handler:", error);
      })));
    } finally {
      inFlight -= jobs.length;
    }
  } catch (error) {
    console.error("[crm/worker] drain failed:", error);
  } finally {
    draining = false;
  }
}

/**
 * Starts one HMR-safe in-process worker loop. The only job that sends is
 * auto_send, which exists only while the owner's reply autopilot is on.
 */
export function startCrmWorker(): void {
  if (started && workerGlobal[WORKER_STATE_KEY]?.owner === workerOwner) return;
  started = true;

  const previous = workerGlobal[WORKER_STATE_KEY];
  if (previous && previous.owner !== workerOwner) clearInterval(previous.timer);

  console.log(
    `[crm/worker] starting — poll ${POLL_INTERVAL_MS}ms, concurrency ${CONCURRENCY}`,
  );
  const timer = setInterval(() => {
    if (workerGlobal[WORKER_STATE_KEY]?.owner !== workerOwner) {
      clearInterval(timer);
      return;
    }
    void drain();
  }, POLL_INTERVAL_MS);
  workerGlobal[WORKER_STATE_KEY] = { owner: workerOwner, timer };
  void drain();
}

/** Runs one synchronous pass for operational endpoints and tests. */
export async function drainOnce(): Promise<void> {
  await drain();
}

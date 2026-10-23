import "server-only";

import type { CompletionBudget } from "@/lib/ai/server/structuredCompletion";
import {
  CrmJobClaimLostError,
  saveCrmJobPayload,
  type CrmJob,
  type CrmJobExecution,
} from "../queue";
import {
  REPLY_BUDGET_PAYLOAD_KEY,
  ReplyBudgetPersistenceError,
  createPersistedReplyBudget,
  createReplyBudgetState,
  replyBudgetStateFromPayload,
  type ReplyBudgetState,
} from "./budget";

/**
 * The job's reply budget as a CompletionBudget. State lives on the job's
 * payload: created on the first claim that needs it, topped up never, and
 * re-read from the claimed row on every retry, so no claim of the job can
 * reset it.
 *
 * For a claimed job the budget FAILS CLOSED (RR1): a transport request is
 * authorized only after its consumption has been persisted under the
 * claim's ownership (saveCrmJobPayload is fenced on worker + attempt).
 * A lost claim propagates as CrmJobClaimLostError — and marks the
 * execution lost — instead of being warned about while the request goes
 * ahead unrecorded; a transient persistence failure likewise authorizes
 * nothing (ReplyBudgetPersistenceError) and the job can be retried
 * against the last recorded state.
 *
 * A job that holds no claim (a handler invoked directly by a person or a
 * script, never claimed by the worker) has nothing to persist against:
 * its budget counts in memory for that invocation only, as before.
 */
export async function replyBudgetForJob(
  job: CrmJob,
  execution?: CrmJobExecution | null,
): Promise<CompletionBudget> {
  const existing = replyBudgetStateFromPayload(job.payload);
  const state: ReplyBudgetState = existing ?? createReplyBudgetState(Date.now());
  if (job.status !== "running" || !job.lockedBy) {
    return createPersistedReplyBudget(state, async () => undefined);
  }
  const persist = async (next: ReplyBudgetState) => {
    try {
      await saveCrmJobPayload(job, { ...job.payload, [REPLY_BUDGET_PAYLOAD_KEY]: next });
    } catch (error) {
      if (error instanceof CrmJobClaimLostError) execution?.markClaimLost(error);
      throw error;
    }
  };
  if (!existing) {
    try {
      await persist(state);
    } catch (error) {
      if (error instanceof CrmJobClaimLostError) throw error;
      throw new ReplyBudgetPersistenceError(error);
    }
  }
  return createPersistedReplyBudget(state, persist);
}

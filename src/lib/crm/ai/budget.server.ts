import "server-only";

import type { CompletionBudget } from "@/lib/ai/server/structuredCompletion";
import { saveCrmJobPayload, type CrmJob } from "../queue";
import {
  REPLY_BUDGET_PAYLOAD_KEY,
  createReplyBudgetState,
  replyBudgetAllows,
  replyBudgetStateFromPayload,
  type ReplyBudgetState,
} from "./budget";

/**
 * The job's reply budget as a CompletionBudget. State lives on the job's
 * payload: created on the first claim that needs it, topped up never, and
 * re-read from the claimed row on every retry, so no claim of the job can
 * reset it. Consumption is persisted before each transport request is
 * allowed; a failed save (a lost claim, a transient database error) degrades
 * to in-memory counting for this execution rather than failing the reply —
 * the deadline and cap still bind everything this process runs.
 */
export async function replyBudgetForJob(job: CrmJob): Promise<CompletionBudget> {
  let state: ReplyBudgetState = replyBudgetStateFromPayload(job.payload) ?? createReplyBudgetState(Date.now());
  const persist = async () => {
    try {
      await saveCrmJobPayload(job, { ...job.payload, [REPLY_BUDGET_PAYLOAD_KEY]: state });
    } catch (error) {
      console.warn(`[crm/budget] could not persist the reply budget for job ${job.id}:`, error);
    }
  };
  if (!replyBudgetStateFromPayload(job.payload)) await persist();
  return {
    deadlineAtMs: state.deadlineAtMs,
    beforeTransportRequest: async (nowMs) => {
      if (!replyBudgetAllows(state, nowMs)) return false;
      state = { ...state, callsUsed: state.callsUsed + 1 };
      await persist();
      return true;
    },
  };
}

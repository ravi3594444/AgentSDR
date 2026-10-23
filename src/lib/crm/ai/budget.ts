/**
 * One reply job, one budget — shared by every model call the job makes,
 * however deeply they nest, and persisted on the job row so queue retries
 * and process restarts cannot hand the work a fresh allowance.
 *
 * What counts: one unit is one *transport request* (one provider call),
 * including every retry inside a completion and the one AI/ML schema-format
 * resend. An *answer* is a stage's accepted result; a stage may spend
 * several units producing one answer. Grounding rejections are retries
 * inside the draft's completion, so they draw from the same budget without
 * extra plumbing.
 *
 * The defaults are sized from the reply paths' legitimate worst cases
 * (timeouts in the stage code): classification answers in one call (at most
 * 4 units with retries and the resend); the reply agent in at most 3 turns
 * (2 attempts each); a draft in one generation (at most 4 units); the
 * auto-send chain in a check (60s), one repair regeneration (30s) and a
 * re-check (60s). Ten units and 180 seconds fit all of those with headroom
 * for transient retries, while capping what the nested multipliers used to
 * allow: up to 3 job attempts × (3 model attempts + a resend) per stage,
 * roughly 13 minutes of provider time for one job. When the budget runs
 * out mid-chain, the last stage loses its tail retries and degrades to its
 * existing hold-for-review state — never to a canned message.
 */
export const REPLY_BUDGET_PAYLOAD_KEY = "replyBudget";
export const REPLY_BUDGET_MAX_CALLS = 10;
export const REPLY_BUDGET_TOTAL_MS = 180_000;

export type ReplyBudgetState = {
  /** Epoch milliseconds when the budget expires. */
  deadlineAtMs: number;
  /** Transport requests already spent, across every claim of the job. */
  callsUsed: number;
};

export function createReplyBudgetState(nowMs: number): ReplyBudgetState {
  return { deadlineAtMs: nowMs + REPLY_BUDGET_TOTAL_MS, callsUsed: 0 };
}

/** The budget persisted on a job's payload, or null when absent or malformed. */
export function replyBudgetStateFromPayload(payload: unknown): ReplyBudgetState | null {
  if (!payload || typeof payload !== "object") return null;
  const raw = (payload as Record<string, unknown>)[REPLY_BUDGET_PAYLOAD_KEY];
  if (!raw || typeof raw !== "object") return null;
  const { deadlineAtMs, callsUsed } = raw as { deadlineAtMs?: unknown; callsUsed?: unknown };
  if (typeof deadlineAtMs !== "number" || !Number.isFinite(deadlineAtMs) || deadlineAtMs <= 0) return null;
  if (typeof callsUsed !== "number" || !Number.isFinite(callsUsed) || callsUsed < 0) return null;
  return { deadlineAtMs, callsUsed: Math.floor(callsUsed) };
}

export function replyBudgetAllows(state: ReplyBudgetState, nowMs: number): boolean {
  return state.callsUsed < REPLY_BUDGET_MAX_CALLS && nowMs < state.deadlineAtMs;
}

export function replyBudgetRemainingMs(state: ReplyBudgetState, nowMs: number): number {
  return Math.max(0, state.deadlineAtMs - nowMs);
}

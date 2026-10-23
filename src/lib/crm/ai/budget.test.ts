import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  REPLY_BUDGET_MAX_CALLS,
  REPLY_BUDGET_PAYLOAD_KEY,
  REPLY_BUDGET_TOTAL_MS,
  createReplyBudgetState,
  replyBudgetAllows,
  replyBudgetRemainingMs,
  replyBudgetStateFromPayload,
} from "./budget";

describe("reply budget state", () => {
  it("starts with the full allowance and the documented deadline", () => {
    const state = createReplyBudgetState(1_000_000);
    assert.equal(state.callsUsed, 0);
    assert.equal(state.deadlineAtMs, 1_000_000 + REPLY_BUDGET_TOTAL_MS);
    assert.equal(replyBudgetAllows(state, 1_000_000), true);
    assert.equal(replyBudgetRemainingMs(state, 1_000_000), REPLY_BUDGET_TOTAL_MS);
  });

  it("stops at the call cap even with time left", () => {
    const state = { deadlineAtMs: 1_000_000 + REPLY_BUDGET_TOTAL_MS, callsUsed: REPLY_BUDGET_MAX_CALLS };
    assert.equal(replyBudgetAllows(state, 1_000_000), false);
  });

  it("stops at the deadline even with calls left", () => {
    const state = createReplyBudgetState(1_000_000);
    assert.equal(replyBudgetAllows(state, state.deadlineAtMs), false);
    assert.equal(replyBudgetRemainingMs(state, state.deadlineAtMs + 5_000), 0);
  });

  it("round-trips through the job payload and rejects malformed values", () => {
    const state = createReplyBudgetState(2_000_000);
    const payload = { expectedContextVersion: 3, [REPLY_BUDGET_PAYLOAD_KEY]: state };
    assert.deepEqual(replyBudgetStateFromPayload(payload), state);
    assert.equal(replyBudgetStateFromPayload({}), null);
    assert.equal(replyBudgetStateFromPayload(null), null);
    assert.equal(replyBudgetStateFromPayload({ [REPLY_BUDGET_PAYLOAD_KEY]: { deadlineAtMs: "soon", callsUsed: 1 } }), null);
    assert.equal(replyBudgetStateFromPayload({ [REPLY_BUDGET_PAYLOAD_KEY]: { deadlineAtMs: 5, callsUsed: -1 } }), null);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  REPLY_BUDGET_MAX_CALLS,
  REPLY_BUDGET_PAYLOAD_KEY,
  REPLY_BUDGET_TOTAL_MS,
  ReplyBudgetPersistenceError,
  createPersistedReplyBudget,
  createReplyBudgetState,
  replyBudgetAllows,
  replyBudgetRemainingMs,
  replyBudgetStateFromPayload,
  type ReplyBudgetState,
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

describe("persisted reply budget (RR1: fails closed)", () => {
  it("authorizes exactly the cap when every persist succeeds, recording each request first", async () => {
    const recorded: number[] = [];
    const budget = createPersistedReplyBudget(createReplyBudgetState(1_000_000), async (state) => {
      recorded.push(state.callsUsed);
    });
    let allowed = 0;
    for (let n = 0; n < REPLY_BUDGET_MAX_CALLS + 3; n++) {
      if (await budget.beforeTransportRequest(1_000_000)) allowed++;
    }
    assert.equal(allowed, REPLY_BUDGET_MAX_CALLS);
    assert.deepEqual(recorded, Array.from({ length: REPLY_BUDGET_MAX_CALLS }, (_, i) => i + 1));
  });

  it("authorizes nothing when persistence fails, and does not spend the allowance", async () => {
    let fail = true;
    const recorded: ReplyBudgetState[] = [];
    const budget = createPersistedReplyBudget(createReplyBudgetState(1_000_000), async (state) => {
      if (fail) throw new Error("database unavailable");
      recorded.push(state);
    });
    await assert.rejects(
      async () => { await budget.beforeTransportRequest(1_000_000); },
      (error: unknown) => error instanceof ReplyBudgetPersistenceError,
    );
    // Once persistence works again the full allowance is still there: the
    // failed attempt was never counted, in memory or on the row.
    fail = false;
    assert.equal(await budget.beforeTransportRequest(1_000_000), true);
    assert.equal(recorded[0]?.callsUsed, 1);
  });

  it("propagates a lost claim as-is instead of authorizing the request", async () => {
    const claimLost = new Error("CRM job j-1 is no longer owned by this worker");
    claimLost.name = "CrmJobClaimLostError";
    const budget = createPersistedReplyBudget(createReplyBudgetState(1_000_000), async () => {
      throw claimLost;
    });
    await assert.rejects(async () => { await budget.beforeTransportRequest(1_000_000); }, (error: unknown) => error === claimLost);
  });

  it("still refuses at the deadline without persisting anything", async () => {
    let persists = 0;
    const state = createReplyBudgetState(1_000_000);
    const budget = createPersistedReplyBudget(state, async () => { persists++; });
    assert.equal(await budget.beforeTransportRequest(state.deadlineAtMs), false);
    assert.equal(persists, 0);
  });
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

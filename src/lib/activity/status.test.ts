import { describe, expect, test } from "bun:test";
import { jobState, OPEN_STATES, replyState, runState, WORK_STATE_LABELS, type JobFacts } from "./status";

const now = new Date("2026-10-18T12:00:00Z");
const job = (facts: Partial<JobFacts>): JobFacts => ({ status: "queued", runAfter: null, heartbeatAt: null, attempts: 0, progress: null, result: null, ...facts });

describe("a job's state is read from its record, never guessed", () => {
  test("a queued job waiting for an Apify slot or a provider limit says so, with the recorded reason", () => {
    expect(jobState(job({ progress: { waiting: { kind: "slot", reason: "both Apify runs are busy" } } }), now)).toEqual({ state: "waiting_slot", reason: "both Apify runs are busy" });
    expect(jobState(job({ progress: { waiting: { kind: "quota", reason: "TinyFish Search allows 30 a minute" } } }), now)).toEqual({ state: "waiting_quota", reason: "TinyFish Search allows 30 a minute" });
  });

  test("running with a fresh heartbeat is working; with a heartbeat over 3 minutes old it is stalled, not working", () => {
    expect(jobState(job({ status: "running", heartbeatAt: new Date(now.getTime() - 60_000) }), now).state).toBe("executing");
    const stale = jobState(job({ status: "running", heartbeatAt: new Date(now.getTime() - 4 * 60_000) }), now);
    expect(stale.state).toBe("stale");
    expect(stale.reason).toContain("picked up again");
  });

  test("a retry carries the last error; a later run_after without one is scheduled; otherwise queued", () => {
    expect(jobState(job({ attempts: 1, progress: { lastError: "timeout" } }), now)).toEqual({ state: "retrying", reason: "timeout" });
    expect(jobState(job({ runAfter: new Date(now.getTime() + 60_000) }), now).state).toBe("scheduled");
    expect(jobState(job({ runAfter: new Date(now.getTime() + 1_000) }), now).state).toBe("queued");
  });

  test("a search that ended without searching (handed on, or the platform not searched) is not reported as done", () => {
    expect(jobState(job({ status: "succeeded", result: { notSearched: true, note: "Apify is not connected" } }), now)).toEqual({ state: "not_searched", reason: "Apify is not connected" });
    expect(jobState(job({ status: "succeeded", result: { handedToJobId: "x" } }), now).state).toBe("not_searched");
    expect(jobState(job({ status: "succeeded", result: { found: 12 } }), now)).toEqual({ state: "completed", reason: null });
    expect(jobState(job({ status: "failed" }), now).state).toBe("failed");
    expect(jobState(job({ status: "cancelled" }), now).state).toBe("cancelled");
  });
});

test("an outreach plan's state: proposed needs Start; running is working, not a confirmed send", () => {
  expect(runState("proposed")).toBe("needs_approval");
  expect(runState("starting")).toBe("executing");
  expect(runState("running")).toBe("executing");
  expect(runState("paused")).toBe("paused");
  expect(runState("completed")).toBe("completed");
  expect(runState("stopped")).toBe("completed");
  expect(runState("cancelled")).toBe("cancelled");
  expect(runState("failed")).toBe("failed");
});

test("open states are exactly the ones that can still change on their own", () => {
  for (const state of Object.keys(WORK_STATE_LABELS) as (keyof typeof WORK_STATE_LABELS)[]) {
    expect(OPEN_STATES.has(state)).toBe(!["completed", "not_searched", "failed", "cancelled"].includes(state));
  }
});

test("a reply waiting on the owner says Needs you even when an earlier message was answered", () => {
  expect(replyState({ answered: true, latest: true, workflowState: "action_required" })).toBe("needs_you");
  expect(replyState({ answered: true, latest: true, workflowState: "waiting" })).toBe("answered");
  expect(replyState({ answered: false, latest: true, workflowState: "classifying" })).toBe("processing");
  expect(replyState({ answered: false, latest: true, workflowState: "unclassified" })).toBe("processing");
  expect(replyState({ answered: false, latest: true, workflowState: null })).toBe("waiting");
});

test("the record's state belongs to its newest reply: an older answered reply stays Answered", () => {
  expect(replyState({ answered: true, latest: false, workflowState: "action_required" })).toBe("answered");
  // An older reply nobody answered is still part of the open question.
  expect(replyState({ answered: false, latest: false, workflowState: "action_required" })).toBe("needs_you");
});

test("an open owner decision keeps the newest reply in Needs you after the assistant's answer", () => {
  expect(replyState({ answered: true, latest: true, workflowState: "idle", needsYou: true })).toBe("needs_you");
  expect(replyState({ answered: true, latest: false, workflowState: "idle", needsYou: true })).toBe("answered");
  expect(replyState({ answered: true, latest: true, workflowState: "idle", needsYou: false })).toBe("answered");
});

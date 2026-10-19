import { describe, expect, test } from "bun:test";
import { canCancelJob, jobState, OPEN_STATES, planCounts, planState, REPLY_STATE_LABELS, repliesSeenUntil, replyState, runState, WORK_STATE_LABELS, type JobFacts } from "./status";
import type { SenderStatus } from "@/lib/assistant/runEvidence";

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
  // A partial job is finished; a partial plan is still running, and planState says so itself.
  for (const state of Object.keys(WORK_STATE_LABELS) as (keyof typeof WORK_STATE_LABELS)[]) {
    expect(OPEN_STATES.has(state)).toBe(!["completed", "partial", "not_searched", "failed", "cancelled"].includes(state));
  }
});

test("a reply waiting on the owner says Needs you even when an earlier message was answered", () => {
  expect(replyState({ answered: true, latest: true, workflowState: "action_required", needsYou: true })).toBe("needs_you");
  expect(replyState({ answered: true, latest: true, workflowState: "waiting" })).toBe("answered");
  expect(replyState({ answered: false, latest: true, workflowState: "classifying" })).toBe("processing");
  expect(replyState({ answered: false, latest: true, workflowState: "unclassified" })).toBe("processing");
  expect(replyState({ answered: false, latest: true, workflowState: null })).toBe("waiting");
});

test("the record's state belongs to its newest reply: an older answered reply stays Answered", () => {
  expect(replyState({ answered: true, latest: false, workflowState: "action_required" })).toBe("answered");
  // An older reply nobody answered is still part of the open question.
  expect(replyState({ answered: false, latest: false, workflowState: "action_required", needsYou: true })).toBe("needs_you");
  expect(replyState({ answered: false, latest: false, workflowState: "action_required" })).toBe("action_required");
});

test("Needs you is the CRM's Needs you: Action required with no open decision or draft is Action required", () => {
  expect(replyState({ answered: false, latest: true, workflowState: "action_required", needsYou: false })).toBe("action_required");
  expect(replyState({ answered: true, latest: true, workflowState: "action_required" })).toBe("action_required");
  expect(replyState({ answered: false, latest: true, workflowState: "action_required", needsYou: true })).toBe("needs_you");
  expect(REPLY_STATE_LABELS.action_required).toBe("Action required");
  expect(REPLY_STATE_LABELS.needs_you).toBe("Needs you");
});

test("Activity cancels search jobs only; a plan's start is stopped through the plan", () => {
  for (const kind of ["discovery", "web_discovery", "linkedin_search", "apify_instagram"]) {
    expect(canCancelJob({ kind, status: "queued" })).toBe(true);
    expect(canCancelJob({ kind, status: "running" })).toBe(true);
    expect(canCancelJob({ kind, status: "succeeded" })).toBe(false);
    expect(canCancelJob({ kind, status: "cancelled" })).toBe(false);
  }
  expect(canCancelJob({ kind: "outreach_start", status: "queued" })).toBe(false);
  expect(canCancelJob({ kind: "outreach_start", status: "running" })).toBe(false);
  expect(canCancelJob({ kind: "something_new", status: "queued" })).toBe(false);
});

describe("replies are marked seen only up to what the full list showed", () => {
  const reply = (recordedAt: string, isNew: boolean) => ({ recordedAt, isNew });
  test("the newest recorded time shown, when the unfiltered list shows something new", () => {
    expect(repliesSeenUntil("all", [reply("2026-10-18T10:00:00.000Z", false), reply("2026-10-18T11:30:00.000Z", true), reply("2026-10-18T11:00:00.000Z", true)])).toBe("2026-10-18T11:30:00.000Z");
  });
  test("a late-recorded reply further down the list still sets the mark", () => {
    expect(repliesSeenUntil("all", [reply("2026-10-18T11:00:00.000Z", false), reply("2026-10-18T12:00:00.000Z", true)])).toBe("2026-10-18T12:00:00.000Z");
  });
  test("nothing new, or a channel filter hiding other channels' replies: nothing is marked", () => {
    expect(repliesSeenUntil("all", [reply("2026-10-18T11:00:00.000Z", false)])).toBeNull();
    expect(repliesSeenUntil("all", [])).toBeNull();
    expect(repliesSeenUntil("email", [reply("2026-10-18T11:00:00.000Z", true)])).toBeNull();
  });
});

test("an open owner decision keeps the newest reply in Needs you after the assistant's answer", () => {
  expect(replyState({ answered: true, latest: true, workflowState: "idle", needsYou: true })).toBe("needs_you");
  expect(replyState({ answered: true, latest: false, workflowState: "idle", needsYou: true })).toBe("answered");
  expect(replyState({ answered: true, latest: true, workflowState: "idle", needsYou: false })).toBe("answered");
});

describe("partial work and sending hours are told apart from done and working", () => {
  test("a search cut short, or with some of its searches failed, is partial with the reason; its leads are kept", () => {
    const cut = jobState(job({ status: "succeeded", progress: { stage: "done", partial: true }, result: { found: 7 } }), now);
    expect(cut.state).toBe("partial");
    expect(cut.reason).toContain("cut short");
    const someFailed = jobState(job({ status: "succeeded", result: { found: 4, searches: [{ query: "a", error: null }, { query: "b", error: "TinyFish answered 503" }, { query: "c", error: null }] } }), now);
    expect(someFailed).toEqual({ state: "partial", reason: "1 of 3 searches failed (TinyFish answered 503); what the others found is kept" });
    expect(jobState(job({ status: "succeeded", result: { found: 4, searches: [{ query: "a", error: null }] } }), now).state).toBe("completed");
    expect(OPEN_STATES.has("partial")).toBe(false);
  });

  const sender = (gates: string[], nextAt: string | null = null): SenderStatus => ({ channel: "whatsapp", account: "+91 98220 11111", timezone: "Asia/Kolkata", gates, nextAt, queued: 3, note: null });

  test("a running plan whose every sender is outside its hours says so, with the earliest next send", () => {
    const linkedinAccount: SenderStatus = { ...sender(["Outside working hours (Mon–Fri 09:00–18:00 America/New_York)"], "2026-10-18T13:00:00.000Z"), channel: "linkedin", account: "Ravi" };
    const state = planState({ status: "running", error: null, senders: [sender(["Outside campaign sending hours (Asia/Kolkata)"], "2026-10-19T03:30:00.000Z"), linkedinAccount] });
    expect(state).toEqual({ state: "outside_hours", reason: "every sender is outside its sending hours", open: true, nextAt: "2026-10-18T13:00:00.000Z" });
    expect(WORK_STATE_LABELS.outside_hours).toBe("Outside sending hours");
  });

  test("outside its hours and also held by something with no known end (a disconnection) names every hold, not only the hours", () => {
    const held = planState({ status: "running", error: null, senders: [sender(["Unipile is disconnected", "Outside working hours (Mon–Fri 09:00–18:00 UTC)"], null)] });
    expect(held).toEqual({ state: "executing", reason: "no sender can send right now: Unipile is disconnected; Outside working hours (Mon–Fri 09:00–18:00 UTC)", open: true, nextAt: null });
  });

  test("one sender inside its hours keeps the plan working; every sender held by something else names the holds", () => {
    expect(planState({ status: "running", error: null, senders: [sender(["Outside campaign sending hours (Asia/Kolkata)"]), sender([])] }).state).toBe("executing");
    const held = planState({ status: "running", error: null, senders: [sender(["Daily limit of 25 new chats used"], "2026-10-19T03:30:00.000Z")] });
    expect(held).toEqual({ state: "executing", reason: "no sender can send right now: Daily limit of 25 new chats used", open: true, nextAt: "2026-10-19T03:30:00.000Z" });
  });

  test("a running plan with a channel that failed to launch is partial and still open; without senders it is working", () => {
    expect(planState({ status: "running", error: "email: no mailbox is connected", senders: [sender([])] })).toEqual({ state: "partial", reason: "running on its other channels; email: no mailbox is connected", open: true, nextAt: null });
    expect(planState({ status: "running", error: null, senders: null }).state).toBe("executing");
    expect(planState({ status: "paused", error: null, senders: null })).toEqual({ state: "paused", reason: null, open: true, nextAt: null });
    expect(planState({ status: "stopped", error: null, senders: null }).open).toBe(false);
  });

  test("a plan's counts: contacted means accepted for sending at least, never an uncertain or failed send; replied is a recorded reply", () => {
    const tones = ["waiting", "sent", "sent", "replied", "good", "failed", "stopped"] as const;
    expect(planCounts(tones.map((tone) => ({ progress: { tone, text: "" } })))).toEqual({ leads: 7, contacted: 4, replied: 2 });
    expect(planCounts([])).toEqual({ leads: 0, contacted: 0, replied: 0 });
  });
});

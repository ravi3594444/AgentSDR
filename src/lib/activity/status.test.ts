import { describe, expect, test } from "bun:test";
import { canCancelJob, failedSummary, jobState, nextAtPhrase, OPEN_STATES, planCounts, planOutcome, planState, reasonGivesTime, REPLY_STATE_LABELS, repliesSeenUntil, replyState, runState, WORK_STATE_LABELS, type JobFacts, type PlanLead } from "./status";
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

  const sender = (gates: string[], nextAt: string | null = null, queued = 3): SenderStatus => ({ channel: "whatsapp", account: "+91 98220 11111", timezone: null, gates, nextAt, queued, note: null, limits: null, details: [] });

  test("sending is always on: there is no outside-hours state", () => {
    expect(Object.keys(WORK_STATE_LABELS)).not.toContain("outside_hours");
    expect(Object.values(WORK_STATE_LABELS).join(" ")).not.toMatch(/hours/i);
  });

  test("one sender with nothing holding it keeps the plan working; every sender held is waiting to send, not working, and names the holds", () => {
    expect(planState({ status: "running", error: null, senders: [sender(["Unipile is disconnected"]), sender([])] }).state).toBe("executing");
    const held = planState({ status: "running", error: null, senders: [sender(["25 of 25 new chats used in the last 24 hours"], "2026-10-19T03:30:00.000Z")] });
    expect(held).toEqual({ state: "waiting_send", reason: "no sender can send right now: 25 of 25 new chats used in the last 24 hours", open: true, nextAt: "2026-10-19T03:30:00.000Z" });
    expect(WORK_STATE_LABELS.waiting_send).toBe("Waiting to send");
    const disconnected = planState({ status: "running", error: null, senders: [sender(["Unipile is disconnected", "The number is disconnected"], null)] });
    expect(disconnected).toEqual({ state: "waiting_send", reason: "no sender can send right now: Unipile is disconnected; The number is disconnected", open: true, nextAt: null });
  });

  test("a running plan with a channel that failed to launch is partial and still open; without senders it is working", () => {
    expect(planState({ status: "running", error: "email: no mailbox is connected", senders: [sender([])] })).toEqual({ state: "partial", reason: "running on its other channels; email: no mailbox is connected", open: true, nextAt: null });
    expect(planState({ status: "running", error: null, senders: null }).state).toBe("executing");
    expect(planState({ status: "paused", error: null, senders: null })).toEqual({ state: "paused", reason: null, open: true, nextAt: null });
    expect(planState({ status: "stopped", error: null, senders: null }).open).toBe(false);
  });

  test("a plan's counts: contacted means accepted for sending at least, never an uncertain or failed send; replied is a recorded reply", () => {
    const tones = ["waiting", "sent", "sent", "replied", "good", "failed", "stopped"] as const;
    expect(planCounts(tones.map((tone) => ({ progress: { tone, text: "" } })))).toEqual({ leads: 7, contacted: 4, replied: 2, failed: 1 });
    expect(planCounts([])).toEqual({ leads: 0, contacted: 0, replied: 0, failed: 0 });
  });
});

describe("a running plan with nothing left to send says how it ended, never that it is sending", () => {
  const REFUSAL = "Could not send: WhatsApp rejected this recipient. Check the number and whether the profile is restricted; WhatsApp registration was not confirmed.";
  const lead = (tone: PlanLead["progress"]["tone"], open: boolean, contacted = tone === "sent" || tone === "replied" || tone === "good", text = ""): PlanLead => ({ progress: { tone, text }, reach: { contacted, replied: tone === "replied" || tone === "good" }, open });
  const waiting = () => lead("waiting", true);
  const failed = () => lead("failed", false, false, REFUSAL);
  const sentFollowUpDue = () => lead("sent", true);
  const sentDone = () => lead("sent", false);
  const sender = (queued: number, gates: string[] = []): SenderStatus => ({ channel: "whatsapp", account: "+1 415 555 0000", timezone: null, gates, nextAt: null, queued, note: null, limits: null, details: [] });
  const running = (leads: PlanLead[], senders: SenderStatus[] | null = [sender(0)]) => planState({ status: "running", error: null, senders, leads });

  test("all queued: still working, nothing claimed about an outcome", () => {
    const state = running([waiting(), waiting()], [sender(2)]);
    expect(state.state).toBe("executing");
    expect(state.open).toBe(true);
    expect(state.reason).toContain("sending within each channel's daily limits");
  });

  test("its only lead rejected by WhatsApp: failed, with the recorded reason and 0 contacted; nothing left to send", () => {
    const state = running([failed()]);
    expect(state).toEqual({ state: "failed", reason: "1 failed (WhatsApp rejected this recipient), 0 contacted; nothing left to send", open: false, nextAt: null });
    expect(planCounts([failed()])).toEqual({ leads: 1, contacted: 0, replied: 0, failed: 1 });
  });

  test("6 sent with follow-ups pending and 6 failed: still working, and the failures are named", () => {
    const leads = [...Array.from({ length: 6 }, sentFollowUpDue), ...Array.from({ length: 6 }, failed)];
    const state = running(leads, [sender(6)]);
    expect(state.state).toBe("executing");
    expect(state.open).toBe(true);
    expect(state.reason).toBe("sending within each channel's daily limits; sent messages show in Replies and Overview; 6 failed (WhatsApp rejected this recipient) so far");
    expect(planCounts(leads)).toEqual({ leads: 12, contacted: 6, replied: 0, failed: 6 });
  });

  test("6 sent and 6 failed with nothing left: partly done, both counted", () => {
    const state = running([...Array.from({ length: 6 }, sentDone), ...Array.from({ length: 6 }, failed)]);
    expect(state).toEqual({ state: "partial", reason: "6 contacted, 6 failed (WhatsApp rejected this recipient); nothing left to send", open: false, nextAt: null });
  });

  test("all sent and no follow-ups left: done; with follow-ups pending: working", () => {
    expect(running([sentDone(), lead("replied", false)])).toEqual({ state: "completed", reason: "all 2 contacted; nothing left to send", open: false, nextAt: null });
    expect(running([sentFollowUpDue(), sentDone()], [sender(1)]).state).toBe("executing");
  });

  test("nothing remaining for anyone, but a sender still has leads waiting (added to its campaign): not finished", () => {
    expect(running([sentDone()], [sender(3)]).state).toBe("executing");
  });

  test("leads stopped before any message and a launch error are named; a lead with no engine row yet keeps it open", () => {
    const stopped = lead("stopped", false, false);
    expect(running([sentDone(), stopped]).reason).toBe("1 contacted, 1 stopped before a message; nothing left to send");
    expect(planState({ status: "running", error: "email: no mailbox is connected", senders: null, leads: [sentDone()] })).toEqual({ state: "partial", reason: "all 1 contacted; nothing left to send; email: no mailbox is connected", open: false, nextAt: null });
    expect(planOutcome([sentDone(), { progress: { tone: "waiting", text: "Not started yet" } }])).toBeNull();
    expect(planOutcome([])).toBeNull();
  });

  test("the failure reason is the recorded one, shortened; several reasons are counted", () => {
    expect(failedSummary([failed(), lead("failed", false, false, "Delivery uncertain; no automatic resend. Check the chat in WhatsApp Messages"), lead("failed", false, false, "Could not send")]))
      .toBe("3 failed (WhatsApp rejected this recipient; 2 other reasons)");
    expect(failedSummary([lead("failed", false, false, "Could not send")])).toBe("1 failed (no reason recorded)");
    expect(failedSummary([sentDone()])).toBeNull();
  });

  test("a paused or stopped plan keeps its own status; viewing it decides nothing new", () => {
    expect(planState({ status: "paused", error: null, senders: null, leads: [failed()] }).state).toBe("paused");
    expect(planState({ status: "stopped", error: null, senders: null, leads: [failed()] }).state).toBe("completed");
  });
});

// P04: the lead's real delivery state first. The live "Direct email lead"
// case: its first email went out, its follow-up is days away, the queue is
// empty, and the mailbox is pausing between sends. That is a plan waiting for
// a reply with a follow-up scheduled, not "no sender can send right now".
describe("an email plan says where its leads stand before what its senders are doing", () => {
  const at = new Date("2026-10-21T16:30:00Z");
  const followUp = "2026-10-23T16:24:42.353Z";
  const mailbox = (gates: string[], queued: number, nextAt: string | null = null): SenderStatus => ({ channel: "email", account: "ravi@leadx.example", timezone: "Asia/Kolkata", gates, nextAt, queued, note: null, limits: null, details: [] });
  const sentLead = (nextAt: string | null, queued = false): PlanLead => ({ progress: { tone: "sent", text: "First email sent — waiting for a reply" }, reach: { contacted: true, replied: false }, open: true, nextAt, queued, firstMessage: false });
  const pendingLead = (queued: boolean): PlanLead => ({ progress: { tone: "waiting", text: "Waiting to send" }, reach: { contacted: false, replied: false }, open: true, nextAt: null, queued, firstMessage: true });
  const running = (leads: PlanLead[], senders: SenderStatus[]) => planState({ status: "running", error: null, senders, leads, now: at });

  test("the Direct email lead case: sent, a later follow-up, a gap and an empty queue read 'scheduled' with the follow-up's time", () => {
    const gates = ["Next send is allowed at 2026-10-21T16:24:42.353Z", "No send is in this mailbox's queue for an active campaign; the send tick does not build the queue"];
    expect(running([sentLead(followUp)], [mailbox(gates, 0, "2026-10-21T16:44:42.353Z")])).toEqual({ state: "scheduled", reason: "1 contacted — waiting for a reply", open: true, nextAt: followUp });
    expect(WORK_STATE_LABELS.scheduled).toBe("Scheduled");
    // The earliest follow-up of several, and the plan's failures still counted.
    const later = "2026-10-25T09:00:00.000Z";
    const failed: PlanLead = { progress: { tone: "failed", text: "Could not send: Gmail answered 550" }, reach: { contacted: false, replied: false }, open: false };
    expect(running([sentLead(later), sentLead(followUp), failed], [mailbox([], 0)])).toEqual({ state: "scheduled", reason: "2 contacted — waiting for a reply; 1 failed (Gmail answered 550) so far", open: true, nextAt: followUp });
  });

  test("a reason that already says when its wait ends does not get the time again", () => {
    expect(reasonGivesTime("Daily lead limit reached (8 of 8 new leads today); resets Thursday 22 Oct at 00:00 (UTC)")).toBe(true);
    expect(reasonGivesTime("Pausing between sends until 19:27:03 (UTC)")).toBe(true);
    expect(reasonGivesTime("3 contacted — waiting for a reply")).toBe(false);
    expect(reasonGivesTime(null)).toBe(false);
  });

  test("due work with the senders not looked at: no promise that it is prepared", () => {
    const state = planState({ status: "running", error: null, senders: null, leads: [pendingLead(false)], now: at });
    expect(state.reason ?? "").not.toContain("not prepared");
  });

  test("a first email due with nothing in the queue: not prepared yet, and what prepares it; never a cooldown", () => {
    // The mailbox is pausing between sends, but nothing queued waits on it: the pause is a detail (emailSenderStatus), not a hold.
    const pausing = { ...mailbox([], 0), details: ["Pausing between sends until 22:14 (Asia/Kolkata); no queued email waits on it."] };
    expect(running([pendingLead(false)], [pausing])).toEqual({ state: "waiting_send", reason: "1 due message is not prepared for sending yet; the queue is topped up every 10 minutes while its sender is connected and has room today", open: true, nextAt: null });
    expect(running([pendingLead(false), sentLead(null)], [mailbox([], 0)]).reason).toBe("2 due messages are not prepared for sending yet; the queue is topped up every 10 minutes while their sender is connected and has room today");
  });

  test("…unless a sender holds it for a reason of its own: the hold is named (a disconnected mailbox, its daily send limit)", () => {
    expect(running([pendingLead(false)], [mailbox(["Mailbox status is disconnected"], 0)])).toEqual({ state: "waiting_send", reason: "no sender can send right now: Mailbox status is disconnected", open: true, nextAt: null });
    expect(running([pendingLead(false)], [mailbox(["Mailbox has used its daily limit of 30 (Asia/Kolkata)"], 0, "2026-10-21T18:30:00.000Z")]).nextAt).toBe("2026-10-21T18:30:00.000Z");
  });

  test("a queued first email held by the gap between sends shows the cooldown, with when it ends", () => {
    const gap = "Pausing between sends until 22:14:42 (Asia/Kolkata)";
    expect(running([pendingLead(true)], [mailbox([gap], 1, "2026-10-21T16:44:42.353Z")])).toEqual({ state: "waiting_send", reason: `no sender can send right now: ${gap}`, open: true, nextAt: "2026-10-21T16:44:42.353Z" });
    expect(running([pendingLead(true)], [mailbox([], 1)]).state).toBe("executing");
  });

  test("first emails held by the daily lead limit: its own state, with the reset time", () => {
    const limit = "Daily lead limit reached (50 of 50 new leads today); resets Thursday 22 Oct at 00:00 (Asia/Kolkata)";
    const resets = "2026-10-21T18:30:00.000Z";
    const state = running([pendingLead(false), sentLead(followUp)], [mailbox([limit], 0, resets)]);
    expect(state).toEqual({ state: "daily_lead_limit", reason: limit, open: true, nextAt: resets });
    expect(WORK_STATE_LABELS.daily_lead_limit).toBe("Daily lead limit reached");
    expect(OPEN_STATES.has("daily_lead_limit")).toBe(true);
    // Any channel: a WhatsApp number whose first messages wait for the limit.
    const number = (gates: string[], nextAt: string | null): SenderStatus => ({ channel: "whatsapp", account: "+91 98220 11111", timezone: null, gates, nextAt, queued: 4, note: null, limits: null, details: [] });
    const whatsappLead: PlanLead = { progress: { tone: "waiting", text: "Waiting to send" }, reach: { contacted: false, replied: false }, open: true };
    expect(planState({ status: "running", error: null, senders: [number([limit], resets)], leads: [whatsappLead] })).toEqual({ state: "daily_lead_limit", reason: limit, open: true, nextAt: resets });
    // Held by something else too: every hold is named.
    expect(planState({ status: "running", error: null, senders: [number(["Unipile is disconnected", limit], null)], leads: [whatsappLead] }).state).toBe("waiting_send");
  });
});

test("the time beside a plan's reason says what it is: the next follow-up, the limit's reset, or the next allowed send", () => {
  expect(nextAtPhrase("scheduled")).toBe("next follow-up");
  expect(nextAtPhrase("daily_lead_limit")).toBe("resets");
  expect(nextAtPhrase("waiting_send")).toBe("the next send is allowed");
});

describe("an owner request's research (its objective job)", () => {
  test("while its searches run or the assistant picks the next source, it is working, with what it waits for", () => {
    expect(jobState(job({ runAfter: new Date(now.getTime() + 60_000), progress: { stage: "watching", leads: 12, leadTarget: 40, waiting: { kind: "objective", reason: "the assistant is choosing the next source" } } }), now))
      .toEqual({ state: "executing", reason: "the assistant is choosing the next source" });
  });

  test("stopped short of its target it is partly done with the real reason; the target reached is done; cancelled and failed say so", () => {
    expect(jobState(job({ status: "succeeded", result: { stopReason: "budget_spent", leads: 18, leadTarget: 40 } }), now)).toEqual({ state: "partial", reason: "18 of 40 leads; stopped because the spend cap was used" });
    expect(jobState(job({ status: "succeeded", result: { stopReason: "time_limit", leads: 3, leadTarget: 25 } }), now).reason).toBe("3 of 25 leads; stopped because the time limit passed");
    expect(jobState(job({ status: "succeeded", result: { stopReason: "sources_exhausted", leads: 0, leadTarget: 25 } }), now).state).toBe("partial");
    expect(jobState(job({ status: "succeeded", result: { stopReason: "target_reached", leads: 41, leadTarget: 40 } }), now)).toEqual({ state: "completed", reason: "41 of 40 leads; the target was reached" });
    expect(jobState(job({ status: "succeeded", result: { stopReason: "cancelled", leads: 5, leadTarget: 40 } }), now).state).toBe("cancelled");
    expect(jobState(job({ status: "succeeded", result: { stopReason: "failed", leads: 5, leadTarget: 40 } }), now).state).toBe("failed");
  });
});

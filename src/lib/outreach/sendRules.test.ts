import { describe, expect, test } from "bun:test";
import { alwaysOpenHours } from "./workingHours";
import { leadDueNow, newLeadsToQueue, topUpRoom } from "./sendRules";

const now = new Date("2026-10-21T16:30:00Z");

describe("leadDueNow: a claimed queue row only sends what is due", () => {
  test("a first email (pending, no next send time) is due", () => {
    expect(leadDueNow({ sequenceStatus: "pending", nextSendAt: null }, now)).toBe(true);
    expect(leadDueNow({ sequenceStatus: "pending", nextSendAt: new Date("2026-10-21T16:00:00Z") }, now)).toBe(true);
  });

  test("a follow-up is due only once its time has come", () => {
    expect(leadDueNow({ sequenceStatus: "initial_sent", nextSendAt: new Date("2026-10-21T16:29:59Z") }, now)).toBe(true);
    expect(leadDueNow({ sequenceStatus: "in_follow_up", nextSendAt: now }, now)).toBe(true);
    // A stale row for a lead that advanced since it was queued: its follow-up is days away.
    expect(leadDueNow({ sequenceStatus: "initial_sent", nextSendAt: new Date("2026-10-23T16:30:00Z") }, now)).toBe(false);
    expect(leadDueNow({ sequenceStatus: "pending", nextSendAt: new Date("2026-10-22T00:00:00Z") }, now)).toBe(false);
  });

  test("a follow-up with no time, or a lead out of its sequence, is never due", () => {
    expect(leadDueNow({ sequenceStatus: "in_follow_up", nextSendAt: null }, now)).toBe(false);
    for (const status of ["reply_received", "reply_processing", "sequence_completed", "bounced", "suppressed"] as const) {
      expect(leadDueNow({ sequenceStatus: status, nextSendAt: new Date("2026-10-20T00:00:00Z") }, now)).toBe(false);
    }
  });
});

describe("topUpRoom: what a top-up may add to a mailbox's queue", () => {
  const mailbox = { dailySendLimit: 30, todayEmailsSent: 12, sendCounterResetAt: new Date("2026-10-21T02:00:00Z"), workingHours: alwaysOpenHours("Asia/Kolkata") };

  test("the daily limit, less what was sent today and what is already queued", () => {
    expect(topUpRoom(mailbox, 5, now)).toBe(13);
    expect(topUpRoom({ ...mailbox, todayEmailsSent: 30 }, 0, now)).toBe(0);
    expect(topUpRoom(mailbox, 40, now)).toBe(0);
  });

  test("a counter from an earlier day (not reset yet) is skipped: only the daily build resets it", () => {
    expect(topUpRoom({ ...mailbox, sendCounterResetAt: new Date("2026-10-20T10:00:00Z") }, 0, now)).toBeNull();
    expect(topUpRoom({ ...mailbox, sendCounterResetAt: null }, 0, now)).toBeNull();
  });
});

describe("newLeadsToQueue: first emails within the daily lead limit's places", () => {
  const lead = (id: string, contacted = false) => ({ id, contacted });

  test("people not yet contacted take today's remaining places; the rest wait", () => {
    expect(newLeadsToQueue([lead("a"), lead("b"), lead("c")], { places: 2, capacity: 10 })).toEqual(["a", "b"]);
    expect(newLeadsToQueue([lead("a"), lead("b")], { places: 0, capacity: 10 })).toEqual([]);
  });

  test("someone automated outreach already reached takes no place, so is not stuck behind the limit", () => {
    expect(newLeadsToQueue([lead("a"), lead("b", true), lead("c"), lead("d", true)], { places: 1, capacity: 10 })).toEqual(["a", "b", "d"]);
  });

  test("never more than the mailboxes' capacity", () => {
    expect(newLeadsToQueue([lead("a", true), lead("b", true), lead("c")], { places: 5, capacity: 2 })).toEqual(["a", "b"]);
  });
});

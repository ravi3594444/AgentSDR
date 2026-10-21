import { expect, test } from "bun:test";
import { alwaysOpenHours, mailboxHoursFromWeekly } from "@/lib/outreach/workingHours";
import { describeChannelSending } from "./results";
import { emailSendingStatus, mailboxDailyRoom } from "./sendingStatus";

const now = new Date("2026-10-19T10:00:00Z");
const mailbox = {
  status: "connected",
  provider: "unipile",
  unipileAccountId: "sender",
  todayEmailsSent: 0,
  dailySendLimit: 30,
  sendCounterResetAt: now,
  nextEmailTime: null,
  workingHours: alwaysOpenHours("UTC"),
  activeQueue: 3,
  providerConnected: true,
};
const input = { now, paused: false };
test("sending is always on: a mailbox's old restricted hours never block it, and no hours or window are reported", () => {
  const late = { ...mailbox, workingHours: mailboxHoursFromWeekly({ timezone: "UTC", days: [1], start: "15:00", end: "17:00" }) };
  const status = emailSendingStatus([{ ...mailbox, providerConnected: false }, late], input);
  expect(status.open).toBe(true);
  expect(status.blockedBy).toBeNull();
  expect(Object.keys(status)).not.toContain("hours");
  expect(describeChannelSending(status)).not.toMatch(/hours|window|queue/i);
});
test("spare capacity in an unqueued mailbox does not unblock a capped queued mailbox", () => {
  const status = emailSendingStatus(
    [
      { ...mailbox, todayEmailsSent: 30 },
      { ...mailbox, activeQueue: 0 },
    ],
    input,
  );
  expect(status.blockedBy).toBe("daily_limit");
  expect(describeChannelSending(status)).toBe("has used its mailboxes' daily send limits; each starts again at its own midnight");
});
test("stale counters use the new local day and future send gaps still block", () => {
  const stale = {
    ...mailbox,
    todayEmailsSent: 30,
    sendCounterResetAt: new Date("2026-10-18T10:00:00Z"),
  };
  expect(mailboxDailyRoom(stale, now)).toBe(30);
  expect(emailSendingStatus([stale], input).open).toBe(true);
  const pausing = emailSendingStatus([{ ...stale, nextEmailTime: new Date("2026-10-19T10:05:00Z") }], input);
  expect(pausing.blockedBy).toBe("throttled");
  expect(describeChannelSending(pausing)).toBe("is pausing between sends");
});
test("readiness is never presented as evidence that a send happened, and the queue stays out of the words", () => {
  const status = emailSendingStatus([mailbox], input);
  expect(status.open).toBe(true);
  expect(describeChannelSending(status)).toBe("has emails due and ready for the next send");
  expect(describeChannelSending(emailSendingStatus([{ ...mailbox, activeQueue: 0 }], input))).toBe("has nothing due to send right now");
  expect(
    emailSendingStatus([mailbox], { ...input, paused: true }).blockedBy,
  ).toBe("paused");
});
test("mixed per-mailbox blockers remain visible", () => {
  const status = emailSendingStatus(
    [
      { ...mailbox, todayEmailsSent: 30 },
      { ...mailbox, nextEmailTime: new Date("2026-10-19T10:05:00Z") },
    ],
    input,
  );
  expect(status.blockedBy).toBe("sender_checks");
  expect(status.detail).toContain("daily limit");
  expect(status.detail).toContain("Pausing between sends");
});

import { expect, test } from "bun:test";
import { mailboxHoursFromWeekly } from "@/lib/outreach/workingHours";
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
  workingHours: mailboxHoursFromWeekly({
    timezone: "UTC",
    days: [1, 2, 3, 4, 5],
    start: "09:00",
    end: "17:00",
  }),
  activeQueue: 3,
  providerConnected: true,
};
const input = { now, paused: false };
test("does not combine an open disconnected mailbox with a connected mailbox outside hours", () => {
  const late = {
    ...mailbox,
    workingHours: mailboxHoursFromWeekly({
      timezone: "UTC",
      days: [1],
      start: "15:00",
      end: "17:00",
    }),
  };
  const status = emailSendingStatus(
    [{ ...mailbox, providerConnected: false }, late],
    input,
  );
  expect(status.open).toBe(false);
  expect(status.blockedBy).toBe("outside_hours");
  expect(status.nextOpenAt).toBe("2026-10-19T15:00:00.000Z");
  expect(describeChannelSending(status)).toContain("next window");
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
});
test("stale counters use the new local day and future send gaps still block", () => {
  const stale = {
    ...mailbox,
    todayEmailsSent: 30,
    sendCounterResetAt: new Date("2026-10-18T10:00:00Z"),
  };
  expect(mailboxDailyRoom(stale, now)).toBe(30);
  expect(emailSendingStatus([stale], input).open).toBe(true);
  expect(
    emailSendingStatus(
      [{ ...stale, nextEmailTime: new Date("2026-10-19T10:05:00Z") }],
      input,
    ).blockedBy,
  ).toBe("throttled");
});
test("readiness is never presented as evidence that a send happened", () => {
  const status = emailSendingStatus([mailbox], input);
  expect(status.open).toBe(true);
  expect(describeChannelSending(status)).toBe(
    "has queued work for the next send check",
  );
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
  expect(status.detail).toContain("Next send");
});

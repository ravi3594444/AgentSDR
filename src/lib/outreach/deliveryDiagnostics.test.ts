import { expect, test } from "bun:test";
import { DEFAULT_WORKING_HOURS } from "./schema";
import { emailDeliveryGates } from "./deliveryDiagnostics";
import { mailboxHoursFromWeekly } from "./workingHours";

const mailbox = {
  status: "connected",
  provider: "unipile",
  unipileAccountId: "account",
  todayEmailsSent: 0,
  dailySendLimit: 30,
  sendCounterResetAt: null,
  nextEmailTime: null,
  workingHours: DEFAULT_WORKING_HOURS,
};
const input = {
  providerConnected: true,
  paused: false,
  activeQueue: 4,
  now: new Date("2026-10-19T06:00:00Z"),
};
test("a mailbox with the default (always-open) hours is never outside its hours, not even on the Saturday from the reported incident", () => {
  expect(emailDeliveryGates(mailbox, input)).toEqual([]);
  expect(emailDeliveryGates(mailbox, { ...input, now: new Date("2026-10-17T11:00:00Z") })).toEqual([]);
});
test("a legacy mailbox's restricted hours hold nothing: the send tick no longer reads them", () => {
  const legacy = { ...mailbox, workingHours: mailboxHoursFromWeekly({ timezone: "Asia/Kolkata", days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" }) };
  expect(emailDeliveryGates(legacy, input)).toEqual([]);
  expect(emailDeliveryGates(legacy, { ...input, now: new Date("2026-10-17T11:00:00Z") })).toEqual([]);
});
test("the pause between sends is written in the display time zone, to the second, never as an ISO time; the queue in plain words", () => {
  const gates = emailDeliveryGates({ ...mailbox, nextEmailTime: new Date("2026-10-21T16:24:42.353Z") }, { ...input, activeQueue: 0, now: new Date("2026-10-21T16:10:00Z"), displayTimeZone: "Asia/Kolkata" });
  expect(gates).toEqual([
    { code: "gap", reason: "Pausing between sends until 21:54:42 (Asia/Kolkata)" },
    { code: "queue", reason: "No email of an active campaign is in this mailbox's send queue" },
  ]);
  expect(JSON.stringify(gates)).not.toMatch(/\d{4}-\d\d-\d\dT|send tick/);
});
test("reports all recorded blockers without treating a stale daily counter as today's usage", () => {
  const blocked = {
    ...mailbox,
    status: "disabled",
    unipileAccountId: null,
    todayEmailsSent: 30,
    sendCounterResetAt: input.now,
    nextEmailTime: new Date("2026-10-19T07:00:00Z"),
  };
  expect(
    emailDeliveryGates(blocked, {
      ...input,
      providerConnected: false,
      paused: true,
      activeQueue: 0,
    }).map((g) => g.code),
  ).toEqual([
    "paused",
    "mailbox",
    "provider",
    "account",
    "gap",
    "capacity",
    "queue",
  ]);
  expect(
    emailDeliveryGates(
      { ...blocked, sendCounterResetAt: new Date("2026-10-18T00:00:00Z") },
      input,
    ).some((g) => g.code === "capacity"),
  ).toBe(false);
});

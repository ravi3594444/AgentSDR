import { describe, expect, test } from "bun:test";
import { mailboxHoursFromWeekly } from "@/lib/outreach/workingHours";
import { coveringApproval, emailSenderStatus, linkedinSenderStatus, runAuthorization, whatsappSenderStatus, type RunAuthorizationInput } from "./runEvidence";

const base: RunAuthorizationInput = { status: "running", approvedAt: new Date("2026-10-18T10:00:00Z"), approverName: "Ravi", autonomous: false, ownApproval: null, coveringApproval: null, threadAutonomous: false };

describe("runAuthorization", () => {
  test("a plan that has not started is never described as started", () => {
    expect(runAuthorization({ ...base, status: "proposed", approvedAt: null })).toMatchObject({ kind: "none", text: "Not started: nothing is sent until you press Start." });
    const autonomousChat = runAuthorization({ ...base, status: "proposed", approvedAt: null, threadAutonomous: true });
    expect(autonomousChat.kind).toBe("none");
    expect(autonomousChat.text).toContain("did not start this one");
    expect(runAuthorization({ ...base, status: "cancelled", approvedAt: null }).text).toContain("nothing was sent");
    expect(runAuthorization({ ...base, status: "failed", approvedAt: null }).kind).toBe("none");
  });

  test("a plan whose launch failed sent nothing, so it is never described as started, however it was authorized", () => {
    // A run is failed only when no channel launched, after Start recorded who pressed it.
    for (const how of [{}, { autonomous: true }, { ownApproval: { expiresAt: "2026-10-19T10:00:00Z" } }, { mayBeUnderApproval: true }]) {
      expect(runAuthorization({ ...base, ...how, status: "failed" })).toEqual({ kind: "none", text: "It did not start; nothing was sent.", by: null, at: null, until: null });
    }
  });

  test("names how it was authorized: Start, a request approval, or Autonomous mode", () => {
    expect(runAuthorization(base)).toMatchObject({ kind: "start", text: "Started by Ravi with Start.", by: "Ravi", at: "2026-10-18T10:00:00.000Z" });
    expect(runAuthorization({ ...base, ownApproval: { expiresAt: "2026-10-19T10:00:00Z" } })).toMatchObject({ kind: "request", until: "2026-10-19T10:00:00Z" });
    expect(runAuthorization({ ...base, coveringApproval: { approverName: "Asha", approvedAt: "2026-10-18T09:00:00Z", expiresAt: "2026-10-19T09:00:00Z" } }).text).toBe("Started on its own under Asha's approval of this request.");
    expect(runAuthorization({ ...base, autonomous: true }).text).toBe("Started on its own by this chat's Autonomous mode, in Ravi's name.");
    // Started while another plan's request approval was open, with no record of which: neither is claimed.
    expect(runAuthorization({ ...base, mayBeUnderApproval: true })).toMatchObject({ kind: "start", text: "Started in Ravi's name." });
    // A stopped or finished plan keeps how it was authorized.
    expect(runAuthorization({ ...base, status: "stopped" }).kind).toBe("start");
  });

  test("a request approval covers a start only between its approval and its expiry", () => {
    const approvals = [{ approvedAt: "2026-10-18T09:00:00Z", expiresAt: "2026-10-19T09:00:00Z" }];
    expect(coveringApproval(new Date("2026-10-18T12:00:00Z"), approvals)).toBe(approvals[0]!);
    expect(coveringApproval(new Date("2026-10-18T08:00:00Z"), approvals)).toBeNull();
    expect(coveringApproval(new Date("2026-10-20T08:00:00Z"), approvals)).toBeNull();
    expect(coveringApproval(null, approvals)).toBeNull();
  });
});

const india = mailboxHoursFromWeekly({ timezone: "Asia/Kolkata", days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" });
const mondayEarly = new Date("2026-10-19T01:00:00Z"); // 06:30 in India
const guardrails = { warmUpHours: 24, newChatsPerDay: 25, minSecondsBetweenSends: 10 };
const whatsapp = { account: "+91 98000 00001", status: "connected", unipileConnected: true, paused: false, sendingHours: india, guardrails, connectedAt: new Date("2026-10-01T00:00:00Z"), lastSentAt: null, newChatTimes: [] as Date[], queued: 3, now: mondayEarly };
/** `count` new chats, the first at `oldest`, then one every `everyMinutes`: oldest first, as the query returns them. */
const newChats = (count: number, oldest: string, everyMinutes = 1) => Array.from({ length: count }, (_, i) => new Date(Date.parse(oldest) + i * everyMinutes * 60_000));

describe("sender status", () => {
  test("outside its hours a number says so in its own time zone, and when the window opens", () => {
    const status = whatsappSenderStatus(whatsapp);
    expect(status.timezone).toBe("Asia/Kolkata");
    expect(status.gates).toEqual(["Outside campaign sending hours (Asia/Kolkata)"]);
    expect(status.nextAt).toBe("2026-10-19T03:30:00.000Z");
  });

  test("no hours set: no time zone is invented and nothing waits", () => {
    const status = whatsappSenderStatus({ ...whatsapp, sendingHours: null });
    expect(status).toMatchObject({ timezone: null, gates: [], nextAt: null });
  });

  test("the later of several gates decides; a gate with no known end gives no time", () => {
    const now = new Date("2026-10-19T06:00:00Z"); // inside hours
    const full = whatsappSenderStatus({ ...whatsapp, now, newChatTimes: newChats(25, "2026-10-18T20:00:00Z") });
    expect(full.nextAt).toBe("2026-10-19T20:00:00.000Z");
    expect(full.note).toContain("Follow-ups");
    const warming = whatsappSenderStatus({ ...whatsapp, now, connectedAt: new Date("2026-10-19T00:00:00Z") });
    expect(warming.nextAt).toBe("2026-10-20T00:00:00.000Z");
    expect(whatsappSenderStatus({ ...whatsapp, now, unipileConnected: false }).nextAt).toBeNull();
    expect(whatsappSenderStatus({ ...whatsapp, now, connectedAt: null }).nextAt).toBeNull();
  });

  test("over a lowered new-chat limit, it waits until enough chats leave the 24 hours, not just the oldest", () => {
    // 25 new chats, one every 30 minutes from 15:00, then the limit is lowered to 10: send.ts refuses until 16 have aged out.
    const now = new Date("2026-10-18T14:00:00Z");
    const over = whatsappSenderStatus({ ...whatsapp, sendingHours: null, now, guardrails: { ...guardrails, newChatsPerDay: 10 }, newChatTimes: newChats(25, "2026-10-17T15:00:00Z", 30) });
    expect(over.gates).toEqual(["25 of 10 new chats used in the last 24 hours"]);
    expect(over.nextAt).toBe("2026-10-18T22:30:00.000Z"); // the 16th oldest (22:30) plus 24 hours
    // A limit of none: no chat leaving the window frees one.
    expect(whatsappSenderStatus({ ...whatsapp, sendingHours: null, now, guardrails: { ...guardrails, newChatsPerDay: 0 }, newChatTimes: newChats(2, "2026-10-17T15:00:00Z") }).nextAt).toBeNull();
  });

  test("a mailbox outside an overnight window after days off may send again from midnight", () => {
    const weeknights = mailboxHoursFromWeekly({ timezone: "UTC", days: [1, 2, 3, 4, 5], start: "22:00", end: "06:00" });
    const status = emailSenderStatus({ mailbox: "nights@example.com", workingHours: weeknights, nextEmailTime: null, gates: [{ code: "hours", reason: "Outside this mailbox's sending hours (UTC)" }], queued: 1, now: new Date("2026-10-17T07:00:00Z") });
    expect(status.nextAt).toBe("2026-10-19T00:00:00.000Z");
  });

  test("a mailbox whose window runs until midnight is never promised that midnight", () => {
    const untilMidnight = mailboxHoursFromWeekly({ timezone: "UTC", days: [1, 2, 3, 4, 5], start: "09:00", end: "00:00" });
    const hours = emailSenderStatus({ mailbox: "late@example.com", workingHours: untilMidnight, nextEmailTime: null, gates: [{ code: "hours", reason: "Outside this mailbox's sending hours (UTC)" }], queued: 1, now: new Date("2026-10-17T07:00:00Z") });
    expect(hours.nextAt).toBe("2026-10-19T09:00:00.000Z");
    // Its daily limit used on Monday afternoon: Tuesday 00:00 is only Monday's window closing, so Tuesday 09:00.
    const capacity = emailSenderStatus({ mailbox: "late@example.com", workingHours: untilMidnight, nextEmailTime: null, gates: [{ code: "capacity", reason: "Mailbox has used its daily limit of 30 (UTC)" }], queued: 1, now: new Date("2026-10-19T15:00:00Z") });
    expect(capacity.nextAt).toBe("2026-10-20T09:00:00.000Z");
  });

  test("a mailbox at its daily limit in an overnight window may send again from the next local midnight", () => {
    const nights = mailboxHoursFromWeekly({ timezone: "UTC", days: [1, 2, 3, 4, 5], start: "21:00", end: "06:00" });
    const status = emailSenderStatus({ mailbox: "nights@example.com", workingHours: nights, nextEmailTime: null, gates: [{ code: "capacity", reason: "Mailbox has used its daily limit of 30 (UTC)" }], queued: 1, now: new Date("2026-10-19T22:00:00Z") });
    expect(status.nextAt).toBe("2026-10-20T00:00:00.000Z");
  });

  test("a mailbox at its daily limit waits for the next day's window in its time zone", () => {
    const status = emailSenderStatus({ mailbox: "ravi@example.in", workingHours: india, nextEmailTime: null, gates: [{ code: "capacity", reason: "Mailbox has used its daily limit of 30 (Asia/Kolkata)" }], queued: 4, now: new Date("2026-10-19T10:00:00Z") });
    expect(status.nextAt).toBe("2026-10-20T03:30:00.000Z");
    expect(emailSenderStatus({ mailbox: "x", workingHours: india, nextEmailTime: null, gates: [{ code: "provider", reason: "google sending integration is disconnected" }], queued: 0, now: mondayEarly }).nextAt).toBeNull();
  });
});

describe("LinkedIn sender status", () => {
  const india = { workTimezone: "Asia/Kolkata", workStartTime: "09:00", workEndTime: "18:00", workDays: "1,2,3,4,5" };
  const base = { account: "@ravi", status: "CONNECTED", limitReached: false, unipileConnected: true, paused: false, hours: india, nextAllowedRun: null, invitationsToday: 0, invitationsPerDay: 20, nextDayStart: new Date("2026-10-20T00:00:00Z"), queued: 12 };

  test("inside its working hours with invitations left, nothing holds it", () => {
    const status = linkedinSenderStatus({ ...base, now: new Date("2026-10-19T06:00:00Z") }); // Monday 11:30 IST
    expect(status).toMatchObject({ channel: "linkedin", timezone: "Asia/Kolkata", gates: [], nextAt: null, queued: 12 });
  });

  test("outside its working hours it names them and the next opening, in its own time zone", () => {
    const status = linkedinSenderStatus({ ...base, now: new Date("2026-10-19T01:00:00Z") }); // Monday 06:30 IST
    expect(status.gates[0]).toContain("Outside working hours");
    expect(status.gates[0]).toContain("Asia/Kolkata");
    expect(status.nextAt).toBe("2026-10-19T03:30:00.000Z");
  });

  test("the daily invitation limit holds invitations until the next day's hours; follow-ups are not held", () => {
    const status = linkedinSenderStatus({ ...base, invitationsToday: 20, now: new Date("2026-10-19T08:00:00Z") });
    expect(status.gates).toEqual(["20 of 20 invitations sent today"]);
    expect(status.nextAt).toBe("2026-10-20T03:30:00.000Z");
    expect(status.note).toContain("Follow-up");
  });

  test("the gap between runs is a time, not a gate; a disconnected account promises no time", () => {
    const gap = linkedinSenderStatus({ ...base, nextAllowedRun: new Date("2026-10-19T06:20:00Z"), now: new Date("2026-10-19T06:00:00Z") });
    expect(gap.gates).toEqual([]);
    expect(gap.nextAt).toBe("2026-10-19T06:20:00.000Z");
    const down = linkedinSenderStatus({ ...base, status: "CREDENTIALS", now: new Date("2026-10-19T06:00:00Z") });
    expect(down.gates).toEqual(["The account is credentials"]);
    expect(down.nextAt).toBeNull();
    expect(linkedinSenderStatus({ ...base, limitReached: true, now: new Date("2026-10-19T06:00:00Z") }).nextAt).toBeNull();
  });

  test("no working hours anywhere: any time, no time zone invented", () => {
    const status = linkedinSenderStatus({ ...base, hours: { workTimezone: null, workStartTime: null, workEndTime: null, workDays: null }, now: new Date("2026-10-19T01:00:00Z") });
    expect(status).toMatchObject({ timezone: null, gates: [], nextAt: null });
  });
});

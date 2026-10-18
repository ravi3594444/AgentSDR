import { describe, expect, test } from "bun:test";
import { mailboxHoursFromWeekly } from "@/lib/outreach/workingHours";
import { coveringApproval, emailSenderStatus, runAuthorization, whatsappSenderStatus, type RunAuthorizationInput } from "./runEvidence";

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
const whatsapp = { account: "+91 98000 00001", status: "connected", unipileConnected: true, paused: false, sendingHours: india, guardrails, connectedAt: new Date("2026-10-01T00:00:00Z"), lastSentAt: null, newChatsInWindow: 0, oldestNewChatAt: null, queued: 3, now: mondayEarly };

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
    const full = whatsappSenderStatus({ ...whatsapp, now, newChatsInWindow: 25, oldestNewChatAt: new Date("2026-10-18T20:00:00Z") });
    expect(full.nextAt).toBe("2026-10-19T20:00:00.000Z");
    expect(full.note).toContain("Follow-ups");
    const warming = whatsappSenderStatus({ ...whatsapp, now, connectedAt: new Date("2026-10-19T00:00:00Z") });
    expect(warming.nextAt).toBe("2026-10-20T00:00:00.000Z");
    expect(whatsappSenderStatus({ ...whatsapp, now, unipileConnected: false }).nextAt).toBeNull();
    expect(whatsappSenderStatus({ ...whatsapp, now, connectedAt: null }).nextAt).toBeNull();
  });

  test("a mailbox at its daily limit waits for the next day's window in its time zone", () => {
    const status = emailSenderStatus({ mailbox: "ravi@example.in", workingHours: india, nextEmailTime: null, gates: [{ code: "capacity", reason: "Mailbox has used its daily limit of 30 (Asia/Kolkata)" }], queued: 4, now: new Date("2026-10-19T10:00:00Z") });
    expect(status.nextAt).toBe("2026-10-20T03:30:00.000Z");
    expect(emailSenderStatus({ mailbox: "x", workingHours: india, nextEmailTime: null, gates: [{ code: "provider", reason: "google sending integration is disconnected" }], queued: 0, now: mondayEarly }).nextAt).toBeNull();
  });
});

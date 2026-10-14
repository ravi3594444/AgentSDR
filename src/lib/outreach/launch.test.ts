import { describe, expect, test } from "bun:test";
import { emailLaunchProblems, MAX_SEQUENCE_STEPS, parseSequence } from "./launch";
import { leadAfterSend, mailboxAtDailyLimit } from "./sendRules";

const step = (subject: string, body: string, waitDays = 3) => ({ stepNumber: 9, subject, body, waitDays });
const ready = {
  sequence: [step("Hi {{firstName}}", "Hello", 0)],
  googleConnected: true,
  unipileConnected: false,
  connectedMailboxes: { google: 1, unipile: 0 },
  usableLeads: 1,
};

describe("parseSequence", () => {
  test("renumbers steps 1..n and forces the first wait to 0", () => {
    const parsed = parseSequence([step("Intro", "Body", 5), step("", "Bump", 2)]);
    expect(parsed).toEqual({
      ok: true,
      sequence: [
        { stepNumber: 1, subject: "Intro", body: "Body", waitDays: 0 },
        { stepNumber: 2, subject: "", body: "Bump", waitDays: 2 },
      ],
    });
  });

  test("refuses what would send an empty or malformed email", () => {
    expect(parseSequence("nope")).toEqual({ ok: false, error: "sequence must be a list of steps" });
    expect(parseSequence([])).toEqual({ ok: false, error: "Add at least one email to the sequence." });
    expect(parseSequence([step("  ", "Body")])).toEqual({ ok: false, error: "The initial email needs a subject." });
    expect(parseSequence([step("Intro", "Body"), step("", " ")])).toEqual({ ok: false, error: "Email step 2 needs a message body." });
    expect(parseSequence([step("Intro", "Body"), step("", "Bump", 1.5)])).toEqual({ ok: false, error: "Email step 2 needs a wait of 0 to 365 whole days." });
    expect(parseSequence([step("Intro", "Body"), step("", "Bump", -1)]).ok).toBe(false);
    expect(parseSequence([step("Intro", "Body"), null]).ok).toBe(false);
    expect(parseSequence(Array.from({ length: MAX_SEQUENCE_STEPS + 1 }, () => step("Intro", "Body"))).ok).toBe(false);
  });
});

describe("emailLaunchProblems", () => {
  test("a ready campaign has none", () => {
    expect(emailLaunchProblems(ready)).toEqual([]);
  });

  test("lists every missing requirement, not only the first", () => {
    expect(emailLaunchProblems({
      sequence: [],
      googleConnected: false,
      unipileConnected: false,
      connectedMailboxes: { google: 0, unipile: 0 },
      usableLeads: 0,
    })).toEqual([
      "Connect at least one sending mailbox in Settings → Email → Mailboxes: a Google Workspace address, or an inbox linked in Unipile.",
      "Add at least one email to the sequence.",
      "Add leads with an email address that have not replied, bounced or unsubscribed.",
    ]);
  });

  test("a disconnected Google Workspace blocks a resume even with everything else in place", () => {
    expect(emailLaunchProblems({ ...ready, googleConnected: false })).toEqual([
      "Connect Google Workspace in Settings → Email → Connection.",
    ]);
  });

  test("a Unipile inbox sends without Google Workspace", () => {
    expect(emailLaunchProblems({ ...ready, googleConnected: false, unipileConnected: true, connectedMailboxes: { google: 0, unipile: 1 } })).toEqual([]);
  });

  test("a Unipile inbox needs Unipile connected", () => {
    expect(emailLaunchProblems({ ...ready, googleConnected: false, connectedMailboxes: { google: 0, unipile: 2 } })).toEqual([
      "Connect Unipile in Settings → LinkedIn → Connection.",
    ]);
  });

  test("one provider that can send is enough when the other is disconnected", () => {
    expect(emailLaunchProblems({ ...ready, googleConnected: false, unipileConnected: true, connectedMailboxes: { google: 3, unipile: 1 } })).toEqual([]);
  });
});

describe("mailboxAtDailyLimit", () => {
  const now = new Date("2026-10-13T06:00:00Z"); // 11:30 in Kolkata
  const mailbox = { todayEmailsSent: 30, dailySendLimit: 30, sendCounterResetAt: new Date("2026-10-13T00:00:00Z"), workingHours: { timezone: "Asia/Kolkata" } };

  test("stops a mailbox that has sent its limit today", () => {
    expect(mailboxAtDailyLimit(mailbox, now)).toBe(true);
    expect(mailboxAtDailyLimit({ ...mailbox, todayEmailsSent: 29 }, now)).toBe(false);
  });

  test("a counter from an earlier day does not count", () => {
    expect(mailboxAtDailyLimit({ ...mailbox, sendCounterResetAt: new Date("2026-10-12T05:00:00Z") }, now)).toBe(false);
    expect(mailboxAtDailyLimit({ ...mailbox, sendCounterResetAt: null }, now)).toBe(false);
  });
});

describe("leadAfterSend", () => {
  const now = new Date("2026-10-13T06:00:00Z");

  test("the first step schedules the next after its wait", () => {
    expect(leadAfterSend({ currentStep: 0 }, 3, 2, now)).toEqual({
      currentStep: 1,
      sequenceStatus: "initial_sent",
      nextSendAt: new Date("2026-10-15T06:00:00Z"),
    });
  });

  test("a follow-up keeps the lead in follow-up; the last step completes it", () => {
    expect(leadAfterSend({ currentStep: 1 }, 3, 4, now).sequenceStatus).toBe("in_follow_up");
    expect(leadAfterSend({ currentStep: 2 }, 3, null, now)).toEqual({ currentStep: 3, sequenceStatus: "sequence_completed", nextSendAt: null });
  });
});

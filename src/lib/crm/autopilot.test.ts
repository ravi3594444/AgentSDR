import { describe, expect, test } from "bun:test";
import { AUTOPILOT_LIMITS, autopilotDecision, autopilotIdempotencyKey, type AutopilotFacts } from "./autopilot";

const ordinary: AutopilotFacts = {
  enabled: true,
  draftStatus: "awaiting_review",
  classification: { status: "auto_applied", categoryKey: "interested", subcategoryKey: "wants_info" },
  doNotContact: false,
  suppressed: false,
  sentInConversation: 0,
  sentToday: 0,
};

describe("autopilotDecision", () => {
  test("an ordinary, confidently classified reply is sent", () => {
    expect(autopilotDecision(ordinary)).toEqual({ send: true });
    expect(autopilotDecision({ ...ordinary, classification: { status: "accepted", categoryKey: "not_interested", subcategoryKey: null } })).toEqual({ send: true });
  });

  test("off, already handled, Do Not Contact and suppressed are held", () => {
    expect(autopilotDecision({ ...ordinary, enabled: false }).send).toBe(false);
    expect(autopilotDecision({ ...ordinary, draftStatus: "sent" }).send).toBe(false);
    expect(autopilotDecision({ ...ordinary, doNotContact: true }).send).toBe(false);
    expect(autopilotDecision({ ...ordinary, suppressed: true }).send).toBe(false);
  });

  test("uncertain, unusual and person-only replies stay with a person", () => {
    expect(autopilotDecision({ ...ordinary, classification: null }).send).toBe(false);
    expect(autopilotDecision({ ...ordinary, classification: { status: "proposed", categoryKey: "interested", subcategoryKey: null } }).send).toBe(false);
    expect(autopilotDecision({ ...ordinary, classification: { status: "auto_applied", categoryKey: "other", subcategoryKey: "out_of_office" } }).send).toBe(false);
    expect(autopilotDecision({ ...ordinary, classification: { status: "auto_applied", categoryKey: "customer", subcategoryKey: null } }).send).toBe(false);
    for (const key of ["do_not_contact", "meeting_no_show", "meeting_done", "trial_user", "customer"]) {
      expect(autopilotDecision({ ...ordinary, classification: { status: "auto_applied", categoryKey: "interested", subcategoryKey: key } }).send).toBe(false);
    }
  });

  test("per-conversation and daily caps hand over to a person", () => {
    expect(autopilotDecision({ ...ordinary, sentInConversation: AUTOPILOT_LIMITS.perConversation }).send).toBe(false);
    expect(autopilotDecision({ ...ordinary, sentToday: AUTOPILOT_LIMITS.perDay })).toEqual({ send: false, reason: `today's autopilot limit (${AUTOPILOT_LIMITS.perDay}) is reached` });
  });

  test("one automatic send per draft revision", () => {
    expect(autopilotIdempotencyKey("d1", 2)).toBe("autopilot:d1:2");
  });
});

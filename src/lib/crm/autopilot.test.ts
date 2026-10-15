import { describe, expect, test } from "bun:test";
import { AUTOPILOT_LIMITS, autopilotGate, autopilotIdempotencyKey, limitProblem, type AutopilotFacts } from "./autopilot";

const ordinary: AutopilotFacts = {
  draftStatus: "awaiting_review",
  draftRevision: 2,
  queuedRevision: 2,
  editedByPerson: false,
  membership: { runStatus: "running", automatic: true, leadStatus: "active" },
  takeover: false,
  answeredSinceDraft: false,
  newerInbound: false,
  doNotContact: false,
  suppressed: false,
  classification: { status: "auto_applied", categoryKey: "interested", subcategoryKey: "information_requested" },
};

describe("autopilotGate", () => {
  test("an ordinary reply in a running Automatic run passes to the support check", () => {
    expect(autopilotGate(ordinary)).toEqual({ pass: true });
    expect(autopilotGate({ ...ordinary, classification: { status: "accepted", categoryKey: "not_interested", subcategoryKey: null } })).toEqual({ pass: true });
  });

  test("only conversations of an Automatic run: no run, Review mode and other states hold quietly", () => {
    expect(autopilotGate({ ...ordinary, membership: null })).toMatchObject({ pass: false, quiet: true });
    expect(autopilotGate({ ...ordinary, membership: { ...ordinary.membership!, automatic: false } })).toMatchObject({ pass: false, quiet: true, reason: expect.stringContaining("Review") });
    expect(autopilotGate({ ...ordinary, membership: { ...ordinary.membership!, runStatus: "paused" } })).toMatchObject({ pass: false, resumable: true });
    expect(autopilotGate({ ...ordinary, membership: { ...ordinary.membership!, runStatus: "stopped" } })).toMatchObject({ pass: false, reason: "the run is stopped" });
    expect(autopilotGate({ ...ordinary, membership: { ...ordinary.membership!, leadStatus: "opted_out" } })).toMatchObject({ pass: false });
  });

  test("an outdated reply never sends: takeover, edit, newer message, someone answered, new revision", () => {
    for (const change of [
      { takeover: true },
      { editedByPerson: true },
      { newerInbound: true },
      { answeredSinceDraft: true },
      { queuedRevision: 1 },
      { draftStatus: "stale" },
      { draftStatus: "sent" },
    ] satisfies Partial<AutopilotFacts>[]) {
      expect(autopilotGate({ ...ordinary, ...change }).pass).toBe(false);
    }
  });

  test("Do Not Contact and suppression hold", () => {
    expect(autopilotGate({ ...ordinary, doNotContact: true }).pass).toBe(false);
    expect(autopilotGate({ ...ordinary, suppressed: true }).pass).toBe(false);
  });

  test("uncertain, unusual and person-only replies become a decision for the owner", () => {
    expect(autopilotGate({ ...ordinary, classification: null })).toMatchObject({ pass: false, quiet: false, decision: { kind: "uncertain" } });
    expect(autopilotGate({ ...ordinary, classification: { status: "proposed", categoryKey: "interested", subcategoryKey: null } })).toMatchObject({ quiet: false });
    expect(autopilotGate({ ...ordinary, classification: { status: "auto_applied", categoryKey: "customer", subcategoryKey: null } })).toMatchObject({ quiet: false });
    expect(autopilotGate({ ...ordinary, classification: { status: "auto_applied", categoryKey: "other", subcategoryKey: "connected_to_different_poc" } })).toMatchObject({ quiet: false });
    expect(autopilotGate({ ...ordinary, classification: { status: "auto_applied", categoryKey: "other", subcategoryKey: "out_of_office" } })).toMatchObject({ quiet: true });
    for (const key of ["do_not_contact", "meeting_no_show", "meeting_done", "trial_user", "customer"]) {
      expect(autopilotGate({ ...ordinary, classification: { status: "auto_applied", categoryKey: "interested", subcategoryKey: key } }).pass).toBe(false);
    }
  });
});

describe("limits", () => {
  test("per conversation and per 24 hours", () => {
    expect(limitProblem({ sentInConversation: 0, sentInLast24h: 0 })).toBeNull();
    expect(limitProblem({ sentInConversation: AUTOPILOT_LIMITS.perConversation, sentInLast24h: 0 })).toContain("over to you");
    expect(limitProblem({ sentInConversation: 0, sentInLast24h: AUTOPILOT_LIMITS.perDay })).toContain("24 hours");
  });

  test("one automatic send per draft revision", () => {
    expect(autopilotIdempotencyKey("d1", 2)).toBe("autopilot:d1:2");
  });
});

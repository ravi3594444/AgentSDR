import { describe, expect, test } from "bun:test";
import { latestInboundAnswered, manualOutboundDecision, settledWorkflowState, type ManualOutboundRecordState } from "./manualOutbound";
import type { CrmWorkflowState } from "./schema";

const replyAt = new Date("2026-09-02T09:00:00.000Z");
const after = new Date("2026-09-02T09:05:00.000Z");
const before = new Date("2026-09-02T08:55:00.000Z");

function record(overrides: Partial<ManualOutboundRecordState> = {}): ManualOutboundRecordState {
  return {
    workflowState: "action_required",
    latestInboundMessageId: "inbound-1",
    lastInboundAt: replyAt,
    lastOutboundAt: null,
    ...overrides,
  };
}

describe("manual outbound decision", () => {
  test("a message sent after an unanswered reply that is waiting on a person answers it", () => {
    expect(manualOutboundDecision(record(), after)).toBe("answered");
    // Classified and drafting (applied classifications park the record in waiting).
    expect(manualOutboundDecision(record({ workflowState: "waiting" }), after)).toBe("answered");
  });

  test("while the reply is still being classified, the classification job settles it", () => {
    expect(manualOutboundDecision(record({ workflowState: "classifying" }), after)).toBe("await_classification");
    expect(manualOutboundDecision(record({ workflowState: "unclassified" }), after)).toBe("await_classification");
  });

  test("a call-only record (no reply yet) is left to WhatsApp Calling", () => {
    expect(manualOutboundDecision(record({ latestInboundMessageId: null, lastInboundAt: null, workflowState: "waiting" }), after))
      .toBe("record_only");
  });

  test("a message older than the latest reply cannot answer it", () => {
    expect(manualOutboundDecision(record(), before)).toBe("record_only");
  });

  test("a reply already answered is not answered again", () => {
    expect(manualOutboundDecision(record({ lastOutboundAt: new Date("2026-09-02T09:01:00.000Z") }), after)).toBe("record_only");
  });

  test("idle, paused, closed and error records keep their state", () => {
    for (const workflowState of ["idle", "paused", "closed", "error"] as CrmWorkflowState[]) {
      expect(manualOutboundDecision(record({ workflowState }), after)).toBe("record_only");
    }
  });

  test("the same instant as the reply counts as after it", () => {
    expect(manualOutboundDecision(record(), replyAt)).toBe("answered");
  });
});

describe("latestInboundAnswered", () => {
  test("needs a reply and an outbound message no older than it", () => {
    expect(latestInboundAnswered(record())).toBe(false);
    expect(latestInboundAnswered(record({ lastOutboundAt: before }))).toBe(false);
    expect(latestInboundAnswered(record({ lastOutboundAt: after }))).toBe(true);
    expect(latestInboundAnswered(record({ latestInboundMessageId: null, lastOutboundAt: after }))).toBe(false);
  });
});

describe("settling an answered record", () => {
  test("it leaves Action required when nothing else waits on a person", () => {
    expect(settledWorkflowState([])).toBe("idle");
  });

  test("a send whose delivery is uncertain keeps it there until confirmed", () => {
    expect(settledWorkflowState(["delivery_uncertain"])).toBe("action_required");
  });
});

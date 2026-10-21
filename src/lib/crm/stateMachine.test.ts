import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  InvalidCrmTransitionError,
  StaleCrmContextError,
  assertCurrentCrmContext,
  assertWorkflowTransition,
  classificationApplicationDecision,
  crmDueState,
  workflowStateForInbound,
} from "./stateMachine";

describe("CRM workflow transitions", () => {
  it("reopens idle and closed records for a normal inbound reply", () => {
    const target = workflowStateForInbound(false);
    assert.equal(target, "classifying");
    assert.doesNotThrow(() => assertWorkflowTransition("idle", target));
    assert.doesNotThrow(() => assertWorkflowTransition("closed", target));
  });

  it("routes inbound replies from DNC people to compliance review", () => {
    assert.equal(workflowStateForInbound(true), "action_required");
  });

  it("rejects invalid workflow jumps", () => {
    assert.throws(() => assertWorkflowTransition("unclassified", "waiting"),
      InvalidCrmTransitionError,
    );
  });
});

describe("CRM context guard", () => {
  it("accepts the exact version and triggering message", () => {
    assert.doesNotThrow(() => assertCurrentCrmContext(
      { contextVersion: 4, latestInboundMessageId: "message-2" },
      { contextVersion: 4, latestInboundMessageId: "message-2" },
    ));
  });

  it("rejects an older version or message", () => {
    assert.throws(() => assertCurrentCrmContext(
      { contextVersion: 5, latestInboundMessageId: "message-3" },
      { contextVersion: 4, latestInboundMessageId: "message-2" },
    ), StaleCrmContextError);
    assert.throws(() => assertCurrentCrmContext(
      { contextVersion: 5, latestInboundMessageId: "message-3" },
      { contextVersion: 5, latestInboundMessageId: "message-2" },
    ), StaleCrmContextError);
  });
});

describe("classification application policy", () => {
  const base = {
    currentCategoryKey: null,
    currentCategoryLocked: false,
    proposedCategoryKey: "interested" as const,
    confidence: 0.9,
    autoApplyConfidence: 0.85,
    reviewOther: true,
    customerRequiresReview: true,
    subcategoryReviewRequired: false,
    currentStageRank: null,
    proposedStageRank: null,
    proposedSubcategoryKey: null,
  };

  it("auto-applies an ordinary high-confidence result", () => {
    assert.equal(classificationApplicationDecision(base), "auto_apply");
  });

  it("requires review for low confidence, Other, or a sensitive subcategory", () => {
    assert.equal(classificationApplicationDecision({ ...base, confidence: 0.5 }), "requires_review");
    assert.equal(classificationApplicationDecision({ ...base, proposedCategoryKey: "other" }), "requires_review");
    assert.equal(classificationApplicationDecision({ ...base, subcategoryReviewRequired: true }), "requires_review");
  });

  it("reviews Customer promotion only while the pipeline asks for it", () => {
    assert.equal(classificationApplicationDecision({ ...base, proposedCategoryKey: "customer" }), "requires_review");
    assert.equal(classificationApplicationDecision({
      ...base,
      proposedCategoryKey: "customer",
      customerRequiresReview: false,
    }), "auto_apply");
  });

  it("auto-applies everything once the pipeline stops gating", () => {
    const permissive = {
      ...base,
      autoApplyConfidence: 0,
      reviewOther: false,
      customerRequiresReview: false,
    };
    for (const proposedCategoryKey of ["interested", "not_interested", "other", "customer"] as const) {
      assert.equal(
        classificationApplicationDecision({ ...permissive, proposedCategoryKey, confidence: 0.2 }),
        "auto_apply",
      );
    }
  });

  it("never lets AI downgrade a locked Customer", () => {
    assert.equal(classificationApplicationDecision({
      ...base,
      currentCategoryKey: "customer",
      currentCategoryLocked: true,
      proposedCategoryKey: "not_interested",
    }), "protected_customer");
  });
});

describe("the AI only moves a record forward", () => {
  // Pipeline gating off, as production runs it: only the stage rule can hold.
  const atMeetingRequested = {
    currentCategoryKey: "interested" as const,
    currentCategoryLocked: false,
    proposedCategoryKey: "interested" as const,
    confidence: 0.9,
    autoApplyConfidence: 0,
    reviewOther: false,
    customerRequiresReview: false,
    subcategoryReviewRequired: false,
    currentStageRank: 2,
    proposedStageRank: 2,
    proposedSubcategoryKey: "meeting_requested",
  };

  it("holds a move to an earlier stage for review", () => {
    assert.equal(classificationApplicationDecision({
      ...atMeetingRequested,
      proposedStageRank: 1,
      proposedSubcategoryKey: "information_requested",
    }), "protected_stage");
  });

  it("holds a move off the funnel for review", () => {
    assert.equal(classificationApplicationDecision({
      ...atMeetingRequested,
      proposedCategoryKey: "not_interested",
      proposedStageRank: null,
      proposedSubcategoryKey: "not_required_right_now",
    }), "protected_stage");
    assert.equal(classificationApplicationDecision({
      ...atMeetingRequested,
      proposedCategoryKey: "other",
      proposedStageRank: null,
      proposedSubcategoryKey: null,
    }), "protected_stage");
  });

  it("applies a forward or lateral move", () => {
    assert.equal(classificationApplicationDecision({
      ...atMeetingRequested,
      proposedStageRank: 3,
      proposedSubcategoryKey: "meeting_done",
    }), "auto_apply");
    assert.equal(classificationApplicationDecision({
      ...atMeetingRequested,
      proposedSubcategoryKey: "meeting_no_show",
    }), "auto_apply");
  });

  it("never holds Do Not Contact", () => {
    assert.equal(classificationApplicationDecision({
      ...atMeetingRequested,
      proposedCategoryKey: "not_interested",
      proposedStageRank: null,
      proposedSubcategoryKey: "do_not_contact",
    }), "auto_apply");
  });

  it("moves freely from an unranked or empty stage", () => {
    assert.equal(classificationApplicationDecision({
      ...atMeetingRequested,
      currentStageRank: null,
      proposedStageRank: 1,
      proposedSubcategoryKey: "information_requested",
    }), "auto_apply");
  });
});

describe("due state", () => {
  const base = {
    workflowState: "waiting" as const,
    nextActionAt: null,
    draftStatus: null,
    classificationStatus: null,
    hasActiveRun: false,
  };
  const now = new Date("2026-09-07T12:00:00.000Z");

  it("puts a draft awaiting review on someone's desk now", () => {
    assert.equal(
      crmDueState({ ...base, workflowState: "action_required", draftStatus: "awaiting_review", now }),
      "immediate_reply",
    );
  });

  it("calls a drafted follow-up ready rather than an immediate reply", () => {
    assert.equal(
      crmDueState({ ...base, workflowState: "action_required", draftStatus: "awaiting_review", draftStepType: "follow_up", now }),
      "follow_up_ready",
    );
    assert.equal(
      crmDueState({ ...base, workflowState: "action_required", draftStatus: "awaiting_review", draftStepType: "reply", now }),
      "immediate_reply",
    );
    // Delivery reconciliation is urgent whichever step it was.
    assert.equal(
      crmDueState({ ...base, workflowState: "error", draftStatus: "delivery_uncertain", draftStepType: "follow_up", now }),
      "immediate_reply",
    );
  });

  it("treats an error and an undecided classification in Action required the same way", () => {
    assert.equal(crmDueState({ ...base, workflowState: "error", now }), "immediate_reply");
    assert.equal(crmDueState({ ...base, workflowState: "action_required", classificationStatus: "proposed", now }), "immediate_reply");
  });

  it("does not call an older proposal immediate once the record left Action required", () => {
    // Off the queue, answered and waiting on the lead: the schedule decides, as the summary says.
    assert.equal(crmDueState({ ...base, classificationStatus: "proposed", nextActionAt: new Date("2026-09-09T12:00:00.000Z"), now }), "follow_up");
    assert.equal(crmDueState({ ...base, classificationStatus: "proposed", hasActiveRun: true, now }), "pending");
    // A newer reply being classified: nothing for a person yet.
    assert.equal(crmDueState({ ...base, workflowState: "classifying", classificationStatus: "proposed", now }), "none");
  });

  it("does not call an auto-applied classification actionable", () => {
    assert.equal(crmDueState({ ...base, classificationStatus: "auto_applied", now }), "pending");
  });

  it("separates a scheduled follow-up from one that has come due", () => {
    assert.equal(
      crmDueState({ ...base, nextActionAt: new Date("2026-09-09T12:00:00.000Z"), now }),
      "follow_up",
    );
    assert.equal(
      crmDueState({ ...base, nextActionAt: new Date("2026-09-05T12:00:00.000Z"), now }),
      "past_due",
    );
  });

  it("falls back to pending only while something is actually running", () => {
    assert.equal(crmDueState({ ...base, hasActiveRun: true, now }), "pending");
    assert.equal(crmDueState({ ...base, workflowState: "idle", now }), "none");
  });
});

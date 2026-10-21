import type { CrmCategoryKey, CrmWorkflowState } from "./schema";

const ALLOWED_TRANSITIONS: Readonly<Record<CrmWorkflowState, ReadonlySet<CrmWorkflowState>>> = {
  unclassified: new Set(["classifying", "action_required", "paused", "closed", "error"]),
  classifying: new Set(["action_required", "waiting", "paused", "closed", "error"]),
  action_required: new Set(["classifying", "waiting", "idle", "paused", "closed", "error"]),
  waiting: new Set(["classifying", "action_required", "idle", "paused", "closed", "error"]),
  idle: new Set(["classifying", "action_required", "paused", "closed"]),
  paused: new Set(["classifying", "action_required", "waiting", "idle", "closed", "error"]),
  closed: new Set(["classifying", "action_required", "idle"]),
  error: new Set(["classifying", "action_required", "paused", "closed"]),
};

export class InvalidCrmTransitionError extends Error {
  constructor(from: CrmWorkflowState, to: CrmWorkflowState) {
    super(`CRM workflow cannot transition from ${from} to ${to}`);
    this.name = "InvalidCrmTransitionError";
  }
}

export class StaleCrmContextError extends Error {
  constructor(message = "CRM work is stale because the record context changed") {
    super(message);
    this.name = "StaleCrmContextError";
  }
}

export function canTransitionWorkflow(
  from: CrmWorkflowState,
  to: CrmWorkflowState,
): boolean {
  return from === to || ALLOWED_TRANSITIONS[from].has(to);
}

export function assertWorkflowTransition(
  from: CrmWorkflowState,
  to: CrmWorkflowState,
): void {
  if (!canTransitionWorkflow(from, to)) throw new InvalidCrmTransitionError(from, to);
}

/** Every valid inbound reply starts new work; DNC keeps that work compliance-only. */
export function workflowStateForInbound(doNotContact: boolean): CrmWorkflowState {
  return doNotContact ? "action_required" : "classifying";
}

export function assertCurrentCrmContext(
  current: { contextVersion: number; latestInboundMessageId: string | null },
  expected: { contextVersion: number; latestInboundMessageId?: string | null },
): void {
  if (current.contextVersion !== expected.contextVersion) {
    throw new StaleCrmContextError();
  }
  if (
    expected.latestInboundMessageId !== undefined
    && current.latestInboundMessageId !== expected.latestInboundMessageId
  ) {
    throw new StaleCrmContextError("CRM work is stale because a newer inbound message arrived");
  }
}

export type ClassificationApplicationDecision =
  | "auto_apply"
  | "requires_review"
  | "protected_customer"
  | "protected_stage";

/**
 * The AI only moves a record forward through the funnel.
 *
 * Once a record sits on a ranked stage, a proposal for a lower-ranked or
 * unranked subcategory is held for a person to decide rather than applied:
 * going back a step is a judgement about the deal, not about the message.
 * Equal ranks are lateral (Meeting Requested ↔ Meeting No Show). Do Not
 * Contact is exempt — suppression must never wait on a review queue. A record
 * on an unranked stage, or with no stage yet, moves freely.
 */
export function isBackwardStageMove(input: {
  currentStageRank: number | null;
  proposedStageRank: number | null;
  proposedSubcategoryKey: string | null;
}): boolean {
  if (input.currentStageRank === null) return false;
  if (input.proposedSubcategoryKey === "do_not_contact") return false;
  return input.proposedStageRank === null || input.proposedStageRank < input.currentStageRank;
}

export type ClassificationPolicyInput = {
  currentCategoryKey: CrmCategoryKey | null;
  currentCategoryLocked: boolean;
  proposedCategoryKey: CrmCategoryKey;
  confidence: number;
  autoApplyConfidence: number;
  reviewOther: boolean;
  customerRequiresReview: boolean;
  subcategoryReviewRequired: boolean;
  /** Funnel rank of the record's current subcategory; null when unranked. */
  currentStageRank: number | null;
  proposedStageRank: number | null;
  proposedSubcategoryKey: string | null;
};

/** Deterministic, data-backed AI classification policy. */
export function classificationApplicationDecision(
  input: ClassificationPolicyInput,
): ClassificationApplicationDecision {
  if (input.confidence < 0 || input.confidence > 1) {
    throw new Error("Classification confidence must be between 0 and 1");
  }
  if (input.autoApplyConfidence < 0 || input.autoApplyConfidence > 1) {
    throw new Error("Auto-apply confidence must be between 0 and 1");
  }
  if (
    input.currentCategoryLocked
    && input.currentCategoryKey === "customer"
    && input.proposedCategoryKey !== "customer"
  ) {
    return "protected_customer";
  }
  if (isBackwardStageMove(input)) return "protected_stage";
  if (input.proposedCategoryKey === "customer" && input.customerRequiresReview) {
    return "requires_review";
  }
  if (input.subcategoryReviewRequired) return "requires_review";
  if (input.proposedCategoryKey === "other" && input.reviewOther) return "requires_review";
  if (input.confidence < input.autoApplyConfidence) return "requires_review";
  return "auto_apply";
}


/**
 * What the actions list should say a record is waiting for.
 *
 * `next_action_at` alone cannot answer this: a record with a draft ready and a
 * record with a follow-up scheduled next Tuesday are both "due", but only one
 * of them wants a person right now. Derived rather than stored so it can never
 * drift from the draft and classification rows it describes.
 */
export type CrmDueState =
  | "immediate_reply"
  | "follow_up_ready"
  | "past_due"
  | "follow_up"
  | "pending"
  | "none";

export function crmDueState(input: {
  workflowState: CrmWorkflowState;
  nextActionAt: Date | null;
  draftStatus: string | null;
  /** Step the awaiting draft was written for; null for a hand-written draft. */
  draftStepType?: "reply" | "follow_up" | null;
  classificationStatus: string | null;
  hasActiveRun: boolean;
  now?: Date;
}): CrmDueState {
  const now = input.now ?? new Date();
  // Something is on a person's desk right now.
  if (input.workflowState === "error") return "immediate_reply";
  if (input.draftStatus === "awaiting_review" || input.draftStatus === "delivery_uncertain") {
    // A drafted follow-up is just as ready to send, but it is not a reply the
    // lead is waiting on — calling it "Immediate reply" made every record
    // whose reply had gone out look as if it had not.
    return input.draftStatus === "awaiting_review" && input.draftStepType === "follow_up"
      ? "follow_up_ready"
      : "immediate_reply";
  }
  // A classification held for review is the queue's to confirm, so it is
  // immediate only while the record is in Action required — the rule the
  // conversation summary uses. Once the conversation moved on (answered,
  // waiting, a newer reply being classified), the schedule decides; calling
  // it "Immediate reply" beside "nothing is waiting on you" contradicted it.
  if (input.classificationStatus === "proposed" && input.workflowState === "action_required") return "immediate_reply";
  // Otherwise the schedule decides.
  if (input.nextActionAt) return input.nextActionAt <= now ? "past_due" : "follow_up";
  if (input.workflowState === "waiting" || input.hasActiveRun) return "pending";
  return "none";
}

export const CRM_DUE_STATE_LABELS: Readonly<Record<CrmDueState, string>> = {
  immediate_reply: "Immediate reply",
  follow_up_ready: "Follow-up ready",
  past_due: "Past due",
  follow_up: "Follow-up",
  pending: "Pending",
  none: "—",
};

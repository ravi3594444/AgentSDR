/**
 * The reply autopilot's rules: which AI drafts may be sent without a person
 * reading them first. Off unless the owner turns it on (it clears
 * crm_settings.human_send_only); when on, only an ordinary reply qualifies,
 * and anything unusual stays in Action required for a person, as before.
 * Pure, so every rule is unit-tested; autopilot.server.ts applies it.
 *
 * Ordinary: the AI classified the reply on its own (auto-applied, so above
 * the pipeline's confidence threshold and not a subcategory that requires
 * review) or a person accepted it, as interested or not interested, and
 * the draft already passed the grounding checks every draft passes (no
 * placeholders, no claims of things not done). Not ordinary: customers,
 * "other" (out of office, wrong person, unclear), stages a person records
 * (meeting done or missed, trial user), Do Not Contact, an unsubscribed or
 * bounced address, and any conversation the autopilot already answered
 * MAX_PER_CONVERSATION times.
 */

export const AUTOPILOT_ACTOR = "autopilot";

export const AUTOPILOT_LIMITS = {
  /** After this many automatic messages in one conversation, a person takes over. */
  perConversation: 3,
  /** Automatic messages per organization per day (UTC). */
  perDay: 40,
  /**
   * Minutes between a draft being ready and the autopilot answering: a reply
   * seconds after the lead's looks automated, and it leaves the owner a
   * window to answer or edit first (the autopilot then finds the draft
   * handled and holds).
   */
  delayMinutes: 10,
} as const;

/** Subcategories a person handles even when classified with confidence. */
export const AUTOPILOT_ESCALATE_SUBCATEGORIES = new Set([
  "do_not_contact",
  "meeting_no_show",
  "meeting_done",
  "trial_user",
  "customer",
]);

export type AutopilotFacts = {
  enabled: boolean;
  draftStatus: string;
  classification: {
    status: string;
    categoryKey: string | null;
    subcategoryKey: string | null;
  } | null;
  doNotContact: boolean;
  /** The recipient's email is on the suppression list (email conversations only). */
  suppressed: boolean;
  sentInConversation: number;
  sentToday: number;
};

export type AutopilotDecision = { send: true } | { send: false; reason: string };

export function autopilotDecision(facts: AutopilotFacts): AutopilotDecision {
  if (!facts.enabled) return { send: false, reason: "the autopilot is off" };
  if (facts.draftStatus !== "awaiting_review") return { send: false, reason: `the draft is ${facts.draftStatus.replace(/_/g, " ")}` };
  if (facts.doNotContact) return { send: false, reason: "the person is marked Do Not Contact" };
  if (facts.suppressed) return { send: false, reason: "the address unsubscribed or bounced" };
  const classification = facts.classification;
  if (!classification) return { send: false, reason: "the reply is not classified yet" };
  if (classification.status !== "auto_applied" && classification.status !== "accepted") {
    return { send: false, reason: "the AI was not sure what the reply means, so you decide" };
  }
  if (classification.categoryKey === "customer") return { send: false, reason: "they are a customer; you answer customers" };
  if (classification.categoryKey === "other" || !classification.categoryKey) {
    return { send: false, reason: "not an ordinary reply (out of office, wrong person or unclear)" };
  }
  if (classification.subcategoryKey && AUTOPILOT_ESCALATE_SUBCATEGORIES.has(classification.subcategoryKey)) {
    return { send: false, reason: `${classification.subcategoryKey.replace(/_/g, " ")} is for you to handle` };
  }
  if (facts.sentInConversation >= AUTOPILOT_LIMITS.perConversation) {
    return { send: false, reason: `the autopilot already answered this conversation ${facts.sentInConversation} times; over to you` };
  }
  if (facts.sentToday >= AUTOPILOT_LIMITS.perDay) {
    return { send: false, reason: `today's autopilot limit (${AUTOPILOT_LIMITS.perDay}) is reached` };
  }
  return { send: true };
}

/** The send's idempotency key: one automatic send per draft revision, ever. */
export function autopilotIdempotencyKey(draftId: string, revision: number): string {
  return `${AUTOPILOT_ACTOR}:${draftId}:${revision}`;
}

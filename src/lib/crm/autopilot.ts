/**
 * The reply autopilot's send-time rules. A reply is answered automatically
 * only for a conversation whose person belongs to an outreach run the owner
 * started in Automatic mode, while that run is running, and only when
 * nothing has made the queued reply outdated: a person took over or edited
 * it, a newer message arrived, someone answered already, the person opted
 * out. Then the reply must pass the support check
 * (src/lib/assistant/replyCheck.ts) and the limits, re-checked under a lock
 * just before sending. Pure, so every rule is unit-tested; the runner is
 * src/lib/assistant/autopilotRun.server.ts.
 */

export const AUTOPILOT_ACTOR = "autopilot";

export const AUTOPILOT_LIMITS = {
  /**
   * After this many automatic messages in one conversation, a person takes
   * over (a safety net against loops; the handoff usually comes first: when
   * the lead is ready, asks for a person, or asks what the owner's
   * information does not answer).
   */
  perConversation: 10,
  /** Automatic messages per organization in any 24 hours. */
  perDay: 40,
  /**
   * Minutes between a draft being ready and the autopilot answering: a reply
   * seconds after the lead's looks automated, and it leaves the owner a
   * window to answer or edit first (the autopilot then stands down).
   */
  delayMinutes: 10,
} as const;

/** Classifications applied by the AI with confidence or confirmed by a person. */
const CONFIRMED_CLASSIFICATIONS = new Set(["auto_applied", "accepted", "overridden"]);

/** "Other" replies that are not the lead talking: the right person is someone else, or they left. */
const NOT_THE_LEAD_SUBCATEGORIES = new Set(["left_company", "connected_to_different_poc", "did_not_connect_to_different_poc"]);

/** Subcategories a person handles even when classified with confidence. */
export const AUTOPILOT_ESCALATE_SUBCATEGORIES = new Set([
  "do_not_contact",
  "meeting_no_show",
  "meeting_done",
  "trial_user",
  "customer",
]);

export type RunMembershipFacts = {
  runStatus: string;
  /** The run's reply mode: Automatic (true) or Review. */
  automatic: boolean;
  leadStatus: string;
};

export type AutopilotFacts = {
  draftStatus: string;
  draftRevision: number;
  /** The revision the job was queued for (null: any). */
  queuedRevision: number | null;
  /** A person changed the AI's text. */
  editedByPerson: boolean;
  /** The person's run on this conversation's channel; null when the conversation is not from an assistant run. */
  membership: RunMembershipFacts | null;
  /** The owner said they handle this conversation. */
  takeover: boolean;
  /** The conversation waits for the owner in Needs you (an open handoff): the autopilot stays quiet until it is settled. */
  waitingForOwner?: boolean;
  /** An outbound message (a person's or another draft's) went out after this draft was written. */
  answeredSinceDraft: boolean;
  /** The lead wrote again after the message this draft answers. */
  newerInbound: boolean;
  doNotContact: boolean;
  /** The recipient's email is on the suppression list (email conversations only). */
  suppressed: boolean;
  classification: {
    status: string;
    categoryKey: string | null;
    subcategoryKey: string | null;
  } | null;
};

export type GateDecisionKind = "uncertain" | "complaint";

export type AutopilotGate =
  | { pass: true }
  | {
      pass: false;
      reason: string;
      /** Quiet holds need nothing from the owner (Review mode, an outdated draft); the others become a decision. */
      quiet: boolean;
      /** Held because the run is paused: queued again when it resumes. */
      resumable?: boolean;
      decision?: { kind: GateDecisionKind; decision: string };
    };

function hold(reason: string, extra: Partial<Extract<AutopilotGate, { pass: false }>> = {}): AutopilotGate {
  return { pass: false, reason, quiet: true, ...extra };
}

function decide(reason: string, kind: GateDecisionKind, decision: string): AutopilotGate {
  return { pass: false, reason, quiet: false, decision: { kind, decision } };
}

export function autopilotGate(facts: AutopilotFacts): AutopilotGate {
  if (facts.draftStatus !== "awaiting_review") return hold(`the draft is ${facts.draftStatus.replace(/_/g, " ")}`);
  if (facts.queuedRevision !== null && facts.queuedRevision !== facts.draftRevision) return hold("the draft changed after this reply was queued");
  if (!facts.membership) return hold("the conversation is not part of an outreach run");
  if (!facts.membership.automatic) return hold("the run is in Review mode: replies wait for you");
  if (facts.membership.runStatus === "paused") return hold("the run is paused", { resumable: true });
  if (facts.membership.runStatus !== "running") return hold(`the run is ${facts.membership.runStatus}`);
  if (facts.membership.leadStatus === "opted_out") return hold("they asked not to be contacted");
  if (facts.membership.leadStatus !== "active") return hold("outreach to them was stopped");
  if (facts.doNotContact) return hold("the person is marked Do Not Contact");
  if (facts.suppressed) return hold("the address unsubscribed or bounced");
  if (facts.takeover) return hold("you are handling this conversation yourself");
  if (facts.waitingForOwner) return hold("this chat waits for you in Needs you");
  if (facts.editedByPerson) return hold("you edited this reply, so it waits for you to send it");
  if (facts.answeredSinceDraft) return hold("someone already answered after this reply was written");
  if (facts.newerInbound) return hold("a newer message arrived; the reply to it is written next");

  const classification = facts.classification;
  if (!classification) return decide("The reply has not been classified.", "uncertain", "Read the conversation and decide how to answer.");
  // An unconfirmed ("proposed") classification is no reason to leave the
  // lead unanswered: the support check reads the message itself and holds
  // anything it cannot back. Its proposed category still decides the cases
  // a person must handle. Rejected or failed ones go to the owner.
  if (!CONFIRMED_CLASSIFICATIONS.has(classification.status) && classification.status !== "proposed") {
    return decide("The AI could not tell what the reply means.", "uncertain", "Read the conversation and decide how to answer.");
  }
  if (classification.categoryKey === "customer") return decide("They are a customer.", "uncertain", "Answer customers yourself.");
  if (classification.subcategoryKey === "out_of_office") return hold("an out-of-office reply needs no answer");
  if (classification.subcategoryKey && NOT_THE_LEAD_SUBCATEGORIES.has(classification.subcategoryKey)) {
    return decide("Not an ordinary reply (a different contact, or someone who left).", "uncertain", "Read the conversation and decide what to do.");
  }
  if (classification.subcategoryKey && AUTOPILOT_ESCALATE_SUBCATEGORIES.has(classification.subcategoryKey)) {
    return decide(`${classification.subcategoryKey.replace(/_/g, " ")} is for you to handle.`, "uncertain", "Answer this one yourself.");
  }
  return { pass: true };
}

export type LimitFacts = { sentInConversation: number; sentInLast24h: number };

/** Why the limits stop this send, or null. Checked under the organization's lock with every reservation counted. */
export function limitProblem(facts: LimitFacts): string | null {
  if (facts.sentInConversation >= AUTOPILOT_LIMITS.perConversation) {
    return `the autopilot already answered this conversation ${facts.sentInConversation} times; over to you`;
  }
  if (facts.sentInLast24h >= AUTOPILOT_LIMITS.perDay) {
    return `the limit of ${AUTOPILOT_LIMITS.perDay} automatic replies in 24 hours is reached`;
  }
  return null;
}

/** The send's idempotency key: one automatic send per draft revision, ever. */
export function autopilotIdempotencyKey(draftId: string, revision: number): string {
  return `${AUTOPILOT_ACTOR}:${draftId}:${revision}`;
}

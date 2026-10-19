import { byUrgency, handoffLabel, isHandoff } from "@/lib/assistant/handoff";
import type { OwnerDecisionKind } from "@/lib/assistant/schema";

/**
 * Where one CRM conversation stands, told only from recorded evidence: the
 * latest inbound and outbound messages, who sent the answer, the reply mode,
 * what waits on a person (a draft, an owner decision, a classification) and
 * what may not be sent (Do Not Contact, a wrong number). The CRM record and
 * Action required APIs return it (conversationSummary.server.ts loads the
 * facts); the lists and the record page show it. Pure and client-safe.
 *
 * Display and triage only: nothing here authorizes a send or settles a
 * decision. An answered conversation's normal action is to open it, not an
 * urgent instruction to send.
 */

export type AnswerActor = "you" | "assistant";

export type ReplyMode = "automatic" | "review" | "takeover";

export const REPLY_MODE_LABELS: Readonly<Record<ReplyMode, string>> = {
  automatic: "Automatic",
  review: "Review",
  takeover: "Takeover",
};

type MessageEvidence = { idempotencyKey?: unknown; raw?: unknown; origin?: unknown };

/** The origin a message records: the CRM row's raw.origin, or the field the server read it into. */
function recordedOrigin(message: MessageEvidence): string | null {
  const raw = message.raw && typeof message.raw === "object" ? message.raw as Record<string, unknown> : {};
  return typeof message.origin === "string" ? message.origin : typeof raw.origin === "string" ? raw.origin : null;
}

/**
 * A WhatsApp campaign step (an assistant run's WhatsApp leg is a campaign
 * too): the campaign engine's send records it with origin `campaign`.
 */
export function isCampaignStep(message: MessageEvidence): boolean {
  return recordedOrigin(message) === "campaign";
}

/**
 * Who sent an outbound message, from what the message records:
 * - the reply agent and the autopilot send under the `autopilot` actor
 *   (`crm-send:autopilot:…`), as does a wrong number's automatic apology
 *   (`crm-send:wrong-number-ack:…`);
 * - a person sent it from WhatsApp Web or the phone (origin `phone`), from
 *   AgentSDR's Messages tab or Calling (origin `agentsdr`), or pressed Send on
 *   a CRM draft (any other `crm-send:` key);
 * - anything else (a campaign step, history copied from another store) is
 *   unknown, and is never attributed to the owner.
 */
export function outboundActor(message: MessageEvidence): AnswerActor | null {
  const key = typeof message.idempotencyKey === "string" ? message.idempotencyKey : "";
  const origin = recordedOrigin(message);
  if (key.startsWith("crm-send:autopilot:") || key.startsWith("crm-send:wrong-number-ack:")) return "assistant";
  if (origin === "phone" || origin === "agentsdr") return "you";
  if (key.startsWith("crm-send:")) return "you";
  return null;
}

export function answerLabel(actor: AnswerActor | null, campaignStep = false): string {
  if (campaignStep) return "Campaign message sent";
  return actor === "assistant" ? "Answered by assistant" : actor === "you" ? "Answered by you" : "Reply sent";
}

type TimelineMessage = MessageEvidence & { direction?: unknown; sentAt?: unknown; createdAt?: unknown };

/**
 * The client's fallback when a record arrives without a server summary: the
 * latest inbound and outbound of a timeline, whether the latter answers the
 * former, and who sent it.
 */
export function conversationSummary(messages: readonly TimelineMessage[]) {
  const timestamp = (message: TimelineMessage) => new Date(String(message.sentAt ?? message.createdAt ?? "")).getTime();
  let inbound: TimelineMessage | undefined;
  let outbound: TimelineMessage | undefined;
  for (const message of messages) {
    if (!Number.isFinite(timestamp(message))) continue;
    if (message.direction === "inbound" && (!inbound || timestamp(message) >= timestamp(inbound))) inbound = message;
    if (message.direction === "outbound" && (!outbound || timestamp(message) >= timestamp(outbound))) outbound = message;
  }
  const answered = Boolean(inbound && outbound && timestamp(outbound) >= timestamp(inbound));
  return { answered, answerLabel: answerLabel(outbound ? outboundActor(outbound) : null, outbound ? isCampaignStep(outbound) : false), lastOutboundAt: outbound?.sentAt ?? outbound?.createdAt };
}

export type SummaryMessage = {
  id: string;
  conversationId: string;
  channel: string;
  accountRef: string;
  sentAt: string;
  excerpt: string;
};

export type SummaryDecision = { id: string; kind: OwnerDecisionKind; status: string; createdAt: string };

export type ConversationFacts = {
  workflowState: string;
  nextActionAt: Date | string | null;
  latestInbound: SummaryMessage | null;
  /**
   * `campaignStep`: a campaign step recorded under another origin (sent before
   * steps carried `campaign`, or its echo reached the CRM first), found
   * through its whatsapp_campaign_sends row while that row exists.
   */
  latestOutbound: (SummaryMessage & MessageEvidence & { campaignStep?: boolean }) | null;
  /** The newest open draft (awaiting review, failed or delivery uncertain). */
  draft: { id: string; status: string; kind: "reply" | "follow_up" | "apology" } | null;
  /** Any draft on the record awaiting review — the Needs you rule, as crmNeedsYouSql reads it. */
  draftAwaitingReview: boolean;
  /** Status of the record's latest classification. */
  classificationStatus: string | null;
  /** Open owner decisions, and recent reports (interested, opt-out). */
  decisions: readonly SummaryDecision[];
  replyMode: ReplyMode;
  account: { channel: string; ref: string; label: string } | null;
  doNotContact: boolean;
  wrongRoute: { channel: string; route: string; ackStatus: string } | null;
  now?: Date;
};

export type NextActionKind =
  | "do_not_contact"
  | "fix_error"
  | "confirm_classification"
  | "classifying"
  | "confirm_delivery"
  | "review_draft"
  | "decide"
  | "wrong_number"
  | "reply"
  | "follow_up_due"
  | "open_conversation";

export type NextAction = { kind: NextActionKind; label: string; urgent: boolean; detail: string | null };

export type ConversationSummary = {
  latestInbound: SummaryMessage | null;
  latestOutbound: (SummaryMessage & { actor: AnswerActor | null }) | null;
  /** `answered`: the latest outbound went out at or after the latest inbound. `none`: no inbound reply yet. */
  answer: { status: "answered" | "unanswered" | "none"; actor: AnswerActor | null; label: string | null };
  /** Answered, no handoff open and nothing stops the conversation: the lead's move. */
  waitingForThem: boolean;
  channel: string | null;
  account: { channel: string; ref: string; label: string } | null;
  replyMode: ReplyMode;
  replyModeLabel: string;
  pending: {
    draft: ConversationFacts["draft"];
    decisions: { id: string; kind: OwnerDecisionKind; label: string; action: string }[];
    /** Shown, never counted as Needs you. */
    reports: { id: string; kind: OwnerDecisionKind; label: string }[];
    classification: "proposed" | "classifying" | null;
  };
  restrictions: { doNotContact: boolean; wrongRoute: ConversationFacts["wrongRoute"] };
  /** An open owner decision (not a report) or a draft awaiting review. */
  needsYou: boolean;
  nextAction: NextAction;
  /** One line for the record header: who answered and what is awaited. */
  headline: string;
};

function action(kind: NextActionKind, label: string, urgent: boolean, detail: string | null = null): NextAction {
  return { kind, label, urgent, detail };
}

const DRAFT_LABELS = { reply: "Review the reply", follow_up: "Review the follow-up", apology: "Review the wrong-number apology" } as const;

export function describeConversation(facts: ConversationFacts): ConversationSummary {
  const now = facts.now ?? new Date();
  const inbound = facts.latestInbound;
  const outbound = facts.latestOutbound;
  const at = (message: SummaryMessage | null) => message ? new Date(message.sentAt).getTime() : Number.NaN;
  const campaignStep = Boolean(outbound && (outbound.campaignStep === true || isCampaignStep(outbound)));
  const actor = outbound && !campaignStep ? outboundActor(outbound) : null;
  const answered = Boolean(inbound && outbound && at(outbound) >= at(inbound));
  const answer: ConversationSummary["answer"] = !inbound
    ? { status: "none", actor: null, label: null }
    : answered ? { status: "answered", actor, label: answerLabel(actor, campaignStep) } : { status: "unanswered", actor: null, label: null };

  const open = facts.decisions.filter((decision) => decision.status === "open" && isHandoff(decision.kind)).sort(byUrgency);
  const reports = facts.decisions.filter((decision) => !isHandoff(decision.kind));
  // A reply being classified now outranks the previous reply's proposal.
  const classification = facts.workflowState === "classifying" || facts.workflowState === "unclassified" ? "classifying"
    : facts.classificationStatus === "proposed" ? "proposed" : null;
  const draft = facts.draft;
  const due = facts.nextActionAt ? new Date(facts.nextActionAt).getTime() <= now.getTime() : false;

  // A classification held for review is the queue's to confirm (crmActionGroupSql); once the
  // conversation was handled and left the queue, the proposal is shown, not demanded.
  const nextAction: NextAction = facts.doNotContact
    ? action("do_not_contact", "Do not contact", false, "Nothing is sent to this person again.")
    : facts.workflowState === "error" ? action("fix_error", "Fix the processing error", true)
    : classification === "proposed" && facts.workflowState === "action_required" ? action("confirm_classification", "Confirm the classification", true)
    : classification === "classifying" ? action("classifying", "Classifying their reply", false)
    : draft?.status === "delivery_uncertain" ? action("confirm_delivery", "Confirm delivery", true, "The last send may or may not have gone out.")
    : draft?.status === "awaiting_review" ? action("review_draft", DRAFT_LABELS[draft.kind], true)
    : open[0] ? action("decide", handoffLabel(open[0].kind).action, true, handoffLabel(open[0].kind).label)
    : draft?.status === "failed" ? action("review_draft", "Fix the failed draft", true)
    : facts.wrongRoute ? action("wrong_number", "Wrong number — outreach stopped", false)
    : answer.status === "unanswered" && facts.workflowState === "action_required" ? action("reply", "Write a reply", true)
    : facts.workflowState === "waiting" && due ? action("follow_up_due", "Follow-up due", true)
    : action("open_conversation", "Open conversation", false);

  // An open handoff means the lead was told a person will reply (the handover
  // message is the assistant's answer), so the move is the owner's, not theirs.
  const waitingForThem = answer.status === "answered" && open.length === 0 && !facts.doNotContact && !facts.wrongRoute;
  const headline = facts.doNotContact ? "Outreach stopped · Do Not Contact"
    : facts.wrongRoute ? "Wrong number — outreach stopped"
    : answer.status === "answered" ? `${answer.label}${waitingForThem ? " · Waiting for their reply" : ""}`
    : classification === "classifying" ? "Reply received · being classified"
    : answer.status === "unanswered" ? "Not answered yet"
    : "Conversation history";

  const strip = (message: SummaryMessage) => ({
    id: message.id, conversationId: message.conversationId, channel: message.channel,
    accountRef: message.accountRef, sentAt: message.sentAt, excerpt: message.excerpt,
  });
  return {
    latestInbound: inbound ? strip(inbound) : null,
    latestOutbound: outbound ? { ...strip(outbound), actor } : null,
    answer,
    waitingForThem,
    channel: facts.account?.channel ?? inbound?.channel ?? outbound?.channel ?? null,
    account: facts.account,
    replyMode: facts.replyMode,
    replyModeLabel: REPLY_MODE_LABELS[facts.replyMode],
    pending: {
      draft,
      decisions: open.map((decision) => ({ id: decision.id, kind: decision.kind, label: handoffLabel(decision.kind).label, action: handoffLabel(decision.kind).action })),
      reports: reports.map((decision) => ({ id: decision.id, kind: decision.kind, label: handoffLabel(decision.kind).label })),
      classification,
    },
    restrictions: { doNotContact: facts.doNotContact, wrongRoute: facts.wrongRoute },
    needsYou: open.length > 0 || facts.draftAwaitingReview,
    nextAction,
    headline,
  };
}

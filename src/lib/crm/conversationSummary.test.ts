import { describe, expect, test } from "bun:test";
import { conversationSummary, describeConversation, outboundActor, type ConversationFacts } from "./conversationSummary";

const inbound = { direction: "inbound", sentAt: "2026-10-18T15:30:00Z" };
const outbound = { direction: "outbound", sentAt: "2026-10-18T15:31:00Z" };

describe("timeline summary (client fallback)", () => {
  test("an automatic answer is displayed without treating the lead as a pending reply", () => {
    expect(conversationSummary([inbound, { ...outbound, idempotencyKey: "crm-send:autopilot:agent:message" }])).toMatchObject({ answered: true, answerLabel: "Answered by assistant" });
  });

  test("a phone reply is identified, while an unknown sender is not attributed to the owner", () => {
    expect(conversationSummary([inbound, { ...outbound, raw: { origin: "phone" } }]).answerLabel).toBe("Answered by you");
    expect(conversationSummary([inbound, outbound]).answerLabel).toBe("Reply sent");
    expect(conversationSummary([inbound, { ...outbound, raw: { origin: "agentsdr" }, campaignStep: true }]).answerLabel).toBe("Campaign message sent");
  });

  test("a later inbound message requires a new answer even when older events arrive out of order", () => {
    expect(conversationSummary([outbound, { ...inbound, sentAt: "2026-10-18T15:32:00Z" }, inbound]).answered).toBe(false);
  });

  test("missing or invalid delivery timestamps do not claim the message was answered", () => {
    expect(conversationSummary([inbound, { direction: "outbound", sentAt: "invalid" }]).answered).toBe(false);
    expect(conversationSummary([outbound]).answered).toBe(false);
  });
});

describe("who sent an outbound message", () => {
  test("from recorded evidence only", () => {
    expect(outboundActor({ idempotencyKey: "crm-send:autopilot:agent:m1" })).toBe("assistant");
    expect(outboundActor({ idempotencyKey: "crm-send:wrong-number-ack:m1" })).toBe("assistant");
    expect(outboundActor({ idempotencyKey: "whatsapp:abc", origin: "phone" })).toBe("you");
    expect(outboundActor({ idempotencyKey: "whatsapp:abc", raw: { origin: "agentsdr" } })).toBe("you");
    // A person pressed Send on a CRM draft.
    expect(outboundActor({ idempotencyKey: "crm-send:9f1c" })).toBe("you");
    // A campaign step or copied history: unknown, never the owner.
    expect(outboundActor({ idempotencyKey: "outreach-email:1" })).toBeNull();
    expect(outboundActor({ idempotencyKey: "whatsapp:abc" })).toBeNull();
    // A WhatsApp campaign step goes out through the same send as the Messages tab (origin agentsdr).
    expect(outboundActor({ idempotencyKey: "whatsapp:abc", raw: { origin: "agentsdr" }, campaignStep: true })).toBeNull();
  });
});

const NOW = new Date("2026-10-18T16:00:00Z");
const message = (id: string, sentAt: string) => ({ id, conversationId: "c1", channel: "whatsapp", accountRef: "wa-1", sentAt, excerpt: "" });

function facts(overrides: Partial<ConversationFacts> = {}): ConversationFacts {
  return {
    workflowState: "idle",
    nextActionAt: null,
    latestInbound: message("in-1", "2026-10-18T15:30:00Z"),
    latestOutbound: { ...message("out-1", "2026-10-18T15:31:00Z"), idempotencyKey: "crm-send:autopilot:agent:in-1", origin: null },
    draft: null,
    draftAwaitingReview: false,
    classificationStatus: "auto_applied",
    decisions: [],
    replyMode: "automatic",
    account: { channel: "whatsapp", ref: "wa-1", label: "Ravi · +919800000001" },
    doNotContact: false,
    wrongRoute: null,
    now: NOW,
    ...overrides,
  };
}

describe("describeConversation", () => {
  test("an answered conversation waits for their reply; its action is to open it, not to send", () => {
    const summary = describeConversation(facts());
    expect(summary.answer).toEqual({ status: "answered", actor: "assistant", label: "Answered by assistant" });
    expect(summary.waitingForThem).toBe(true);
    expect(summary.headline).toBe("Answered by assistant · Waiting for their reply");
    expect(summary.nextAction).toMatchObject({ kind: "open_conversation", label: "Open conversation", urgent: false });
    expect(summary.needsYou).toBe(false);
    expect(summary.replyModeLabel).toBe("Automatic");
  });

  test("an owner reply from WhatsApp Web reads as answered by you", () => {
    const summary = describeConversation(facts({ latestOutbound: { ...message("out-2", "2026-10-18T15:40:00Z"), idempotencyKey: "whatsapp:x", origin: "phone" } }));
    expect(summary.answer.label).toBe("Answered by you");
  });

  test("a WhatsApp campaign step after their reply is a campaign message, never the owner's answer", () => {
    const summary = describeConversation(facts({
      latestInbound: { ...message("in-1", "2026-10-18T15:30:00Z"), channel: "email", accountRef: "mailbox-1" },
      latestOutbound: { ...message("out-3", "2026-10-18T15:45:00Z"), idempotencyKey: "whatsapp:unipile-msg-1", origin: "agentsdr", campaignStep: true },
      replyMode: "review",
    }));
    expect(summary.answer).toEqual({ status: "answered", actor: null, label: "Campaign message sent" });
    expect(summary.latestOutbound?.actor).toBeNull();
    expect(summary.headline).toBe("Campaign message sent · Waiting for their reply");
    // The same send from the Messages tab is the owner's.
    const own = describeConversation(facts({ latestOutbound: { ...message("out-3", "2026-10-18T15:45:00Z"), idempotencyKey: "whatsapp:unipile-msg-1", origin: "agentsdr" } }));
    expect(own.answer.label).toBe("Answered by you");
  });

  test("a newer inbound message is unanswered again, and being classified is not urgent", () => {
    const summary = describeConversation(facts({ workflowState: "classifying", latestInbound: message("in-2", "2026-10-18T15:50:00Z") }));
    expect(summary.answer.status).toBe("unanswered");
    expect(summary.waitingForThem).toBe(false);
    expect(summary.nextAction).toMatchObject({ kind: "classifying", urgent: false });
    expect(summary.pending.classification).toBe("classifying");
  });

  test("an open decision is Needs you even after an answer; a report is shown but not counted", () => {
    const decisions = [
      { id: "d1", kind: "interested" as const, status: "resolved", createdAt: "2026-10-18T15:32:00Z" },
      { id: "d2", kind: "missing_info" as const, status: "open", createdAt: "2026-10-18T15:32:00Z" },
    ];
    const summary = describeConversation(facts({ decisions }));
    expect(summary.needsYou).toBe(true);
    expect(summary.nextAction).toMatchObject({ kind: "decide", urgent: true, detail: "Answer needed" });
    expect(summary.pending.decisions.map((decision) => decision.id)).toEqual(["d2"]);
    expect(summary.pending.reports.map((report) => report.kind)).toEqual(["interested"]);
    expect(summary.answer.label).toBe("Answered by assistant");
    // The answer was the handover ("a personal reply follows"): the lead waits on the owner, not the other way round.
    expect(summary.waitingForThem).toBe(false);
    expect(summary.headline).toBe("Answered by assistant");
    const reportOnly = describeConversation(facts({ decisions: [decisions[0]!] }));
    expect(reportOnly.needsYou).toBe(false);
    expect(reportOnly.nextAction.kind).toBe("open_conversation");
    expect(reportOnly.waitingForThem).toBe(true);
    expect(reportOnly.headline).toBe("Answered by assistant · Waiting for their reply");
  });

  test("a draft awaiting review comes before an open decision and counts as Needs you", () => {
    const summary = describeConversation(facts({
      workflowState: "action_required",
      latestOutbound: null,
      draft: { id: "dr1", status: "awaiting_review", kind: "reply" },
      draftAwaitingReview: true,
      decisions: [{ id: "d2", kind: "negotiation", status: "open", createdAt: "2026-10-18T15:32:00Z" }],
      replyMode: "review",
    }));
    expect(summary.nextAction).toMatchObject({ kind: "review_draft", label: "Review the reply", urgent: true });
    expect(summary.needsYou).toBe(true);
    expect(summary.answer.status).toBe("unanswered");
  });

  test("a proposed classification is confirmed before anything else; it is not Needs you", () => {
    const summary = describeConversation(facts({ workflowState: "action_required", classificationStatus: "proposed" }));
    expect(summary.nextAction.kind).toBe("confirm_classification");
    expect(summary.needsYou).toBe(false);
    // Once the reply was handled and left the queue, the proposal is shown, not demanded.
    const handled = describeConversation(facts({ workflowState: "idle", classificationStatus: "proposed" }));
    expect(handled.nextAction.kind).toBe("open_conversation");
    expect(handled.pending.classification).toBe("proposed");
  });

  test("Do Not Contact and a wrong number close the conversation instead of asking for a reply", () => {
    const dnc = describeConversation(facts({ doNotContact: true, workflowState: "action_required", latestOutbound: null }));
    expect(dnc.nextAction).toMatchObject({ kind: "do_not_contact", urgent: false });
    expect(dnc.headline).toBe("Outreach stopped · Do Not Contact");
    expect(dnc.waitingForThem).toBe(false);
    const wrong = describeConversation(facts({ wrongRoute: { channel: "whatsapp", route: "919800000002", ackStatus: "sent" } }));
    expect(wrong.nextAction).toMatchObject({ kind: "wrong_number", urgent: false });
    expect(wrong.waitingForThem).toBe(false);
    expect(wrong.answer.label).toBe("Answered by assistant");
  });

  test("an unanswered reply waiting on a person asks for one; an uncertain send asks for confirmation", () => {
    expect(describeConversation(facts({ workflowState: "action_required", latestOutbound: null })).nextAction).toMatchObject({ kind: "reply", urgent: true });
    expect(describeConversation(facts({ workflowState: "action_required", draft: { id: "dr", status: "delivery_uncertain", kind: "reply" } })).nextAction.kind).toBe("confirm_delivery");
  });

  test("a follow-up past its time is due; one in the future is not", () => {
    expect(describeConversation(facts({ workflowState: "waiting", nextActionAt: "2026-10-18T15:00:00Z" })).nextAction.kind).toBe("follow_up_due");
    expect(describeConversation(facts({ workflowState: "waiting", nextActionAt: "2026-10-19T15:00:00Z" })).nextAction.kind).toBe("open_conversation");
  });

  test("a takeover is reported as the reply mode", () => {
    expect(describeConversation(facts({ replyMode: "takeover" })).replyModeLabel).toBe("Takeover");
  });
});

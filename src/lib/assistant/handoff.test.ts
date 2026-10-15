import { describe, expect, test } from "bun:test";
import { byUrgency, handoffLabel, handoverMessage, isHandoff, messageLanguage, takesAnAnswer, tellsTheLead, waitedFor } from "./handoff";
import { judgeReply, type ModelCheck } from "./replyCheck";
import { replyState } from "./runReplies";
import { profileKnowledgeText } from "./profile";
import type { OwnerDecisionKind } from "./schema";

const base: ModelCheck = { intent: "question", questions: [], claims: [], commitments: [], missing: "", escalate: "" };
const knowledge = "Business: Bright Path\n\nOffer: chair servicing";

describe("when a person takes over", () => {
  test("a lead ready for the next step, or asking for a person, goes to the owner even when the reply is backed", () => {
    const ready = judgeReply({ ...base, intent: "ready", escalate: "wants a price for 3 chairs" }, { reply: "Great!", knowledge, leadName: "Dr Rao" });
    expect(ready).toMatchObject({ action: "hold", kind: "ready" });
    expect(ready.action === "hold" && ready.reason).toBe("Dr Rao is ready: wants a price for 3 chairs.");
    expect(judgeReply({ ...base, intent: "wants_person" }, { reply: "Sure.", knowledge, leadName: "Dr Rao" })).toMatchObject({ action: "hold", kind: "person" });
  });

  test("an 'ok' or 'thanks' after an answer gets no reply; before any answer it is answered as usual", () => {
    expect(judgeReply({ ...base, intent: "acknowledgement" }, { reply: "You're welcome!", knowledge, leadName: "A", answeredBefore: true }).action).toBe("no_reply");
    expect(judgeReply({ ...base, intent: "acknowledgement" }, { reply: "Thanks! How do you handle chair repairs at the moment?", knowledge, leadName: "A", answeredBefore: false }).action).toBe("send");
  });

  test("handoffs, reports, and which ones tell the lead", () => {
    expect(isHandoff("ready")).toBe(true);
    expect(isHandoff("interested")).toBe(false);
    expect(isHandoff("opt_out")).toBe(false);
    for (const kind of ["ready", "person", "complaint", "missing_info", "limit"] as OwnerDecisionKind[]) expect(tellsTheLead(kind)).toBe(true);
    // an out-of-office or a message nobody understood is not told "I'll get back to you"
    expect(tellsTheLead("uncertain")).toBe(false);
    expect(tellsTheLead("opt_out")).toBe(false);
    expect(takesAnAnswer("missing_info")).toBe(true);
    expect(takesAnAnswer("ready")).toBe(false);
  });

  test("Needs you: ready to buy first, then the longest wait", () => {
    const items = [
      { kind: "missing_info" as const, createdAt: "2026-10-15T08:00:00Z" },
      { kind: "ready" as const, createdAt: "2026-10-15T10:00:00Z" },
      { kind: "limit" as const, createdAt: "2026-10-15T07:00:00Z" },
      { kind: "missing_info" as const, createdAt: "2026-10-15T06:00:00Z" },
      { kind: "person" as const, createdAt: "2026-10-15T09:00:00Z" },
    ].sort(byUrgency);
    expect(items.map((item) => `${item.kind}@${item.createdAt.slice(11, 13)}`)).toEqual(["ready@10", "person@09", "missing_info@06", "missing_info@08", "limit@07"]);
    expect(handoffLabel("ready").label).toBe("Ready to buy");
    expect(waitedFor("2026-10-15T09:00:00Z", new Date("2026-10-15T09:42:00Z"))).toBe("42 min");
    expect(waitedFor("2026-10-15T01:00:00Z", new Date("2026-10-15T09:42:00Z"))).toBe("8 h");
    expect(waitedFor("2026-10-12T01:00:00Z", new Date("2026-10-15T09:42:00Z"))).toBe("3 days");
  });
});

describe("the handover message", () => {
  test("speaks as the sender (it comes from their number), promises only a personal reply, in the lead's language", () => {
    const whatsapp = handoverMessage("whatsapp", { kind: "missing_info", leadMessage: "Do you service X-ray machines?", senderName: "Ravi Kumar" });
    expect(whatsapp).toEqual({ subject: null, body: "Thanks for your message! I'll get back to you personally on this soon." });
    expect(whatsapp.body).not.toContain("Ravi");
    expect(handoverMessage("whatsapp", { kind: "ready", leadMessage: "Yes let's do it, send the price" }).body).toContain("take this forward");
    expect(handoverMessage("whatsapp", { kind: "ready", leadMessage: "haan bhai kitna lagega, call karo" }).body).toBe("Thank you! Aage ke liye aapko jaldi personally reply milega.");
    expect(handoverMessage("linkedin", { kind: "person", leadMessage: "क्या मैं किसी व्यक्ति से बात कर सकता हूँ?" }).body).toContain("व्यक्तिगत");
    for (const text of [whatsapp.body]) expect(text).not.toMatch(/\b(?:today|tomorrow|minutes?|hours?)\b/i);
  });

  test("an email keeps the thread's subject and is signed by the sender", () => {
    const email = handoverMessage("email", { kind: "complaint", leadMessage: "This is unacceptable", senderName: "Ravi Kumar", leadFirstName: "Asha", subject: "Chair servicing" });
    expect(email.subject).toBe("Re: Chair servicing");
    expect(email.body).toBe("Hi Asha,\n\nThanks for your message! I'll get back to you personally on this soon.\n\nRavi Kumar");
    expect(handoverMessage("email", { kind: "limit", subject: "Re: Hello" }).subject).toBe("Re: Hello");
  });

  test("language detection", () => {
    expect(messageLanguage("Do you cover Baner?")).toBe("en");
    expect(messageLanguage("aap kitna charge karte ho?")).toBe("hinglish");
    expect(messageLanguage("क्या आप बानेर में आते हैं?")).toBe("hi");
    expect(messageLanguage("ok")).toBe("en");
  });
});

describe("the plan card's reply states", () => {
  test("a handover, an acknowledgement and a chat waiting in Needs you", () => {
    expect(replyState({ draftStatus: "sent", autoStatus: "sent", autoReason: "handover (ready): the lead was told a personal reply follows", jobStatus: null, sendAfter: null, receivedAt: "2026-10-15T08:00:00Z" }, true).text).toContain("Needs you");
    expect(replyState({ draftStatus: "awaiting_review", autoStatus: "held", autoReason: "no answer needed: A only acknowledged the last answer; nothing to reply", jobStatus: null, sendAfter: null, receivedAt: "2026-10-15T08:00:00Z" }, true)).toMatchObject({ tone: "done" });
    expect(replyState({ draftStatus: "awaiting_review", autoStatus: "held", autoReason: "this chat waits for you in Needs you", jobStatus: null, sendAfter: null, receivedAt: "2026-10-15T08:00:00Z" }, true).text).toBe("Waiting for you in Needs you");
  });
});

describe("the next step replies lead to", () => {
  test("a short call with the sender unless the owner named another; written only once there is an offer", () => {
    expect(profileKnowledgeText({ offer: "Chair servicing", senderName: "Ravi" })).toContain("Next step offered to interested leads: a short call with Ravi");
    expect(profileKnowledgeText({ offer: "Chair servicing", nextStep: "a free site visit" })).toContain("Next step offered to interested leads: a free site visit");
    expect(profileKnowledgeText({ businessName: "Bright Path" })).not.toContain("Next step");
    expect(profileKnowledgeText({ offer: "X", problemsSolved: "Chairs break; repairs take a week" })).toContain("Problems we solve: Chairs break; repairs take a week");
  });
});

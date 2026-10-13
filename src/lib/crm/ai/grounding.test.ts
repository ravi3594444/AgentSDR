import { describe, expect, test } from "bun:test";
import { draftGroundingProblem, draftLeaks, draftPlaceholders, signatureText, unverifiedActionClaims, type DraftCompletedAction } from "./grounding";

const sentPricing: DraftCompletedAction = {
  kind: "message_sent",
  channel: "email",
  sentAt: "2026-10-01T10:00:00.000Z",
  subject: "Pricing for Acme",
  excerpt: "Here is our pricing overview and a link to the deck.",
};
const meetingBooked: DraftCompletedAction = { kind: "stage_moved", stage: "meeting_booked", occurredAt: "2026-10-02T10:00:00.000Z", note: null };

describe("unverifiedActionClaims", () => {
  test("flags claims of a booked meeting, a sent invitation or an attachment", () => {
    for (const text of [
      "I've booked a 30-minute call for Tuesday at 10am.",
      "I have scheduled our demo for Thursday.",
      "The meeting is confirmed for Monday.",
      "I sent the calendar invite a moment ago.",
      "I've just sent you an invitation for Tuesday.",
      "The invite is on its way.",
      "You should have received the calendar invite.",
      "Please find attached our pricing.",
      "I've attached the case study.",
    ]) {
      expect(unverifiedActionClaims(text, [])).not.toEqual([]);
    }
  });

  test("allows offers, proposals and future intentions", () => {
    for (const text of [
      "Would Tuesday at 10am work for a quick call?",
      "I can send a calendar invite once you confirm a time.",
      "I'll send over the pricing overview today.",
      "Happy to share the deck if that helps.",
      "How is your company handling outbound today?",
      "Thanks for the call last week.",
    ]) {
      expect(unverifiedActionClaims(text, [])).toEqual([]);
    }
  });

  test("a booking is fine once a person recorded the meeting stage", () => {
    expect(unverifiedActionClaims("I've booked the call for Tuesday.", [meetingBooked])).toEqual([]);
  });

  test("a shared document is fine when an earlier sent message mentions it, an invitation never is", () => {
    expect(unverifiedActionClaims("I've sent over the pricing earlier this week.", [sentPricing])).toEqual([]);
    expect(unverifiedActionClaims("I've sent you the contract.", [sentPricing])).not.toEqual([]);
    expect(unverifiedActionClaims("I've sent you the calendar invite.", [sentPricing, meetingBooked])).not.toEqual([]);
  });
});

describe("draftPlaceholders", () => {
  test("finds bracket, brace and sign-off placeholders", () => {
    expect(draftPlaceholders("Best,\n[Your Name]")).toEqual(["[Your Name]"]);
    expect(draftPlaceholders("Hi {{first_name}},")).toEqual(["{{first_name}}"]);
    expect(draftPlaceholders("Thanks,\nYour Name\n")).toEqual(["Your Name"]);
    expect(draftPlaceholders("Book here: <insert calendar link>")).not.toEqual([]);
  });

  test("leaves ordinary text and markdown links alone", () => {
    expect(draftPlaceholders("I came across your name on the speaker list. See [our site](https://example.com).")).toEqual([]);
  });
});

describe("draftGroundingProblem", () => {
  test("is null for a grounded draft", () => {
    expect(draftGroundingProblem({ subject: "Re: Pricing", bodyText: "Would Tuesday at 10am work?\n\nBest,\nAsha" }, [])).toBeNull();
  });

  test("explains placeholders first, then unverified claims", () => {
    expect(draftGroundingProblem({ subject: null, bodyText: "Booked!\n[Your Name]" }, [])).toContain("placeholders");
    expect(draftGroundingProblem({ subject: null, bodyText: "I've booked the call for Tuesday." }, [])).toContain("Nothing has been booked");
  });
});

describe("signatureText", () => {
  test("turns a mailbox signature into plain lines", () => {
    expect(signatureText("<p>Asha Rao<br>Head of Sales &amp; Partnerships</p><div>22nd X AI</div>")).toBe("Asha Rao\nHead of Sales & Partnerships\n22nd X AI");
    expect(signatureText("  ")).toBeNull();
  });
});

describe("draftLeaks", () => {
  test("catches prompt field names and the model describing its limits", () => {
    expect(draftLeaks("While completedActions records what has been done, I am unable to send calendar invitations directly from here.")).toHaveLength(2);
    expect(draftLeaks("Per the knowledge excerpt, our plan costs less.")).toHaveLength(1);
    expect(draftGroundingProblem({ subject: null, bodyText: "As an AI, I can't book meetings." }, [])).toContain("drafting context");
  });

  test("leaves ordinary replies alone, including a promise of what follows", () => {
    expect(draftLeaks("Tuesday at 10:00 works. I'll send an invite and the pricing overview beforehand.")).toEqual([]);
    expect(unverifiedActionClaims("Tuesday at 10:00 works. I'll send an invite and the pricing overview beforehand.", [])).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";
import { agentSystemPrompt, agentUserPrompt, hardStop, ownerNoteToDecision, parseAgentDecision, replyAgentClaimRenewIntervalMs, replyProblems, wrongNumberClosing } from "./agent";

const knowledge = "Business: Bright Path\n\nOffer: Monthly maintenance plan: ₹2,499 per chair per month, includes two visits.\n\nService area: Pune.\n\nHow meetings are booked: https://cal.example.test/brightpath";

describe("the agent's decision", () => {
  test("is parsed strictly: a known action, a reply only for reply, a note only when complete", () => {
    const decision = parseAgentDecision(JSON.stringify({ reasoning: "greeting", action: "reply", reply: "Hi! How do you look after your chairs today?", ownerNote: null, category: "other", confidence: 0.7 }));
    expect(decision).toMatchObject({ action: "reply", category: "other", ownerNote: null });
    expect(parseAgentDecision(JSON.stringify({ action: "no_reply", reply: "ignored", ownerNote: { kind: "ready", note: "" }, category: "weird", confidence: 7 }))).toMatchObject({ action: "no_reply", reply: "", ownerNote: null, category: "other", confidence: 0.5 });
    expect(parseAgentDecision(JSON.stringify({ action: "reply", reply: "Noted! Ravi will call you.", ownerNote: { kind: "ready", note: "wants a call about 3 chairs" }, category: "interested", confidence: 0.9 })).ownerNote).toEqual({ kind: "ready", note: "wants a call about 3 chairs" });
    expect(() => parseAgentDecision(JSON.stringify({ action: "send", reply: "x" }))).toThrow();
    expect(() => parseAgentDecision(JSON.stringify({ action: "reply", reply: "  " }))).toThrow();
  });
});

describe("what must never go out is fed back, never invented", () => {
  test("amounts, days, links, placeholders and done-claims not in the business information are problems", () => {
    expect(replyProblems("The plan is ₹2,499 per chair, two visits a month. Book here: https://cal.example.test/brightpath", "whatsapp", knowledge)).toEqual([]);
    expect(replyProblems("I can do it for ₹1,999 if you sign today.", "whatsapp", knowledge).join(" ")).toContain("₹1,999");
    expect(replyProblems("Shall we meet Tuesday at 4pm?", "whatsapp", knowledge).join(" ")).toMatch(/Tuesday|4pm/);
    expect(replyProblems("Details: https://brightpath.example.com/pricing", "whatsapp", knowledge).join(" ")).toContain("brightpath.example.com");
    expect(replyProblems("Hi [Name], I've attached the brochure.", "email", knowledge).length).toBeGreaterThan(0);
    expect(replyProblems("", "whatsapp", knowledge)).toEqual(["the reply is empty"]);
  });


});

describe("the hard rules", () => {
  const ok = { doNotContact: false, suppressed: false, newerInbound: false, answeredAlready: false, runInactive: false, takeover: false, sentInConversation: 2, sentInLast24h: 5, perConversation: 30, perDay: 40 };
  test("nothing stops an ordinary reply; opt-outs, a newer message, an answer already given and the limits do", () => {
    expect(hardStop(ok)).toBeNull();
    expect(hardStop({ ...ok, doNotContact: true })?.tellOwner).toBe(false);
    expect(hardStop({ ...ok, newerInbound: true })?.reason).toContain("newer message");
    expect(hardStop({ ...ok, answeredAlready: true })?.reason).toContain("already answered");
    expect(hardStop({ ...ok, answeredAlready: true })?.answered).toBe(true);
    expect(hardStop({ ...ok, newerInbound: true, answeredAlready: true })?.answered).toBeUndefined();
    expect(hardStop({ ...ok, sentInLast24h: 40 })?.answered).toBeUndefined();
    expect(hardStop({ ...ok, takeover: true })?.reason).toContain("yourself");
    expect(hardStop({ ...ok, sentInConversation: 30 })).toMatchObject({ tellOwner: true });
    expect(hardStop({ ...ok, sentInLast24h: 40 })).toMatchObject({ tellOwner: true });
  });
});

describe("the prompt", () => {
  test("carries the business information, the owner's instructions, the conversation and the problems to fix", () => {
    const profile = { businessName: "Bright Path", senderName: "Ravi", offer: "Chair servicing", outreachInstructions: "Never discuss price; say Ravi will call." };
    const system = agentSystemPrompt({ channel: "whatsapp", profile });
    expect(system).toContain("Ravi's sales assistant");
    expect(system).toContain("WhatsApp");
    const user = agentUserPrompt({ channel: "whatsapp", profile, knowledge, lead: { name: "Dr Rao", category: "Dental clinic" }, conversation: [{ direction: "outbound", bodyText: "Hi, Ravi here…" }, { direction: "inbound", bodyText: "Hey" }], leadMessage: "Hey", problems: ["it gives an amount the business information does not contain (₹1,999)"], previousReply: "₹1,999 for you", turn: 2 });
    expect(user).toContain("Never discuss price");
    expect(user).toContain("Dr Rao");
    expect(user).toContain("YOU: Hi, Ravi here");
    expect(user).toContain("PROBLEMS TO FIX");
    expect(user).toContain("a short call with Ravi");
    expect(ownerNoteToDecision("ready").kind).toBe("ready");
    expect(ownerNoteToDecision("question").kind).toBe("missing_info");
  });

  test("an Instagram inquiry is answered as a chat, within a chat's length", () => {
    expect(agentSystemPrompt({ channel: "instagram", profile: { senderName: "Ravi" } })).toContain("Instagram: write like a person texting");
    expect(replyProblems("a".repeat(700), "instagram", "")).toEqual([expect.stringContaining("keep it under 600")]);
  });
});

describe("a wrong number", () => {
  test("is its own action: the apology is kept, and it is never filed as a buyer's answer", () => {
    const decision = parseAgentDecision(JSON.stringify({ reasoning: "not the lead", action: "wrong_number", reply: " Sorry about that—we won't message this number again. ", ownerNote: null, category: "not_interested", confidence: 0.9 }));
    expect(decision).toMatchObject({ action: "wrong_number", reply: "Sorry about that—we won't message this number again.", category: "other" });
    // No apology written: the harness uses the fixed line.
    expect(parseAgentDecision(JSON.stringify({ action: "wrong_number", reply: "", ownerNote: null, category: "interested", confidence: 0.8 }))).toMatchObject({ action: "wrong_number", reply: "", category: "other" });
    expect(agentSystemPrompt({ channel: "whatsapp", profile: { senderName: "Ravi" } })).toContain("- wrong_number:");
  });

  test("closes with one apology, unless an explicit opt-out sits beside it", () => {
    expect(wrongNumberClosing({ action: "wrong_number" }, "Wrong number")).toEqual({ optOut: false });
    expect(wrongNumberClosing({ action: "wrong_number" }, "Wrong number, stop messaging me")).toEqual({ optOut: true });
    expect(wrongNumberClosing({ action: "wrong_number" }, "Not him. Don't text me again")).toEqual({ optOut: true });
    // A stop request that also says "wrong number" still records the route, with nothing sent.
    expect(wrongNumberClosing({ action: "stop_contact" }, "wrong number, unsubscribe")).toEqual({ optOut: true });
    expect(wrongNumberClosing({ action: "stop_contact" }, "unsubscribe")).toBeNull();
    expect(wrongNumberClosing({ action: "reply" }, "Wrong number")).toBeNull();
  });
});

describe("the claim heartbeat", () => {
  test("renews three times inside the stale window, capped at a minute", () => {
    expect(replyAgentClaimRenewIntervalMs(3 * 60_000)).toBe(60_000);
    expect(replyAgentClaimRenewIntervalMs(90_000)).toBe(30_000);
    expect(replyAgentClaimRenewIntervalMs(3_000)).toBe(1_000);
    expect(replyAgentClaimRenewIntervalMs(900)).toBe(300);
  });
});

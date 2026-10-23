import { expect, test } from "bun:test";
import { observations, SCENARIOS } from "./reply-agent";
import type { AgentDecision } from "@/lib/assistant/replyAgent/agent";

const reply = (text: string, overrides: Partial<AgentDecision> = {}): AgentDecision => ({ action: "reply", reply: text, ownerNote: null, category: "other", confidence: 0.8, reasoning: "Uses the prior answer", ...overrides });

test("the observed baseline's false interest and call handoff are both visible", () => {
  const findings = observations(reply("Got it. What business are the calls for?", { category: "interested", ownerNote: { kind: "ready", note: "Lead wants a call" } }), SCENARIOS[0]!);
  expect(findings).toContain("ordinary chat was classified as interested");
  expect(findings).toContain("reports an unrequested next step to the owner");
});

test("continuity observations catch repeated filler without banning a normal acknowledgement", () => {
  const scenario = SCENARIOS.find(item => item.id === "continue-generated-reply")!;
  expect(observations(reply("Got it, we can automate follow-ups."), scenario)).toContain("repeats the previous acknowledgement");
  expect(observations(reply("We can automate follow-ups from that spreadsheet."), scenario)).toEqual([]);
  expect(observations(reply("Got it, outbound calls. Who handles them?"), SCENARIOS[0]!)).toEqual([]);
});

test("a genuine follow-up answer need not use the exact words follow-up", () => {
  expect(observations(reply("We can retry unanswered enquiries and record each attempt in your CRM."), SCENARIOS[1]!)).toEqual([]);
});

test("price handoffs and silent opt-outs remain checked", () => {
  const price = SCENARIOS.find(item => item.expect === "price")!;
  expect(observations(reply("Ravi can confirm the price.", { category: "interested", ownerNote: { kind: "question", note: "Please confirm pricing" } }), price)).toEqual([]);
  const stop = SCENARIOS.find(item => item.expect === "stop")!;
  expect(observations(reply("", { action: "stop_contact", category: "not_interested" }), stop)).toEqual([]);
  expect(observations(reply("Can I change your mind?"), stop)).toContain("opt-out did not stop silently");
});

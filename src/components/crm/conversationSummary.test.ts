import { expect, test } from "bun:test";
import { conversationSummary } from "./conversationSummary";

const inbound = { direction: "inbound", sentAt: "2026-10-18T15:30:00Z" };
const outbound = { direction: "outbound", sentAt: "2026-10-18T15:31:00Z" };

test("an automatic answer is displayed without treating the lead as a pending reply", () => {
  expect(conversationSummary([inbound, { ...outbound, idempotencyKey: "crm-send:autopilot:agent:message" }])).toMatchObject({ answered: true, answerLabel: "Answered by assistant" });
});

test("a phone reply is identified, while an unknown sender is not attributed to the owner", () => {
  expect(conversationSummary([inbound, { ...outbound, raw: { origin: "phone" } }]).answerLabel).toBe("Answered by you");
  expect(conversationSummary([inbound, outbound]).answerLabel).toBe("Reply sent");
});

test("a later inbound message requires a new answer even when older events arrive out of order", () => {
  expect(conversationSummary([outbound, { ...inbound, sentAt: "2026-10-18T15:32:00Z" }, inbound]).answered).toBe(false);
});

test("missing or invalid delivery timestamps do not claim the message was answered", () => {
  expect(conversationSummary([inbound, { direction: "outbound", sentAt: "invalid" }]).answered).toBe(false);
  expect(conversationSummary([outbound]).answered).toBe(false);
});

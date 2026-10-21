import { expect, test } from "bun:test";
import { runReplyGeneration, type AgentModel } from "./generation";

const context = { channel: "whatsapp" as const, profile: {}, knowledge: "Business: 22nd X AI. AI automation and websites.", lead: {}, conversation: [], leadMessage: "Hello" };
const reply = (text: string) => JSON.stringify({ action: "reply", reply: text, ownerNote: null, category: "other", confidence: 0.5, reasoning: "A greeting." });

test("the screenshot's HTTP 400 stops after one rejected request, with no fabricated decision", async () => {
  let calls = 0;
  const result = await runReplyGeneration({ context, systemPrompt: "Reply naturally.", requestedModel: () => "deepseek/deepseek-chat", model: async () => {
    calls++;
    throw Object.assign(new Error("400 Validation failed: response_format.type"), { status: 400 });
  } });
  expect(calls).toBe(1);
  expect(result.decision).toBeNull();
  expect(result.model).toBe("deepseek/deepseek-chat");
  expect(result.turns[0]).toMatchObject({ httpStatus: 400, error: "400 Validation failed: response_format.type" });
  expect(result.failureReason).toContain("1 attempt");
});

test("a healthy greeting uses the model's contextual answer", async () => {
  const result = await runReplyGeneration({ context, systemPrompt: "Reply naturally.", model: async () => ({ text: reply("Hi! How do you currently handle incoming calls?"), model: "deepseek/deepseek-chat" }) });
  expect(result.decision?.reply).toBe("Hi! How do you currently handle incoming calls?");
  expect(result.decision?.category).toBe("other");
  expect(result.turns).toHaveLength(1);
  expect(result.failureReason).toBeNull();
});

test("a rejected claim is repaired with feedback before anything can be sent", async () => {
  let calls = 0;
  const model: AgentModel = async ({ userPrompt }) => {
    calls++;
    if (calls === 1) return { text: reply("It costs $999 per month.") };
    expect(userPrompt).toContain("PROBLEMS TO FIX");
    expect(userPrompt).toContain("999");
    return { text: reply("Hi! Which workflow would you like to automate?") };
  };
  const result = await runReplyGeneration({ context, systemPrompt: "Use known facts.", model });
  expect(result.decision?.reply).toBe("Hi! Which workflow would you like to automate?");
  expect(result.turns).toHaveLength(2);
});

test("transient failures can recover, while an exhausted outage never invents a holding message", async () => {
  let calls = 0;
  const recovered = await runReplyGeneration({ context, systemPrompt: "Reply.", model: async () => {
    if (++calls === 1) throw Object.assign(new Error("overloaded"), { status: 503 });
    return { text: reply("Hi! How can I help?") };
  } });
  expect(recovered.decision?.reply).toBe("Hi! How can I help?");
  const failed = await runReplyGeneration({ context, systemPrompt: "Reply.", model: async () => { throw Object.assign(new Error("overloaded"), { status: 503 }); } });
  expect(failed.turns).toHaveLength(3);
  expect(failed.decision).toBeNull();
  expect(failed.failureReason).toContain("overloaded");
});

test("persistent unsupported claims stay failed rather than becoming a customer-facing promise", async () => {
  const result = await runReplyGeneration({ context, systemPrompt: "Use known facts.", model: async () => ({ text: reply("It costs $999 per month.") }) });
  expect(result.decision).toBeNull();
  expect(result.turns).toHaveLength(3);
  expect(result.failureReason).toContain("amount");
});

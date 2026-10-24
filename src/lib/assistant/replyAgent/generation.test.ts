import { expect, test } from "bun:test";
import { runReplyGeneration, type AgentModel } from "./generation";

const context = { channel: "whatsapp" as const, profile: {}, knowledge: "Business: 22nd X AI. AI automation and websites.", lead: {}, conversation: [], leadMessage: "Hello" };
const reply = (text: string) => JSON.stringify({ action: "reply", reply: text, ownerNote: null, category: "other", confidence: 0.5, reasoning: "A greeting." });

test("an already answered services question is not held for a pricing question that may follow", async () => {
  let calls = 0;
  const result = await runReplyGeneration({ context: { ...context, leadMessage: "So what items do you sell?" }, systemPrompt: "Reply.", model: async () => {
    calls++;
    if (calls > 1) return { text: reply("We build AI automation and websites. Which task would you like to automate?") };
    return { text: JSON.stringify({ ...JSON.parse(reply("We build AI automation and websites. Which task would you like to automate?")), ownerNote: { kind: "question", note: "Lead's exact pricing question may follow, and pricing is per project only." } }) };
  } });
  expect(calls).toBe(2);
  expect(result.decision?.action).toBe("reply");
  expect(result.decision?.ownerNote).toBeNull();
});

test("repairing a speculative sentence must not silently delete a real owner handoff", async () => {
  let calls = 0;
  const result = await runReplyGeneration({ context: { ...context, leadMessage: "What is the exact price?" }, systemPrompt: "Reply.", model: async ({ userPrompt }) => {
    if (++calls > 1) expect(userPrompt).toContain("retain any genuine handoff");
    return { text: JSON.stringify({ ...JSON.parse(reply("The owner will confirm your quote.")), ownerNote: { kind: "question", note: calls === 1 ? "They asked for an exact price. A contract question may follow." : "They asked for an exact price; no fixed price is saved." } }) };
  } });
  expect(result.decision?.ownerNote?.note).toContain("exact price");
  expect(result.turns).toHaveLength(2);
});

test("an actual unanswered pricing question still reaches the owner", async () => {
  const result = await runReplyGeneration({ context: { ...context, leadMessage: "What is the exact price?" }, systemPrompt: "Reply.", model: async () => ({ text: JSON.stringify({ ...JSON.parse(reply("The owner will confirm a quote for your project.")), ownerNote: { kind: "question", note: "They asked for the exact project price; no fixed price is saved." } }) }) });
  expect(result.decision?.ownerNote?.kind).toBe("question");
});

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

test("a claim lost while the model works stops the loop and throws (RR2)", async () => {
  const claimLost = new Error("CRM job j-1 is no longer owned by this worker");
  claimLost.name = "CrmJobClaimLostError";
  let calls = 0;
  await expect(runReplyGeneration({ context, systemPrompt: "Reply.", model: async () => {
    calls++;
    throw claimLost;
  } })).rejects.toBe(claimLost);
  expect(calls).toBe(1);
});

test("an aborted signal after the model returns discards its answer (RR2)", async () => {
  const controller = new AbortController();
  const lost = new Error("Reply agent claim lost: a newer attempt took over this message");
  lost.name = "ReplyAgentClaimLostError";
  await expect(runReplyGeneration({ context, systemPrompt: "Reply.", signal: controller.signal, model: async () => {
    controller.abort(lost);
    return { text: reply("Hi! How can I help?") };
  } })).rejects.toBe(lost);
});

test("a spent budget ends the loop with no decision, in one turn (RR1/RR4)", async () => {
  const exhausted = new Error("crm_reply_classification stopped: the shared reply budget is exhausted");
  exhausted.name = "StructuredBudgetExhaustedError";
  let calls = 0;
  const result = await runReplyGeneration({ context, systemPrompt: "Reply.", model: async () => {
    calls++;
    throw exhausted;
  } });
  expect(calls).toBe(1);
  expect(result.decision).toBeNull();
  expect(result.turns).toHaveLength(1);
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

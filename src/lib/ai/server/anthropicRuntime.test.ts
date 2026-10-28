import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { anthropicCostUsd, anthropicRequestFrom, compatResponseFrom, createAnthropicCompatClient } from "./anthropicRuntime";
import { completeStructured } from "./structuredCompletion";

const toolRequest = {
  model: "claude-sonnet-5-5",
  max_tokens: 800,
  messages: [{ role: "system", content: "Sort the reply." }, { role: "user", content: "Thanks, not interested." }],
  tools: [{ type: "function", function: { name: "classify", description: "Submit it", parameters: { type: "object", properties: { label: { type: "string" } }, required: ["label"], additionalProperties: false } } }],
  tool_choice: { type: "function", function: { name: "classify" } },
};

function message(overrides: Partial<Anthropic.Beta.BetaMessage>): Anthropic.Beta.BetaMessage {
  return {
    id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: "tool_use", stop_sequence: null,
    content: [{ type: "tool_use", id: "toolu_1", name: "classify", input: { label: "not_interested" } }],
    usage: { input_tokens: 1000, output_tokens: 200 },
    ...overrides,
  } as Anthropic.Beta.BetaMessage;
}

describe("Anthropic engine: the OpenAI-shaped request as a Messages request", () => {
  test("system prompt, user turn, the tool as a client tool, never a forced choice", () => {
    const request = anthropicRequestFrom(toolRequest);
    expect(request.system).toBe("Sort the reply.");
    expect(request.messages).toEqual([{ role: "user", content: "Thanks, not interested." }]);
    expect(request.tools?.[0]).toMatchObject({ name: "classify", input_schema: { type: "object" } });
    // Opus 5.5 and Sonnet 5.5 refuse forced tool use with a 400.
    expect(request.tool_choice).toEqual({ type: "auto" });
    expect(request.max_tokens).toBeGreaterThanOrEqual(4096);
    expect(request).not.toHaveProperty("temperature");
    expect(request).not.toHaveProperty("thinking");
  });
  test("Opus and Sonnet opt into server-side fallbacks; Haiku has none", () => {
    expect(anthropicRequestFrom(toolRequest)).toMatchObject({ fallbacks: "default", betas: ["server-side-fallback-2026-07-01"] });
    expect(anthropicRequestFrom({ ...toolRequest, model: "claude-haiku-5-5" })).not.toHaveProperty("fallbacks");
  });
  test("an image part becomes an image block beside the text, never dropped", () => {
    const request = anthropicRequestFrom({ ...toolRequest, messages: [{ role: "system", content: "Look." }, { role: "user", content: [{ type: "text", text: "The screenshot:" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AAQ" } }] }] });
    expect(request.messages).toEqual([{ role: "user", content: [{ type: "text", text: "The screenshot:" }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/4AAQ" } }] }]);
    expect(() => anthropicRequestFrom({ ...toolRequest, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.org/shot.png" } }] }] })).toThrow("base64");
  });
  test("a web plugin is refused rather than answered from memory", () => {
    expect(() => anthropicRequestFrom({ ...toolRequest, plugins: [{ id: "web" }] })).toThrow("Web search");
  });
});

describe("Anthropic engine: the answer back", () => {
  test("a tool call, with tokens and an estimated cost", () => {
    const answer = compatResponseFrom(message({}), "claude-sonnet-5-5");
    expect(answer.choices[0]!.message.tool_calls).toEqual([{ type: "function", function: { name: "classify", arguments: "{\"label\":\"not_interested\"}" } }]);
    expect(answer.usage).toEqual({ prompt_tokens: 1000, completion_tokens: 200, cost: 0.004 });
  });
  test("max_tokens is a length finish; a refusal carries no answer", () => {
    expect(compatResponseFrom(message({ stop_reason: "max_tokens", content: [] }), "claude-sonnet-5-5").choices[0]!.finish_reason).toBe("length");
    const refused = compatResponseFrom(message({ stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null } as never }), "claude-sonnet-5-5");
    expect(refused.choices[0]!.message.refusal).toContain("cyber");
    expect(refused.choices[0]!.message.tool_calls).toBeUndefined();
  });
  test("prices per million tokens: Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50", () => {
    expect(anthropicCostUsd("claude-opus-5-5", { input_tokens: 1_000_000, output_tokens: 1_000_000 })).toBe(24);
    expect(anthropicCostUsd("claude-sonnet-5-5", { input_tokens: 1_000_000, output_tokens: 0 })).toBe(2);
    expect(anthropicCostUsd("claude-haiku-5-5", { input_tokens: 100_000, output_tokens: 100_000 })).toBe(0.06);
    // Above 100K input tokens Haiku 5.5 is $0.50 / $2.50.
    expect(anthropicCostUsd("claude-haiku-5-5", { input_tokens: 200_000, output_tokens: 0 })).toBe(0.1);
    expect(anthropicCostUsd("unknown", { input_tokens: 1, output_tokens: 1 })).toBeNull();
  });
});

test("completeStructured runs on the Anthropic engine and retries an answer in prose", async () => {
  const seen: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
  const replies = [
    message({ stop_reason: "end_turn", content: [{ type: "text", text: "It is not interested.", citations: null } as never] }),
    message({}),
  ];
  const client = createAnthropicCompatClient("sk-ant-test", 5_000, { create: async (body) => { seen.push(body); return replies.shift()!; } });
  const result = await completeStructured(
    { timeoutMs: 5_000, systemPrompt: "Sort the reply.", userPrompt: "Thanks, not interested.", maxOutputTokens: 800, jsonSchema: toolRequest.tools[0]!.function.parameters, schemaName: "classify" },
    {
      runtime: async () => ({ providerKey: "anthropic", selection: { provider: "anthropic", modelId: "claude-sonnet-5-5" }, routing: {}, structuredOutput: "tool_call", supportsPlugins: false, client }),
      sleep: async () => undefined,
    },
  );
  expect(JSON.parse(result.text)).toEqual({ label: "not_interested" });
  expect(result.attempts).toBe(2);
  expect(seen.every((body) => (body.tool_choice as { type: string }).type === "auto")).toBe(true);
});

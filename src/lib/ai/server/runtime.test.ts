import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AimlModelSummary } from "../aimlapi-types";
import type { AiRuntimePlan } from "../runtimePlan";
import { runtimeFor } from "./runtime";
import { completeStructured } from "./structuredCompletion";

const connection = { id: "conn-1", providerKey: "aimlapi", name: "AI/ML API", enabled: true, verified: true };
const aimlPlan = (modelId: string): AiRuntimePlan => ({
  providerKey: "aimlapi",
  selection: { provider: "aimlapi", modelId },
  routing: {},
  structuredOutput: "json_schema",
  supportsPlugins: false,
});
const entry = (id: string, capabilities: string[]): AimlModelSummary => ({ id, name: id, capabilities, outputModalities: ["text"] });
// AI/ML catalog tags on 21 Oct 2026.
const catalog = [
  entry("deepseek/deepseek-chat", ["file_input", "parallel_tool_calls", "streaming", "structured_output", "tools"]),
  entry("openai/gpt-4o-mini", ["structured_output"]),
  entry("anthropic/claude-haiku-5.5", ["reasoning", "streaming", "tools", "vision", "web_search"]),
];
const listModels = async () => catalog;

describe("runtimeFor: how AI/ML API models are asked for structured answers", () => {
  test("DeepSeek Chat is asked for json_schema and may fall back to one function call", async () => {
    const runtime = await runtimeFor(aimlPlan("deepseek/deepseek-chat"), connection, "key", 1_000, { listModels });
    assert.equal(runtime.structuredOutput, "json_schema");
    assert.equal(runtime.functionCallFallback, true);
    assert.equal(typeof runtime.client.chat.completions.create, "function");

    // The fields getAiRuntime hands completeStructured are the ones that turn the fallback on.
    const formats: string[] = [];
    const answer = await completeStructured({
      timeoutMs: 1_000, systemPrompt: "Classify.", userPrompt: "Hello", maxOutputTokens: 100, schemaName: "submit",
      jsonSchema: { type: "object", additionalProperties: false, required: ["category"], properties: { category: { type: "string" } } },
    }, {
      sleep: async () => {},
      runtime: async () => ({ ...runtime, client: { chat: { completions: { create: async (payload: never) => {
        const request = payload as Record<string, unknown>;
        formats.push(request.response_format ? "json_schema" : "tool_call");
        if (request.response_format) throw Object.assign(new Error("400 Validation failed"), { status: 400 });
        return { choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ type: "function", function: { name: "submit", arguments: '{"category":"a"}' } }] } }] };
      } } } } }),
    });
    assert.deepEqual(formats, ["json_schema", "tool_call"]);
    assert.equal(answer.text, '{"category":"a"}');
  });

  test("a json_schema model without tools has no fallback; a tools-only model is asked for a function call", async () => {
    const schemaOnly = await runtimeFor(aimlPlan("openai/gpt-4o-mini"), connection, "key", 1_000, { listModels });
    assert.equal(schemaOnly.structuredOutput, "json_schema");
    assert.equal(schemaOnly.functionCallFallback, false);

    const toolsOnly = await runtimeFor(aimlPlan("anthropic/claude-haiku-5.5"), connection, "key", 1_000, { listModels });
    assert.equal(toolsOnly.structuredOutput, "tool_call");
    assert.equal(toolsOnly.functionCallFallback, false);
  });

  test("a catalog that does not list the model, fails or is too slow keeps json_schema, and a refusal may still be asked once as a function call", async () => {
    const cases: Array<{ listModels: () => Promise<AimlModelSummary[]>; waitMs?: number }> = [
      { listModels: async () => [entry("other/model", ["structured_output", "tools"])] },
      { listModels: async () => { throw new Error("Could not load the AI/ML API model list (503)"); } },
      { listModels: () => new Promise<AimlModelSummary[]>(() => {}), waitMs: 10 },
    ];
    for (const options of cases) {
      const runtime = await runtimeFor(aimlPlan("deepseek/deepseek-chat"), connection, "key", 1_000, options);
      assert.equal(runtime.structuredOutput, "json_schema");
      assert.equal(runtime.functionCallFallback, true);
    }
  });

  test("OpenRouter never reads the AI/ML catalog and gets no fallback", async () => {
    let read = false;
    const plan: AiRuntimePlan = {
      providerKey: "openrouter",
      selection: { provider: "deepseek", modelId: "deepseek/deepseek-chat" },
      routing: { provider: { only: ["deepseek"] } },
      structuredOutput: "tool_call",
      supportsPlugins: true,
    };
    const runtime = await runtimeFor(plan, { ...connection, providerKey: "openrouter" }, "key", 1_000, { listModels: async () => { read = true; return catalog; } });
    assert.equal(read, false);
    assert.equal(runtime.structuredOutput, "tool_call");
    assert.equal("functionCallFallback" in runtime, false);
  });
});

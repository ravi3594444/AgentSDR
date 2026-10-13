import { describe, expect, test } from "bun:test";
import { selectableAimlModels } from "./aimlapi-types";
import type { ByokSettings } from "./openrouter-types";
import { planAiRuntime } from "./runtimePlan";

const aimlSettings: ByokSettings = {
  connectionId: "conn-aiml",
  providers: ["aimlapi"],
  modelsByProvider: { aimlapi: ["openai/gpt-4o-mini", "google/gemini-3.5-flash-lite"] },
  defaultModel: { provider: "aimlapi", modelId: "openai/gpt-4o-mini" },
  transcriptionModel: null,
  byokOnlyConfirmed: false,
};

const openRouterSettings: ByokSettings = {
  connectionId: "conn-or",
  providers: ["anthropic"],
  modelsByProvider: { anthropic: ["anthropic/claude-sonnet"] },
  defaultModel: { provider: "anthropic", modelId: "anthropic/claude-sonnet" },
  transcriptionModel: null,
  byokOnlyConfirmed: true,
};

describe("planAiRuntime with AI/ML API", () => {
  test("needs no routing confirmation and answers with strict JSON schema", () => {
    const planned = planAiRuntime(aimlSettings, { providerKey: "aimlapi", verified: true });
    expect(planned).toEqual({
      ok: true,
      plan: {
        providerKey: "aimlapi",
        selection: { provider: "aimlapi", modelId: "openai/gpt-4o-mini" },
        routing: {},
        structuredOutput: "json_schema",
        supportsPlugins: false,
      },
    });
  });

  test("accepts another enabled model and refuses one that is not enabled", () => {
    expect(planAiRuntime(aimlSettings, { providerKey: "aimlapi", verified: true }, { provider: "aimlapi", modelId: "google/gemini-3.5-flash-lite" }).ok).toBe(true);
    expect(planAiRuntime(aimlSettings, { providerKey: "aimlapi", verified: true }, { provider: "aimlapi", modelId: "openai/gpt-5.6-sol" }))
      .toEqual({ ok: false, error: "Model openai/gpt-5.6-sol is not enabled in AI Settings" });
  });

  test("refuses an OpenRouter selection (an old Tables column) while AI/ML API is selected", () => {
    const planned = planAiRuntime(aimlSettings, { providerKey: "aimlapi", verified: true }, { provider: "anthropic", modelId: "anthropic/claude-sonnet" });
    expect(planned.ok).toBe(false);
  });

  test("an unverified connection or a missing default model stops every call", () => {
    expect(planAiRuntime(aimlSettings, { providerKey: "aimlapi", verified: false }).ok).toBe(false);
    expect(planAiRuntime({ ...aimlSettings, defaultModel: null }, { providerKey: "aimlapi", verified: true }))
      .toEqual({ ok: false, error: "Choose a default model in AI Settings" });
    expect(planAiRuntime({ ...aimlSettings, connectionId: null }, null))
      .toEqual({ ok: false, error: "Connect an AI provider in Settings → AI provider" });
  });
});

describe("planAiRuntime with OpenRouter (unchanged rules)", () => {
  test("pins the provider strictly and asks for a function call", () => {
    const planned = planAiRuntime(openRouterSettings, { providerKey: "openrouter", verified: true });
    expect(planned.ok && planned.plan).toEqual({
      providerKey: "openrouter",
      selection: { provider: "anthropic", modelId: "anthropic/claude-sonnet" },
      routing: { provider: { only: ["anthropic"], order: ["anthropic"], allow_fallbacks: false, require_parameters: true } },
      structuredOutput: "tool_call",
      supportsPlugins: true,
    });
  });

  test("still requires the BYOK-only routing confirmation", () => {
    expect(planAiRuntime({ ...openRouterSettings, byokOnlyConfirmed: false }, { providerKey: "openrouter", verified: true }))
      .toEqual({ ok: false, error: "OpenRouter BYOK-only routing is not confirmed in AI Settings" });
  });

  test("an unknown provider key is unavailable", () => {
    expect(planAiRuntime(openRouterSettings, { providerKey: "someone-else", verified: true }).ok).toBe(false);
  });
});

describe("selectableAimlModels", () => {
  test("keeps chat models with structured output only, named and sorted", () => {
    const models = selectableAimlModels({
      data: [
        { id: "z/chat-structured", type: "openai/chat-completions", info: { name: "Zeta", contextLength: 128000 }, capabilities: ["tools", "structured_output"] },
        { id: "a/chat-structured", type: "openai/chat-completions", info: { name: "Alpha", developer: "A Co" }, capabilities: ["structured_output"] },
        { id: "chat-tools-only", type: "openai/chat-completions", info: { name: "Tools only" }, capabilities: ["tools"] },
        { id: "image-model", type: "openai/image-generations", info: { name: "Image" }, capabilities: ["structured_output"] },
        { id: "no-caps", type: "openai/chat-completions", info: { name: "No caps" } },
        { id: 42, type: "openai/chat-completions", capabilities: ["structured_output"] },
      ],
    });
    expect(models.map((model) => model.id)).toEqual(["a/chat-structured", "z/chat-structured"]);
    expect(models[1]).toEqual({
      id: "z/chat-structured",
      name: "Zeta",
      developer: undefined,
      description: undefined,
      context_length: 128000,
      capabilities: ["tools", "structured_output"],
      outputModalities: ["text"],
    });
  });

  test("an unexpected body is an empty list, not a crash", () => {
    expect(selectableAimlModels(null)).toEqual([]);
    expect(selectableAimlModels({ data: "nope" })).toEqual([]);
  });
});

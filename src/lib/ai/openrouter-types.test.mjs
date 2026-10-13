import { describe, expect, test } from "bun:test";
import {
  isRetryableOpenRouterError,
  toolCallSystemPrompt,
  normalizeByokSettings,
  openRouterTokenLimit,
  resolveByokAllowedModelIds,
  selectionKey,
  strictImageProviderRouting,
  strictProviderRouting,
} from "./openrouter-types.ts";

describe("OpenRouter BYOK settings", () => {
  test("normalizes and deduplicates provider-specific model selections", () => {
    expect(normalizeByokSettings({
      connectionId: " connection-1 ",
      providers: ["openai", "openai", "anthropic"],
      modelsByProvider: {
        openai: ["openai/gpt-5", "openai/gpt-5", ""],
        anthropic: ["anthropic/claude-sonnet-4"],
      },
      defaultModel: { provider: "openai", modelId: "openai/gpt-5" },
      transcriptionModel: { provider: "anthropic", modelId: "anthropic/claude-sonnet-4" },
      byokOnlyConfirmed: true,
    })).toEqual({
      connectionId: "connection-1",
      providers: ["openai", "anthropic"],
      modelsByProvider: {
        openai: ["openai/gpt-5"],
        anthropic: ["anthropic/claude-sonnet-4"],
      },
      defaultModel: { provider: "openai", modelId: "openai/gpt-5" },
      transcriptionModel: { provider: "anthropic", modelId: "anthropic/claude-sonnet-4" },
      researchModel: null,
      researchDailyLimit: 25,
      byokOnlyConfirmed: true,
    });
  });

  test("keeps a research model only from the allowlist, and bounds the daily limit", () => {
    const base = { providers: ["aimlapi"], modelsByProvider: { aimlapi: ["perplexity/sonar"] } };
    expect(normalizeByokSettings({ ...base, researchModel: { provider: "aimlapi", modelId: "perplexity/sonar" } }).researchModel)
      .toEqual({ provider: "aimlapi", modelId: "perplexity/sonar" });
    expect(normalizeByokSettings({ ...base, researchModel: { provider: "aimlapi", modelId: "perplexity/sonar-pro" } }).researchModel).toBeNull();
    expect(normalizeByokSettings({ ...base, researchDailyLimit: 0 }).researchDailyLimit).toBe(1);
    expect(normalizeByokSettings({ ...base, researchDailyLimit: 10_000 }).researchDailyLimit).toBe(500);
    expect(normalizeByokSettings({ ...base, researchDailyLimit: "50" }).researchDailyLimit).toBe(25);
  });

  test("drops a transcription model outside the allowlist, and defaults it to null", () => {
    const base = { providers: ["openai"], modelsByProvider: { openai: ["openai/gpt-5"] } };
    expect(normalizeByokSettings({ ...base, transcriptionModel: { provider: "google", modelId: "google/gemini" } }).transcriptionModel).toBeNull();
    expect(normalizeByokSettings(base).transcriptionModel).toBeNull();
  });

  test("drops a default that is not in the selected provider/model allowlist", () => {
    expect(normalizeByokSettings({
      providers: ["openai"],
      modelsByProvider: { openai: ["openai/gpt-5"] },
      defaultModel: { provider: "anthropic", modelId: "anthropic/claude-sonnet-4" },
    }).defaultModel).toBeNull();
  });

  test("builds a single-provider route with fallbacks disabled", () => {
    expect(strictProviderRouting("anthropic")).toEqual({
      only: ["anthropic"],
      order: ["anthropic"],
      allow_fallbacks: false,
      require_parameters: true,
    });
    expect(selectionKey({ provider: "anthropic", modelId: "anthropic/claude-sonnet-4" }))
      .toBe("anthropic::anthropic/claude-sonnet-4");
    expect(strictImageProviderRouting("openai")).toEqual({
      only: ["openai"],
      order: ["openai"],
      allow_fallbacks: false,
    });
  });

  test("uses the supported completion limit parameter for OpenAI model IDs", () => {
    expect(openRouterTokenLimit("openai/gpt-5.6-terra", 16000)).toEqual({
      max_completion_tokens: 16000,
    });
    expect(openRouterTokenLimit("anthropic/claude-sonnet-4.6", 16000)).toEqual({
      max_tokens: 16000,
    });
  });

  test("resolves an Azure deployment allowlist against the global model catalog", () => {
    expect(resolveByokAllowedModelIds({
      provider: "azure",
      allowedModelIds: ["openai/gpt-5.2"],
      providerModels: [],
      globalModels: [{ id: "openai/gpt-5.2" }, { id: "openai/gpt-4o" }],
    })).toEqual({
      modelIds: ["openai/gpt-5.2"],
      unmatchedModelIds: [],
    });
  });

  test("keeps Azure allowlisted models returned by the provider catalog", () => {
    expect(resolveByokAllowedModelIds({
      provider: "azure",
      allowedModelIds: ["openai/gpt-4o"],
      providerModels: [{ id: "openai/gpt-4o" }],
      globalModels: [],
    })).toEqual({
      modelIds: ["openai/gpt-4o"],
      unmatchedModelIds: [],
    });
  });

  test("does not broaden non-Azure provider allowlists with global models", () => {
    expect(resolveByokAllowedModelIds({
      provider: "openai",
      allowedModelIds: ["openai/gpt-5.2", "azure-deployment-name"],
      providerModels: [{ id: "openai/gpt-4o" }],
      globalModels: [{ id: "openai/gpt-5.2" }],
    })).toEqual({
      modelIds: [],
      unmatchedModelIds: ["openai/gpt-5.2", "azure-deployment-name"],
    });
  });

  test("matches a versioned Azure allowlist entry to its routable model ID", () => {
    expect(resolveByokAllowedModelIds({
      provider: "azure",
      allowedModelIds: ["openai/gpt-5.6-luna-pro-20260709"],
      providerModels: [{
        id: "openai/gpt-5.6-luna-pro",
        canonicalSlug: "openai/gpt-5.6-luna-pro-20260709",
      }],
      globalModels: [],
    })).toEqual({
      modelIds: ["openai/gpt-5.6-luna-pro"],
      unmatchedModelIds: [],
    });
  });
});

describe("OpenRouter structured-completion retry", () => {
  const withStatus = (status, message = "failed") => Object.assign(new Error(message), { status });

  test("retries rate limiting and provider or gateway faults", () => {
    for (const status of [408, 409, 425, 429, 500, 502, 503, 529]) {
      expect(isRetryableOpenRouterError(withStatus(status))).toBe(true);
    }
  });

  test("does not retry routing or configuration failures", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isRetryableOpenRouterError(withStatus(status))).toBe(false);
    }
  });

  test("reads statusCode when status is absent", () => {
    expect(isRetryableOpenRouterError(Object.assign(new Error("x"), { statusCode: 503 }))).toBe(true);
  });

  test("retries dropped connections and timeouts without a status", () => {
    expect(isRetryableOpenRouterError(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(true);
    const timeout = new Error("timed out");
    timeout.name = "APIConnectionTimeoutError";
    expect(isRetryableOpenRouterError(timeout)).toBe(true);
  });

  test("does not retry plain errors or non-Error values", () => {
    expect(isRetryableOpenRouterError(new Error("malformed"))).toBe(false);
    expect(isRetryableOpenRouterError("503")).toBe(false);
    expect(isRetryableOpenRouterError(null)).toBe(false);
    expect(isRetryableOpenRouterError({ status: 503 })).toBe(false);
  });

  test("tells the model the tool call is the only accepted answer", () => {
    const prompt = toolCallSystemPrompt("You classify replies.", "crm_reply_classification");
    expect(prompt.startsWith("You classify replies.")).toBe(true);
    expect(prompt).toContain("calling the crm_reply_classification function");
    expect(prompt).toContain("Never answer in prose");
  });
});

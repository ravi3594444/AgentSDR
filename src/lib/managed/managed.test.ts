import { describe, expect, test } from "bun:test";
import { ALLOWANCES, allowanceDecision, formatAllowanceAmount, periodReset, periodStart } from "./allowances";
import { EMPTY_MANAGED_AI_SETTINGS, managedAiProblem, normalizeManagedAiSettings, secretHint, type PlatformCredentialKey } from "./catalog";
import { credentialFingerprint, mergePlatformCredentialInput, PlatformCredentialError } from "./store.server";

describe("allowances", () => {
  const now = new Date("2026-10-22T15:00:00Z");
  test("a month runs from the 1st, 00:00 UTC, to the next 1st", () => {
    expect(periodStart(now).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(periodReset(now).toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(periodReset(new Date("2026-12-31T23:59:59Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
  test("both the workspace allowance and the platform budget hold", () => {
    const allowance = { label: "Web searches", unit: "requests" as const, period: "month" as const, workspace: 10, platform: 100 };
    expect(allowanceDecision(allowance, { workspace: 9, platform: 50 }, 1, now)).toEqual({ ok: true });
    const workspace = allowanceDecision(allowance, { workspace: 10, platform: 50 }, 1, now);
    expect(workspace.ok).toBe(false);
    if (!workspace.ok) {
      expect(workspace.scope).toBe("workspace");
      expect(workspace.reason).toContain("10 requests of 10 requests");
      expect(workspace.resetsAt?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    }
    const platform = allowanceDecision(allowance, { workspace: 0, platform: 100 }, 1, now);
    expect(!platform.ok && platform.scope).toBe("platform");
    // The platform's own figures never appear in a refusal a customer reads.
    expect(!platform.ok && platform.reason).not.toContain("100");
  });
  test("a standing count (connected accounts) has no reset date", () => {
    const decision = allowanceDecision(ALLOWANCES.unipile_linkedin, { workspace: 2, platform: 2 }, 1, now);
    expect(!decision.ok && decision.resetsAt).toBeNull();
  });
  test("amounts read in their unit", () => {
    expect(formatAllowanceAmount(1.234, "usd")).toBe("$1.23");
    expect(formatAllowanceAmount(1, "accounts")).toBe("1 account");
    expect(formatAllowanceAmount(1500, "urls")).toBe("1,500 pages");
  });
});

describe("Included AI settings", () => {
  const stored = new Set<PlatformCredentialKey>(["anthropic", "openrouter"]);
  test("malformed values are dropped", () => {
    expect(normalizeManagedAiSettings({ engine: "claude-code", defaultModel: { provider: 1 } })).toEqual(EMPTY_MANAGED_AI_SETTINGS);
  });
  test("an engine needs its key stored and a model of its own", () => {
    expect(managedAiProblem({ ...EMPTY_MANAGED_AI_SETTINGS, engine: "aimlapi", defaultModel: { provider: "aimlapi", modelId: "x" } }, stored)).toContain("Store the AI/ML API key");
    expect(managedAiProblem({ ...EMPTY_MANAGED_AI_SETTINGS, engine: "anthropic", defaultModel: { provider: "anthropic", modelId: "claude-sonnet-5-5" } }, stored)).toBeNull();
    expect(managedAiProblem({ ...EMPTY_MANAGED_AI_SETTINGS, engine: "anthropic", defaultModel: { provider: "anthropic", modelId: "claude-3-opus" } }, stored)).toContain("listed Claude models");
    expect(managedAiProblem({ ...EMPTY_MANAGED_AI_SETTINGS, engine: "openrouter", defaultModel: { provider: "deepinfra", modelId: "z-ai/glm" } }, stored)).toContain("BYOK-only");
  });
  test("the Claude Code subscription login is never an Included engine", () => {
    expect(normalizeManagedAiSettings({ engine: "claude_code" }).engine).toBeNull();
  });
});

describe("platform credential input", () => {
  test("a blank secret keeps the stored one; a non-secret blank clears", () => {
    const merged = mergePlatformCredentialInput("brightdata", { apiKey: "", serpZone: "" }, { apiKey: "stored-secret-123456", serpZone: "zone1" });
    expect(merged).toEqual({ apiKey: "stored-secret-123456", serpZone: "" });
  });
  test("unknown fields and missing required ones are refused", () => {
    expect(() => mergePlatformCredentialInput("tavily", { apiKey: "k", other: "x" }, null)).toThrow(PlatformCredentialError);
    expect(() => mergePlatformCredentialInput("tavily", {}, null)).toThrow("API key is required");
  });
  test("Unipile gets a generated webhook secret", () => {
    const merged = mergePlatformCredentialInput("unipile", { baseUrl: "api1.unipile.com:1", apiKey: "abc" }, null);
    expect(merged.notifySecret.length).toBeGreaterThan(30);
  });
  test("a hint shows at most four characters and a fingerprint never the key", () => {
    expect(secretHint("sk-ant-abcdef1234")).toBe("…1234");
    expect(secretHint("short")).toBe("…");
    const fingerprint = credentialFingerprint("anthropic", { apiKey: "sk-ant-abcdef1234" });
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint).not.toContain("abcdef");
    expect(credentialFingerprint("tavily", { apiKey: "same" })).not.toBe(credentialFingerprint("tinyfish", { apiKey: "same" }));
  });
});

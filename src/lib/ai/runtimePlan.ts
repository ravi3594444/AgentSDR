import { AIML_PROVIDER_KEY, AIML_PROVIDER_NAME } from "./aimlapi-types";
import { strictProviderRouting, type ByokSettings, type OpenRouterModelSelection } from "./openrouter-types";

/**
 * The gate every model call passes, as a pure function of the organization's
 * AI settings and its selected connection. server/runtime.ts applies it before
 * decrypting a key; Getting Started and the settings checks reason the same way.
 *
 * Settings still live in the row created for OpenRouter BYOK
 * (`openrouter-byok-settings`); the selected connection's provider decides
 * which rules apply:
 *
 * - OpenRouter: the operator must confirm BYOK-only routing, and every text
 *   call is pinned to one upstream provider with fallbacks off. Structured
 *   answers come back as a function call (see structuredCompletion.ts).
 * - AI/ML API: one key, no BYOK providers, no routing confirmation. Models are
 *   chosen from its catalog and structured answers use strict JSON schema
 *   (`response_format`), which every selectable model advertises.
 */

export type AiProviderKey = "openrouter" | typeof AIML_PROVIDER_KEY;

export const RUNTIME_PROVIDERS: Record<AiProviderKey, string> = {
  openrouter: "OpenRouter",
  [AIML_PROVIDER_KEY]: AIML_PROVIDER_NAME,
};

export function isRuntimeProvider(value: string): value is AiProviderKey {
  return Object.prototype.hasOwnProperty.call(RUNTIME_PROVIDERS, value);
}

export type AiRuntimePlan = {
  providerKey: AiProviderKey;
  selection: OpenRouterModelSelection;
  /** Fields every text request carries: OpenRouter's strict provider routing; nothing for AI/ML API. */
  routing: Record<string, unknown>;
  /** How a structured answer is requested. */
  structuredOutput: "tool_call" | "json_schema";
  /**
   * AI/ML API only: the model is asked for json_schema and its catalog tags
   * list `tools`, so a json_schema request it refuses with HTTP 400 is sent
   * once more as a function call (aimlFunctionCallFallback). Set by
   * server/runtime.ts from the catalog; absent when the catalog was not read.
   */
  functionCallFallback?: boolean;
  /** OpenRouter's server-side plugins (web search) are available. */
  supportsPlugins: boolean;
};

export type AiConnectionFacts = { providerKey: string; verified: boolean } | null;

export function planAiRuntime(
  settings: ByokSettings,
  connection: AiConnectionFacts,
  requested?: OpenRouterModelSelection,
): { ok: true; plan: AiRuntimePlan } | { ok: false; error: string } {
  if (!settings.connectionId) return { ok: false, error: "Connect an AI provider in Settings → AI provider" };
  if (!connection?.verified || !isRuntimeProvider(connection.providerKey)) {
    return { ok: false, error: "The AI connection in AI Settings is unavailable" };
  }
  const providerKey = connection.providerKey;
  if (providerKey === "openrouter" && !settings.byokOnlyConfirmed) {
    return { ok: false, error: "OpenRouter BYOK-only routing is not confirmed in AI Settings" };
  }

  const selection = requested ?? settings.defaultModel;
  if (!selection) return { ok: false, error: "Choose a default model in AI Settings" };
  if (providerKey === AIML_PROVIDER_KEY && selection.provider !== AIML_PROVIDER_KEY) {
    return { ok: false, error: `This model is not an ${AIML_PROVIDER_NAME} model; choose one in AI Settings` };
  }
  if (!settings.providers.includes(selection.provider)) {
    return {
      ok: false,
      error: providerKey === "openrouter"
        ? `OpenRouter provider ${selection.provider} is not enabled in AI Settings`
        : `No ${AIML_PROVIDER_NAME} models are enabled in AI Settings`,
    };
  }
  if (!settings.modelsByProvider[selection.provider]?.includes(selection.modelId)) {
    return {
      ok: false,
      error: providerKey === "openrouter"
        ? `Model ${selection.modelId} is not enabled for ${selection.provider} in AI Settings`
        : `Model ${selection.modelId} is not enabled in AI Settings`,
    };
  }

  return {
    ok: true,
    plan: providerKey === "openrouter"
      ? { providerKey, selection, routing: { provider: strictProviderRouting(selection.provider) }, structuredOutput: "tool_call", supportsPlugins: true }
      : { providerKey, selection, routing: {}, structuredOutput: "json_schema", supportsPlugins: false },
  };
}

export type OpenRouterModelSummary = {
  id: string;
  canonicalSlug?: string;
  name: string;
  description?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  supportedParameters?: string[];
  outputModalities?: string[];
};

export type OpenRouterProviderModels = {
  slug: string;
  name: string;
  credentialCount: number;
  prioritizedCredentialCount: number;
  fallbackCredentialCount: number;
  discoveredModelCount: number;
  modelFilterRestricted: boolean;
  allowedModelCount: number;
  unmatchedAllowedModels: string[];
  models: OpenRouterModelSummary[];
};

export type OpenRouterModelSelection = {
  provider: string;
  modelId: string;
};

export type ByokSettings = {
  connectionId: string | null;
  providers: string[];
  modelsByProvider: Record<string, string[]>;
  defaultModel: OpenRouterModelSelection | null;
  /** Model used to transcribe call recordings; must accept audio input. Null = transcription off. */
  transcriptionModel: OpenRouterModelSelection | null;
  /**
   * Model used for web research about imported companies (src/lib/research/);
   * must search the web and return its sources. Null = research off. Kept
   * apart from defaultModel: a search model costs more per call and is no
   * better at drafting.
   */
  researchModel: OpenRouterModelSelection | null;
  /** Most research runs per organization per day (UTC), failed ones included. */
  researchDailyLimit: number;
  /**
   * OpenRouter only exposes this setting in its workspace UI. We require the
   * operator to confirm it before any inference call can run.
   */
  byokOnlyConfirmed: boolean;
};

function strings(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean))].slice(0, limit);
}

function normalizeSelection(value: unknown): OpenRouterModelSelection | null {
  if (!value || typeof value !== "object") return null;
  const selection = value as Partial<OpenRouterModelSelection>;
  if (typeof selection.provider !== "string" || typeof selection.modelId !== "string") return null;
  const provider = selection.provider.trim();
  const modelId = selection.modelId.trim();
  return provider && modelId ? { provider, modelId } : null;
}

export const RESEARCH_DAILY_LIMIT_DEFAULT = 25;
export const RESEARCH_DAILY_LIMIT_MAX = 500;

export function normalizeByokSettings(value: unknown): ByokSettings {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const providers = strings(raw.providers, 100);
  const source = raw.modelsByProvider && typeof raw.modelsByProvider === "object"
    ? raw.modelsByProvider as Record<string, unknown>
    : {};
  const modelsByProvider = Object.fromEntries(
    providers.map((provider) => [provider, strings(source[provider], 1000)]),
  );

  const legacyModels = strings(raw.models, 1000);
  if (legacyModels.length && !Object.values(modelsByProvider).some((models) => models.length)) {
    for (const provider of providers) modelsByProvider[provider] = legacyModels;
  }

  const defaultModel = normalizeSelection(raw.defaultModel);
  const transcriptionModel = normalizeSelection(raw.transcriptionModel);
  const researchModel = normalizeSelection(raw.researchModel);
  const researchDailyLimit = typeof raw.researchDailyLimit === "number" && Number.isFinite(raw.researchDailyLimit)
    ? Math.min(RESEARCH_DAILY_LIMIT_MAX, Math.max(1, Math.floor(raw.researchDailyLimit)))
    : RESEARCH_DAILY_LIMIT_DEFAULT;
  return {
    connectionId: typeof raw.connectionId === "string" && raw.connectionId.trim() ? raw.connectionId.trim() : null,
    providers,
    modelsByProvider,
    defaultModel: defaultModel && modelsByProvider[defaultModel.provider]?.includes(defaultModel.modelId)
      ? defaultModel
      : null,
    transcriptionModel: transcriptionModel && modelsByProvider[transcriptionModel.provider]?.includes(transcriptionModel.modelId)
      ? transcriptionModel
      : null,
    researchModel: researchModel && modelsByProvider[researchModel.provider]?.includes(researchModel.modelId)
      ? researchModel
      : null,
    researchDailyLimit,
    byokOnlyConfirmed: raw.byokOnlyConfirmed === true,
  };
}

export function strictProviderRouting(provider: string) {
  return {
    only: [provider],
    order: [provider],
    allow_fallbacks: false as const,
    require_parameters: true as const,
  };
}

/** The image endpoint supports provider pinning, but not require_parameters. */
export function strictImageProviderRouting(provider: string) {
  return {
    only: [provider],
    order: [provider],
    allow_fallbacks: false as const,
  };
}

/** OpenAI-family chat endpoints use the replacement for deprecated max_tokens. */
export function openRouterTokenLimit(modelId: string, limit: number) {
  return modelId.startsWith("openai/")
    ? { max_completion_tokens: limit }
    : { max_tokens: limit };
}

/**
 * Azure OpenAI deployments are private and therefore are not guaranteed to be
 * present in Azure's public OpenRouter provider catalog. For Azure only, a
 * canonical model slug explicitly attached to the BYOK credential is resolved
 * against the global OpenRouter catalog. Other providers remain constrained to
 * models advertised by their provider catalog.
 */
export function resolveByokAllowedModelIds(input: {
  provider: string;
  allowedModelIds: string[];
  providerModels: Array<{ id: string; canonicalSlug?: string }>;
  globalModels: Array<{ id: string; canonicalSlug?: string }>;
}): { modelIds: string[]; unmatchedModelIds: string[] } {
  const allowedModelIds = [...new Set(input.allowedModelIds.map((id) => id.trim()).filter(Boolean))];
  const models = input.provider === "azure"
    ? [...input.providerModels, ...input.globalModels]
    : input.providerModels;
  const allowed = new Set(allowedModelIds);
  const modelIds = [...new Set(models
    .filter((model) => allowed.has(model.id) || Boolean(model.canonicalSlug && allowed.has(model.canonicalSlug)))
    .map((model) => model.id))];
  const matchedAllowedIds = new Set(models.flatMap((model) => [model.id, model.canonicalSlug].filter(Boolean)));
  return {
    modelIds,
    unmatchedModelIds: allowedModelIds.filter((id) => !matchedAllowedIds.has(id)),
  };
}

export function selectionKey(selection: OpenRouterModelSelection): string {
  return `${selection.provider}::${selection.modelId}`;
}

/**
 * True for a failure worth a second attempt: rate limiting, a provider or
 * gateway fault, or a dropped connection. Routing and configuration
 * failures (400, 401, 403, 404) are deterministic and are not retried.
 */
export function isRetryableOpenRouterError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { status?: unknown; statusCode?: unknown; code?: unknown };
  const status = Number(candidate.status ?? candidate.statusCode);
  if (Number.isFinite(status) && status > 0) {
    return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  }
  if (error.name === "APIConnectionError" || error.name === "APIConnectionTimeoutError") return true;
  return typeof candidate.code === "string"
    && ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE", "EAI_AGAIN"].includes(candidate.code);
}

/** The tool schema carries the shape; the prompt only has to say that the call is the answer. */
export function toolCallSystemPrompt(systemPrompt: string, schemaName: string): string {
  return `${systemPrompt}\n\nYou must answer by calling the ${schemaName} function exactly once with every required argument. Never answer in prose.`;
}

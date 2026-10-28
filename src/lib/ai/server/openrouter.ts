import "server-only";

import { createHash } from "node:crypto";
import OpenAI from "openai";
import {
  resolveByokAllowedModelIds,
  type OpenRouterModelSummary,
  type OpenRouterProviderModels,
} from "../openrouter-types";
import { BRAND } from "@/lib/brand";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** One OpenAI-compatible client for every server-side model call. */
export function createOpenRouterClient(apiKey: string, timeout = 30_000) {
  if (!apiKey.trim()) throw new Error("OpenRouter inference API key is not configured");
  return new OpenAI({
    apiKey: apiKey.trim(),
    baseURL: OPENROUTER_BASE_URL,
    timeout,
    maxRetries: 0,
    defaultHeaders: {
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://localhost:3000",
      "X-Title": BRAND.name,
    },
  });
}

export type OpenRouterModel = { id: string; canonical_slug?: string; name: string; description?: string; context_length?: number; architecture?: { input_modalities?: string[]; output_modalities?: string[] }; pricing?: { prompt?: string; completion?: string }; supported_parameters?: string[] };
export type OpenRouterByokCredential = {
  id: string;
  provider: string;
  name: string | null;
  label: string;
  disabled: boolean;
  is_fallback: boolean;
  allowed_models: string[] | null;
  allowed_api_key_hashes: string[] | null;
};
type OpenRouterProvider = { slug: string; name: string };

async function openRouterJson<T>(path: string, apiKey?: string): Promise<T> {
  const response = await fetch(`${OPENROUTER_BASE_URL}${path}`, {
    headers: apiKey?.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => null) as ({ error?: { message?: string } } & T) | null;
  if (!response.ok) {
    throw new Error(body?.error?.message ?? `OpenRouter request failed (${response.status})`);
  }
  if (!body) throw new Error("OpenRouter returned an empty response");
  return body;
}

let inputsCache: { value: Promise<Map<string, string[]>>; expires: number } | null = null;

/** What a model takes as input ("text", "image", …) by its id, from OpenRouter's public catalog (cached 10 minutes); null when it is not listed. */
export async function openRouterModelInputs(modelId: string): Promise<string[] | null> {
  if (!inputsCache || inputsCache.expires < Date.now()) {
    const value = openRouterJson<{ data?: OpenRouterModel[] }>("/models?limit=1000&output_modalities=all")
      .then((body) => new Map((body.data ?? []).flatMap((model) => [[model.id, model.architecture?.input_modalities ?? ["text"]], ...(model.canonical_slug ? [[model.canonical_slug, model.architecture?.input_modalities ?? ["text"]] as [string, string[]]] : [])])));
    inputsCache = { value, expires: Date.now() + 10 * 60_000 };
    value.catch(() => {
      if (inputsCache?.value === value) inputsCache = null;
    });
  }
  return (await inputsCache.value).get(modelId) ?? null;
}

export async function verifyOpenRouterInferenceKey(apiKey: string): Promise<void> {
  const body = await openRouterJson<{ data?: { is_management_key?: boolean } }>("/key", apiKey);
  if (body.data?.is_management_key) {
    throw new Error("Use an OpenRouter inference key here; management keys cannot run models");
  }
}

export async function listOpenRouterByokCredentials(managementKey: string): Promise<OpenRouterByokCredential[]> {
  const credentials: OpenRouterByokCredential[] = [];
  for (let offset = 0; ; offset += 100) {
    const body = await openRouterJson<{ data?: OpenRouterByokCredential[]; total_count?: number }>(`/byok?limit=100&offset=${offset}`, managementKey);
    const page = body.data ?? [];
    credentials.push(...page);
    if (!page.length || credentials.length >= (body.total_count ?? credentials.length)) break;
  }
  return credentials;
}

export async function listOpenRouterByokCatalog(
  managementKey: string,
): Promise<OpenRouterProviderModels[]> {
  const [credentials, providerBody] = await Promise.all([
    listOpenRouterByokCredentials(managementKey),
    openRouterJson<{ data?: OpenRouterProvider[] }>("/providers"),
  ]);
  const providerNames = new Map((providerBody.data ?? []).map((provider) => [provider.slug, provider.name]));
  const active = credentials.filter((credential) => !credential.disabled);
  const groups = new Map<string, OpenRouterByokCredential[]>();
  for (const credential of active) {
    groups.set(credential.provider, [...(groups.get(credential.provider) ?? []), credential]);
  }

  const hasRestrictedAzureCredential = (groups.get("azure") ?? [])
    .some((credential) => !credential.is_fallback && credential.allowed_models !== null);
  const globalModelsPromise = hasRestrictedAzureCredential
    ? openRouterJson<{ data?: OpenRouterModel[] }>("/models?limit=1000&output_modalities=all")
    : Promise.resolve<{ data?: OpenRouterModel[] }>({ data: [] });

  return Promise.all([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(async ([slug, entries]) => {
    // Fallback-section credentials run after OpenRouter's shared endpoints.
    // They are shown for visibility, but never exposed as selectable strict routes.
    const prioritized = entries.filter((entry) => !entry.is_fallback);
    if (!prioritized.length) {
      return {
        slug,
        name: providerNames.get(slug) ?? slug,
        credentialCount: entries.length,
        prioritizedCredentialCount: 0,
        fallbackCredentialCount: entries.length,
        discoveredModelCount: 0,
        modelFilterRestricted: false,
        allowedModelCount: 0,
        unmatchedAllowedModels: [],
        models: [],
      };
    }

    // The Models API is public. Avoid sending the inference key here because
    // API-key/account restrictions can hide models that are valid for this
    // BYOK provider. The BYOK credential filters are applied explicitly below.
    const providerName = providerNames.get(slug) ?? slug;
    const params = new URLSearchParams({
      providers: providerName,
      limit: "1000",
      output_modalities: "all",
    });
    const body = await openRouterJson<{ data?: OpenRouterModel[] }>(`/models?${params}`);
    const unrestricted = prioritized.some((entry) => entry.allowed_models === null);
    const allowed = new Set(prioritized.flatMap((entry) => entry.allowed_models ?? []));
    const isSelectableModel = (model: OpenRouterModel) => {
      const outputModalities = model.architecture?.output_modalities ?? ["text"];
      return !model.id.endsWith(":free")
        && (outputModalities.includes("text") || outputModalities.includes("image"));
    };
    const discovered = (body.data ?? []).filter(isSelectableModel);
    const globalModels = slug === "azure" && !unrestricted
      ? ((await globalModelsPromise).data ?? []).filter(isSelectableModel)
      : [];
    const resolved = resolveByokAllowedModelIds({
      provider: slug,
      allowedModelIds: [...allowed],
      providerModels: discovered.map((model) => ({ id: model.id, canonicalSlug: model.canonical_slug })),
      globalModels: globalModels.map((model) => ({ id: model.id, canonicalSlug: model.canonical_slug })),
    });
    const restrictedModelIds = new Set(resolved.modelIds);
    const sourceModels = slug === "azure" && !unrestricted
      ? [...new Map([...globalModels, ...discovered].map((model) => [model.id, model])).values()]
      : discovered;
    const catalogModels: OpenRouterModelSummary[] = sourceModels
      .filter((model) => unrestricted || restrictedModelIds.has(model.id))
      .map((model) => ({
        id: model.id,
        canonicalSlug: model.canonical_slug,
        name: model.name,
        description: model.description,
        context_length: model.context_length,
        pricing: model.pricing,
        supportedParameters: model.supported_parameters,
        outputModalities: model.architecture?.output_modalities ?? ["text"],
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      slug,
      name: providerName,
      credentialCount: entries.length,
      prioritizedCredentialCount: prioritized.length,
      fallbackCredentialCount: entries.length - prioritized.length,
      discoveredModelCount: discovered.length,
      modelFilterRestricted: !unrestricted,
      allowedModelCount: allowed.size,
      unmatchedAllowedModels: resolved.unmatchedModelIds,
      models: catalogModels,
    };
  }));
}

/**
 * The catalog costs several OpenRouter calls (credentials, providers, then a
 * model list per provider) — seconds per request — and changes only when
 * someone edits their BYOK keys on OpenRouter. Pickers read it through this
 * per-process cache; AI Settings and save-time checks call the live one.
 */
const CATALOG_TTL_MS = 5 * 60_000;
const catalogCache = new Map<string, { value: Promise<OpenRouterProviderModels[]>; expires: number }>();

export function listOpenRouterByokCatalogCached(managementKey: string): Promise<OpenRouterProviderModels[]> {
  const key = createHash("sha256").update(managementKey).digest("hex");
  const hit = catalogCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  // Cache the promise, so concurrent opens share one fetch; a failure is not kept.
  const value = listOpenRouterByokCatalog(managementKey);
  catalogCache.set(key, { value, expires: Date.now() + CATALOG_TTL_MS });
  value.catch(() => {
    if (catalogCache.get(key)?.value === value) catalogCache.delete(key);
  });
  return value;
}

export type OpenRouterImageResponse = {
  created: number;
  data: Array<{ b64_json: string; media_type?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number };
};

export async function generateOpenRouterImage(input: {
  apiKey: string;
  model: string;
  prompt: string;
  provider: { only: string[]; order: string[]; allow_fallbacks: false };
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<OpenRouterImageResponse> {
  const timeoutSignal = AbortSignal.timeout(input.timeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(`${OPENROUTER_BASE_URL}/images`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey.trim()}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://localhost:3000",
      "X-Title": BRAND.name,
    },
    body: JSON.stringify({
      model: input.model,
      prompt: input.prompt,
      n: 1,
      provider: input.provider,
    }),
    cache: "no-store",
    signal,
  });
  const body = await response.json().catch(() => null) as
    | (OpenRouterImageResponse & { error?: { message?: string } })
    | null;
  if (!response.ok) {
    throw new Error(body?.error?.message ?? `OpenRouter image request failed (${response.status})`);
  }
  if (!body) throw new Error("OpenRouter returned an empty image response");
  return body;
}

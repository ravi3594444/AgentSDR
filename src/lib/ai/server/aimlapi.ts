import "server-only";

import OpenAI from "openai";
import { AIML_BASE_URL, selectableAimlModels, type AimlModelSummary } from "../aimlapi-types";

/** The OpenAI-compatible client for AI/ML API calls. */
export function createAimlClient(apiKey: string, timeout = 30_000) {
  if (!apiKey.trim()) throw new Error("AI/ML API key is not configured");
  return new OpenAI({ apiKey: apiKey.trim(), baseURL: AIML_BASE_URL, timeout, maxRetries: 0 });
}

/**
 * Confirms a key works before it is stored. GET /v1/key describes the key
 * itself (name, disabled, limits, usage) and costs nothing; a wrong key is a
 * 401. The model list cannot do this: it is public and answers any key.
 */
export async function verifyAimlApiKey(apiKey: string): Promise<void> {
  const response = await fetch(`${AIML_BASE_URL}/key`, {
    headers: { Authorization: `Bearer ${apiKey.trim()}` },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => null) as { data?: { disabled?: unknown }; message?: unknown } | null;
  if (response.status === 401 || response.status === 403) {
    throw new Error("AI/ML API rejected this key. Copy it again from aimlapi.com → Keys.");
  }
  if (!response.ok) {
    throw new Error(typeof body?.message === "string" ? body.message : `AI/ML API key check failed (${response.status})`);
  }
  if (body?.data?.disabled === true) throw new Error("This AI/ML API key is disabled");
}

/** The structured-output chat models in AI/ML API's live catalog (public; no key needed). */
export async function listAimlModels(): Promise<AimlModelSummary[]> {
  const response = await fetch(`${AIML_BASE_URL}/models?include=capabilities`, {
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Could not load the AI/ML API model list (${response.status})`);
  return selectableAimlModels(await response.json());
}

/**
 * The catalog is about a megabyte and changes when AI/ML adds models, not per
 * request. Pickers read it through this per-process cache; AI Settings
 * (?all=1) and save-time checks call the live one.
 */
const CATALOG_TTL_MS = 10 * 60_000;
let cached: { value: Promise<AimlModelSummary[]>; expires: number } | null = null;

export function listAimlModelsCached(): Promise<AimlModelSummary[]> {
  if (cached && cached.expires > Date.now()) return cached.value;
  const value = listAimlModels();
  cached = { value, expires: Date.now() + CATALOG_TTL_MS };
  value.catch(() => {
    if (cached?.value === value) cached = null;
  });
  return value;
}

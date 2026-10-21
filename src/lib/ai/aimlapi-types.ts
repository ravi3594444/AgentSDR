/**
 * AI/ML API (aimlapi.com): one OpenAI-compatible endpoint for many vendors'
 * models, billed to a single AI/ML API balance. Unlike OpenRouter there is no
 * management key, no BYOK provider list and no routing switch to confirm: the
 * one inference key is the whole connection.
 *
 * Client-safe constants and the pure catalog filter; the network calls live in
 * server/aimlapi.ts.
 */

export const AIML_PROVIDER_KEY = "aimlapi";
export const AIML_PROVIDER_NAME = "AI/ML API";
export const AIML_BASE_URL = "https://api.aimlapi.com/v1";
export const AIML_KEYS_URL = "https://aimlapi.com/app/keys";
export const AIML_MODELS_DOCS_URL = "https://docs.aimlapi.com/api-references/service-endpoints/complete-model-list";

/** One entry of GET /v1/models?include=capabilities, as far as it is read here. */
type AimlCatalogEntry = {
  id?: unknown;
  type?: unknown;
  info?: { name?: unknown; developer?: unknown; description?: unknown; contextLength?: unknown } | null;
  capabilities?: unknown;
};

export type AimlModelSummary = {
  id: string;
  name: string;
  developer?: string;
  description?: string;
  context_length?: number;
  /** AI/ML's capability tags, e.g. structured_output, tools, vision, reasoning. */
  capabilities: string[];
  outputModalities: string[];
};

/**
 * How a model is asked for a structured answer: a strict JSON schema when
 * AI/ML marks it `structured_output`, else one function call (`tools`).
 * AI/ML's tags are incomplete: every Claude model lacks `structured_output`
 * although Claude Haiku 5.5 answered strict JSON correctly on 17 Oct 2026;
 * the function call worked for it too and is what OpenRouter uses for every
 * model, so it is the safe way for a model only tagged `tools`.
 */
export function aimlStructuredMode(capabilities: readonly string[]): "json_schema" | "tool_call" {
  return capabilities.includes("structured_output") ? "json_schema" : "tool_call";
}

/**
 * Whether a json_schema request the model refuses with HTTP 400 may be sent
 * once more as a function call (structuredCompletion.ts): only for a model
 * asked for json_schema that AI/ML also tags `tools`. `structured_output`
 * does not promise json_schema itself: DeepSeek Chat carries the tag while
 * its published request schema allows only text and json_object response
 * formats (AI/ML docs-json, 21 Oct 2026), so every request 400ed. Every
 * model that accepts json_schema keeps that format; nothing is switched up
 * front.
 */
export function aimlFunctionCallFallback(capabilities: readonly string[]): boolean {
  return aimlStructuredMode(capabilities) === "json_schema" && capabilities.includes("tools");
}

/**
 * The models every AI feature here can use: chat-completion models that
 * AI/ML marks `structured_output` or `tools`, because classification, drafts
 * and table columns all need an answer of an exact shape (aimlStructuredMode
 * says how each is asked). Anything else (image, video, speech, embeddings,
 * chat models with neither) is left out rather than offered and failing on
 * the first call.
 */
export function selectableAimlModels(body: unknown): AimlModelSummary[] {
  const entries = Array.isArray((body as { data?: unknown } | null)?.data) ? (body as { data: unknown[] }).data : [];
  const models = new Map<string, AimlModelSummary>();
  for (const raw of entries) {
    const entry = raw as AimlCatalogEntry;
    if (typeof entry?.id !== "string" || entry.type !== "openai/chat-completions") continue;
    const capabilities = Array.isArray(entry.capabilities)
      ? entry.capabilities.filter((value): value is string => typeof value === "string")
      : [];
    if (!capabilities.includes("structured_output") && !capabilities.includes("tools")) continue;
    const info = entry.info ?? {};
    models.set(entry.id, {
      id: entry.id,
      name: typeof info.name === "string" && info.name.trim() ? info.name.trim() : entry.id,
      developer: typeof info.developer === "string" ? info.developer : undefined,
      description: typeof info.description === "string" ? info.description : undefined,
      context_length: typeof info.contextLength === "number" ? info.contextLength : undefined,
      capabilities,
      outputModalities: ["text"],
    });
  }
  return [...models.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

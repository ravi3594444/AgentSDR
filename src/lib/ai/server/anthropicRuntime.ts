import "server-only";

import Anthropic from "@anthropic-ai/sdk";

/**
 * Anthropic (Claude API) as an AI engine for Included workspaces: the
 * Messages API with an API key the platform operator stores in the operator
 * panel (src/lib/managed/), never a personal Claude subscription and never
 * process.env. Each call constructs its client with that key, so concurrent
 * workspaces share nothing but the key.
 *
 * The rest of the app speaks the OpenAI-compatible request shape
 * (completeStructured, the AI column runner). `createAnthropicCompatClient`
 * translates that shape to one Messages request and the answer back:
 *
 * - system messages become `system`; the user turn stays the user turn.
 * - A function tool becomes a client tool with its JSON Schema as
 *   `input_schema`. Forced tool choice (`any` / `tool`) is refused with a 400
 *   by Claude Opus 5.5 and Claude Sonnet 5.5, so the call always goes with
 *   `tool_choice: auto`; the system prompt names the one function to call
 *   (toolCallSystemPrompt), and completeStructured already retries an answer
 *   that did not call it.
 * - Thinking is adaptive (the default on these models; it cannot be turned
 *   off on Opus 5.5 or Sonnet 5.5), so `max_tokens` has a floor to leave room
 *   for it. Effort is set explicitly to each model's own default.
 * - Sampling parameters are never sent (the API refuses them).
 * - Opus 5.5 and Sonnet 5.5 requests opt into server-side refusal fallbacks
 *   (`fallbacks: "default"`), so a safety decline is retried on a fallback
 *   model inside the same call; Haiku 5.5 has none.
 * - stop_reason maps to finish_reason: max_tokens → length (completeStructured
 *   doubles the budget), refusal → a refusal message (a rejected attempt).
 *
 * Cost is estimated from the token counts at Anthropic's published per-token
 * prices (cached 2026-10-06), because the response carries tokens, not
 * dollars; it is put on `usage.cost` like OpenRouter's so the usage ledgers
 * read it the same way, and every figure is labelled estimated.
 */

export const ANTHROPIC_PROVIDER_KEY = "anthropic";

/** US$ per million tokens: [input, output]. Haiku 5.5 is priced higher above 100K input tokens. */
const PRICES: Record<string, { input: number; output: number; longInput?: number; longOutput?: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, longInput: 0.5, longOutput: 2.5 },
};

const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);
const MIN_MAX_TOKENS = 4_096;
/** Non-streaming requests stay well under the SDK's HTTP timeout with this ceiling. */
const MAX_MAX_TOKENS = 32_000;

/** Estimated cost of one call, or null for a model without a published price here. */
export function anthropicCostUsd(model: string, usage: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | null | undefined): number | null {
  const price = PRICES[model];
  if (!price || !usage) return null;
  const input = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) * 1.25 + (usage.cache_read_input_tokens ?? 0) * 0.1;
  const output = usage.output_tokens ?? 0;
  const long = (usage.input_tokens ?? 0) > 100_000 && price.longInput !== undefined;
  const cost = (input * (long ? price.longInput! : price.input) + output * (long ? price.longOutput! : price.output)) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/** One free authenticated call (the model list) proves the key; throws an Error whose message is safe to show. */
export async function verifyAnthropicKey(apiKey: string): Promise<void> {
  const client = new Anthropic({ apiKey: apiKey.trim(), timeout: 15_000, maxRetries: 0 });
  try {
    await client.models.list({ limit: 1 });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) throw new Error("Anthropic rejected this API key");
    if (error instanceof Anthropic.PermissionDeniedError) throw new Error("This Anthropic key may not list models");
    if (error instanceof Anthropic.APIConnectionError) throw new Error("Could not reach Anthropic");
    if (error instanceof Anthropic.APIError) throw new Error(`Anthropic answered ${error.status ?? "an error"}`);
    throw new Error("Could not verify this Anthropic key");
  }
}

type CompatMessage = { role?: unknown; content?: unknown };
type CompatTool = { type?: unknown; function?: { name?: unknown; description?: unknown; parameters?: unknown } };
type CompatRequest = {
  model?: unknown;
  messages?: CompatMessage[];
  max_tokens?: unknown;
  max_completion_tokens?: unknown;
  tools?: CompatTool[];
  plugins?: unknown;
};

export type CompatResponse = {
  choices: Array<{
    finish_reason: string | null;
    message: {
      content: string | null;
      refusal?: string | null;
      tool_calls?: Array<{ type: "function"; function: { name: string; arguments: string } }>;
    };
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; cost: number | null };
  model: string;
  /** Anthropic's own response id, for support. */
  id: string;
};

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("");
  }
  return "";
}

/** The Messages request for one OpenAI-shaped request. Exported for tests. */
export function anthropicRequestFrom(raw: CompatRequest): Anthropic.Beta.MessageCreateParamsNonStreaming {
  if (raw.plugins) throw new Error("Web search plugins are not offered by the Anthropic engine");
  const model = typeof raw.model === "string" ? raw.model : "";
  if (!model) throw new Error("No Claude model named");
  const system = (raw.messages ?? []).filter((message) => message.role === "system").map((message) => text(message.content)).filter(Boolean).join("\n\n");
  const messages: Anthropic.Beta.BetaMessageParam[] = (raw.messages ?? [])
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({ role: message.role as "user" | "assistant", content: text(message.content) }));
  if (!messages.length || messages[0]!.role !== "user") messages.unshift({ role: "user", content: "Answer as instructed." });
  const requested = Number(raw.max_tokens ?? raw.max_completion_tokens);
  const maxTokens = Math.min(Math.max(Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : MIN_MAX_TOKENS, MIN_MAX_TOKENS), MAX_MAX_TOKENS);
  const tools = (raw.tools ?? []).flatMap((tool): Anthropic.Beta.BetaTool[] => {
    const name = tool.function?.name;
    const parameters = tool.function?.parameters;
    if (tool.type !== "function" || typeof name !== "string" || !parameters || typeof parameters !== "object") return [];
    return [{
      name,
      ...(typeof tool.function?.description === "string" ? { description: tool.function.description } : {}),
      input_schema: parameters as Anthropic.Beta.BetaTool.InputSchema,
    }];
  });
  const fallbacks = FALLBACK_MODELS.has(model);
  return {
    model,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages,
    ...(tools.length ? { tools, tool_choice: { type: "auto" as const } } : {}),
    output_config: { effort: model.startsWith("claude-sonnet") ? "high" : "medium" },
    ...(fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
  };
}

/** The OpenAI-shaped answer for one Messages response. Exported for tests. */
export function compatResponseFrom(response: Anthropic.Beta.BetaMessage, requestedModel: string): CompatResponse {
  const content = response.content.filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text").map((block) => block.text).join("").trim();
  const toolCalls = response.content
    .filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use")
    .map((block) => ({ type: "function" as const, function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } }));
  const finish = response.stop_reason === "max_tokens" || response.stop_reason === "model_context_window_exceeded"
    ? "length"
    : response.stop_reason === "tool_use" ? "tool_calls" : response.stop_reason === "refusal" ? "content_filter" : "stop";
  const refusal = response.stop_reason === "refusal"
    ? `Claude declined this request${response.stop_details?.category ? ` (${response.stop_details.category})` : ""}`
    : null;
  const usage = response.usage;
  const served = typeof response.model === "string" && response.model ? response.model : requestedModel;
  return {
    id: response.id,
    model: served,
    choices: [{
      finish_reason: finish,
      message: {
        content: refusal ? null : content || null,
        ...(refusal ? { refusal } : {}),
        ...(toolCalls.length && !refusal ? { tool_calls: toolCalls } : {}),
      },
    }],
    usage: {
      prompt_tokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      completion_tokens: usage.output_tokens ?? 0,
      cost: anthropicCostUsd(served, usage) ?? anthropicCostUsd(requestedModel, usage),
    },
  };
}

type MessagesApi = { create: (body: Anthropic.Beta.MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal }) => Promise<Anthropic.Beta.BetaMessage> };

/**
 * A client with the one method the app calls (`chat.completions.create`),
 * answered by the Messages API. `messages` is injectable for tests.
 */
export function createAnthropicCompatClient(apiKey: string, timeoutMs: number, messages?: MessagesApi) {
  const api: MessagesApi = messages ?? new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 1 }).beta.messages;
  return {
    chat: {
      completions: {
        create: async (raw: never, options: { signal?: AbortSignal } = {}): Promise<CompatResponse> => {
          const request = anthropicRequestFrom(raw as CompatRequest);
          const response = await api.create(request, { signal: options.signal });
          return compatResponseFrom(response, request.model);
        },
      },
    },
  };
}

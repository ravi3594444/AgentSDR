import "server-only";

import {
  isRetryableOpenRouterError,
  openRouterTokenLimit,
  toolCallSystemPrompt,
  type OpenRouterModelSelection,
} from "@/lib/ai/openrouter-types";
import { AIML_PROVIDER_KEY } from "@/lib/ai/aimlapi-types";
import { ENGINE_NAMES, type AiEngineKey, type AiRuntimePlan } from "@/lib/ai/runtimePlan";
import { structuredRuntime } from "@/lib/ai/claudeCode/runtime.server";
import { CLAUDE_CODE_ENGINE_KEY } from "@/lib/ai/claudeCode/contract";

/**
 * Every structured answer in the app comes through here. How it is asked for
 * depends on the provider the organization selected (runtimePlan.ts):
 *
 * Claude Code — when an owner selected it and the call names no model, the
 * json_schema request below becomes one CLI generation on that owner's own
 * Claude login (claudeCode/runtime.server.ts), its answer judged here like
 * any other. Its errors say whether another attempt can help (`retryable`:
 * only a CLI that died mid-answer or an overloaded API), so a usage limit, a
 * sign-out, a missing model, a timeout or a busy server is never retried, and
 * nothing falls back to an API provider.
 *
 * AI/ML API — strict JSON schema (`response_format: json_schema`) for the
 * models AI/ML marks `structured_output`, the answer being the message
 * content; models it marks only `tools` (every Claude model, Grok) answer
 * with one function call like OpenRouter (aimlStructuredMode,
 * runtime.ts). Probed on 13 Oct 2026 with the CRM classifier and
 * draft schemas (anyOf null, enum, minLength, format: date-time) against
 * openai/gpt-4o-mini, google/gemini-3.5-flash-lite and
 * anthropic/claude-haiku-latest: all accepted strict mode and answered on
 * schema.
 *
 * The tag does not promise json_schema itself: DeepSeek Chat is tagged
 * `structured_output` and `tools`, yet its request schema allows only text
 * and json_object, so its json_schema request is refused with HTTP 400
 * before inference (21 Oct 2026). When a json_schema request gets any 400
 * (AI/ML's body says only "Validation failed", so the cause is not read) and
 * the model is also tagged `tools` (aimlFunctionCallFallback), the same
 * attempt is sent once more as a forced function call (same model, prompts
 * and schema) and the rest of the call stays a function call. That is the
 * only switch: never back, never twice, and only for a 400 — 401, 403, 404,
 * 422, 429, 5xx and timeouts behave as below. The refused request is not
 * counted as an attempt (it produced no answer), so a call makes at most
 * `maxAttempts` + 1 requests. Nothing is remembered between calls: every
 * call asks for json_schema first, so a model that always refuses it costs
 * one refused request per call, and one unrelated 400 never moves a model
 * off json_schema for later calls.
 *
 * OpenRouter — a function call, never `response_format`. JSON mode is the
 * parameter the pinned providers
 * disagree on (minimax-m3 drifts off-schema in it, and strict json_schema is
 * refused outright by its endpoint), whereas every configured provider
 * supports `tools`, and a call hands back the arguments as one JSON string.
 *
 * The single tool is offered with `tool_choice: "auto"` on purpose. Probed
 * on 16 Sep 2026 with `require_parameters: true`: a forced function or
 * `"required"` is refused by OpenRouter's routing for minimax and z-ai ("No
 * endpoints found that support the provided 'tool_choice' value"), and
 * z-ai's own API rejects a forced function outright; `"auto"` is honoured on
 * all three providers and the one offered tool is called.
 *
 * Because "auto" leaves the model free to answer in prose, and because a
 * call's arguments can still miss the schema, each attempt is judged and
 * a bad one is retried: no tool call, arguments that are not a JSON object,
 * arguments the caller's `accept` rejects, or a transient transport error
 * (429, 5xx, timeout). Routing and configuration errors (400 apart from
 * the one AI/ML json_schema fallback above, 401, 403, 404) are not retried —
 * another attempt would fail the same way.
 *
 * Reasoning models spend `max_tokens` on thinking before the call:
 * minimax-m3 was measured using 799 of an 800-token budget on reasoning and
 * finishing with `length` and no call, and neither `reasoning.effort` nor
 * `reasoning.max_tokens` capped it reliably. A `length` finish is therefore
 * retried with double the output budget each time.
 */

const DEFAULT_MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [500, 1_500];

export type StructuredCompletionInput = {
  requestedModel?: OpenRouterModelSelection;
  timeoutMs: number;
  systemPrompt: string;
  userPrompt: string;
  maxOutputTokens: number;
  /** JSON Schema for the tool's parameters; the model's arguments must satisfy it. */
  jsonSchema: Record<string, unknown>;
  /** Tool name; snake_case, as it is shown to the model. */
  schemaName: string;
  /** What the tool submits, in one sentence, as shown to the model. */
  schemaDescription?: string;
  /**
   * Caller-side validation of the parsed arguments. Throw to reject the
   * attempt; the thrown message is surfaced if every attempt is rejected.
   */
  accept?: (text: string) => void;
  /** Called before each retry (attempt 2, 3, …), e.g. to tell the owner the model is being asked again. */
  onRetry?: (info: { attempt: number; maxAttempts: number; reason: string }) => void | Promise<void>;
  /** OpenRouter plugins, e.g. `[{ id: "web" }]` for grounded answers. */
  plugins?: Array<Record<string, unknown>>;
  /** Sees each request before it is sent, so a caller can audit one that fails. */
  onRequest?: (request: Record<string, unknown>) => void;
  maxAttempts?: number;
  signal?: AbortSignal;
};

export type StructuredCompletionResult = {
  /** The tool's arguments, verbatim JSON text. */
  text: string;
  provider: string;
  model: string;
  request: Record<string, unknown>;
  response: unknown;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
  };
  /** Attempts at an answer; a json_schema request refused before the function-call fallback is not one. */
  attempts: number;
};

class RejectedAttemptError extends Error {}

function httpStatusOf(error: unknown): number | undefined {
  const candidate = error as { status?: unknown; statusCode?: unknown } | null;
  const status = Number(candidate?.status ?? candidate?.statusCode);
  return Number.isFinite(status) && status > 0 ? status : undefined;
}

/**
 * What callers read off a provider's error, for an error that wraps it: the
 * HTTP status (the reply agent stops on a permanent 4xx) and the SDK's code,
 * type, body and request id (the AI-column audit stops at the first error in
 * the chain that carries a status).
 */
function providerErrorFields(error: unknown): Record<string, unknown> {
  const status = httpStatusOf(error);
  const source = error && typeof error === "object" ? error as Record<string, unknown> : {};
  return Object.fromEntries([
    ["status", status],
    ...(["code", "type", "error", "requestID"] as const).map((key) => [key, source[key]] as const),
  ].filter(([, value]) => value !== undefined && value !== null));
}

function describeResponseError(response: unknown): string | null {
  const error = (response as { error?: unknown } | null)?.error;
  if (!error || typeof error !== "object") return null;
  const { message, code } = error as { message?: unknown; code?: unknown };
  const parts = [code, message].filter((part) => typeof part === "string" || typeof part === "number");
  return parts.length ? parts.join(" ") : null;
}

function isJsonObjectText(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

/** The slice of the runtime this module uses; tests substitute a fake client here. */
export type StructuredCompletionRuntime = (
  requested: OpenRouterModelSelection | undefined,
  timeoutMs: number,
) => Promise<Pick<AiRuntimePlan, "selection" | "routing" | "structuredOutput" | "functionCallFallback" | "supportsPlugins"> & {
  /** An API provider (runtime.ts), or Claude Code (claudeCode/runtime.server.ts). */
  providerKey: AiEngineKey;
  client: { chat: { completions: { create: (request: never, options: { signal?: AbortSignal }) => Promise<StructuredChatResponse> } } };
}>;

type StructuredChatResponse = {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      refusal?: string | null;
      tool_calls?: Array<{ type: string; function?: { name: string; arguments: string } }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: unknown;
  /** Claude Code: the model id the CLI actually ran (the selection holds its alias). */
  model?: string | null;
};

/** JSON-schema mode: the instruction that matches toolCallSystemPrompt for a function call. */
export function jsonSchemaSystemPrompt(systemPrompt: string, schemaName: string, description?: string): string {
  return `${systemPrompt}\n\nAnswer with one JSON object that matches the ${schemaName} schema${description ? ` (${description.replace(/\.$/, "")})` : ""}. Never answer in prose.`;
}

/**
 * Whether a schema meets strict structured-output rules: every object lists
 * all of its properties as required and sets additionalProperties: false, all
 * the way down. The app's own schemas do; a schema typed into a table column
 * may not, and strict mode answers that with a 400. Such a schema is sent
 * non-strict instead (the answer is still parsed and checked by `accept`).
 */
export function isStrictJsonSchema(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.every(isStrictJsonSchema);
  if (!schema || typeof schema !== "object") return true;
  const node = schema as Record<string, unknown>;
  const properties = node.properties && typeof node.properties === "object" ? node.properties as Record<string, unknown> : null;
  const isObject = node.type === "object" || (Array.isArray(node.type) && node.type.includes("object")) || properties !== null;
  if (isObject) {
    if (node.additionalProperties !== false) return false;
    const required = Array.isArray(node.required) ? new Set(node.required) : new Set();
    if (properties && Object.keys(properties).some((key) => !required.has(key))) return false;
  }
  const children = [
    ...(properties ? Object.values(properties) : []),
    node.items,
    node.anyOf,
    node.oneOf,
    node.allOf,
    ...(node.$defs && typeof node.$defs === "object" ? Object.values(node.$defs) : []),
    ...(node.definitions && typeof node.definitions === "object" ? Object.values(node.definitions) : []),
  ];
  return children.every((child) => child === undefined || isStrictJsonSchema(child));
}

/** A model that wraps its JSON in a markdown fence anyway: keep what is inside. */
function unfenced(text: string): string {
  const match = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/i.exec(text);
  return match ? match[1] : text.trim();
}

export async function completeStructured(
  input: StructuredCompletionInput,
  dependencies: { runtime?: StructuredCompletionRuntime; sleep?: typeof sleep } = {},
): Promise<StructuredCompletionResult> {
  const { client, selection, routing, structuredOutput, functionCallFallback, supportsPlugins, providerKey } = await (dependencies.runtime ?? structuredRuntime)(
    input.requestedModel,
    input.timeoutMs,
  );
  // Switches once, json_schema to tool_call, and only on AI/ML API (see the top of this file).
  let mode = structuredOutput;
  const mayFallBack = providerKey === AIML_PROVIDER_KEY && structuredOutput === "json_schema" && functionCallFallback === true;
  let schemaRefusal: string | null = null;
  if (input.plugins?.length && !supportsPlugins) {
    // Answering a web-research question from the model's memory would look
    // like a researched answer; refuse instead.
    throw new Error(`Web search runs through OpenRouter's web plugin, which ${ENGINE_NAMES[providerKey]} does not offer. Select an OpenRouter connection in AI Settings for this feature.`);
  }
  const maxAttempts = Math.max(1, Math.floor(input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  let outputTokens = input.maxOutputTokens;
  // When `accept` rejects an answer, the next attempt is told why and shown
  // what it wrote; repeating the identical request mostly repeats the answer.
  let rejected: { text: string; reason: string } | null = null;
  const userContent = () => rejected
    ? [
        input.userPrompt,
        `Your previous answer was rejected: ${rejected.reason}`,
        `The rejected answer was:\n${rejected.text.slice(0, 4_000)}`,
        "Answer again, fixing exactly that.",
      ].join("\n\n")
    : input.userPrompt;

  function buildRequest() {
    const base = {
      model: selection.modelId,
      ...openRouterTokenLimit(selection.modelId, outputTokens),
      ...routing,
    };
    if (mode === "json_schema") {
      return {
        ...base,
        messages: [
          { role: "system" as const, content: jsonSchemaSystemPrompt(input.systemPrompt, input.schemaName, input.schemaDescription) },
          { role: "user" as const, content: userContent() },
        ],
        response_format: {
          type: "json_schema" as const,
          json_schema: { name: input.schemaName, strict: isStrictJsonSchema(input.jsonSchema), schema: input.jsonSchema },
        },
      };
    }
    return {
      ...base,
      messages: [
        { role: "system" as const, content: toolCallSystemPrompt(input.systemPrompt, input.schemaName) },
        { role: "user" as const, content: userContent() },
      ],
      ...(input.plugins?.length ? { plugins: input.plugins } : {}),
      tools: [{
        type: "function" as const,
        function: {
          name: input.schemaName,
          description: input.schemaDescription
            ?? "Submit the structured result. Call it exactly once; it is the only way to answer.",
          parameters: input.jsonSchema,
        },
      }],
      // AI/ML API: the call is required, not left to the model. Measured 18 Oct 2026 with the
      // assistant's real prompt: with "auto", Claude Haiku 5.5 spent its whole budget reasoning
      // and stopped mid-call (finish "length", arguments {} or message-only) every time, and
      // Grok 4.7 answered in prose; with the function named, both returned complete calls.
      tool_choice: providerKey === "openrouter"
        ? "auto" as const
        : { type: "function" as const, function: { name: input.schemaName } },
    };
  }

  /** The JSON text an attempt produced, or a RejectedAttemptError saying why it is unusable. */
  function answerText(response: StructuredChatResponse): string {
    const choice = response.choices?.[0];
    const message = choice?.message;
    if (mode === "json_schema") {
      const content = typeof message?.content === "string" ? message.content : "";
      if (!content.trim()) {
        const detail = describeResponseError(response);
        if (detail) throw new Error(`${ENGINE_NAMES[providerKey]} returned no ${input.schemaName} answer: ${detail}`);
        if (typeof message?.refusal === "string" && message.refusal.trim()) {
          throw new RejectedAttemptError(`The model refused: ${message.refusal.trim().slice(0, 300)}`);
        }
        if (choice?.finish_reason === "length") {
          const spent = outputTokens;
          outputTokens *= 2;
          throw new RejectedAttemptError(`The model ran out of output tokens (${spent}) before answering`);
        }
        throw new RejectedAttemptError(`The model returned no ${input.schemaName} JSON`);
      }
      const text = unfenced(content);
      if (!isJsonObjectText(text)) {
        if (choice?.finish_reason === "length") {
          const spent = outputTokens;
          outputTokens *= 2;
          throw new RejectedAttemptError(`The model ran out of output tokens (${spent}) mid-answer`);
        }
        throw new RejectedAttemptError(`The ${input.schemaName} answer is not a JSON object`);
      }
      return text;
    }

    // OpenRouter can answer 200 with an `error` body and no `choices`; that
    // used to surface as "undefined is not an object (evaluating 'a.choices[0]')".
    const call = message?.tool_calls?.find((candidate) => (
      candidate.type === "function" && candidate.function?.name === input.schemaName
    ))?.function;
    if (!call) {
      const detail = describeResponseError(response);
      if (detail) throw new Error(`${ENGINE_NAMES[providerKey]} returned no ${input.schemaName} call: ${detail}`);
      if (choice?.finish_reason === "length") {
        const spent = outputTokens;
        outputTokens *= 2;
        throw new RejectedAttemptError(
          `The model ran out of output tokens (${spent}) before calling ${input.schemaName}`,
        );
      }
      // A model can call names it read in the prompt (DeepSeek Chat called the
      // assistant's action names) instead of the one function offered; asked
      // again unchanged, it does the same, so the retry is told what it called.
      const others = (message?.tool_calls ?? []).flatMap((candidate) => candidate.function?.name ? [candidate.function] : []);
      if (others.length) {
        const names = [...new Set(others.map((other) => other.name))];
        const reason = `you called ${names.join(" and ")}, which ${names.length > 1 ? "are not functions" : "is not a function"} here; the only function is ${input.schemaName}: call it once, with what you meant inside its arguments`;
        rejected = { text: JSON.stringify(others.map((other) => ({ name: other.name, arguments: other.arguments }))), reason };
        throw new RejectedAttemptError(`The model called ${names.join(", ")} instead of ${input.schemaName}`);
      }
      throw new RejectedAttemptError(
        message?.content?.trim()
          ? `The model answered in prose instead of calling ${input.schemaName}`
          : `The model returned neither a ${input.schemaName} call nor content`,
      );
    }
    if (choice?.finish_reason === "length") {
      // A call cut off at the token limit can still parse ({} or a lone message): never accept it as the answer.
      const spent = outputTokens;
      outputTokens *= 2;
      throw new RejectedAttemptError(`The model ran out of output tokens (${spent}) while writing its ${input.schemaName} call`);
    }
    const text = call.arguments;
    if (typeof text !== "string" || !isJsonObjectText(text)) {
      throw new RejectedAttemptError(`The ${input.schemaName} call carried arguments that are not a JSON object`);
    }
    return text;
  }

  async function attempt(): Promise<Omit<StructuredCompletionResult, "attempts">> {
    const request = buildRequest();
    input.onRequest?.(request);
    const response: StructuredChatResponse = await client.chat.completions.create(request as never, { signal: input.signal });
    const text = answerText(response);
    try {
      input.accept?.(text);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      rejected = { text, reason };
      // Diagnostics: what the model actually sent, so a rejection can be explained from the server log.
      console.warn(`[ai/structured] ${input.schemaName} answer rejected (${selection.provider} ${selection.modelId}): ${reason}\n--- model answer (first 3000 chars) ---\n${text.slice(0, 3000)}\n--- end ---`);
      throw new RejectedAttemptError(reason);
    }
    return {
      text,
      provider: selection.provider,
      model: providerKey === CLAUDE_CODE_ENGINE_KEY && typeof response.model === "string" && response.model ? response.model : selection.modelId,
      request,
      response,
      usage: {
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
      },
    };
  }

  /** One attempt; a json_schema request refused with HTTP 400 is sent once more as a function call. */
  async function attemptOrFallBack(): Promise<Omit<StructuredCompletionResult, "attempts">> {
    try {
      return await attempt();
    } catch (error) {
      if (!mayFallBack || mode !== "json_schema" || httpStatusOf(error) !== 400 || input.signal?.aborted) throw error;
      schemaRefusal = messageOf(error);
      mode = "tool_call";
      console.warn(`[ai/structured] ${input.schemaName}: ${selection.modelId} refused the json_schema request (${schemaRefusal}); asking once more as a function call`);
      return await attempt();
    }
  }

  /** After the switch, a failure also says why json_schema was dropped. */
  const afterRefusal = (failure: string) => schemaRefusal
    ? `${input.schemaName}: the json_schema request was rejected (${schemaRefusal}) and the function-call retry also failed: ${failure}`
    : failure;

  let lastError: unknown;
  for (let index = 0; index < maxAttempts; index += 1) {
    if (index > 0) {
      // Lets the caller say it is retrying; a failure to say so never stops the retry.
      await Promise.resolve(input.onRetry?.({ attempt: index + 1, maxAttempts, reason: messageOf(lastError) })).catch(() => undefined);
      await (dependencies.sleep ?? sleep)(RETRY_BACKOFF_MS[Math.min(index - 1, RETRY_BACKOFF_MS.length - 1)], input.signal);
    }
    try {
      return { ...(await attemptOrFallBack()), attempts: index + 1 };
    } catch (error) {
      lastError = error;
      const retryable = error instanceof RejectedAttemptError || (claudeCodeRetryable(error) ?? isRetryableOpenRouterError(error));
      if (!retryable || input.signal?.aborted) {
        if (!schemaRefusal) throw error;
        throw Object.assign(new Error(afterRefusal(messageOf(error)), { cause: error }), providerErrorFields(error));
      }
    }
  }
  throw new Error(afterRefusal(`${input.schemaName} failed after ${maxAttempts} attempts: ${messageOf(lastError)}`), { cause: lastError });
}

/** Claude Code errors say themselves whether another attempt can help (claudeCode/runner.server.ts); null for any other error. */
function claudeCodeRetryable(error: unknown): boolean | null {
  const candidate = error as { name?: unknown; retryable?: unknown } | null;
  return candidate?.name === "ClaudeCodeError" && typeof candidate.retryable === "boolean" ? candidate.retryable : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

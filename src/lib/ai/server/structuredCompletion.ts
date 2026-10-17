import "server-only";

import {
  isRetryableOpenRouterError,
  openRouterTokenLimit,
  toolCallSystemPrompt,
  type OpenRouterModelSelection,
} from "@/lib/ai/openrouter-types";
import { RUNTIME_PROVIDERS, type AiRuntimePlan } from "@/lib/ai/runtimePlan";
import { getAiRuntime } from "./runtime";

/**
 * Every structured answer in the app comes through here. How it is asked for
 * depends on the provider the organization selected (runtimePlan.ts):
 *
 * AI/ML API — strict JSON schema (`response_format: json_schema`). Only
 * models AI/ML marks `structured_output` can be selected, and the answer is
 * the message content. Probed on 13 Oct 2026 with the CRM classifier and
 * draft schemas (anyOf null, enum, minLength, format: date-time) against
 * openai/gpt-4o-mini, google/gemini-3.5-flash-lite and
 * anthropic/claude-haiku-latest: all accepted strict mode and answered on
 * schema.
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
 * (429, 5xx, timeout). Routing and configuration errors (400, 401, 403,
 * 404) are not retried — another attempt would fail the same way.
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
  attempts: number;
};

class RejectedAttemptError extends Error {}

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
) => Promise<Pick<AiRuntimePlan, "providerKey" | "selection" | "routing" | "structuredOutput" | "supportsPlugins"> & {
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
  const { client, selection, routing, structuredOutput, supportsPlugins, providerKey } = await (dependencies.runtime ?? getAiRuntime)(
    input.requestedModel,
    input.timeoutMs,
  );
  if (input.plugins?.length && !supportsPlugins) {
    // Answering a web-research question from the model's memory would look
    // like a researched answer; refuse instead.
    throw new Error(`Web search runs through OpenRouter's web plugin, which ${RUNTIME_PROVIDERS[providerKey]} does not offer. Select an OpenRouter connection in AI Settings for this feature.`);
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
    if (structuredOutput === "json_schema") {
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
      tool_choice: "auto" as const,
    };
  }

  /** The JSON text an attempt produced, or a RejectedAttemptError saying why it is unusable. */
  function answerText(response: StructuredChatResponse): string {
    const choice = response.choices?.[0];
    const message = choice?.message;
    if (structuredOutput === "json_schema") {
      const content = typeof message?.content === "string" ? message.content : "";
      if (!content.trim()) {
        const detail = describeResponseError(response);
        if (detail) throw new Error(`${RUNTIME_PROVIDERS[providerKey]} returned no ${input.schemaName} answer: ${detail}`);
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
      if (detail) throw new Error(`OpenRouter returned no ${input.schemaName} call: ${detail}`);
      if (choice?.finish_reason === "length") {
        const spent = outputTokens;
        outputTokens *= 2;
        throw new RejectedAttemptError(
          `The model ran out of output tokens (${spent}) before calling ${input.schemaName}`,
        );
      }
      throw new RejectedAttemptError(
        message?.content?.trim()
          ? `The model answered in prose instead of calling ${input.schemaName}`
          : `The model returned neither a ${input.schemaName} call nor content`,
      );
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
      model: selection.modelId,
      request,
      response,
      usage: {
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
      },
    };
  }

  let lastError: unknown;
  for (let index = 0; index < maxAttempts; index += 1) {
    if (index > 0) {
      await (dependencies.sleep ?? sleep)(RETRY_BACKOFF_MS[Math.min(index - 1, RETRY_BACKOFF_MS.length - 1)], input.signal);
    }
    try {
      return { ...(await attempt()), attempts: index + 1 };
    } catch (error) {
      lastError = error;
      const retryable = error instanceof RejectedAttemptError || isRetryableOpenRouterError(error);
      if (!retryable || input.signal?.aborted) throw error;
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${input.schemaName} failed after ${maxAttempts} attempts: ${reason}`, { cause: lastError });
}

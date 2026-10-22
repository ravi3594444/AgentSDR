import "server-only";

import type { OpenRouterModelSelection } from "@/lib/ai/openrouter-types";
import { getAiRuntime } from "@/lib/ai/server/runtime";
import type { StructuredCompletionRuntime } from "@/lib/ai/server/structuredCompletion";
import { CLAUDE_CODE_ENGINE_KEY, type ClaudeCodeEffort, type ClaudeCodeModel } from "./contract";
import type { ClaudeAccount } from "./cli.server";
import { claudeCodeBinding } from "./engine.server";
import { runGeneration, type GenerationInput, type GenerationResult } from "./runner.server";

/**
 * Claude Code under completeStructured: a runtime whose client turns the
 * json_schema request completeStructured builds (system prompt, user prompt,
 * schema) into one CLI generation and hands the answer back as message
 * content. completeStructured therefore judges it exactly as it judges an
 * API model's: the caller's schema, its `accept` validation, and its retries
 * with the rejected answer shown back.
 *
 * It answers only the app's own steps, those that do not name a model
 * (assistant turns, lead judging, writers, CRM replies and the reply agent).
 * A call that names an API model (a table AI column saved for one) keeps
 * that API connection; OpenRouter's web plugin is not offered, so a call
 * needing web search is refused, not answered from memory.
 */

/** Extra time over the caller's timeout for starting the CLI process. */
const PROCESS_START_MS = 20_000;

type JsonSchemaRequest = {
  model?: unknown;
  messages?: Array<{ role?: unknown; content?: unknown }>;
  response_format?: { json_schema?: { schema?: unknown } };
};

function messageText(request: JsonSchemaRequest, role: "system" | "user"): string {
  return (request.messages ?? []).filter((message) => message.role === role).map((message) => typeof message.content === "string" ? message.content : "").join("\n\n");
}

export function claudeCodeRuntime(
  binding: { account: ClaudeAccount; model: ClaudeCodeModel; effort?: ClaudeCodeEffort },
  timeoutMs: number,
  run: (input: GenerationInput) => Promise<GenerationResult> = runGeneration,
): Awaited<ReturnType<StructuredCompletionRuntime>> {
  return {
    providerKey: CLAUDE_CODE_ENGINE_KEY,
    selection: { provider: CLAUDE_CODE_ENGINE_KEY, modelId: binding.model },
    routing: {},
    structuredOutput: "json_schema",
    functionCallFallback: false,
    supportsPlugins: false,
    client: {
      chat: {
        completions: {
          create: async (raw: never, options: { signal?: AbortSignal }) => {
            const request = raw as JsonSchemaRequest;
            const schema = request.response_format?.json_schema?.schema;
            if (!schema || typeof schema !== "object") throw new Error("Claude Code answers structured requests only");
            const result = await run({
              account: binding.account,
              model: binding.model,
              effort: binding.effort,
              systemPrompt: messageText(request, "system"),
              userPrompt: messageText(request, "user"),
              jsonSchema: schema as Record<string, unknown>,
              timeoutMs: timeoutMs + PROCESS_START_MS,
              signal: options.signal,
            });
            return {
              choices: [{ finish_reason: "stop", message: { content: result.text } }],
              usage: { prompt_tokens: result.usage.inputTokens, completion_tokens: result.usage.outputTokens },
              model: result.modelId,
            };
          },
        },
      },
    },
  };
}

/**
 * What completeStructured runs on: Claude Code when this organization
 * selected it and the call names no API model, otherwise the API runtime
 * (getAiRuntime), unchanged.
 */
export const structuredRuntime: StructuredCompletionRuntime = async (requested: OpenRouterModelSelection | undefined, timeoutMs: number) => {
  if (!requested) {
    const binding = await claudeCodeBinding();
    if (binding) return claudeCodeRuntime(binding, timeoutMs);
  }
  return getAiRuntime(requested, timeoutMs);
};

import "server-only";

import { getByokSettings } from "../byok";
import { getAiConnection, getAiCredentials, type AiConnection } from "../connections";
import type { OpenRouterModelSelection } from "../openrouter-types";
import { RUNTIME_PROVIDERS, planAiRuntime, type AiRuntimePlan } from "../runtimePlan";
import { aimlFunctionCallFallback, aimlStructuredMode, type AimlModelSummary } from "../aimlapi-types";
import { createAimlClient, listAimlModelsCached } from "./aimlapi";
import { createOpenRouterClient } from "./openrouter";

export type StrictOpenRouterRouting = {
  only: string[];
  order: string[];
  allow_fallbacks: false;
  require_parameters: true;
};

/**
 * The mandatory entry point for every model call: applies the gate in
 * runtimePlan.ts to the organization's AI settings, then decrypts the
 * selected connection's key and returns a client for its provider.
 * OpenRouter and AI/ML API are both OpenAI-compatible, so callers use one
 * client type and add `plan.routing` to each text request.
 */
export async function getAiRuntime(
  requested?: OpenRouterModelSelection,
  timeout = 30_000,
) {
  const settings = await getByokSettings();
  const connection = settings.connectionId ? await getAiConnection(settings.connectionId) : null;
  const planned = planAiRuntime(settings, connection, requested);
  if (!planned.ok) throw new Error(planned.error);

  const credentials = await getAiCredentials(connection!.id);
  if (!credentials?.apiKey) throw new Error(`Reconnect ${RUNTIME_PROVIDERS[planned.plan.providerKey]} in AI Settings`);
  return runtimeFor(planned.plan, connection!, credentials.apiKey, timeout);
}

export type AiRuntime = Awaited<ReturnType<typeof getAiRuntime>>;

const CATALOG_WAIT_MS = 5_000;

/**
 * A gated plan made into a runtime: its provider's client, and how its model
 * is asked for structured answers. Separate from getAiRuntime, which reads
 * the database, so tests can give it a catalog.
 */
export async function runtimeFor(
  plan: AiRuntimePlan,
  connection: AiConnection,
  apiKey: string,
  timeout: number,
  catalog: { listModels?: () => Promise<AimlModelSummary[]>; waitMs?: number } = {},
) {
  const structured = plan.providerKey === "openrouter" ? null : await aimlModeFor(plan.selection.modelId, plan.structuredOutput, catalog);
  return {
    ...plan,
    structuredOutput: structured?.structuredOutput ?? plan.structuredOutput,
    ...(structured ? { functionCallFallback: structured.functionCallFallback } : {}),
    client: plan.providerKey === "openrouter"
      ? createOpenRouterClient(apiKey, timeout)
      : createAimlClient(apiKey, timeout),
    apiKey,
    connection,
  } satisfies AiRuntimePlan & Record<string, unknown>;
}

/**
 * How an AI/ML API model is asked for structured answers, from its tags in
 * AI/ML's catalog (cached 10 minutes), and whether a refused json_schema
 * request may fall back to a function call. When the catalog cannot be read
 * in a few seconds, or no longer lists the model, the plan's default is kept
 * and there is no fallback: the model's `tools` tag is unknown.
 */
async function aimlModeFor(
  modelId: string,
  fallback: AiRuntimePlan["structuredOutput"],
  { listModels = listAimlModelsCached, waitMs = CATALOG_WAIT_MS }: { listModels?: () => Promise<AimlModelSummary[]>; waitMs?: number },
): Promise<Pick<AiRuntimePlan, "structuredOutput"> & { functionCallFallback: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const models = await Promise.race([
    listModels().catch(() => null),
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), waitMs); }),
  ]);
  clearTimeout(timer);
  const model = models?.find((entry) => entry.id === modelId);
  return model
    ? { structuredOutput: aimlStructuredMode(model.capabilities), functionCallFallback: aimlFunctionCallFallback(model.capabilities) }
    : { structuredOutput: fallback, functionCallFallback: false };
}

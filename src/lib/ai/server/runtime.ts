import "server-only";

import { getByokSettings } from "../byok";
import { getAiConnection, getAiCredentials, type AiConnection } from "../connections";
import type { OpenRouterModelSelection } from "../openrouter-types";
import { ANTHROPIC_ENGINE_KEY, RUNTIME_PROVIDERS, planAiRuntime, type AiRuntimePlan } from "../runtimePlan";
import { AIML_PROVIDER_KEY, aimlFunctionCallFallback, aimlStructuredMode, type AimlModelSummary } from "../aimlapi-types";
import { createAimlClient, listAimlModelsCached } from "./aimlapi";
import { createOpenRouterClient } from "./openrouter";
import { createAnthropicCompatClient } from "./anthropicRuntime";
import { isManagedAiConnectionId } from "../byok";
import { meteredAiClient } from "@/lib/managed/aiMeter.server";
import { serviceMode } from "@/lib/managed/modes.server";
import type { ManagedAiEngine } from "@/lib/managed/catalog";

/** Thrown when a workspace on the Included AI service asks while the platform has no working engine. */
export class ManagedAiUnavailableError extends Error {
  constructor() {
    super("The included AI service is not available right now. Try again later, or choose My own provider for AI in Settings → Advanced → Use your own providers.");
    this.name = "ManagedAiUnavailableError";
  }
}

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
  const managed = (await serviceMode("ai")) === "managed";
  const connection = settings.connectionId ? await getAiConnection(settings.connectionId) : null;
  // An Included workspace never sees the engine's configuration in an error: only that it is unavailable.
  if (managed && (!connection?.verified || !isManagedAiConnectionId(connection.id))) throw new ManagedAiUnavailableError();
  const planned = planAiRuntime(settings, connection, requested);
  if (!planned.ok) {
    if (managed) throw new ManagedAiUnavailableError();
    throw new Error(planned.error);
  }

  const credentials = await getAiCredentials(connection!.id);
  if (!credentials?.apiKey) {
    if (managed) throw new ManagedAiUnavailableError();
    throw new Error(`Reconnect ${RUNTIME_PROVIDERS[planned.plan.providerKey]} in AI Settings`);
  }
  const runtime = await runtimeFor(planned.plan, connection!, credentials.apiKey, timeout);
  return {
    ...runtime,
    client: meteredAiClient(runtime.client, {
      source: managed ? "managed" : "own",
      engine: planned.plan.providerKey as ManagedAiEngine,
      model: planned.plan.selection.modelId,
    }),
  };
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
  const structured = plan.providerKey === AIML_PROVIDER_KEY ? await aimlModeFor(plan.selection.modelId, plan.structuredOutput, catalog) : null;
  return {
    ...plan,
    structuredOutput: structured?.structuredOutput ?? plan.structuredOutput,
    ...(structured ? { functionCallFallback: structured.functionCallFallback } : {}),
    client: plan.providerKey === "openrouter"
      ? createOpenRouterClient(apiKey, timeout)
      : plan.providerKey === ANTHROPIC_ENGINE_KEY
        // The Messages API behind the one method the app calls; its answers have the same shape.
        ? createAnthropicCompatClient(apiKey, timeout) as unknown as ReturnType<typeof createOpenRouterClient>
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
 * and a refused json_schema request may still be asked once as a function
 * call: the `tools` tag is unknown, and a second refusal costs one request
 * while no retry cost the whole turn (DeepSeek Chat 400s every json_schema
 * request, so a slow catalog read used to stop the assistant on the owner's
 * first message).
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
    : { structuredOutput: fallback, functionCallFallback: true };
}

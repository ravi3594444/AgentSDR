import "server-only";

import { getByokSettings } from "../byok";
import { getAiConnection, getAiCredentials } from "../connections";
import type { OpenRouterModelSelection } from "../openrouter-types";
import { RUNTIME_PROVIDERS, planAiRuntime, type AiRuntimePlan } from "../runtimePlan";
import { createAimlClient } from "./aimlapi";
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
  const { plan } = planned;

  const credentials = await getAiCredentials(connection!.id);
  if (!credentials?.apiKey) throw new Error(`Reconnect ${RUNTIME_PROVIDERS[plan.providerKey]} in AI Settings`);

  return {
    ...plan,
    client: plan.providerKey === "openrouter"
      ? createOpenRouterClient(credentials.apiKey, timeout)
      : createAimlClient(credentials.apiKey, timeout),
    apiKey: credentials.apiKey,
    connection: connection!,
  } satisfies AiRuntimePlan & Record<string, unknown>;
}

export type AiRuntime = Awaited<ReturnType<typeof getAiRuntime>>;

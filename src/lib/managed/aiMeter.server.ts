import "server-only";

import { responseCostUsd } from "@/lib/assistant/usage.server";
import { reserveAiCall, settleAiCall, aiCallCost, type AiCallMeta } from "./usage.server";

/**
 * Every model call through the AI runtime is one provider_usage row
 * (provider 'ai'), attributed to the platform's key ('managed') or the
 * workspace's own ('own'). An Included call is reserved against the
 * workspace's AI allowance and the platform budget first (it is refused,
 * with nothing sent, when either is used up); then settled at the cost the
 * provider reported, or an estimate from its tokens, labelled estimated.
 *
 * A call the provider answered with an error used nothing. A call whose
 * answer was lost (a timeout, a dropped connection) stays at its reserved
 * amount as `uncertain`: the provider may have run it. Nothing is re-sent
 * here; completeStructured's own retries are new calls, each reserved.
 */

type ChatClient = { chat: { completions: { create: (request: never, options?: never) => Promise<unknown> } } };

function answered(error: unknown): boolean {
  const status = Number((error as { status?: unknown } | null)?.status);
  return Number.isFinite(status) && status > 0;
}

/** The same client, with each `chat.completions.create` reserved and settled. */
export function meteredAiClient<T extends ChatClient>(client: T, meta: AiCallMeta): T {
  const create = client.chat.completions.create.bind(client.chat.completions) as (request: never, options?: never) => Promise<unknown>;
  const metered = async (request: never, options?: never) => {
    const usageId = await reserveAiCall({ ...meta, model: String((request as { model?: unknown } | null)?.model ?? meta.model) });
    let response: unknown;
    try {
      response = await create(request, options);
    } catch (error) {
      await settleAiCall(usageId, {
        status: answered(error) ? "failed" : "uncertain",
        error: error instanceof Error ? error.message : String(error),
      }).catch((settleError: unknown) => console.error("[managed/ai] could not settle a failed call:", settleError));
      throw error;
    }
    const cost = meta.engine === "claude-code" ? { costUsd: null, estimated: false } : aiCallCost(response, responseCostUsd(response));
    // Anthropic reports tokens, not dollars: its cost (anthropicRuntime.ts) is always an estimate.
    const { costUsd } = cost;
    const estimated = cost.estimated || meta.engine === "anthropic";
    const usage = (response as { usage?: { prompt_tokens?: number; completion_tokens?: number } } | null)?.usage;
    await settleAiCall(usageId, { status: "settled", costUsd, estimated, tokens: { input: usage?.prompt_tokens, output: usage?.completion_tokens } })
      .catch((settleError: unknown) => console.error("[managed/ai] could not settle a call:", settleError));
    return response;
  };
  // Proxies, not copies: the SDK clients are class instances whose other methods must keep working.
  const completions = new Proxy(client.chat.completions, { get: (target, prop, receiver) => (prop === "create" ? metered : Reflect.get(target, prop, receiver)) });
  const chat = new Proxy(client.chat, { get: (target, prop, receiver) => (prop === "completions" ? completions : Reflect.get(target, prop, receiver)) });
  return new Proxy(client, { get: (target, prop, receiver) => (prop === "chat" ? chat : Reflect.get(target, prop, receiver)) });
}

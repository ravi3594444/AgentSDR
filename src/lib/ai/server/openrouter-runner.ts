import "server-only";
import { PermanentRunError, RetryableRunError, aiProviderLabel } from "@/lib/grid/runners/types";
import { isTransientOpenRouterError } from "./openrouter-errors";
import { openRouterTokenLimit, strictImageProviderRouting } from "../openrouter-types";
import { generateOpenRouterImage } from "./openrouter";
import { getAiRuntime } from "./runtime";
import { completeStructured } from "./structuredCompletion";
import type { AiRunner } from "./types";
import { AIML_PROVIDER_KEY, AIML_PROVIDER_NAME } from "../aimlapi-types";
import type { AiProviderKey } from "../runtimePlan";

/**
 * OpenRouter answers an upstream failure with a generic message ("Provider
 * returned error") and puts the provider's own words in `metadata.raw`.
 * Surface those, from the error itself or from whatever it wraps.
 */
function auditError(error: unknown) {
  let api: { status?: unknown; code?: unknown; type?: unknown; error?: unknown } | undefined;
  for (let current: unknown = error; current && typeof current === "object"; current = (current as { cause?: unknown }).cause) {
    if (typeof (current as { status?: unknown }).status === "number") { api = current as typeof api; break; }
  }
  const metadata = (api?.error as { metadata?: { raw?: unknown; provider_name?: unknown } } | undefined)?.metadata;
  const upstream = upstreamMessage(metadata?.raw);
  const providerName = typeof metadata?.provider_name === "string" ? metadata.provider_name : null;
  const message = error instanceof Error ? error.message : "OpenRouter request failed";
  return {
    error: upstream ? `${message} — ${providerName ? `${providerName}: ` : ""}${upstream}` : message,
    ...(typeof api?.status === "number" ? { status: api.status } : {}),
    ...(typeof api?.code === "string" ? { code: api.code } : {}),
    ...(typeof api?.type === "string" ? { type: api.type } : {}),
    ...(metadata ? { upstream: metadata } : {}),
  };
}

/** `raw` is usually the provider's JSON error body; pull its message out. */
function upstreamMessage(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const body = JSON.parse(raw) as { error?: { message?: unknown } | string; message?: unknown };
    const found = typeof body.error === "string" ? body.error : body.error?.message ?? body.message;
    if (typeof found === "string" && found.trim()) return found.trim();
  } catch {
    // not JSON; use it as it is
  }
  return raw.trim().slice(0, 500);
}

/**
 * OpenRouter's web plugin defaults to the provider's own search. On Gemini
 * that is Google Search grounding, a built-in tool the model may decline to
 * call (rows came back answered from memory, with no citations), and which
 * Google refuses outright beside function calling — the structured path —
 * with "enable tool_config.include_server_side_tool_invocations". Exa runs
 * the search on OpenRouter's side before the model sees the prompt: every
 * row is searched, citations come back, and structured output still works.
 */
function webPlugins(config: { useCase: string }, modelId: string) {
  if (config.useCase !== "web-research") return undefined;
  return [modelId.startsWith("google/") ? { id: "web", engine: "exa" } : { id: "web" }];
}

/**
 * The text runner for one provider's AI columns. Both providers go through
 * getAiRuntime, so the column runs on the connection AI Settings selected;
 * a column saved for the other provider is refused in runners/ai.ts first.
 */
function chatRunner(providerKey: AiProviderKey): AiRunner {
  return async ({ config, model, prompt, schema, examples, timeoutMs, signal }) => {
    let auditRequest: unknown;
    const upstream = providerKey === AIML_PROVIDER_KEY ? AIML_PROVIDER_KEY : config.upstreamProvider;
    try {
      if (!upstream) throw new PermanentRunError("Re-save this AI column with an OpenRouter provider");
      if (providerKey === AIML_PROVIDER_KEY && config.useCase !== "content") {
        throw new PermanentRunError(`${AIML_PROVIDER_NAME} columns can create or modify content only; web research and images need an OpenRouter connection`);
      }
      const requestedModel = { provider: upstream, modelId: model.modelId };
      if (schema) {
        const system = ["You are filling in one row of a spreadsheet.", ...examples.map((example) => `Example input:\n${example.input}\nExpected response:\n${example.response}`)].join("\n\n");
        const result = await completeStructured({
          requestedModel,
          timeoutMs,
          systemPrompt: system,
          userPrompt: prompt,
          maxOutputTokens: config.maxTokens ?? model.maxOutputTokens ?? 16000,
          jsonSchema: schema,
          schemaName: "fill_row",
          plugins: webPlugins(config, model.modelId),
          onRequest: (request) => { auditRequest = request; },
          signal,
        });
        auditRequest = result.request;
        return { value: JSON.parse(result.text), usage: result.usage, raw: result.response, request: result.request };
      }
      const runtime = await getAiRuntime(requestedModel, timeoutMs);
      const system = ["You are filling in one row of a spreadsheet.", "Respond with the answer only — no preamble.", ...examples.map((example) => `Example input:\n${example.input}\nExpected response:\n${example.response}`)].join("\n\n");
      const tokenLimit = openRouterTokenLimit(model.modelId, config.maxTokens ?? model.maxOutputTokens ?? 16000);
      const plugins = runtime.supportsPlugins ? webPlugins(config, model.modelId) : undefined;
      const request = { model: model.modelId, messages: [{ role: "system", content: system }, { role: "user", content: prompt }], ...tokenLimit, ...runtime.routing, ...(plugins ? { plugins } : {}) };
      auditRequest = request;
      const response = await runtime.client.chat.completions.create(request as never, { signal });
      const text = response.choices[0]?.message.content?.trim() ?? "";
      return { value: text, usage: { inputTokens: response.usage?.prompt_tokens, outputTokens: response.usage?.completion_tokens }, raw: response, request };
    } catch (error) {
      if (error instanceof PermanentRunError && error.audit) throw error;
      const response = auditError(error);
      const audit = {
        provider: aiProviderLabel(providerKey, upstream, model.key),
        request: auditRequest,
        response,
      };
      // A rate limit, a 5xx or a timeout is the provider's moment, not the
      // user's config — let the queue back off and retry it.
      if (isTransientOpenRouterError(error)) throw new RetryableRunError(response.error, audit);
      throw new PermanentRunError(response.error, audit);
    }
  };
}

export const runOpenRouter: AiRunner = chatRunner("openrouter");
export const runAimlApi: AiRunner = chatRunner(AIML_PROVIDER_KEY);

export const runOpenRouterImage: AiRunner = async ({ config, model, prompt, timeoutMs, signal }) => {
  let auditRequest: unknown;
  try {
    if (!config.upstreamProvider) throw new PermanentRunError("Re-save this AI column with an OpenRouter provider");
    const { apiKey, providerKey } = await getAiRuntime(
      { provider: config.upstreamProvider, modelId: model.modelId },
      timeoutMs,
    );
    if (providerKey !== "openrouter") throw new PermanentRunError("Image columns need an OpenRouter connection in AI Settings");
    const provider = strictImageProviderRouting(config.upstreamProvider);
    const request = { model: model.modelId, prompt, n: 1, provider };
    auditRequest = request;
    const response = await generateOpenRouterImage({
      apiKey,
      model: model.modelId,
      prompt,
      provider,
      timeoutMs,
      signal,
    });
    const image = response.data?.[0];
    if (!image?.b64_json) throw new PermanentRunError("The model returned no image");
    const mediaType = image.media_type?.startsWith("image/") ? image.media_type : "image/png";
    return {
      value: `data:${mediaType};base64,${image.b64_json}`,
      usage: {
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
      },
      raw: response,
      request,
    };
  } catch (error) {
    if (error instanceof PermanentRunError && error.audit) throw error;
    const response = auditError(error);
    const audit = {
      provider: aiProviderLabel("openrouter", config.upstreamProvider, model.key),
      request: auditRequest,
      response,
    };
    // A rate limit, a 5xx or a timeout is the provider's moment, not the
    // user's config — let the queue back off and retry it.
    if (isTransientOpenRouterError(error)) throw new RetryableRunError(response.error, audit);
    throw new PermanentRunError(response.error, audit);
  }
};

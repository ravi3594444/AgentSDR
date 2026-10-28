import "server-only";

import { AIML_PROVIDER_KEY } from "@/lib/ai/aimlapi-types";
import { claudeCodeBinding } from "@/lib/ai/claudeCode/engine.server";
import { ANTHROPIC_ENGINE_KEY } from "@/lib/ai/runtimePlan";
import { listAimlModelsCached } from "./aimlapi";
import { openRouterModelInputs } from "./openrouter";
import { getAiRuntime } from "./runtime";

export type VisionSupport = { supported: boolean; detail: string };

/**
 * Whether completeStructured's model, as this organization selected it,
 * can be given an image (a screenshot of the owner's browser). Read from
 * the provider's own catalog: OpenRouter's input modalities, AI/ML API's
 * `vision` tag; every Claude model on the Anthropic API takes images. A
 * Claude Code structured generation here takes text only. When it cannot
 * be told, the answer is no: the screen tools then say so plainly, and the
 * chat never switches to another (or a paid) model to see.
 */
export async function structuredVision(): Promise<VisionSupport> {
  try {
    if (await claudeCodeBinding()) return { supported: false, detail: "this chat's AI runs on Claude Code's text-only structured answers here, so it cannot be shown a screenshot" };
    const runtime = await getAiRuntime(undefined, 10_000);
    const model = runtime.selection.modelId;
    if (runtime.providerKey === ANTHROPIC_ENGINE_KEY) return { supported: true, detail: `${model} sees images` };
    if (runtime.providerKey === AIML_PROVIDER_KEY) {
      const entry = (await listAimlModelsCached()).find((item) => item.id === model);
      return entry?.capabilities.includes("vision")
        ? { supported: true, detail: `${model} sees images` }
        : { supported: false, detail: `the selected AI model (${model}) does not take images${entry ? "" : " (it is not in AI/ML API's catalog)"}` };
    }
    const inputs = await openRouterModelInputs(model);
    return inputs?.includes("image")
      ? { supported: true, detail: `${model} sees images` }
      : { supported: false, detail: `the selected AI model (${model}) does not take images${inputs ? "" : " (it is not in OpenRouter's catalog)"}` };
  } catch {
    return { supported: false, detail: "whether the selected AI model takes images could not be checked just now" };
  }
}

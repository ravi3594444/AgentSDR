import { NextRequest, NextResponse } from "next/server";
import { getByokSettings, saveByokSettings } from "@/lib/ai/byok";
import { normalizeByokSettings } from "@/lib/ai/openrouter-types";
import { getAiConnection, getAiCredentials } from "@/lib/ai/connections";
import { listOpenRouterByokCatalog } from "@/lib/ai/server/openrouter";
import { listAimlModels } from "@/lib/ai/server/aimlapi";
import { AIML_PROVIDER_KEY, AIML_PROVIDER_NAME } from "@/lib/ai/aimlapi-types";
import { authContextErrorResponse, requirePermission, withOrgContext } from "@/lib/auth/context";

export async function GET(request: NextRequest) {
  try {
    return await withOrgContext(request, async () => {
      return NextResponse.json(await getByokSettings());
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
export async function PUT(req: NextRequest) {
  try {
    return await withOrgContext(req, async (ctx) => {
      requirePermission(ctx, { integrations: ["manage"] });
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== "object") {
        return NextResponse.json({ error: "Invalid settings" }, { status: 400 });
      }
      const settings = normalizeByokSettings(body);
      // AI/ML API: one key and its catalog; none of OpenRouter's BYOK rules below apply.
      const selected = settings.connectionId ? await getAiConnection(settings.connectionId) : null;
      if (selected?.providerKey === AIML_PROVIDER_KEY) {
        return await saveAimlSettings(settings, selected.verified);
      }
      if (settings.providers.length && !settings.connectionId) {
        return NextResponse.json({ error: "Connect OpenRouter before selecting providers" }, { status: 400 });
      }
      if (settings.providers.length && !settings.byokOnlyConfirmed) {
        return NextResponse.json({ error: "Confirm BYOK-only routing before saving" }, { status: 400 });
      }
      if (settings.connectionId) {
        const connection = await getAiConnection(settings.connectionId);
        if (!connection?.verified || connection.providerKey !== "openrouter") {
          return NextResponse.json({ error: "Select a verified OpenRouter connection" }, { status: 400 });
        }
        if (settings.providers.length) {
          const credentials = await getAiCredentials(connection.id);
          if (!credentials?.apiKey || !credentials.managementKey) {
            return NextResponse.json({ error: "Reconnect OpenRouter before saving" }, { status: 400 });
          }
          try {
            const catalog = await listOpenRouterByokCatalog(credentials.managementKey);
            const available = new Map(catalog.map((provider) => [provider.slug, new Set(provider.models.map((model) => model.id))]));
            for (const provider of settings.providers) {
              const models = available.get(provider);
              if (!models) return NextResponse.json({ error: `${provider} has no active BYOK credential` }, { status: 400 });
              if (settings.modelsByProvider[provider].some((model) => !models.has(model))) {
                return NextResponse.json({ error: `One or more selected ${provider} models are no longer available through BYOK` }, { status: 400 });
              }
            }
            if (settings.defaultModel) {
              const defaultProvider = catalog.find((provider) => provider.slug === settings.defaultModel?.provider);
              const defaultModel = defaultProvider?.models.find((model) => model.id === settings.defaultModel?.modelId);
              if (
                !defaultModel?.outputModalities?.includes("text")
                || !defaultModel.supportedParameters?.includes("tools")
              ) {
                return NextResponse.json({ error: "The default model must support function calling" }, { status: 400 });
              }
            }
          } catch (error) {
            return NextResponse.json({ error: error instanceof Error ? error.message : "Could not validate OpenRouter BYOK settings" }, { status: 502 });
          }
        }
      }
      if (settings.providers.some((provider) => !(settings.modelsByProvider[provider]?.length))) {
        return NextResponse.json({ error: "Select at least one model for every enabled provider" }, { status: 400 });
      }
      if (settings.providers.length && !settings.defaultModel) {
        return NextResponse.json({ error: "Choose a default model" }, { status: 400 });
      }
      // Web research runs through AI/ML API's search models only in this release.
      return NextResponse.json(await saveByokSettings({ ...settings, researchModel: null }));
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

/**
 * AI/ML API settings: the selected models must still be structured-output
 * chat models in its live catalog, and one of them is the default. There is
 * no management key, BYOK provider list or shared-capacity confirmation.
 * Transcription stays off: audio has not been checked against AI/ML API.
 */
async function saveAimlSettings(settings: ReturnType<typeof normalizeByokSettings>, verified: boolean) {
  if (!verified) return NextResponse.json({ error: `Reconnect ${AIML_PROVIDER_NAME} before saving` }, { status: 400 });
  if (settings.providers.some((provider) => provider !== AIML_PROVIDER_KEY)) {
    return NextResponse.json({ error: `Only ${AIML_PROVIDER_NAME} models can be selected for this connection` }, { status: 400 });
  }
  if (settings.transcriptionModel) {
    return NextResponse.json({ error: `Call transcription is not available with ${AIML_PROVIDER_NAME} yet; leave it off` }, { status: 400 });
  }
  const models = settings.modelsByProvider[AIML_PROVIDER_KEY] ?? [];
  if (settings.providers.length && !models.length) {
    return NextResponse.json({ error: "Select at least one model" }, { status: 400 });
  }
  if (models.length) {
    let catalog: Awaited<ReturnType<typeof listAimlModels>>;
    try {
      catalog = await listAimlModels();
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : `Could not load the ${AIML_PROVIDER_NAME} model list` }, { status: 502 });
    }
    const available = new Set(catalog.map((model) => model.id));
    const missing = models.filter((model) => !available.has(model));
    if (missing.length) {
      return NextResponse.json({ error: `Not offered with structured output by ${AIML_PROVIDER_NAME}: ${missing.slice(0, 5).join(", ")}` }, { status: 400 });
    }
    if (!settings.defaultModel) return NextResponse.json({ error: "Choose a default model" }, { status: 400 });
    if (settings.researchModel) {
      const research = catalog.find((model) => model.id === settings.researchModel?.modelId);
      if (!research?.capabilities.includes("web_search")) {
        return NextResponse.json({ error: `${settings.researchModel.modelId} does not search the web on ${AIML_PROVIDER_NAME}; choose a model marked Web search for research` }, { status: 400 });
      }
    }
  }
  // Routing confirmation is an OpenRouter concept; never carry a stale one over.
  return NextResponse.json(await saveByokSettings({ ...settings, byokOnlyConfirmed: false }));
}

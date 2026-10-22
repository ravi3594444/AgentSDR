import { NextRequest, NextResponse } from "next/server";
import { listOpenRouterByokCatalog, listOpenRouterByokCatalogCached } from "@/lib/ai/server/openrouter";
import { listAimlModels, listAimlModelsCached } from "@/lib/ai/server/aimlapi";
import { AIML_PROVIDER_KEY, AIML_PROVIDER_NAME } from "@/lib/ai/aimlapi-types";
import { getOwnByokSettings, isManagedAiConnectionId } from "@/lib/ai/byok";
import { getAiConnection, getAiCredentials } from "@/lib/ai/connections";
import { authContextErrorResponse, withOrgContext } from "@/lib/auth/context";
import { isDemoMode } from "@/lib/demo/mode";
import { DEMO_OPENROUTER_CATALOG } from "@/lib/demo/openrouterCatalog";

export async function GET(request: NextRequest) {
  try {
    return await withOrgContext(request, async () => {
      try {
        // The workspace's own connection and settings only: the Included engine's catalog is never listed.
        const settings = await getOwnByokSettings();
        const connectionId = request.nextUrl.searchParams.get("connectionId") ?? settings.connectionId;
        if (!connectionId || isManagedAiConnectionId(connectionId)) return NextResponse.json({ providerKey: null, providers: [], models: [], settings });
        const connection = await getAiConnection(connectionId);
        if (connection?.providerKey === AIML_PROVIDER_KEY) {
          if (!connection.verified) return NextResponse.json({ error: `Reconnect ${AIML_PROVIDER_NAME} in AI Settings` }, { status: 409 });
          // Same shape as OpenRouter's, as one "provider" holding every
          // structured-output chat model, so the column dialog needs no branch.
          const models = request.nextUrl.searchParams.has("all") ? await listAimlModels() : await listAimlModelsCached();
          const selected = new Set(settings.connectionId === connection.id ? settings.modelsByProvider[AIML_PROVIDER_KEY] ?? [] : []);
          const provider = {
            slug: AIML_PROVIDER_KEY,
            name: AIML_PROVIDER_NAME,
            credentialCount: 1,
            prioritizedCredentialCount: 1,
            fallbackCredentialCount: 0,
            discoveredModelCount: models.length,
            modelFilterRestricted: false,
            allowedModelCount: 0,
            unmatchedAllowedModels: [],
            models: models.map((model) => ({ ...model, supportedParameters: model.capabilities })),
          };
          const enabled = provider.models
            .filter((model) => selected.has(model.id))
            .map((model) => ({ ...model, provider: AIML_PROVIDER_KEY, providerName: AIML_PROVIDER_NAME }));
          return NextResponse.json({ providerKey: AIML_PROVIDER_KEY, providers: [provider], models: enabled, settings });
        }
        const credentials = connection?.verified ? await getAiCredentials(connection.id) : null;
        if (!connection || connection.providerKey !== "openrouter" || !credentials?.apiKey || !credentials.managementKey) {
          return NextResponse.json({ error: "Reconnect OpenRouter in AI Settings" }, { status: 409 });
        }
        // AI Settings (?all=1) must see a key added on OpenRouter right away;
        // the column dialog's picker can take the cached catalog. The public
        // demo's keys are placeholders: it shows a fixed catalog instead.
        const providers = isDemoMode()
          ? DEMO_OPENROUTER_CATALOG
          : request.nextUrl.searchParams.has("all")
          ? await listOpenRouterByokCatalog(credentials.managementKey)
          : await listOpenRouterByokCatalogCached(credentials.managementKey);
        const enabled = providers.flatMap((provider) => {
          const selected = new Set(settings.modelsByProvider[provider.slug] ?? []);
          return provider.models
            .filter((model) => settings.providers.includes(provider.slug) && selected.has(model.id))
            .map((model) => ({ ...model, provider: provider.slug, providerName: provider.name }));
        });
        return NextResponse.json({ providerKey: "openrouter", providers, models: enabled, settings });
      } catch (error) {
        return NextResponse.json({ error: error instanceof Error ? error.message : "Could not fetch AI models" }, { status: 502 });
      }
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

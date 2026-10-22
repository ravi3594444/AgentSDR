import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { gridProviders } from "@/lib/grid/schema";
import { normalizeByokSettings, RESEARCH_DAILY_LIMIT_DEFAULT, type ByokSettings } from "./openrouter-types";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import type { ManagedAiSettings } from "@/lib/managed/catalog";
import { serviceMode } from "@/lib/managed/modes.server";
import { getManagedAiSettings } from "@/lib/managed/store.server";

const KEY = "openrouter-byok-settings";
const empty: ByokSettings = {
  connectionId: null,
  providers: [],
  modelsByProvider: {},
  defaultModel: null,
  transcriptionModel: null,
  researchModel: null,
  researchDailyLimit: RESEARCH_DAILY_LIMIT_DEFAULT,
  byokOnlyConfirmed: false,
};

/**
 * The connection id the Included AI engine answers to (connections.ts). Not a
 * row id: it resolves only for an organization on the Included service.
 */
export const MANAGED_AI_CONNECTION_ID = "included-ai";

export function isManagedAiConnectionId(id: string | null | undefined): boolean {
  return id === MANAGED_AI_CONNECTION_ID;
}

/** The organization's own saved AI settings (My own provider). The settings pages read and write these. */
export async function getOwnByokSettings(): Promise<ByokSettings> {
  const [row] = await db
    .select({ config: gridProviders.config })
    .from(gridProviders)
    .where(and(inOrg(gridProviders), eq(gridProviders.key, KEY)))
    .limit(1);
  return row ? normalizeByokSettings(row.config) : empty;
}

/** The Included engine's settings, shaped like an organization's own so every gate reads them the same way. */
export function managedByokSettings(managed: ManagedAiSettings): ByokSettings {
  if (!managed.engine || managed.engine === "claude-code" || !managed.defaultModel) return empty;
  const selections = [managed.defaultModel, managed.researchModel, managed.transcriptionModel].filter((selection): selection is NonNullable<typeof selection> => Boolean(selection));
  const modelsByProvider: Record<string, string[]> = {};
  for (const selection of selections) modelsByProvider[selection.provider] = [...new Set([...(modelsByProvider[selection.provider] ?? []), selection.modelId])];
  return {
    connectionId: MANAGED_AI_CONNECTION_ID,
    providers: Object.keys(modelsByProvider),
    modelsByProvider,
    defaultModel: managed.defaultModel,
    transcriptionModel: managed.engine === "openrouter" ? managed.transcriptionModel : null,
    researchModel: managed.engine === "aimlapi" ? managed.researchModel : null,
    researchDailyLimit: RESEARCH_DAILY_LIMIT_DEFAULT,
    byokOnlyConfirmed: managed.engine === "openrouter" ? managed.byokOnlyConfirmed : false,
  };
}

/**
 * The AI settings every model call and gate uses: the Included engine's for
 * an organization on the Included service, its own otherwise. Server-only,
 * and never returned to the browser for an Included organization: the
 * settings routes read getOwnByokSettings instead.
 */
export async function getByokSettings(): Promise<ByokSettings> {
  if ((await serviceMode("ai")) === "managed") return managedByokSettings(await getManagedAiSettings());
  return getOwnByokSettings();
}

export async function saveByokSettings(input: ByokSettings): Promise<ByokSettings> {
  const value = normalizeByokSettings(input);
  if (isManagedAiConnectionId(value.connectionId)) throw new Error("Choose one of this workspace's own AI connections");
  await db
    .insert(gridProviders)
    .values({ organizationId: currentOrganizationId(), key: KEY, name: "OpenRouter BYOK settings", config: value, enabled: true })
    .onConflictDoUpdate({
      target: [gridProviders.organizationId, gridProviders.key],
      set: { config: value, updatedAt: new Date() },
    });
  return value;
}

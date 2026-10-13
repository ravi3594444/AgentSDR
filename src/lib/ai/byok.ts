import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { gridProviders } from "@/lib/grid/schema";
import { normalizeByokSettings, RESEARCH_DAILY_LIMIT_DEFAULT, type ByokSettings } from "./openrouter-types";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";

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

export async function getByokSettings(): Promise<ByokSettings> {
  const [row] = await db
    .select({ config: gridProviders.config })
    .from(gridProviders)
    .where(and(inOrg(gridProviders), eq(gridProviders.key, KEY)))
    .limit(1);
  return row ? normalizeByokSettings(row.config) : empty;
}

export async function saveByokSettings(input: ByokSettings): Promise<ByokSettings> {
  const value = normalizeByokSettings(input);
  await db
    .insert(gridProviders)
    .values({ organizationId: currentOrganizationId(), key: KEY, name: "OpenRouter BYOK settings", config: value, enabled: true })
    .onConflictDoUpdate({
      target: [gridProviders.organizationId, gridProviders.key],
      set: { config: value, updatedAt: new Date() },
    });
  return value;
}

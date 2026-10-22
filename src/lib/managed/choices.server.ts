import "server-only";

import { allowanceFor, workspaceAllowances, type WorkspaceAllowanceView } from "./usage.server";
import { ALLOWANCE_KEYS } from "./allowances";
import { MANAGED_SERVICE_INFO, MANAGED_SERVICES, type ManagedService, type ServiceMode } from "./catalog";
import { allServiceModes, hasOwnCredentials } from "./modes.server";
import { getManagedAiSettings, storedPlatformCredentialKeys } from "./store.server";
import { MANAGED_UNIPILE_ENABLED } from "@/lib/platform/credentials";

/**
 * What a workspace's settings show about its providers: per service the
 * choice (Included service or My own provider), whether the Included service
 * is available right now, whether the workspace saved credentials of its
 * own, and the allowances left. Never which keys, engines or models the
 * platform uses.
 */

export type ServiceChoice = {
  service: ManagedService;
  label: string;
  description: string;
  mode: ServiceMode;
  /** The workspace chose explicitly (or the migration recorded it); false: the default. */
  explicit: boolean;
  /** The Included service can run right now. */
  includedAvailable: boolean;
  /** Included is not offered for this service yet on this server (Unipile before account ownership). */
  includedOffered: boolean;
  ownSaved: boolean;
  ownSettingsHref: string;
  ownSettingsLabel: string;
};

/** Whether the platform can serve each service now: its key stored (AI: its engine chosen and that key stored). */
async function includedAvailability(): Promise<Record<ManagedService, boolean>> {
  const stored = await storedPlatformCredentialKeys();
  const ai = await getManagedAiSettings();
  return {
    ai: Boolean(ai.engine && ai.defaultModel && stored.has(ai.engine)),
    unipile: stored.has("unipile"),
    tinyfish: stored.has("tinyfish"),
    tavily: stored.has("tavily"),
    brightdata: stored.has("brightdata"),
    apify: stored.has("apify"),
  };
}

export async function serviceChoices(): Promise<ServiceChoice[]> {
  const [modes, available] = await Promise.all([allServiceModes(), includedAvailability()]);
  // Unipile is offered as Included only once account ownership is on (src/lib/platform/credentials.ts).
  const unipileOffered = MANAGED_UNIPILE_ENABLED;
  const choices: ServiceChoice[] = [];
  for (const service of MANAGED_SERVICES) {
    const info = MANAGED_SERVICE_INFO[service];
    const offered = service === "unipile" ? unipileOffered : true;
    choices.push({
      service,
      label: info.label,
      description: info.description,
      mode: offered ? modes[service].mode : "own",
      explicit: modes[service].explicit,
      includedAvailable: offered && available[service],
      includedOffered: offered,
      ownSaved: await hasOwnCredentials(service),
      ownSettingsHref: info.ownSettingsHref,
      ownSettingsLabel: info.ownSettingsLabel,
    });
  }
  return choices;
}

export type PlanUsage = { choices: ServiceChoice[]; allowances: WorkspaceAllowanceView[] };

/** Settings → Plan & usage: the choices, and the allowances of the services the workspace takes as Included. */
export async function planUsage(): Promise<PlanUsage> {
  const choices = await serviceChoices();
  const included = new Set(choices.filter((choice) => choice.mode === "managed").map((choice) => choice.service));
  const keys = ALLOWANCE_KEYS.filter((key) => included.has(allowanceFor(key).service));
  return { choices, allowances: await workspaceAllowances(keys) };
}

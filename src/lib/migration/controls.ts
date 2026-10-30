/**
 * Operational kill switches used during the unified-People cutover.
 *
 * PEOPLE_MIGRATION_MODE is the master switch: it pauses every background
 * writer/outbound path below and blocks user-triggered campaign mutations,
 * while deliberately leaving inbound webhook routes available.
 *
 * The narrower PAUSE_* switches are useful for canary resume. Environment
 * values are read for every invocation instead of once at module load so
 * tests and runtimes with refreshable environment configuration see the
 * current value.
 */

type Environment = Record<string, string | undefined>;

export type MigrationControl =
  | "emailOutbound"
  | "linkedinOutbound"
  | "whatsappOutbound"
  | "instagramOutbound"
  | "browserOutbound"
  | "linkedinResolution"
  | "linkedinSearch"
  | "gridWorker";

const CONTROL_ENV: Record<MigrationControl, string> = {
  emailOutbound: "PAUSE_EMAIL_OUTBOUND",
  linkedinOutbound: "PAUSE_LINKEDIN_OUTBOUND",
  whatsappOutbound: "PAUSE_WHATSAPP_OUTBOUND",
  instagramOutbound: "PAUSE_INSTAGRAM_OUTBOUND",
  browserOutbound: "PAUSE_BROWSER_OUTBOUND",
  linkedinResolution: "PAUSE_LINKEDIN_RESOLUTION",
  linkedinSearch: "PAUSE_LINKEDIN_SEARCH",
  gridWorker: "PAUSE_GRID_WORKER",
};

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

export function enabled(value: string | undefined): boolean {
  return TRUE_VALUES.has(value?.trim().toLowerCase() ?? "");
}

export function isPeopleMigrationMode(env: Environment = process.env): boolean {
  return enabled(env.PEOPLE_MIGRATION_MODE);
}

export function isMigrationControlPaused(
  control: MigrationControl,
  env: Environment = process.env,
): boolean {
  return isPeopleMigrationMode(env) || enabled(env[CONTROL_ENV[control]]);
}

const BLOCKED_MUTATION_PREFIXES = [
  "/api/grid/tables/", // enrichment runs and grid-to-campaign enrollment
  "/api/linkedin/campaigns",
  "/api/linkedin/jobs",
  "/api/linkedin/leads",
  "/api/linkedin/messages/send",
  "/api/linkedin/search",
  "/api/outreach/campaigns",
  "/api/outreach/inbox/", // manual Email replies and draft approvals
  "/api/outreach/mailboxes/", // mailbox edits and test sends
] as const;

/**
 * Returns why a request must be rejected during migration mode, or null when
 * it is safe. Webhook and unsubscribe endpoints are intentionally absent.
 */
export function migrationMutationBlockReason(
  pathname: string,
  method: string,
  env: Environment = process.env,
): string | null {
  if (!isPeopleMigrationMode(env) && !enabled(env.PAUSE_CAMPAIGN_MUTATIONS)) return null;
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase())) return null;
  if (!BLOCKED_MUTATION_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return null;
  return "Unified People migration is in progress; campaign and outbound changes are temporarily paused.";
}

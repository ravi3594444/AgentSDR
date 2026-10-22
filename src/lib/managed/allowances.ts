/**
 * Allowances for Included services: what one workspace may use of the
 * platform's credentials each month, and the platform-wide budget all
 * Included workspaces share. One default set, declared once here in the
 * style of src/lib/channels/rules.ts; there are no per-workspace plans (a
 * decision recorded in docs/plans/MANAGED_SAAS_IMPLEMENTATION_2026-10-22.md
 * for the owner to confirm or widen).
 *
 * They apply only to Included use. A workspace on My own provider is bound by
 * its own settings and its provider's own limits, as before; its use is
 * still recorded (credential_source = 'own') but never counted here.
 *
 * Enforced at reservation time under a platform-wide advisory lock per
 * allowance (usage.server.ts), inside the same transaction that records the
 * use, so concurrent jobs cannot pass either limit. Months are calendar
 * months in UTC.
 *
 * The request research-spend cap (an objective's spendCapUsd, the Sending
 * rule objectiveSpendUsd) is separate and keeps its meaning: one request's
 * paid research, whoever's key pays for it.
 *
 * Client-safe: no database or server imports.
 */

import type { ManagedService } from "./catalog";

export type AllowanceUnit = "usd" | "requests" | "urls" | "credits" | "accounts";

export type AllowanceKey =
  | "ai_usd"
  | "tinyfish_search"
  | "tinyfish_fetch"
  | "tavily_search"
  | "brightdata_credits"
  | "apify_usd"
  | "unipile_linkedin"
  | "unipile_whatsapp"
  | "unipile_instagram"
  | "unipile_email";

export type Allowance = {
  key: AllowanceKey;
  service: ManagedService;
  label: string;
  unit: AllowanceUnit;
  /** month: resets on the 1st, 00:00 UTC. none: a standing count (connected accounts). */
  period: "month" | "none";
  /** What one workspace may use in a period. */
  workspace: number;
  /** What all Included workspaces together may use in a period. */
  platform: number;
  /** The figure is AgentSDR's own count or estimate, not the provider's bill. */
  estimated: boolean;
};

export const ALLOWANCES: Record<AllowanceKey, Allowance> = {
  ai_usd: { key: "ai_usd", service: "ai", label: "AI usage", unit: "usd", period: "month", workspace: 10, platform: 300, estimated: true },
  tinyfish_search: { key: "tinyfish_search", service: "tinyfish", label: "Web searches", unit: "requests", period: "month", workspace: 600, platform: 12_000, estimated: false },
  tinyfish_fetch: { key: "tinyfish_fetch", service: "tinyfish", label: "Pages read", unit: "urls", period: "month", workspace: 1_500, platform: 30_000, estimated: false },
  tavily_search: { key: "tavily_search", service: "tavily", label: "Website searches", unit: "requests", period: "month", workspace: 150, platform: 3_000, estimated: false },
  brightdata_credits: { key: "brightdata_credits", service: "brightdata", label: "Social research records", unit: "credits", period: "month", workspace: 500, platform: 10_000, estimated: true },
  apify_usd: { key: "apify_usd", service: "apify", label: "Maps and Instagram discovery", unit: "usd", period: "month", workspace: 5, platform: 100, estimated: false },
  unipile_linkedin: { key: "unipile_linkedin", service: "unipile", label: "LinkedIn accounts", unit: "accounts", period: "none", workspace: 2, platform: 400, estimated: false },
  unipile_whatsapp: { key: "unipile_whatsapp", service: "unipile", label: "WhatsApp numbers", unit: "accounts", period: "none", workspace: 2, platform: 400, estimated: false },
  unipile_instagram: { key: "unipile_instagram", service: "unipile", label: "Instagram accounts", unit: "accounts", period: "none", workspace: 2, platform: 400, estimated: false },
  unipile_email: { key: "unipile_email", service: "unipile", label: "Email inboxes", unit: "accounts", period: "none", workspace: 3, platform: 600, estimated: false },
};

export const ALLOWANCE_KEYS = Object.keys(ALLOWANCES) as AllowanceKey[];

/**
 * Fixed limits of Included use that are not monthly allowances: how one run
 * may spend, and features kept off on the platform's account.
 */
export const MANAGED_LIMITS = {
  /** AI: what one model call reserves before it runs; settled to its reported or estimated cost. */
  aiReservePerCallUsd: 0.05,
  /** Apify: the most one run may charge, and its results, on the platform's token. */
  apifyMaxChargePerRunUsd: 1,
  apifyMaxResultsPerRun: 100,
  /** Bright Data: the most records one research job may collect. */
  brightdataMaxRecordsPerSearch: 60,
  /** TinyFish's metered browser stays off on the platform's key. */
  tinyfishBrowserMinutesPerDay: 0,
  /** Tavily: searches a day per workspace, beside the monthly allowance. */
  tavilyDailySearches: 50,
} as const;

/** The Unipile account allowance for a channel. */
export const UNIPILE_ACCOUNT_ALLOWANCE: Record<"linkedin" | "whatsapp" | "instagram" | "email", AllowanceKey> = {
  linkedin: "unipile_linkedin",
  whatsapp: "unipile_whatsapp",
  instagram: "unipile_instagram",
  email: "unipile_email",
};

/** The start of the UTC month containing `now`. */
export function periodStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** When the month's allowance resets: the 1st of next month, 00:00 UTC. */
export function periodReset(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/**
 * Whether `amount` more fits under both limits, given what the workspace and
 * the platform already used (reserved counts in full). Pure; the server
 * calls it with the sums it read under the lock.
 */
export function allowanceDecision(
  allowance: Pick<Allowance, "label" | "workspace" | "platform" | "unit" | "period">,
  used: { workspace: number; platform: number },
  amount: number,
  now = new Date(),
): { ok: true } | { ok: false; scope: "workspace" | "platform"; reason: string; resetsAt: Date | null } {
  const resetsAt = allowance.period === "month" ? periodReset(now) : null;
  const when = resetsAt ? ` It resets on ${resetsAt.toISOString().slice(0, 10)}.` : "";
  const amountText = (value: number) => formatAllowanceAmount(value, allowance.unit);
  if (used.workspace + amount > allowance.workspace) {
    return {
      ok: false,
      scope: "workspace",
      reason: `This workspace's Included allowance for ${allowance.label} is used up (${allowance.unit === "usd" ? amountText(used.workspace) : Math.round(used.workspace).toLocaleString("en-US")} of ${amountText(allowance.workspace)}${allowance.period === "month" ? " this month" : ""}).${when}`,
      resetsAt,
    };
  }
  if (used.platform + amount > allowance.platform) {
    return {
      ok: false,
      scope: "platform",
      reason: `The Included service has no room for more ${allowance.label} right now.${when}`,
      resetsAt,
    };
  }
  return { ok: true };
}

/** "$1.25", "120 requests", "3 accounts". */
export function formatAllowanceAmount(value: number, unit: AllowanceUnit): string {
  if (unit === "usd") return `$${(Math.round(value * 100) / 100).toFixed(2)}`;
  const rounded = Math.round(value);
  const word = { requests: "request", urls: "page", credits: "credit", accounts: "account" }[unit];
  return `${rounded.toLocaleString("en-US")} ${word}${rounded === 1 ? "" : "s"}`;
}

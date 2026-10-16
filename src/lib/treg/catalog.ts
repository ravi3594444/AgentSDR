/**
 * Treg (treg.to), "OpenRouter for agent tools": one key for thousands of
 * paid API endpoints (lead and company enrichment, email find and verify,
 * Google Maps and web search, social profiles). A beta source, off until an
 * owner turns on the "Treg tools" optional feature and saves a key.
 *
 * Protocol (https://treg.to/llms.txt, read 2026-10-16): the catalog is
 * public (GET /catalog/search, /catalog/endpoints/{id}); a call goes to
 * /call/{endpoint id} with the `X-Treg-Token` header, is billed per call to
 * the team's prepaid balance, and reports its price in `X-Treg-Cost-Micro`.
 * Out of balance is HTTP 402.
 *
 * Pure and client-safe: parsing, the id rule and the spending rules, so
 * each is unit-tested. treg.server.ts makes the calls.
 */

export const TREG_BASE_URL = "https://treg.to";

/** Spending rules (per organization; the daily cap is the owner's setting). */
export const TREG_LIMITS = {
  /** Default daily spend cap in USD. */
  defaultDailyCapUsd: 2,
  maxDailyCapUsd: 100,
  /** An endpoint costing more than this per call is refused (bulk exports, video generation). */
  maxUsdPerCall: 0.25,
  /** What the model reads of one result. */
  maxResultChars: 6_000,
} as const;

/** One catalog endpoint, as the assistant sees it. */
export type TregEndpoint = {
  id: string;
  summary: string;
  method: string;
  /** Price per call in USD; null when Treg publishes none (such a call is refused). */
  usd: number | null;
  /** Billed only on a hit, or on every call. */
  billing: "per_success" | "per_call" | "unknown";
  /** Parameters by name, with whether each is required. */
  params: { name: string; required: boolean; where: "query" | "body" }[];
};

/**
 * Only catalog endpoint ids ("treg.people.email.find",
 * "tikhub.tiktok.user.profile"): never a URL, so a call cannot reach an
 * arbitrary host or a tool another Treg team registered.
 */
export function isCatalogId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 120 && /^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)+$/i.test(value);
}

function paramsOf(input: unknown): TregEndpoint["params"] {
  if (!input || typeof input !== "object") return [];
  const node = input as { body?: unknown; query?: unknown; params?: unknown };
  const out: TregEndpoint["params"] = [];
  for (const [where, group] of [["body", node.body], ["query", node.query ?? node.params]] as const) {
    if (!group || typeof group !== "object" || Array.isArray(group)) continue;
    for (const [name, spec] of Object.entries(group as Record<string, unknown>)) {
      out.push({ name, required: Boolean((spec as { required?: unknown } | null)?.required), where });
    }
  }
  return out.slice(0, 20);
}

/** A catalog entry (GET /catalog/search results, GET /catalog/endpoints/{id}) in the shape the assistant reads. */
export function parseEndpoint(raw: unknown): TregEndpoint | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as { id?: unknown; summary?: unknown; name?: unknown; method?: unknown; cost?: { usd?: unknown; value?: unknown; type?: unknown } | null; input?: unknown };
  if (!isCatalogId(row.id)) return null;
  const usd = typeof row.cost?.usd === "number" ? row.cost.usd : typeof row.cost?.value === "number" ? row.cost.value : null;
  const type = String(row.cost?.type ?? "");
  return {
    id: row.id,
    summary: String(row.summary ?? row.name ?? "").replace(/\s+/g, " ").trim().slice(0, 240),
    method: typeof row.method === "string" ? row.method.toUpperCase() : "GET",
    usd: usd !== null && Number.isFinite(usd) && usd >= 0 ? usd : null,
    billing: type === "per_success" ? "per_success" : type ? "per_call" : "unknown",
    params: paramsOf(row.input),
  };
}

/** The endpoints a catalog search returned, cheapest-first within what was found. */
export function parseSearch(body: unknown, limit = 6): TregEndpoint[] {
  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  return results.map(parseEndpoint).filter((endpoint): endpoint is TregEndpoint => Boolean(endpoint)).slice(0, limit);
}

/** The price a call reported (`X-Treg-Cost-Micro` header, micro-dollars), in USD; null when absent. */
export function reportedCostUsd(header: string | null | undefined): number | null {
  if (header === null || header === undefined || header.trim() === "") return null;
  const micro = Number(header);
  return Number.isFinite(micro) && micro >= 0 ? micro / 1_000_000 : null;
}

/** Why this call may not be made now, or null. */
export function callProblem(endpoint: TregEndpoint, spentTodayUsd: number, dailyCapUsd: number): string | null {
  if (endpoint.usd === null) return `Treg publishes no price for ${endpoint.id}, so it is not called`;
  if (endpoint.usd > TREG_LIMITS.maxUsdPerCall) return `${endpoint.id} costs $${endpoint.usd} a call, above the $${TREG_LIMITS.maxUsdPerCall} a call this app allows`;
  if (spentTodayUsd + endpoint.usd > dailyCapUsd) return `the daily Treg spend cap of $${dailyCapUsd} is reached ($${spentTodayUsd.toFixed(3)} spent in the last 24 hours)`;
  return null;
}

/** What the model reads of a call's answer: compact JSON, cut to a size it can use. */
export function compactResult(body: unknown, max: number = TREG_LIMITS.maxResultChars): string {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.length > max ? `${text.slice(0, max)}… (cut: ${text.length} characters in all)` : text;
}

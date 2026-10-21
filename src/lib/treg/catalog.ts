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
  /**
   * Treg's listed price in USD, per `unit` (a call, a result, a row, a
   * domain…), plus any flat `callFee`; null when Treg publishes none (such
   * an endpoint is refused). A per-result price is a floor, not the call's
   * cost: the hard limit is the ceiling sent with every call (callCeilingUsd).
   */
  usd: number | null;
  unit: string;
  callFee: number;
  /** Billed only on a hit, per call, or per result. */
  billing: "per_success" | "per_call" | "per_result" | "unknown";
  /** Parameters by name, with whether each is required and Treg's note on it. */
  params: { name: string; required: boolean; where: "query" | "body"; note?: string }[];
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
  const node = input as { body?: unknown; query?: unknown; queryParams?: unknown; params?: unknown };
  const out: TregEndpoint["params"] = [];
  for (const [where, group] of [["body", node.body], ["query", node.queryParams ?? node.query ?? node.params]] as const) {
    if (!group || typeof group !== "object" || Array.isArray(group)) continue;
    for (const [name, spec] of Object.entries(group as Record<string, unknown>)) {
      const detail = (spec ?? {}) as { required?: unknown; note?: unknown };
      const note = typeof detail.note === "string" ? detail.note.replace(/\s+/g, " ").trim().slice(0, 120) : "";
      out.push({ name, required: Boolean(detail.required), where, ...(note ? { note } : {}) });
    }
  }
  return out.slice(0, 20);
}

function money(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * A catalog entry in the shape the assistant reads: a search result, or
 * GET /catalog/endpoints/{id}, which wraps it as `{ endpoint: … }`.
 */
export function parseEndpoint(raw: unknown): TregEndpoint | null {
  if (!raw || typeof raw !== "object") return null;
  const wrapped = (raw as { endpoint?: unknown }).endpoint;
  const row = (wrapped && typeof wrapped === "object" ? wrapped : raw) as {
    id?: unknown; summary?: unknown; name?: unknown; method?: unknown; input?: unknown;
    cost?: { usd?: unknown; value?: unknown; type?: unknown; unit?: unknown; call_fee?: unknown } | null;
  };
  if (!isCatalogId(row.id)) return null;
  const type = String(row.cost?.type ?? "");
  return {
    id: row.id,
    summary: String(row.summary ?? row.name ?? "").replace(/\s+/g, " ").trim().slice(0, 240),
    method: typeof row.method === "string" && /^(GET|POST)$/i.test(row.method) ? row.method.toUpperCase() : "GET",
    usd: money(row.cost?.usd) ?? money(row.cost?.value),
    unit: typeof row.cost?.unit === "string" && row.cost.unit.trim() ? row.cost.unit.trim().slice(0, 20) : "call",
    callFee: money(row.cost?.call_fee) ?? 0,
    billing: type === "per_success" ? "per_success" : type === "per_result" ? "per_result" : type ? "per_call" : "unknown",
    params: paramsOf(row.input),
  };
}

/** The least one call can cost: one unit plus the flat fee. */
export function minimumCostUsd(endpoint: TregEndpoint): number | null {
  return endpoint.usd === null ? null : endpoint.usd + endpoint.callFee;
}

/**
 * The most this call may cost: what is left of the daily cap, and never more
 * than the per-call limit. Sent as `X-Treg-Route-Max-Cost`, so Treg itself
 * refuses (HTTP 402 route_max_cost, nothing charged) a call that would
 * reserve more — the hard limit whatever the endpoint's price unit.
 */
export function callCeilingUsd(spentTodayUsd: number, dailyCapUsd: number): number {
  return Math.max(0, Math.floor(Math.min(TREG_LIMITS.maxUsdPerCall, dailyCapUsd - spentTodayUsd) * 1_000_000) / 1_000_000);
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
  const least = minimumCostUsd(endpoint);
  if (least === null) return `Treg publishes no price for ${endpoint.id}, so it is not called`;
  if (least > TREG_LIMITS.maxUsdPerCall) return `${endpoint.id} costs at least $${least} a call, above the $${TREG_LIMITS.maxUsdPerCall} a call this app allows`;
  if (least > callCeilingUsd(spentTodayUsd, dailyCapUsd)) return `the daily Treg spend cap of $${dailyCapUsd} is reached ($${spentTodayUsd.toFixed(4)} spent in the last 24 hours)`;
  return null;
}

/** One line per endpoint, for the model: id, price and parameters. */
export function describeEndpoint(endpoint: TregEndpoint): string {
  const price = endpoint.usd === null ? "no published price (cannot be called)" : `$${endpoint.usd} per ${endpoint.unit}${endpoint.callFee ? ` + $${endpoint.callFee} a call` : ""}${endpoint.billing === "per_success" ? ", billed on a hit" : ""}`;
  const params = endpoint.params.map((param) => `${param.name}${param.required ? "*" : ""} (${param.where}${param.note ? `: ${param.note}` : ""})`).join("; ");
  return `${endpoint.id} [${endpoint.method}] — ${endpoint.summary} — ${price}${params ? ` — parameters: ${params}` : ""}`;
}

/** What an owner sees and edits in Settings → Providers & features → Treg (never the key). */
export type TregSettingsView = {
  connected: boolean;
  keyHint: string | null;
  /** The Treg team the key belongs to, as Treg named it when the key was saved. */
  team: string | null;
  dailyCapUsd: number;
  spentTodayUsd: number;
};

/** What the model reads of a call's answer: compact JSON, cut to a size it can use. */
export function compactResult(body: unknown, max: number = TREG_LIMITS.maxResultChars): string {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.length > max ? `${text.slice(0, max)}… (cut: ${text.length} characters in all)` : text;
}

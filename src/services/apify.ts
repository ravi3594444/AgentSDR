import "server-only";

/**
 * Apify's REST API v2 (docs.apify.com/api/v2), only the calls AgentSDR
 * makes: start an Actor run with hard limits, read a run, read its dataset
 * items, abort it, and read the account's monthly allowance. Nothing here
 * changes billing, plans or limits — PUT /v2/users/me/limits (raising the
 * cap) is never called. The token is the organization's own
 * (apify/settings.server.ts), sent as a Bearer header, never in a URL.
 */

const API = "https://api.apify.com/v2";
const TIMEOUT_MS = 30_000;

export class ApifyError extends Error {
  constructor(
    readonly status: number | null,
    readonly type: string | null,
    message: string,
  ) {
    super(message);
    this.name = "ApifyError";
  }
}

/** Test hook: the e2e check points this at a stand-in. */
let apiBase = API;
export function setApifyApiBase(base: string | null): void {
  apiBase = base ?? API;
}

async function call<T>(token: string, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiBase}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    throw new ApifyError(null, null, `Apify could not be reached: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    const error = (json as { error?: { type?: string; message?: string } } | null)?.error;
    throw new ApifyError(response.status, error?.type ?? null, error?.message ?? `Apify answered HTTP ${response.status}`);
  }
  return json as T;
}

export type ApifyRun = {
  id: string;
  status: string;
  statusMessage: string | null;
  defaultDatasetId: string | null;
  usageTotalUsd: number | null;
};

function runOf(data: Record<string, unknown> | undefined): ApifyRun {
  if (!data || typeof data.id !== "string") throw new ApifyError(null, null, "Apify answered without a run");
  return {
    id: data.id,
    status: typeof data.status === "string" ? data.status : "UNKNOWN",
    statusMessage: typeof data.statusMessage === "string" ? data.statusMessage : null,
    defaultDatasetId: typeof data.defaultDatasetId === "string" ? data.defaultDatasetId : null,
    usageTotalUsd: typeof data.usageTotalUsd === "number" ? data.usageTotalUsd : null,
  };
}

/**
 * Starts a run of `actorId` (username~actor-name) with hard limits:
 * maxTotalChargeUsd (pay-per-event Actors), maxItems (pay-per-result
 * Actors), a timeout and a memory size. Returns immediately.
 */
export async function startApifyRun(
  token: string,
  actorId: string,
  input: Record<string, unknown>,
  limits: { maxTotalChargeUsd: number; maxItems: number; timeoutSeconds: number; memoryMbytes: number },
): Promise<ApifyRun> {
  const query = new URLSearchParams({
    maxTotalChargeUsd: String(limits.maxTotalChargeUsd),
    maxItems: String(limits.maxItems),
    timeout: String(limits.timeoutSeconds),
    memory: String(limits.memoryMbytes),
  });
  const result = await call<{ data?: Record<string, unknown> }>(token, "POST", `/actors/${encodeURIComponent(actorId)}/runs?${query}`, input);
  return runOf(result.data);
}

export async function getApifyRun(token: string, runId: string): Promise<ApifyRun> {
  const result = await call<{ data?: Record<string, unknown> }>(token, "GET", `/actor-runs/${encodeURIComponent(runId)}`);
  return runOf(result.data);
}

export async function abortApifyRun(token: string, runId: string): Promise<void> {
  await call(token, "POST", `/actor-runs/${encodeURIComponent(runId)}/abort`);
}

/** Up to `limit` items of a dataset from `offset` (clean items only). */
export async function listApifyDatasetItems(token: string, datasetId: string, offset: number, limit: number): Promise<unknown[]> {
  const query = new URLSearchParams({ offset: String(offset), limit: String(limit), clean: "true", format: "json" });
  const result = await call<unknown>(token, "GET", `/datasets/${encodeURIComponent(datasetId)}/items?${query}`);
  return Array.isArray(result) ? result : [];
}

/** The account's monthly allowance: its hard usage limit and what is used this cycle (USD). Read only. */
export async function getApifyAccountLimits(token: string): Promise<{ maxMonthlyUsageUsd: number | null; monthlyUsageUsd: number | null }> {
  const result = await call<{ data?: { limits?: { maxMonthlyUsageUsd?: unknown }; current?: { monthlyUsageUsd?: unknown } } }>(token, "GET", "/users/me/limits");
  const max = result.data?.limits?.maxMonthlyUsageUsd;
  const used = result.data?.current?.monthlyUsageUsd;
  return { maxMonthlyUsageUsd: typeof max === "number" ? max : null, monthlyUsageUsd: typeof used === "number" ? used : null };
}

/** Checks a token before it is saved (GET /v2/users/me). */
export async function verifyApifyToken(token: string): Promise<{ username: string | null }> {
  const result = await call<{ data?: { username?: unknown } }>(token, "GET", "/users/me");
  return { username: typeof result.data?.username === "string" ? result.data.username : null };
}

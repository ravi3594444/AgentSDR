import "server-only";

import { reportedCostUsd, TREG_BASE_URL, type TregEndpoint } from "@/lib/treg/catalog";

/**
 * Treg's HTTP API (https://treg.to/llms.txt), only the calls AgentSDR makes:
 * who a key belongs to, the public catalog, and one /call/{catalog id}.
 * Nothing here tops up, changes billing or registers tools. The key is the
 * organization's own (lib/treg/treg.server.ts), sent as `X-Treg-Token`,
 * never in a URL.
 */

const TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 90_000;
/** What is read of one answer before it is cut (the model reads far less). */
const MAX_BODY_CHARS = 1_000_000;

export class TregError extends Error {
  constructor(
    readonly status: number | null,
    /** Treg's machine-readable error ("route_max_cost", "provider_paused", …) when it gave one. */
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "TregError";
  }
}

/** Test hook: the e2e check points this at a stand-in. */
let apiBase = TREG_BASE_URL;
export function setTregApiBase(base: string | null): void {
  apiBase = base ?? TREG_BASE_URL;
}

function parse(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

/** Treg's error, from `{ error, message }`, `{ detail: { error, message } }` or `{ detail: "…" }`. */
function errorOf(status: number, body: unknown): TregError {
  const node = (body && typeof body === "object" ? body : {}) as { error?: unknown; message?: unknown; detail?: unknown };
  const detail = (node.detail && typeof node.detail === "object" ? node.detail : {}) as { error?: unknown; message?: unknown };
  const code = [node.error, detail.error].find((value): value is string => typeof value === "string") ?? null;
  const message = [node.message, detail.message, node.detail].find((value): value is string => typeof value === "string" && value.trim() !== "")
    ?? (typeof body === "string" && body.trim() ? body.trim().slice(0, 300) : `Treg answered HTTP ${status}`);
  return new TregError(status, code, message.slice(0, 500));
}

async function request(path: string, init: { headers?: Record<string, string>; method?: string; body?: string; timeoutMs?: number }): Promise<Response> {
  try {
    return await fetch(`${apiBase}${path}`, {
      method: init.method ?? "GET",
      headers: { Accept: "application/json", ...init.headers },
      body: init.body,
      signal: AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS),
      cache: "no-store",
      redirect: "error",
    });
  } catch (error) {
    throw new TregError(null, null, `Treg could not be reached: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function json(path: string, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await request(path, { headers });
  const body = parse(await response.text());
  if (!response.ok) throw errorOf(response.status, body);
  return body;
}

/** Whose key this is: Treg's team for it (GET /auth/me). Throws TregError 401 for a key Treg does not know. */
export async function verifyTregKey(key: string): Promise<{ team: string | null }> {
  const body = (await json("/auth/me", { "X-Treg-Token": key })) as { org?: unknown; org_id?: unknown } | null;
  const org = body?.org;
  const team = typeof org === "string" ? org : org && typeof org === "object" && typeof (org as { name?: unknown }).name === "string" ? (org as { name: string }).name : null;
  return { team: team?.slice(0, 120) ?? null };
}

/** The public catalog's best matches for a task, in Treg's words (no key sent). */
export async function searchTregCatalog(query: string, limit: number): Promise<unknown> {
  return json(`/catalog/search?${new URLSearchParams({ q: query, limit: String(limit) })}`);
}

/** One catalog endpoint's own page: its price, method and parameters (no key sent). */
export async function getTregEndpoint(id: string): Promise<unknown> {
  return json(`/catalog/endpoints/${encodeURIComponent(id)}`);
}

export type TregCallResult = {
  httpStatus: number;
  ok: boolean;
  body: unknown;
  /** X-Treg-Cost-Micro in USD; null when Treg sent none. */
  costUsd: number | null;
  callId: string | null;
  error: TregError | null;
};

/**
 * One call to a catalog endpoint, with `X-Treg-Route-Max-Cost` as its hard
 * ceiling (Treg refuses with 402 route_max_cost, charging nothing, when the
 * call would reserve more) and an Idempotency-Key, so a retried request is
 * never billed twice. A provider's own error is relayed by Treg and not
 * charged.
 */
export async function callTreg(
  key: string,
  endpoint: Pick<TregEndpoint, "id" | "method">,
  input: { query: Record<string, string | string[]>; body: Record<string, unknown> | null },
  options: { ceilingUsd: number; idempotencyKey: string },
): Promise<TregCallResult> {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(input.query)) for (const item of Array.isArray(value) ? value : [value]) query.append(name, item);
  const post = endpoint.method === "POST";
  const response = await request(`/call/${encodeURIComponent(endpoint.id)}${query.size ? `?${query}` : ""}`, {
    method: post ? "POST" : "GET",
    headers: {
      "X-Treg-Token": key,
      "X-Treg-Route-Max-Cost": options.ceilingUsd.toFixed(6),
      "Idempotency-Key": options.idempotencyKey,
      ...(post ? { "Content-Type": "application/json" } : {}),
    },
    body: post ? JSON.stringify(input.body ?? {}) : undefined,
    timeoutMs: CALL_TIMEOUT_MS,
  });
  const text = await response.text();
  const body = parse(text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) : text);
  return {
    httpStatus: response.status,
    ok: response.ok,
    body,
    costUsd: reportedCostUsd(response.headers.get("x-treg-cost-micro")),
    callId: response.headers.get("x-treg-call-id"),
    error: response.ok ? null : errorOf(response.status, body),
  };
}

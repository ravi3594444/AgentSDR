import "server-only";

import { retryAfterMs } from "@/lib/quota/quota";

/** Exa Search and Contents only. One transport attempt; never send a key in a URL or log provider bodies. */
export type ExaSearchInput = { query: string; numResults?: number; includeDomains?: string[]; excludeDomains?: string[] };
export type ExaResult = { url: string; title: string; snippet: string; text: string; author: string | null; date: string | null };
export type ExaResponse = { results: ExaResult[]; requestId: string | null; costUsd: number | null; notices: string[]; failures: { url: string; status: string }[] };

export const EXA_PAGE_CHARS = 12_000;
export const EXA_READ_BATCH = 10;
const MAX_RESPONSE_BYTES = 4_000_000;
const API_BASE = "https://api.exa.ai";
let apiBase = API_BASE;
/** In-process fixture endpoint; never taken from a workspace, request, or environment variable. */
export function setExaApiBaseForTests(base: string | null): void { apiBase = base ?? API_BASE; }

export class ExaError extends Error {
  constructor(readonly status: number | null, readonly retryAfterMs: number | null = null) {
    super(status === 401 || status === 403 ? "Exa rejected the platform key. Ask the operator to check it."
      : status === 402 ? "Exa has no available credits. Ask the operator to check its account."
      : status === 429 ? "Exa is rate limiting this key. Wait before trying again."
      : status === null ? "Exa did not return a usable answer. This attempt may have been billed; it was not retried."
      : `Exa answered HTTP ${status}.`);
    this.name = "ExaError";
  }
  get uncertain(): boolean { return this.status === null || this.status >= 500; }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const str = (value: unknown, max: number) => typeof value === "string" ? value.slice(0, max) : "";

export function exaSearchInput(input: ExaSearchInput): Required<Pick<ExaSearchInput, "query" | "numResults">> & ExaSearchInput {
  if (typeof input.query !== "string" || input.query.trim().length < 2 || input.query.length > 4096) throw new TypeError("query must contain 2–4096 characters");
  const numResults = input.numResults ?? 10;
  if (!Number.isInteger(numResults) || numResults < 1 || numResults > 100) throw new TypeError("Exa numResults must be a whole number from 1 to 100");
  for (const key of ["includeDomains", "excludeDomains"] as const) {
    const values = input[key];
    if (values !== undefined && (!Array.isArray(values) || values.length > 1200 || values.some((value) => typeof value !== "string" || !value.trim() || value.length > 255))) throw new TypeError(`${key} must be an array of up to 1200 domain names`);
  }
  return { ...input, query: input.query.trim(), numResults };
}

/** Auto search with one content type. Ten results include content; extra results and content are reserved at list price. */
export function exaSearchCeiling(numResults: number): number { return (7 + Math.max(0, numResults - 10) * 2) / 1000; }
export function exaReadCeiling(urlCount: number): number { return urlCount / 1000; }

function parsedResponse(value: unknown, maxResults: number): ExaResponse {
  const body = object(value);
  if (!Array.isArray(body.results)) throw new ExaError(null);
  const results: ExaResult[] = [];
  for (const item of body.results.slice(0, maxResults)) {
    const raw = object(item);
    let url: URL;
    try { url = new URL(String(raw.url)); } catch { continue; }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) continue;
    const highlights = Array.isArray(raw.highlights) ? raw.highlights.filter((item): item is string => typeof item === "string").join("\n").slice(0, 4000) : "";
    results.push({ url: url.href, title: str(raw.title, 250), snippet: highlights, text: str(raw.text, EXA_PAGE_CHARS), author: str(raw.author, 200) || null, date: str(raw.publishedDate, 80) || null });
  }
  const total = object(body.costDollars).total;
  return {
    results,
    requestId: str(body.requestId, 128) || null,
    costUsd: typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : null,
    // Exa distinguishes model-facing notices from developer warnings. Never send raw warnings to the model.
    notices: (Array.isArray(body.notices) ? body.notices : []).map((notice) => str(typeof notice === "string" ? notice : object(notice).message, 1000)).filter(Boolean).slice(0, 20),
    failures: (Array.isArray(body.statuses) ? body.statuses : []).map(object).filter((status) => status.status !== "success").map((status) => ({ url: str(status.id, 2048), status: str(status.status, 120) })),
  };
}

async function call(key: string, path: "search" | "contents", input: unknown, maxResults: number, signal?: AbortSignal): Promise<ExaResponse> {
  if (!key.trim()) throw new ExaError(401);
  let response: Response;
  try {
    response = await fetch(`${apiBase}/${path}`, {
      method: "POST", headers: { "x-api-key": key, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
      redirect: "error", cache: "no-store",
    });
  } catch { throw new ExaError(null); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new ExaError(response.status, retryAfterMs(response.headers.get("retry-after"), new Date()));
  }
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new ExaError(null);
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new ExaError(null); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return parsedResponse(JSON.parse(Buffer.concat(chunks).toString("utf8")), maxResults);
  } catch { throw new ExaError(null); }
}

export async function exaSearch(key: string, input: ExaSearchInput, signal?: AbortSignal): Promise<ExaResponse> {
  const args = exaSearchInput(input);
  return call(key, "search", { ...args, type: "auto", contents: { highlights: true } }, args.numResults, signal);
}

/** The app validates public addresses and source provenance before calling this transport. */
export async function exaContents(key: string, urls: string[], signal?: AbortSignal): Promise<ExaResponse> {
  if (!Array.isArray(urls) || !urls.length || urls.length > EXA_READ_BATCH || urls.some((url) => typeof url !== "string" || url.length > 2048)) throw new TypeError(`urls must contain 1–${EXA_READ_BATCH} public page addresses`);
  return call(key, "contents", { urls, text: { maxCharacters: EXA_PAGE_CHARS } }, urls.length, signal);
}

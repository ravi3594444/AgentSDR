import "server-only";

import { TAVILY_API_URL } from "@/lib/tavily/catalog";

/**
 * Tavily's REST API (docs.tavily.com), only the calls AgentSDR makes: one
 * basic search, and the key's usage (which spends no credits). The key is
 * the organization's own (lib/tavily/tavily.server.ts), sent as a Bearer
 * header, never in a URL. Nothing here changes the plan or its limits.
 */

const TIMEOUT_MS = 30_000;

export class TavilyError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "TavilyError";
  }
}

/** Test hook: the e2e check points this at a stand-in. */
let apiBase = TAVILY_API_URL;
export function setTavilyApiBase(base: string | null): void {
  apiBase = base ?? TAVILY_API_URL;
}

/** Tavily's error in words an owner can act on (401 key, 429 busy, 432 plan limit, 433 pay-as-you-go limit). */
function errorOf(status: number, body: unknown): TavilyError {
  const detail = (body as { detail?: unknown } | null)?.detail;
  const said = typeof detail === "string" ? detail : typeof (detail as { error?: unknown } | null)?.error === "string" ? (detail as { error: string }).error : null;
  if (status === 401) return new TavilyError(status, "Tavily rejected the key");
  if (status === 432) return new TavilyError(status, `the Tavily plan's credits are used up${said ? ` (${said.slice(0, 200)})` : ""}; they renew monthly, or the plan can be changed on tavily.com`);
  if (status === 433) return new TavilyError(status, "the Tavily pay-as-you-go limit is reached; it can be raised on the Tavily dashboard");
  if (status === 429) return new TavilyError(status, "Tavily is rate limiting this key; try again shortly");
  return new TavilyError(status, `Tavily answered HTTP ${status}${said ? `: ${said.slice(0, 200)}` : ""}`);
}

async function call(key: string, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${apiBase}${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
      redirect: "error",
    });
  } catch (error) {
    throw new TavilyError(null, `Tavily could not be reached: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) throw errorOf(response.status, json);
  return json;
}

/** The key's and the plan's credits (GET /usage); throws TavilyError 401 for a key Tavily does not know. */
export async function getTavilyUsage(key: string): Promise<unknown> {
  return call(key, "GET", "/usage");
}

/** One basic search (1 credit): result pages only, no generated answer, no page bodies. */
export async function tavilySearch(key: string, query: string, maxResults: number): Promise<unknown> {
  return call(key, "POST", "/search", {
    query,
    search_depth: "basic",
    max_results: maxResults,
    include_answer: false,
    include_raw_content: false,
    include_images: false,
    include_usage: true,
  });
}

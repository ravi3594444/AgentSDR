import "server-only";

/** Who a source call is for: the assistant thread or job, kept on the ledger row. */
/** Who a read serves; `requestId` (the owner's request) goes into its usage row, so the request's own research is counted. */
export type ResearchCallContext = { threadId?: string | null; jobId?: string | null; requestId?: string | null };

/** The usage row's detail with the request it served, when there is one. */
export function usageDetail(context: ResearchCallContext, detail: Record<string, unknown>): Record<string, unknown> {
  return context.requestId ? { ...detail, requestId: context.requestId } : detail;
}

const TIMEOUT_MS = 10_000;
const USER_AGENT = "AgentSDR research reader";

export type JsonAnswer = { status: number; body: unknown; retryAfter: string | null };

/** One GET of a fixed public API (never a URL a page or a person supplied). The body is undefined when it is not JSON. */
export async function getJson(url: string): Promise<JsonAnswer> {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": USER_AGENT },
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body: unknown = await response.json().catch(() => undefined);
  return { status: response.status, body, retryAfter: response.headers.get("retry-after") };
}

/** `run` over `items` with at most `limit` at a time; results in input order. */
export async function mapWithLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

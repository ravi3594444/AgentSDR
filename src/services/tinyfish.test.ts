import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTinyfishBrowserSession, deleteTinyfishBrowserSession, setTinyfishApiBase, tinyfishFetch, TinyfishError, tinyfishSearch } from "./tinyfish";

type Seen = { method: string; url: string; key: string | null; body: unknown };
const realFetch = globalThis.fetch;
let seen: Seen[] = [];
let answer: (request: Seen) => Response | Promise<Response>;

beforeEach(() => {
  seen = [];
  setTinyfishApiBase({ search: "https://search.tf.test", fetch: "https://fetch.tf.test", browser: "https://browser.tf.test" });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request: Seen = {
      method: init?.method ?? "GET",
      url: String(input),
      key: new Headers(init?.headers).get("x-api-key"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    seen.push(request);
    return answer(request);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setTinyfishApiBase(null);
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("TinyFish client", () => {
  test("search sends the key as a header and the query as parameters", async () => {
    answer = () => json(200, { query: "q", results: [], total_results: 0, page: 0 });
    await tinyfishSearch("sk-tinyfish-key-123456", { query: "dentists Pune", location: "IN", purpose: "find clinics", page: 2 });
    const url = new URL(seen[0]!.url);
    expect(seen[0]!.key).toBe("sk-tinyfish-key-123456");
    expect(url.origin).toBe("https://search.tf.test");
    expect(Object.fromEntries(url.searchParams)).toEqual({ query: "dentists Pune", location: "IN", purpose: "find clinics", page: "2" });
    expect(seen[0]!.url).not.toContain("sk-tinyfish");
  });

  test("fetch asks for Markdown and links", async () => {
    answer = () => json(200, { results: [], errors: [] });
    await tinyfishFetch("sk-tinyfish-key-123456", ["https://a.example/"]);
    expect(seen[0]).toMatchObject({ method: "POST", url: "https://fetch.tf.test" });
    expect(seen[0]!.body).toMatchObject({ urls: ["https://a.example/"], format: "markdown", links: true });
  });

  test("a 429 carries Retry-After and the reset time", async () => {
    answer = () => json(429, { error: { code: "RATE_LIMIT_EXCEEDED", message: "slow down" } }, { "retry-after": "7", "x-ratelimit-reset": "1792344180" });
    const error = await tinyfishSearch("k".repeat(20), { query: "x" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TinyfishError);
    const e = error as TinyfishError;
    expect([e.status, e.code, e.retryAfterMs, e.resetAt?.toISOString(), e.uncertain]).toEqual([429, "RATE_LIMIT_EXCEEDED", 7_000, "2026-10-18T17:23:00.000Z", false]);
    expect(e.message).toContain("rate limiting");
  });

  test("a 402 says the free allowance is used and that the Wallet is never topped up", async () => {
    answer = () => json(402, { error: { code: "FREE_ALLOWANCE_EXHAUSTED" } });
    const e = (await tinyfishFetch("k".repeat(20), ["https://a.example/"]).catch((x: unknown) => x)) as TinyfishError;
    expect([e.status, e.code, e.product]).toEqual([402, "FREE_ALLOWANCE_EXHAUSTED", "fetch"]);
    expect(e.message).toContain("never tops up");
  });

  test("an unreachable host is an uncertain failure", async () => {
    answer = () => {
      throw new TypeError("network down");
    };
    const e = (await tinyfishSearch("k".repeat(20), { query: "x" }).catch((x: unknown) => x)) as TinyfishError;
    expect([e.status, e.uncertain]).toEqual([null, true]);
  });

  /** An answer whose headers arrived and whose body is cut off part way (a reset socket, the timeout). */
  const cutOff = (status: number, headers: Record<string, string> = {}) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{\"results\":["));
      controller.error(new TypeError("The socket connection was closed unexpectedly"));
    },
  }), { status, headers: { "content-type": "application/json", ...headers } });

  test("a 2xx answer cut off while its body is read is uncertain: TinyFish did the work", async () => {
    answer = () => cutOff(200);
    const fetched = (await tinyfishFetch("k".repeat(20), ["https://a.example/"]).catch((x: unknown) => x)) as TinyfishError;
    expect(fetched).toBeInstanceOf(TinyfishError);
    expect([fetched.product, fetched.status, fetched.uncertain]).toEqual(["fetch", null, true]);
    expect(fetched.message).toContain("cut off");
    answer = () => cutOff(201);
    const browser = (await createTinyfishBrowserSession("k".repeat(20), { timeoutSeconds: 60 }).catch((x: unknown) => x)) as TinyfishError;
    expect(browser).toBeInstanceOf(TinyfishError);
    expect([browser.product, browser.uncertain]).toEqual(["browser", true]);
  });

  test("an error answer cut off while its body is read keeps its status and wait", async () => {
    answer = () => cutOff(429, { "retry-after": "7" });
    const e = (await tinyfishSearch("k".repeat(20), { query: "x" }).catch((x: unknown) => x)) as TinyfishError;
    expect(e).toBeInstanceOf(TinyfishError);
    expect([e.status, e.retryAfterMs, e.uncertain]).toEqual([429, 7_000, false]);
  });

  test("browser sessions are created and ended by id", async () => {
    answer = (request) => request.method === "POST"
      ? json(201, { session_id: "br-1/2", cdp_url: "wss://x.tf.test/cdp", base_url: "https://x.tf.test" })
      : new Response(null, { status: 204 });
    const session = await createTinyfishBrowserSession("k".repeat(20), { url: "https://a.example", timeoutSeconds: 120 });
    expect(session).toEqual({ sessionId: "br-1/2", cdpUrl: "wss://x.tf.test/cdp", baseUrl: "https://x.tf.test" });
    expect(seen[0]!.body).toEqual({ url: "https://a.example", timeout_seconds: 120 });
    await deleteTinyfishBrowserSession("k".repeat(20), session.sessionId);
    expect(seen[1]).toMatchObject({ method: "DELETE", url: "https://browser.tf.test/br-1%2F2" });
  });

  test("a session answer without a CDP URL is refused", async () => {
    answer = () => json(201, { session_id: "br-1", cdp_url: "https://not-a-websocket" });
    const e = (await createTinyfishBrowserSession("k".repeat(20), { timeoutSeconds: 60 }).catch((x: unknown) => x)) as TinyfishError;
    expect(e.code).toBe("BAD_RESPONSE");
  });

  test("Browser 404 means the product is not enabled", async () => {
    answer = () => json(404, { error: { code: "NOT_FOUND" } });
    const e = (await createTinyfishBrowserSession("k".repeat(20), { timeoutSeconds: 60 }).catch((x: unknown) => x)) as TinyfishError;
    expect(e.message).toBe("TinyFish Browser is not enabled for this account");
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import http from "node:http";
import type { LookupFunction } from "node:net";
import { deflateRawSync, gzipSync } from "node:zlib";
import { fetchPublicPage, proxiedByEnvironment, publicOnlyLookup, requestWithLookup, type Resolver } from "./websiteContacts.server";

/** A local server standing in for a website: it records every request it gets. */
const hits: { host: string | undefined; path: string | undefined }[] = [];
let port = 0;
const server = http.createServer((request, response) => {
  hits.push({ host: request.headers.host, path: request.url });
  if (request.url === "/gzip") {
    response.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
    response.end(gzipSync("<p>Write to hello@lotus.example</p>"));
  } else if (request.url === "/big") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`${"word ".repeat(299_999)}info@acme.com ${"more ".repeat(100_000)}`);
  } else if (request.url === "/encoding-none") {
    response.writeHead(200, { "content-type": "text/html", "content-encoding": "none" });
    response.end("<p>Write to none@lotus.example</p>");
  } else if (request.url === "/raw-deflate") {
    response.writeHead(200, { "content-type": "text/html", "content-encoding": "deflate" });
    response.end(deflateRawSync("<p>Write to raw@lotus.example</p>"));
  } else if (request.url === "/gzip-trailing") {
    response.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
    response.end(Buffer.concat([gzipSync("<p>Write to trail@lotus.example</p>"), Buffer.from([0, 0, 0])]));
  } else if (request.url === "/moved") {
    response.writeHead(301, { location: "/contact" });
    response.end();
  } else {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<h1>Lotus Dental</h1>");
  }
});

// These tests read pages directly; a proxy in the test machine's environment would route them through fetch.
const PROXY_KEYS = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"] as const;
const savedProxyEnv = Object.fromEntries(PROXY_KEYS.map((key) => [key, process.env[key]]));

beforeAll(async () => {
  for (const key of PROXY_KEYS) delete process.env[key];
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(() => {
  for (const key of PROXY_KEYS) if (savedProxyEnv[key] !== undefined) process.env[key] = savedProxyEnv[key];
  server.close();
});

const toLocal: LookupFunction = (_hostname, options, callback) => {
  if (options?.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
  else callback(null, "127.0.0.1", 4);
};

function lookupOnce(lookup: LookupFunction, hostname: string, all = true): Promise<unknown> {
  return new Promise((resolve, reject) => lookup(hostname, { all }, (error, address) => (error ? reject(error) : resolve(address))));
}

describe("publicOnlyLookup", () => {
  test("passes public answers through and refuses a private one", async () => {
    const answers: Record<string, { address: string; family: number }[]> = {
      "public.test": [{ address: "93.184.216.34", family: 4 }, { address: "2606:2800:220:1::1", family: 6 }],
      "mixed.test": [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }],
      "metadata.test": [{ address: "169.254.169.254", family: 4 }],
      "mapped.test": [{ address: "::ffff:127.0.0.1", family: 6 }],
    };
    const lookup = publicOnlyLookup(async (host) => answers[host] ?? []);
    expect(await lookupOnce(lookup, "public.test")).toEqual(answers["public.test"]);
    expect(await lookupOnce(lookup, "public.test", false)).toBe("93.184.216.34");
    for (const host of ["mixed.test", "metadata.test", "mapped.test", "nothing.test"]) {
      await expect(lookupOnce(lookup, host)).rejects.toThrow(`${host} is not a public website`);
    }
  });
});

describe("fetchPublicPage", () => {
  test("a DNS answer that turns private on the second resolution (rebinding) is never connected to", async () => {
    const calls: string[] = [];
    // First answer public (the early check), then the loopback address where the stand-in site listens.
    const rebinding: Resolver = async (host) => {
      calls.push(host);
      return calls.length === 1 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "127.0.0.1", family: 4 }];
    };
    const before = hits.length;
    await expect(fetchPublicPage(`http://rebind.test:${port}/`, { resolve: rebinding })).rejects.toThrow("rebind.test is not a public website");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls).toEqual(["rebind.test", "rebind.test"]);
    expect(hits.length).toBe(before);
  });

  test("behind an outbound proxy pages go through fetch (which uses the proxy), after the public-address check", async () => {
    const realFetch = globalThis.fetch;
    const fetched: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      fetched.push(String(input));
      return new Response("<h1>Proxied page</h1>", { status: 200, headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    process.env.HTTP_PROXY = "http://proxy.internal:3128";
    try {
      const publicAnswer: Resolver = async () => [{ address: "93.184.216.34", family: 4 }];
      expect(await fetchPublicPage("http://shop.test/", { resolve: publicAnswer })).toEqual({ url: "http://shop.test/", html: "<h1>Proxied page</h1>" });
      expect(fetched).toEqual(["http://shop.test/"]);
      // The name is still checked: a private answer is refused before fetch is called.
      const privateAnswer: Resolver = async () => [{ address: "10.0.0.5", family: 4 }];
      await expect(fetchPublicPage("http://intranet.test/", { resolve: privateAnswer })).rejects.toThrow("intranet.test is not a public website");
      expect(fetched).toEqual(["http://shop.test/"]);
    } finally {
      delete process.env.HTTP_PROXY;
      globalThis.fetch = realFetch;
    }
  });

  test("an address written as the host is refused before any connection", async () => {
    const before = hits.length;
    await expect(fetchPublicPage(`http://127.0.0.1:${port}/`)).rejects.toThrow("127.0.0.1 is not a public website");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hits.length).toBe(before);
  });
});

describe("requestWithLookup", () => {
  test("connects to the address its lookup returned, keeping the site's host name", async () => {
    const answer = await requestWithLookup(new URL(`http://lotus.test:${port}/`), toLocal);
    expect(answer).toEqual({ status: 200, location: null, contentType: "text/html; charset=utf-8", html: "<h1>Lotus Dental</h1>" });
    expect(hits.at(-1)).toEqual({ host: `lotus.test:${port}`, path: "/" });
  });

  test("reads what sloppy servers send, as fetch did", async () => {
    expect((await requestWithLookup(new URL(`http://lotus.test:${port}/encoding-none`), toLocal)).html).toBe("<p>Write to none@lotus.example</p>");
    expect((await requestWithLookup(new URL(`http://lotus.test:${port}/raw-deflate`), toLocal)).html).toBe("<p>Write to raw@lotus.example</p>");
    expect((await requestWithLookup(new URL(`http://lotus.test:${port}/gzip-trailing`), toLocal)).html).toBe("<p>Write to trail@lotus.example</p>");
  });

  test("decompresses gzip, caps the body at 1.5 MB, and reports redirects without following them", async () => {
    expect((await requestWithLookup(new URL(`http://lotus.test:${port}/gzip`), toLocal)).html).toBe("<p>Write to hello@lotus.example</p>");
    // Capped at 1.5 MB, ending on a whole word: the address straddling the cap is dropped, never shortened.
    const big = (await requestWithLookup(new URL(`http://lotus.test:${port}/big`), toLocal)).html ?? "";
    expect(big.length).toBeLessThanOrEqual(1_500_000);
    expect(big.length).toBeGreaterThan(1_499_000);
    expect(big.endsWith(" ")).toBe(true);
    expect(big).not.toContain("info@acme.co");
    expect(await requestWithLookup(new URL(`http://lotus.test:${port}/moved`), toLocal)).toEqual({ status: 301, location: "/contact", contentType: "", html: null });
  });
});

describe("proxiedByEnvironment", () => {
  test("on Node a proxy variable changes nothing: its fetch would connect directly", () => {
    expect(proxiedByEnvironment(new URL("https://shop.example/"), { HTTPS_PROXY: "http://proxy:3128" }, false)).toBe(false);
  });

  test("follows the scheme's proxy variable and NO_PROXY", () => {
    const env = { HTTPS_PROXY: "http://proxy:3128", NO_PROXY: "localhost,.internal.example,exempt.example" };
    expect(proxiedByEnvironment(new URL("https://shop.example/"), env)).toBe(true);
    expect(proxiedByEnvironment(new URL("http://shop.example/"), env)).toBe(false);
    expect(proxiedByEnvironment(new URL("https://a.internal.example/"), env)).toBe(false);
    expect(proxiedByEnvironment(new URL("https://exempt.example/"), env)).toBe(false);
    expect(proxiedByEnvironment(new URL("https://www.exempt.example/"), env)).toBe(false);
    expect(proxiedByEnvironment(new URL("https://notexempt.example/"), env)).toBe(true);
    expect(proxiedByEnvironment(new URL("https://shop.example/"), { https_proxy: "http://p:1", no_proxy: "*" })).toBe(false);
    expect(proxiedByEnvironment(new URL("https://shop.example/"), {})).toBe(false);
  });
});

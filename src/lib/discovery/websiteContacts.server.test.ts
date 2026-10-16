import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import http from "node:http";
import type { LookupFunction } from "node:net";
import { gzipSync } from "node:zlib";
import { fetchPublicPage, publicOnlyLookup, requestWithLookup, type Resolver } from "./websiteContacts.server";

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
    response.end("x".repeat(2_000_000));
  } else if (request.url === "/moved") {
    response.writeHead(301, { location: "/contact" });
    response.end();
  } else {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<h1>Lotus Dental</h1>");
  }
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(() => {
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

  test("decompresses gzip, caps the body at 1.5 MB, and reports redirects without following them", async () => {
    expect((await requestWithLookup(new URL(`http://lotus.test:${port}/gzip`), toLocal)).html).toBe("<p>Write to hello@lotus.example</p>");
    expect((await requestWithLookup(new URL(`http://lotus.test:${port}/big`), toLocal)).html?.length).toBe(1_500_000);
    expect(await requestWithLookup(new URL(`http://lotus.test:${port}/moved`), toLocal)).toEqual({ status: 301, location: "/contact", contentType: "", html: null });
  });
});

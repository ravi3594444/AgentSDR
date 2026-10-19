import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import http from "node:http";
import type { LookupFunction } from "node:net";
import { deflateRawSync, gzipSync } from "node:zlib";
import { offerFocus } from "./websiteProfile";
import { collectWebsiteContacts, fetchPublicPage, PageRedirectRefusedError, proxiedByEnvironment, publicOnlyLookup, requestWithLookup, type Resolver } from "./websiteContacts.server";

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

  test("a redirect to Reddit or a login-walled site is refused before that host is asked for anything", async () => {
    const asked: string[] = [];
    const moves: Record<string, string> = {
      "https://short.example/thread": "https://www.reddit.com/r/smallbusiness/comments/abc/",
      "https://short.example/link": "https://redd.it/abc123",
      "https://short.example/profile": "https://www.linkedin.com/in/someone",
      "https://short.example/insta": "https://instagram.com./someone",
    };
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      asked.push(url);
      return moves[url]
        ? new Response(null, { status: 301, headers: { location: moves[url]! } })
        : new Response("<p>Thread text. Mail ops@acme-agency.example</p>", { status: 200, headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    for (const [from, to] of Object.entries(moves)) {
      const refused = await fetchPublicPage(from, { fetchImpl, allowPrivate: true }).then(() => null, (error: unknown) => error);
      expect(refused).toBeInstanceOf(PageRedirectRefusedError);
      expect((refused as PageRedirectRefusedError).destination.toString()).toBe(new URL(to).toString());
    }
    expect(asked).toEqual(Object.keys(moves));
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

describe("collectWebsiteContacts", () => {
  const site: Record<string, string> = {
    "https://lotus.example/": `<html><head><meta name="description" content="Lotus Dental, a family dental clinic in Baner."></head><body>
      <a href="/contact">Contact</a><a href="/team">Team</a><a href="/careers">Careers</a><a href="/blog">Blog</a>
      <a href="https://calendly.com/lotus/visit">Book a visit</a><a href="https://www.linkedin.com/company/lotus-dental">LinkedIn</a>
      <a href="mailto:hello@lotus.example">hello@lotus.example</a></body></html>`,
    "https://lotus.example/contact": `<form><input type="email" name="email"><textarea></textarea></form><a href="tel:+912012345678">Call</a>`,
    "https://lotus.example/team": `<div><h3>Dr. Sara Mehta</h3><p>Founder</p><a href="mailto:sara@lotus.example">sara@lotus.example</a></div>`,
    "https://lotus.example/careers": `<h1>Careers</h1><p>We're hiring!</p><ul><li>Receptionist (part time)</li></ul>`,
  };

  test("contacts and observations come from the same responses: every page is fetched once, external links never", async () => {
    const asked: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      asked.push(url);
      const html = site[url];
      return html ? new Response(html, { status: 200, headers: { "content-type": "text/html" } }) : new Response("missing", { status: 404 });
    }) as typeof fetch;
    const focus = offerFocus({ offer: "An AI receptionist that answers every call", targetCustomers: "dental clinics" });
    const result = await collectWebsiteContacts("https://lotus.example/", { fetchImpl, allowPrivate: true }, focus);
    expect(asked).toEqual(["https://lotus.example/", "https://lotus.example/contact", "https://lotus.example/team", "https://lotus.example/careers"]);
    expect(result.pagesRead).toEqual(asked);
    expect(result.contacts.map((contact) => contact.value).sort()).toEqual(["+912012345678", "hello@lotus.example", "https://www.linkedin.com/company/lotus-dental", "sara@lotus.example"]);
    expect(result.profile?.pagesRead).toEqual(asked);
    expect(result.profile?.observations.map((item) => [item.topic, item.text])).toEqual([
      ["booking", "Online booking link (Calendly)"],
      ["context", "Lotus Dental, a family dental clinic in Baner."],
      ["contact", "Contact form"],
      ["hiring", "Receptionist (part time)"],
    ]);
    expect(result.profile?.people).toEqual([{ name: "Dr. Sara Mehta", role: "Founder", email: "sara@lotus.example", linkedin: null, sourceUrl: "https://lotus.example/team" }]);
  });

  test("a page that redirected to another host is not read as the business's own", async () => {
    const pages: Record<string, Response | (() => Response)> = {};
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://smile.example/") return new Response(`<a href="/team">Team</a><a href="/careers">Careers</a>`, { status: 200, headers: { "content-type": "text/html" } });
      if (url === "https://smile.example/team") return new Response(null, { status: 301, headers: { location: "https://jobs-board.example/team" } });
      if (url === "https://jobs-board.example/team") return new Response(`<h3>Raj Mehta</h3><p>CEO</p><a href="mailto:raj@jobs-board.example">raj@jobs-board.example</a>`, { status: 200, headers: { "content-type": "text/html" } });
      return pages[url] ? (pages[url] as Response) : new Response("missing", { status: 404 });
    }) as typeof fetch;
    const result = await collectWebsiteContacts("https://smile.example/", { fetchImpl, allowPrivate: true }, offerFocus({ offer: "AI receptionist" }));
    expect(result.profile?.people).toEqual([]);
    expect(result.profile?.pagesRead).toEqual(["https://smile.example/"]);
  });

  test("a site that cannot be read has no profile", async () => {
    const fetchImpl = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    const result = await collectWebsiteContacts("https://down.example/", { fetchImpl, allowPrivate: true });
    expect(result.profile).toBeNull();
    expect(result.error).toContain("503");
  });
});

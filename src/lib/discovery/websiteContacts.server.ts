import "server-only";

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { PassThrough, type Readable, type Transform } from "node:stream";
import { constants as zlibConstants, createBrotliDecompress, createGunzip, createInflate, createInflateRaw } from "node:zlib";
import { assertPublicUrl, isBlockedAddress } from "@/lib/grid/runners/http";
import { BRAND } from "@/lib/brand";
import { publicAppUrl } from "@/lib/http/publicAppUrl";
import { isRedditHost } from "@/lib/research/sources/reddit";
import { contactPageLinks, extractContacts, type FoundContact } from "./contacts";

/**
 * Reads a business's own website for the contact details it publishes:
 * the home page, then up to three same-site contact/about/imprint pages.
 * Every request is to a public address, small (1.5 MB), short (10 s) and
 * identified by its User-Agent. Nothing is guessed: a site that publishes no
 * address yields none.
 *
 * Public means checked where it is connected: each request resolves the
 * host through its own `lookup`, which refuses any private, loopback,
 * link-local or CGNAT answer (the grid HTTP column's isBlockedAddress), so a
 * DNS server that answers "public" to a first check and "private" to the
 * connection (rebinding) gets nowhere. Every redirect hop is checked again,
 * and no connection is pooled or shared with other code.
 *
 * Behind an outbound proxy (HTTP_PROXY / HTTPS_PROXY, minus NO_PROXY) on
 * Bun — whose fetch sends such requests through the proxy, which resolves
 * and connects — pinning the address is not possible here: the request goes
 * through fetch, as before this reader existed, after the same
 * public-address check of the name. Without this a server that must go
 * through a proxy could not read websites at all (Google Maps discovery
 * included). Node's fetch ignores those variables and would connect
 * directly, so under Node the pinned reader is always used.
 */

const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1";

/** Every address a host name resolves to. */
export type Resolver = (hostname: string) => Promise<LookupAddress[]>;

export type PageFetchOptions = {
  /**
   * Tests point this at a local fixture server: pages are then read with
   * `fetchImpl` (or fetch) and no address check. Production never sets it.
   */
  allowPrivate?: boolean;
  fetchImpl?: typeof fetch;
  /** Tests stand in DNS here; production resolves with the system resolver. */
  resolve?: Resolver;
};

const systemResolve: Resolver = (hostname) => new Promise((resolve, reject) => {
  dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => (error ? reject(error) : resolve(addresses)));
});

/** Sites that need a login and forbid automated reading. */
export const LOGIN_WALLED_HOST = /(?:^|\.)(?:instagram\.com|facebook\.com|fb\.com|x\.com|twitter\.com|tiktok\.com|linkedin\.com|threads\.net)$/i;

/**
 * A redirect to Reddit (no reader and no workaround, research/sources/reddit.ts)
 * or to a login-walled site, refused before it is followed: nothing is asked
 * of that host.
 */
export class PageRedirectRefusedError extends Error {
  constructor(readonly destination: URL) {
    super(`${destination.hostname} needs a login or may not be read; the redirect to it was not followed`);
    this.name = "PageRedirectRefusedError";
  }
}

function refusedDestination(url: URL): boolean {
  const host = url.hostname.replace(/\.$/, "");
  return isRedditHost(host) || LOGIN_WALLED_HOST.test(host);
}

function notPublic(hostname: string): Error {
  return Object.assign(new Error(`${hostname} is not a public website`), { code: "ENOTPUBLIC" });
}

/**
 * The `lookup` a page request connects with: it resolves the name and
 * refuses the connection when any answer is not a public address, so the
 * address checked is the address connected to.
 */
export function publicOnlyLookup(resolve: Resolver = systemResolve): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then((answers) => {
      const wanted = options?.family === 4 || options?.family === 6 ? answers.filter((answer) => answer.family === options.family) : answers;
      if (!wanted.length || answers.some((answer) => isBlockedAddress(answer.address))) {
        callback(notPublic(hostname), "", 0);
        return;
      }
      if (options?.all) callback(null, wanted);
      else callback(null, wanted[0]!.address, wanted[0]!.family);
    }, (error: NodeJS.ErrnoException) => callback(error, "", 0));
  };
}

function userAgent(): string {
  const site = publicAppUrl();
  return `Mozilla/5.0 (compatible; ${BRAND.shortName}-contact-finder/1.0${site ? `; +${site}` : ""})`;
}

/** One answer: the status, where a redirect points, and the page when it is a readable one. */
export type Answer = { status: number; location: string | null; contentType: string; html: string | null };

const readableType = (type: string) => !type || /html|xml/i.test(type);

/** Content-Encoding values decoded here. */
const DECODED_ENCODINGS = new Set(["gzip", "x-gzip", "deflate", "br"]);

/**
 * The decompressed body. Lenient like fetch: trailing bytes after a gzip
 * member are ignored, and "deflate" may be zlib-wrapped (as the standard
 * says) or raw (as some servers send) — told apart by its first two bytes.
 */
function decodedBody(response: Readable, encoding: string): Readable {
  const options = { finishFlush: zlibConstants.Z_SYNC_FLUSH };
  if (encoding !== "deflate") {
    const decoder = encoding === "br" ? createBrotliDecompress() : createGunzip(options);
    response.on("error", (error) => decoder.destroy(error));
    return response.pipe(decoder);
  }
  const out = new PassThrough();
  response.on("error", (error) => out.destroy(error));
  let inflater: Transform | null = null;
  response.on("data", (chunk: Buffer) => {
    if (!inflater) {
      const zlibWrapped = chunk.length >= 2 && (chunk[0]! & 0x0f) === 8 && ((chunk[0]! << 8) | chunk[1]!) % 31 === 0;
      inflater = zlibWrapped ? createInflate(options) : createInflateRaw(options);
      inflater.on("error", (error) => out.destroy(error));
      inflater.pipe(out);
    }
    inflater.write(chunk);
  });
  response.on("end", () => (inflater ? inflater.end() : out.end()));
  return out;
}

/** Content-Encoding values that mean "not encoded" in practice. */
const PLAIN_ENCODINGS = new Set(["identity", "none", "utf-8", "utf8", "text", "binary", "8bit", "7bit"]);

function decode(bytes: Uint8Array[], total: number): string {
  const out = new Uint8Array(Math.min(total, MAX_BYTES));
  let offset = 0;
  for (const chunk of bytes) {
    const slice = chunk.subarray(0, Math.max(0, out.length - offset));
    out.set(slice, offset);
    offset += slice.byteLength;
    if (offset >= out.length) break;
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(out);
  if (total <= MAX_BYTES) return text;
  // Cut short: drop the last partial word, so "info@acme.com" is never read as "info@acme.co".
  const end = Math.max(text.lastIndexOf(">"), text.search(/\s\S*$/));
  return end > 0 ? text.slice(0, end + 1) : "";
}

async function readCapped(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  return decode(chunks, total);
}

/** Test fixtures (allowPrivate / fetchImpl) and proxied requests: fetch, with the one-time address check (skipped only for fixtures). */
async function fetchAnswer(url: URL, options: PageFetchOptions): Promise<Answer> {
  if (!options.allowPrivate) {
    try {
      await assertPublicUrl(url, options.resolve ? async (host) => (await options.resolve!(host)).map((answer) => answer.address) : undefined, false);
    } catch {
      throw notPublic(url.hostname);
    }
  }
  const response = await (options.fetchImpl ?? fetch)(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "User-Agent": userAgent(), Accept: ACCEPT },
  });
  const contentType = response.headers.get("content-type") ?? "";
  const status = response.status;
  if (status < 200 || status >= 300 || !readableType(contentType)) {
    await response.body?.cancel().catch(() => undefined);
    return { status, location: response.headers.get("location"), contentType, html: null };
  }
  return { status, location: null, contentType, html: await readCapped(response) };
}

/** The response body, decompressed, at most MAX_BYTES of it. */
function readStream(stream: Readable, onDone: () => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      onDone();
      resolve(decode(chunks, total));
    };
    stream.on("data", (chunk: Buffer) => {
      if (settled) return;
      chunks.push(chunk);
      total += chunk.byteLength;
      if (total >= MAX_BYTES) {
        finish();
        stream.destroy();
      }
    });
    stream.on("end", finish);
    stream.on("error", (error) => {
      if (settled) return;
      settled = true;
      onDone();
      reject(error);
    });
  });
}

/**
 * One GET whose connection goes only to an address `lookup` returned (with
 * publicOnlyLookup, one it checked as public); TLS still verifies the host
 * name. Exported for its tests.
 */
export function requestWithLookup(url: URL, lookup: LookupFunction): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(url, {
      method: "GET",
      headers: { "User-Agent": userAgent(), Accept: ACCEPT, "Accept-Encoding": "gzip, deflate" },
      lookup,
      // Read-only and bounded: tolerate the sloppy answers fetch tolerated (a repeated
      // Content-Length, LF-only lines) rather than lose a business's website.
      insecureHTTPParser: true,
      // A fresh connection every time: a pooled socket could have been opened by code without this lookup.
      agent: false,
    }, (response) => {
      const status = response.statusCode ?? 0;
      const contentType = String(response.headers["content-type"] ?? "");
      const location = typeof response.headers.location === "string" ? response.headers.location : null;
      if (status < 200 || status >= 300 || !readableType(contentType)) {
        clearTimeout(timer);
        response.destroy();
        resolve({ status, location, contentType, html: null });
        return;
      }
      const encoding = String(response.headers["content-encoding"] ?? "").trim().toLowerCase();
      // Lenient like fetch: trailing bytes after a gzip body, raw (zlib-less) deflate.
      if (encoding && !PLAIN_ENCODINGS.has(encoding) && !DECODED_ENCODINGS.has(encoding)) {
        clearTimeout(timer);
        response.destroy();
        reject(new Error(`${url.toString()} answered in an unsupported encoding (${encoding})`));
        return;
      }
      const decoder = DECODED_ENCODINGS.has(encoding) ? decodedBody(response, encoding) : null;
      readStream(decoder ?? response, () => {
        clearTimeout(timer);
        response.destroy();
      }).then((html) => resolve({ status, location, contentType, html }), reject);
    });
    // The whole exchange (connection, answer, body) within TIMEOUT_MS; the response handler runs after this line.
    const timer = setTimeout(() => request.destroy(new Error(`${url.hostname} did not answer within ${TIMEOUT_MS / 1_000} s`)), TIMEOUT_MS);
    request.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end();
  });
}

/**
 * Whether fetch would send a request for `url` through an outbound proxy:
 * on Bun, HTTPS_PROXY / HTTP_PROXY (either case) for its scheme, unless
 * NO_PROXY names its host (exact, a parent domain, or "*").
 */
export function proxiedByEnvironment(url: URL, env: Record<string, string | undefined> = process.env, onBun: boolean = Boolean(process.versions.bun)): boolean {
  // Only Bun's fetch uses these variables; Node's connects directly, so pinning still applies there.
  if (!onBun) return false;
  const proxy = url.protocol === "https:" ? env.HTTPS_PROXY ?? env.https_proxy : env.HTTP_PROXY ?? env.http_proxy;
  if (!proxy?.trim()) return false;
  const host = url.hostname.toLowerCase();
  const exempt = (env.NO_PROXY ?? env.no_proxy ?? "").split(",").map((entry) => entry.trim().toLowerCase().replace(/:\d+$/, "")).filter(Boolean);
  return !exempt.some((entry) => entry === "*" || host === entry.replace(/^\*?\./, "") || host.endsWith(entry.startsWith(".") ? entry : `.${entry.replace(/^\*\./, "")}`));
}

/**
 * Refuses an address that is not a public website (private, loopback,
 * link-local, carrier-grade NAT, metadata; the name resolved first) before
 * anything is sent to it or to a service that reads it for us (TinyFish).
 * Test fixtures (allowPrivate / fetchImpl) skip it, as in fetchPublicPage.
 */
export async function assertPublicPageUrl(rawUrl: string, options: PageFetchOptions = {}): Promise<void> {
  const url = new URL(rawUrl);
  if (!/^https?:$/.test(url.protocol)) throw new Error(`Not a web address: ${url.toString()}`);
  if (options.allowPrivate || options.fetchImpl) return;
  try {
    await assertPublicUrl(url, async (host) => (await (options.resolve ?? systemResolve)(host)).map((entry) => entry.address), false);
  } catch {
    throw notPublic(url.hostname);
  }
}

/**
 * One HTML page from a public address, following up to three redirects; null
 * when it is not HTML. A redirect to Reddit or a login-walled site is not
 * followed (PageRedirectRefusedError).
 */
export async function fetchPublicPage(rawUrl: string, options: PageFetchOptions = {}): Promise<{ url: string; html: string } | null> {
  const fixtures = Boolean(options.allowPrivate || options.fetchImpl);
  const lookup = publicOnlyLookup(options.resolve ?? systemResolve);
  let url = new URL(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!/^https?:$/.test(url.protocol)) throw new Error(`Not a web address: ${url.toString()}`);
    let answer: Answer;
    if (fixtures || proxiedByEnvironment(url)) {
      // Fixtures, or a proxy that connects for us: fetch, after the name's public-address check.
      answer = await fetchAnswer(url, options);
    } else {
      // Checked here for a clear refusal (and for an address written as the host, which no lookup sees)…
      try {
        await assertPublicUrl(url, async (host) => (await (options.resolve ?? systemResolve)(host)).map((entry) => entry.address), false);
      } catch {
        throw notPublic(url.hostname);
      }
      // …and again by the connection's own lookup, which is what counts.
      answer = await requestWithLookup(url, lookup);
    }
    if (answer.status >= 300 && answer.status < 400) {
      if (!answer.location) throw new Error(`${url.toString()} redirected without a destination`);
      url = new URL(answer.location, url);
      if (refusedDestination(url)) throw new PageRedirectRefusedError(url);
      continue;
    }
    if (answer.status < 200 || answer.status >= 300) throw new Error(`${url.toString()} answered HTTP ${answer.status}`);
    if (answer.html === null) return null;
    return { url: url.toString(), html: answer.html };
  }
  throw new Error(`${rawUrl} redirected more than ${MAX_REDIRECTS} times`);
}

export type WebsiteContacts = {
  contacts: FoundContact[];
  pagesRead: string[];
  /** Why the site could not be read at all, when it could not. */
  error: string | null;
};

export async function collectWebsiteContacts(website: string, options: PageFetchOptions = {}): Promise<WebsiteContacts> {
  const pagesRead: string[] = [];
  const contacts = new Map<string, FoundContact>();
  const keep = (found: FoundContact[]) => {
    for (const contact of found) {
      const key = `${contact.kind}:${contact.value.toLowerCase()}`;
      if (!contacts.has(key)) contacts.set(key, contact);
    }
  };
  let home;
  try {
    home = await fetchPublicPage(website, options);
  } catch (error) {
    return { contacts: [], pagesRead, error: error instanceof Error ? error.message : String(error) };
  }
  if (!home) return { contacts: [], pagesRead, error: "the website did not return a web page" };
  pagesRead.push(home.url);
  keep(extractContacts(home.html, home.url));
  for (const link of contactPageLinks(home.html, home.url, 3)) {
    try {
      const page = await fetchPublicPage(link, options);
      if (!page) continue;
      pagesRead.push(page.url);
      keep(extractContacts(page.html, page.url));
    } catch {
      // One unreadable contact page does not lose what the others had.
    }
  }
  return { contacts: [...contacts.values()], pagesRead, error: null };
}

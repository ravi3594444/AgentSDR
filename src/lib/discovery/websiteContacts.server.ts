import "server-only";

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import type { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { assertPublicUrl, isBlockedAddress } from "@/lib/grid/runners/http";
import { BRAND } from "@/lib/brand";
import { publicAppUrl } from "@/lib/http/publicAppUrl";
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

function decode(bytes: Uint8Array[], total: number): string {
  const out = new Uint8Array(Math.min(total, MAX_BYTES));
  let offset = 0;
  for (const chunk of bytes) {
    const slice = chunk.subarray(0, Math.max(0, out.length - offset));
    out.set(slice, offset);
    offset += slice.byteLength;
    if (offset >= out.length) break;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(out);
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

/** Test fixtures only (allowPrivate / fetchImpl): fetch, with the old one-time address check. */
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
      const decoder = encoding === "gzip" || encoding === "x-gzip" ? createGunzip()
        : encoding === "deflate" ? createInflate()
          : encoding === "br" ? createBrotliDecompress()
            : null;
      if (encoding && encoding !== "identity" && !decoder) {
        clearTimeout(timer);
        response.destroy();
        reject(new Error(`${url.toString()} answered in an unsupported encoding (${encoding})`));
        return;
      }
      if (decoder) {
        response.on("error", (error) => decoder.destroy(error));
        response.pipe(decoder);
      }
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

/** One HTML page from a public address, following up to three redirects; null when it is not HTML. */
export async function fetchPublicPage(rawUrl: string, options: PageFetchOptions = {}): Promise<{ url: string; html: string } | null> {
  const fixtures = Boolean(options.allowPrivate || options.fetchImpl);
  const lookup = publicOnlyLookup(options.resolve ?? systemResolve);
  let url = new URL(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!/^https?:$/.test(url.protocol)) throw new Error(`Not a web address: ${url.toString()}`);
    let answer: Answer;
    if (fixtures) {
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

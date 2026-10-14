import "server-only";

import { assertPublicUrl } from "@/lib/grid/runners/http";
import { BRAND } from "@/lib/brand";
import { publicAppUrl } from "@/lib/http/publicAppUrl";
import { contactPageLinks, extractContacts, type FoundContact } from "./contacts";

/**
 * Reads a business's own website for the contact details it publishes:
 * the home page, then up to three same-site contact/about/imprint pages.
 * Every request is to a public address (the grid HTTP column's guard,
 * checked again on each redirect), small (1.5 MB), short (10 s) and
 * identified by its User-Agent. Nothing is guessed: a site that publishes no
 * address yields none.
 */

const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

export type PageFetchOptions = {
  /** Tests point this at a local fixture server; production never sets it. */
  allowPrivate?: boolean;
  fetchImpl?: typeof fetch;
};

function userAgent(): string {
  const site = publicAppUrl();
  return `Mozilla/5.0 (compatible; ${BRAND.shortName}-contact-finder/1.0${site ? `; +${site}` : ""})`;
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
  const bytes = new Uint8Array(Math.min(total, MAX_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    const slice = chunk.subarray(0, Math.max(0, bytes.length - offset));
    bytes.set(slice, offset);
    offset += slice.byteLength;
    if (offset >= bytes.length) break;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/** One HTML page from a public address, following up to three redirects; null when it is not HTML. */
export async function fetchPublicPage(rawUrl: string, options: PageFetchOptions = {}): Promise<{ url: string; html: string } | null> {
  const doFetch = options.fetchImpl ?? fetch;
  let url = new URL(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!/^https?:$/.test(url.protocol)) throw new Error(`Not a web address: ${url.toString()}`);
    try {
      await assertPublicUrl(url, undefined, options.allowPrivate ?? false);
    } catch {
      throw new Error(`${url.hostname} is not a public website`);
    }
    const response = await doFetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": userAgent(), Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1" },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw new Error(`${url.toString()} redirected without a destination`);
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`${url.toString()} answered HTTP ${response.status}`);
    }
    const type = response.headers.get("content-type") ?? "";
    if (type && !/html|xml/i.test(type)) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    return { url: url.toString(), html: await readCapped(response) };
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

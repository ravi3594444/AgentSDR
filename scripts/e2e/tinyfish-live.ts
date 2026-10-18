/**
 * TinyFish's real API, once per product, to catch contract drift: one
 * search, one fetch of a public page, and one browser session that the
 * assistant's real driver (playwright-core over CDP) reads a page in before
 * it is ended (about $0.002 of Browser time). Reads the key
 * from TINYFISH_API_KEY for this check only; the app itself never reads a
 * TinyFish key from the environment. Prints shapes and timings, never the
 * key.
 *
 *   TINYFISH_API_KEY=… bun run --conditions=react-server scripts/e2e/tinyfish-live.ts [--no-browser]
 */
import { tinyfishFetchResult, tinyfishSearchHits } from "@/lib/tinyfish/catalog";
import { createTinyfishBrowserSession, deleteTinyfishBrowserSession, tinyfishFetch, tinyfishSearch, TinyfishError } from "@/services/tinyfish";
import { connectBrowser } from "@/lib/browser/driver.server";

const key = process.env.TINYFISH_API_KEY;
if (!key) {
  console.error("Set TINYFISH_API_KEY for this check.");
  process.exit(2);
}

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
async function timed<T>(work: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now();
  const value = await work();
  return [value, Math.round(performance.now() - started)];
}

try {
  const [body, ms] = await timed(() => tinyfishSearch(key, { query: "real estate agents Pune", location: "IN", purpose: "Find real estate agencies in Pune for B2B outreach" }));
  const hits = tinyfishSearchHits(body);
  check("Search answers with result pages", hits.length > 0 && hits.every((hit) => hit.url.startsWith("http")), `${hits.length} hits in ${ms} ms; first ${hits[0]?.site ?? "-"}`);
  const raw = (body as { results?: Record<string, unknown>[] }).results?.[0] ?? {};
  check("Search result fields are as documented", ["position", "site_name", "title", "snippet", "url"].every((field) => field in raw), Object.keys(raw).join(","));
} catch (error) {
  check("Search answers", false, error instanceof Error ? error.message : String(error));
}

try {
  const [body, ms] = await timed(() => tinyfishFetch(key, ["https://example.com/", "https://example.com/this-page-does-not-exist-agentsdr"]));
  const { pages, failures: failed } = tinyfishFetchResult(body);
  check("Fetch reads a public page as Markdown with links", pages.length >= 1 && pages[0]!.text.length > 0, `${pages.length} page(s), ${failed.length} failure(s) in ${ms} ms; links ${pages[0]?.links.length ?? 0}`);
  check("Fetch reports a failed URL per URL, not as an HTTP error", failed.length + pages.length === 2, failed.map((failure) => failure.code).join(",") || "none failed");
} catch (error) {
  check("Fetch answers", false, error instanceof Error ? error.message : String(error));
}

if (!process.argv.includes("--no-browser")) {
  try {
    const [session, ms] = await timed(() => createTinyfishBrowserSession(key, { url: "https://example.com", timeoutSeconds: 60 }));
    check("Browser creates a session with a CDP URL", session.cdpUrl.startsWith("wss://"), `${ms} ms`);
    try {
      // The real driver (playwright-core over CDP), as the assistant's browser tools use it.
      const [page, connectMs] = await timed(() => connectBrowser(session.cdpUrl));
      await page.goto("https://example.com/");
      const snapshot = await page.snapshot();
      check("the assistant's driver reads the page over CDP", /Example Domain/i.test(snapshot.title) && snapshot.elements.length > 0, `${connectMs} ms to connect; title “${snapshot.title}”, ${snapshot.elements.length} elements`);
      await page.disconnect();
    } catch (error) {
      check("the assistant's driver reads the page over CDP", false, error instanceof Error ? error.message.slice(0, 200) : String(error));
    }
    await deleteTinyfishBrowserSession(key, session.sessionId);
    await deleteTinyfishBrowserSession(key, session.sessionId);
    check("Browser ends the session, twice without error", true);
  } catch (error) {
    const detail = error instanceof TinyfishError ? `${error.status} ${error.code ?? ""} ${error.message}` : String(error);
    check("Browser session", false, detail);
  }
}

console.log(failures ? `\n${failures} live check(s) failed` : "\nTinyFish live checks passed");
process.exit(failures ? 1 : 0);

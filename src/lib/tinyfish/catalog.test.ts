import { describe, expect, test } from "bun:test";
import { fetchFailureText, keyHint, keyProblem, tinyfishFetchResult, tinyfishSearchHits, webUrl } from "./catalog";

// The live answer of 18 October 2026, trimmed (scratchpad record of the
// verification call): results carry position, site_name, title, snippet, url.
const searchAnswer = {
  query: "real estate agents Pune instagram",
  results: [
    { position: 1, site_name: "www.instagram.com", title: "Niyamat Nadir (@niyamatnadir) • Instagram photos and videos", snippet: "Pune Realtor @geminiproperties.pune.", url: "https://www.instagram.com/niyamatnadir/?hl=en" },
    { position: 2, site_name: "example.in", title: "Top   agents\nin Pune", snippet: "A list", url: "https://example.in/agents", date: "2026-09-01" },
    { position: 3, site_name: "x", title: "dup", snippet: "", url: "https://example.in/agents" },
    { position: 4, title: "bad scheme", url: "javascript:alert(1)" },
    { position: 5, title: "no url" },
  ],
  total_results: 5,
  page: 0,
};

describe("TinyFish search results", () => {
  test("keeps http(s) URLs once, in order, with cleaned text", () => {
    const hits = tinyfishSearchHits(searchAnswer);
    expect(hits.map((hit) => hit.url)).toEqual(["https://www.instagram.com/niyamatnadir/?hl=en", "https://example.in/agents"]);
    expect(hits[1]).toEqual({ url: "https://example.in/agents", title: "Top agents in Pune", snippet: "A list", site: "example.in", date: "2026-09-01" });
    expect(hits[0]!.date).toBeNull();
  });

  test("anything else is no results", () => {
    expect(tinyfishSearchHits(null)).toEqual([]);
    expect(tinyfishSearchHits({ results: "nope" })).toEqual([]);
    expect(tinyfishSearchHits(searchAnswer, 1)).toHaveLength(1);
  });
});

describe("TinyFish fetch results", () => {
  test("pages carry text, final URL and deduplicated public links; failures carry their code", () => {
    const { pages, failures } = tinyfishFetchResult({
      results: [{
        url: "https://acme.example/", final_url: "https://www.acme.example/home", title: "Acme", description: null, language: "en", published_date: null,
        text: "# Acme\nWe build things.", links: ["https://www.acme.example/contact", "https://www.acme.example/contact", "mailto:hi@acme.example", "ftp://x"],
      }],
      errors: [{ url: "https://gone.example/", error: "page_not_found", status: 404 }, { url: "https://slow.example/", error: "timeout" }],
    });
    expect(pages).toEqual([{
      url: "https://acme.example/", finalUrl: "https://www.acme.example/home", title: "Acme", description: null, language: "en", publishedDate: null,
      text: "# Acme\nWe build things.", links: ["https://www.acme.example/contact"],
    }]);
    expect(failures).toEqual([{ url: "https://gone.example/", code: "page_not_found", status: 404 }, { url: "https://slow.example/", code: "timeout", status: null }]);
    expect(fetchFailureText(failures[0]!)).toBe("the page does not exist");
    expect(fetchFailureText({ code: "login_required", status: null })).toBe("the page needs a login");
    expect(fetchFailureText({ code: "something_new", status: null })).toContain("something_new");
  });

  test("an answer without arrays reads as nothing", () => {
    expect(tinyfishFetchResult({})).toEqual({ pages: [], failures: [] });
    expect(tinyfishFetchResult("x")).toEqual({ pages: [], failures: [] });
  });
});

describe("keys and URLs", () => {
  test("hint shows the last four characters only", () => {
    expect(keyHint("sk-tinyfish-abcdefghijklmnop")).toBe("…mnop");
  });

  test("obvious non-keys are refused before any call", () => {
    expect(keyProblem("short")).not.toBeNull();
    expect(keyProblem("sk-tinyfish-has a space-in-it")).not.toBeNull();
    expect(keyProblem("sk-tinyfish-abcdefghijklmnop")).toBeNull();
  });

  test("webUrl accepts http(s) only", () => {
    expect(webUrl(" https://a.example/x ")).toBe("https://a.example/x");
    expect(webUrl("file:///etc/passwd")).toBeNull();
    expect(webUrl(42)).toBeNull();
  });
});

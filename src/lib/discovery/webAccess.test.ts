import { describe, expect, test } from "bun:test";
import type { ByokSettings } from "@/lib/ai/openrouter-types";
import { publicLinks } from "./contacts";
import { buildKeywordQueries, buildSearchQueries } from "./webDiscovery";
import { webSearchAvailabilityFrom, webSearchProviderName } from "./webSearch.server";

describe("links a read page offers", () => {
  const html = `
    <a href="/contact#form">Contact</a>
    <a href="https://www.acme.example/team">Team</a>
    <a href='https://partner.example/acme'>Partner</a>
    <a href="mailto:hi@acme.example">Mail</a>
    <a href="tel:+911234567">Call</a>
    <a href="javascript:void(0)">x</a>
    <a href="/contact">Contact again</a>
    <a href="ftp://files.acme.example/x">ftp</a>
    <a href="https://acme.example/">Home (the page itself)</a>`;

  test("same-site links come first, then others; no mail, phone, script, ftp, fragments or repeats", () => {
    expect(publicLinks(html, "https://acme.example/")).toEqual([
      "https://acme.example/contact",
      "https://www.acme.example/team",
      "https://partner.example/acme",
    ]);
  });

  test("the limit holds, and a bad base gives nothing", () => {
    expect(publicLinks(html, "https://acme.example/", 1)).toEqual(["https://acme.example/contact"]);
    expect(publicLinks(html, "not a url")).toEqual([]);
  });
});

describe("keyword searches for a search engine", () => {
  test("index-aligned with the sentence searches, Instagram last", () => {
    const input = { customers: "real estate agencies", where: "Pune", instagram: true };
    const sentences = buildSearchQueries(input);
    const keywords = buildKeywordQueries(input);
    expect(keywords).toEqual(["real estate agencies Pune", "real estate agencies Pune directory list", "real estate agencies Pune instagram"]);
    expect(keywords).toHaveLength(sentences.length);
    expect(buildKeywordQueries({ customers: "tile wholesalers", where: "Lagos" })).toHaveLength(2);
  });
});

describe("which web search a website search uses", () => {
  const settings = { connectionId: null } as unknown as ByokSettings;

  test("TinyFish first while it is on for web search, then Tavily", () => {
    expect(webSearchAvailabilityFrom(settings, null, { connected: true }, { connected: true, useForWebSearch: true })).toMatchObject({ available: true, provider: "tinyfish" });
    expect(webSearchAvailabilityFrom(settings, null, { connected: true }, { connected: true, useForWebSearch: false })).toMatchObject({ available: true, provider: "tavily" });
    expect(webSearchAvailabilityFrom(settings, null, null, { connected: true, useForWebSearch: false })).toMatchObject({ available: false });
  });

  test("an unavailable search names TinyFish as the free option", () => {
    expect(webSearchAvailabilityFrom(settings, null, null, null).reason).toContain("TinyFish");
  });

  test("each provider is named for what it is", () => {
    expect(webSearchProviderName("tinyfish")).toBe("TinyFish Search");
    expect(webSearchProviderName("tavily")).toBe("Tavily");
    expect(webSearchProviderName("openrouter")).toBe("OpenRouter web search");
    expect(webSearchProviderName("aimlapi")).toContain("web research");
    expect(webSearchProviderName(null)).toBe("web search");
  });
});

describe("a search's source and provider, as the owner reads them", () => {
  test("names both, and never calls a website fallback a Maps or Instagram search", async () => {
    const { sourceLabel } = await import("./discovery.server");
    expect(sourceLabel("maps", "scraper")).toBe("Google Maps through the built-in scraper");
    expect(sourceLabel("maps", "apify")).toBe("Google Maps through Apify");
    expect(sourceLabel("instagram", "apify")).toBe("Instagram through Apify");
    expect(sourceLabel("linkedin", "apify")).toBe("LinkedIn through Apify");
    expect(sourceLabel("instagram", "website")).toBe("Instagram (not searched; website search instead)");
  });
});

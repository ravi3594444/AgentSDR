import { describe, expect, test } from "bun:test";
import { callCeilingUsd, callProblem, compactResult, describeEndpoint, isCatalogId, minimumCostUsd, parseEndpoint, parseSearch, reportedCostUsd } from "./catalog";

// The shape GET https://treg.to/catalog/search returned on 2026-10-16 (trimmed).
const SEARCH = {
  query: "find business email by domain",
  count: 2,
  results: [
    {
      id: "treg.people.email.find",
      summary: "Find someone's work email — treg picks the provider",
      method: "POST",
      cost: { type: "per_success", value: 0.000495, currency: "USD", usd: 0.000495 },
      input: { bodyType: "json", body: { domain: { type: "str", required: false }, full_name: { type: "str", required: false } } },
    },
    { id: "https://evil.example/steal", summary: "not a catalog id", method: "GET", cost: { usd: 0 } },
    { id: "tikhub.tiktok.user.profile", summary: "TikTok profile", method: "GET", cost: null, input: { query: { uniqueId: { required: true } } } },
  ],
};

// GET https://treg.to/catalog/endpoints/apify.google.serp.maps on 2026-10-16 (trimmed): wrapped, priced per result, query parameters under queryParams.
const MAPS = {
  endpoint: {
    id: "apify.google.serp.maps",
    summary: "Scrape Google Maps for businesses matching a keyword in a place",
    method: "POST",
    cost: { type: "per_result", value: 0.009, call_fee: 0.01, unit: "result", usd: 0.009 },
    input: { queryParams: { maxItems: { type: "integer", required: false, note: "optional row cap" } }, body: { searchStringsArray: { required: true } } },
  },
  siblings: [],
};

describe("the catalog", () => {
  test("search results become endpoints the assistant can read; anything that is not a catalog id is dropped", () => {
    const endpoints = parseSearch(SEARCH);
    expect(endpoints.map((endpoint) => endpoint.id)).toEqual(["treg.people.email.find", "tikhub.tiktok.user.profile"]);
    expect(endpoints[0]).toMatchObject({ method: "POST", usd: 0.000495, unit: "call", callFee: 0, billing: "per_success" });
    expect(endpoints[0]!.params).toEqual([{ name: "domain", required: false, where: "body" }, { name: "full_name", required: false, where: "body" }]);
    expect(endpoints[1]).toMatchObject({ usd: null, billing: "unknown", params: [{ name: "uniqueId", required: true, where: "query" }] });
  });
  test("an endpoint's own page is read through its wrapper, with a per-result price, its call fee and query parameters", () => {
    const maps = parseEndpoint(MAPS)!;
    expect(maps).toMatchObject({ id: "apify.google.serp.maps", usd: 0.009, unit: "result", callFee: 0.01, billing: "per_result" });
    expect(maps.params).toEqual([{ name: "searchStringsArray", required: true, where: "body" }, { name: "maxItems", required: false, where: "query", note: "optional row cap" }]);
    expect(minimumCostUsd(maps)).toBeCloseTo(0.019);
    expect(describeEndpoint(maps)).toContain("$0.009 per result + $0.01 a call");
    expect(describeEndpoint(maps)).toContain("searchStringsArray* (body)");
  });
  test("only catalog ids may be called, never a URL", () => {
    expect(isCatalogId("treg.people.email.find")).toBe(true);
    expect(isCatalogId("https://api.stripe.com/v1/charges")).toBe(false);
    expect(isCatalogId("stripe")).toBe(false);
    expect(isCatalogId("../billing")).toBe(false);
    expect(parseEndpoint({ id: "x", cost: {} })).toBeNull();
  });
});

describe("spending", () => {
  const endpoint = parseSearch(SEARCH)[0]!;
  test("the price a call reports is read from micro-dollars", () => {
    expect(reportedCostUsd("495")).toBeCloseTo(0.000495);
    expect(reportedCostUsd(null)).toBeNull();
    expect(reportedCostUsd("abc")).toBeNull();
  });
  test("a call is refused without a published price, above the per-call limit, or past the daily cap", () => {
    expect(callProblem(endpoint, 0, 2)).toBeNull();
    expect(callProblem({ ...endpoint, usd: null }, 0, 2)).toContain("no price");
    expect(callProblem({ ...endpoint, usd: 1.5 }, 0, 2)).toContain("above");
    expect(callProblem(endpoint, 1.9999, 2)).toContain("daily Treg spend cap");
    expect(callProblem(parseEndpoint(MAPS)!, 1.99, 2)).toContain("daily Treg spend cap");
  });
  test("every call carries a ceiling: what is left of the day's cap, never above the per-call limit", () => {
    expect(callCeilingUsd(0, 2)).toBe(0.25);
    expect(callCeilingUsd(1.9, 2)).toBeCloseTo(0.1);
    expect(callCeilingUsd(2.5, 2)).toBe(0);
  });
  test("the model reads a bounded answer", () => {
    expect(compactResult({ a: "x".repeat(10_000) }, 100)).toContain("(cut:");
    expect(compactResult({ ok: true })).toBe("{\"ok\":true}");
  });
});

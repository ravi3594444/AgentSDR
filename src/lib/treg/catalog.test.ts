import { describe, expect, test } from "bun:test";
import { callProblem, compactResult, isCatalogId, parseEndpoint, parseSearch, reportedCostUsd } from "./catalog";

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

describe("the catalog", () => {
  test("search results become endpoints the assistant can read; anything that is not a catalog id is dropped", () => {
    const endpoints = parseSearch(SEARCH);
    expect(endpoints.map((endpoint) => endpoint.id)).toEqual(["treg.people.email.find", "tikhub.tiktok.user.profile"]);
    expect(endpoints[0]).toMatchObject({ method: "POST", usd: 0.000495, billing: "per_success" });
    expect(endpoints[0]!.params).toEqual([{ name: "domain", required: false, where: "body" }, { name: "full_name", required: false, where: "body" }]);
    expect(endpoints[1]).toMatchObject({ usd: null, billing: "unknown", params: [{ name: "uniqueId", required: true, where: "query" }] });
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
  });
  test("the model reads a bounded answer", () => {
    expect(compactResult({ a: "x".repeat(10_000) }, 100)).toContain("(cut:");
    expect(compactResult({ ok: true })).toBe("{\"ok\":true}");
  });
});

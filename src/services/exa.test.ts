import { afterAll, expect, test } from "bun:test";
import { ExaError, exaContents, exaReadCeiling, exaSearch, exaSearchCeiling, exaSearchInput, setExaApiBaseForTests } from "./exa";
import { groundingCorpus, ungroundedContacts } from "@/lib/assistant/agent";
import { spendFromLedgers } from "@/lib/assistant/objective";
import { isPlatformCredentialKey, PLATFORM_CREDENTIAL_INFO } from "@/lib/managed/catalog";

let status = 200;
let response: unknown = { results: [] };
let raw = false;
const requests: { url: string; key: string | null; body: Record<string, unknown> }[] = [];
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  requests.push({ url: request.url, key: request.headers.get("x-api-key"), body: await request.json() as Record<string, unknown> });
  return new Response(raw ? "bad-json" : JSON.stringify(response), { status, headers: { "Content-Type": "application/json", "Retry-After": "23" } });
} });
setExaApiBaseForTests(server.url.origin);
afterAll(() => { setExaApiBaseForTests(null); server.stop(true); });

test("Exa key is an operator credential with a secret field and a disclosed check", () => {
  expect(isPlatformCredentialKey("exa")).toBe(true);
  expect(PLATFORM_CREDENTIAL_INFO.exa.fields[0]?.secret).toBe(true);
  expect(PLATFORM_CREDENTIAL_INFO.exa.fields[0]?.help).toContain("metered search");
});

test("search accepts natural descriptions, correct auto wire format, source highlights and estimated cost", async () => {
  response = { results: [{ title: "Independent owner", url: "https://owner.example/about", highlights: ["Priya owns the company", "Contact priya@owner.example"], publishedDate: "2026-10-27" }, { url: "file:///secrets" }], requestId: "req-1", costDollars: { total: 0.007 }, notices: ["Some pages are cached"], warnings: ["Developer-only diagnostic"] };
  const result = await exaSearch("fixture-exa-secret", { query: "Independent manufacturers with a public owner contact", includeDomains: ["owner.example"] });
  const sent = requests.at(-1)!;
  expect(sent.key).toBe("fixture-exa-secret");
  expect(sent.url).not.toContain("secret");
  expect(sent.body).toMatchObject({ type: "auto", numResults: 10, contents: { highlights: true } });
  expect(sent.body).not.toHaveProperty("useAutoprompt");
  expect(result.results).toHaveLength(1);
  expect(result.results[0]?.snippet).toContain("priya@owner.example");
  expect(result.costUsd).toBe(0.007);
  expect(result.notices).toEqual(["Some pages are cached"]);
  expect(JSON.stringify(result)).not.toContain("Developer-only");
});

test("contents uses the current urls/text API and bounds page text", async () => {
  response = { results: [{ url: "https://owner.example/contact", text: "x".repeat(20_000) }], statuses: [{ id: "https://missing.example/", status: "error" }], costDollars: { total: 0.001 } };
  const result = await exaContents("fixture", ["https://owner.example/contact"]);
  expect(requests.at(-1)?.body).toEqual({ urls: ["https://owner.example/contact"], text: { maxCharacters: 12_000 } });
  expect(result.results[0]?.text).toHaveLength(12_000);
  expect(result.failures).toHaveLength(1);
});

test("provider rejection has one attempt, Retry-After, and no response-body or key leak", async () => {
  status = 429; response = { error: "fixture-exa-secret private provider details" };
  const before = requests.length;
  const error = await exaSearch("fixture-exa-secret", { query: "business owners" }).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(ExaError);
  expect((error as ExaError).retryAfterMs).toBe(23_000);
  expect((error as ExaError).uncertain).toBe(false);
  expect(String(error)).not.toContain("fixture-exa-secret");
  expect(requests.length).toBe(before + 1);
  status = 200;
});

test("unreadable success and server errors are uncertain, never silently retried", async () => {
  raw = true;
  const before = requests.length;
  const error = await exaSearch("fixture", { query: "business owners" }).catch((error: unknown) => error);
  expect((error as ExaError).uncertain).toBe(true);
  expect(requests.length).toBe(before + 1);
  raw = false; status = 503;
  expect((await exaSearch("fixture", { query: "business owners" }).catch((error: ExaError) => error) as ExaError).uncertain).toBe(true);
  status = 200;
});

test("bad arguments spend nothing and list-price reservations cover search/content", async () => {
  const before = requests.length;
  for (const numResults of [0, 101, 1.5, NaN]) expect(() => exaSearchInput({ query: "owners", numResults })).toThrow();
  expect(() => exaSearchInput({ query: "owners", includeDomains: "wrong" as unknown as string[] })).toThrow();
  expect(exaSearchCeiling(10)).toBe(0.007);
  expect(exaSearchCeiling(100)).toBe(0.187);
  expect(exaReadCeiling(10)).toBe(0.01);
  await expect(exaContents("fixture", [])).rejects.toThrow();
  expect(requests.length).toBe(before);
});

test("explicit cap accounting includes settled, reserved, uncertain and rejected Exa calls", () => {
  const rows = [
    { ledger: "usage" as const, provider: "exa", product: "search", status: "settled", units: 1, usedUnits: 1, costUsd: "0.007" },
    { ledger: "usage" as const, provider: "exa", product: "contents", status: "reserved", units: 2, usedUnits: null, costUsd: "0.002" },
    { ledger: "usage" as const, provider: "exa", product: "search", status: "uncertain", units: 1, usedUnits: 1, costUsd: "0.007" },
    { ledger: "usage" as const, provider: "exa", product: "search", status: "failed", units: 1, usedUnits: 0, costUsd: "0" },
  ];
  const spend = spendFromLedgers(rows);
  expect(spend.exaUsd).toBe(0.016);
  expect(spend.totalUsd).toBe(0.016);
  expect(spend.reservedUsd).toBe(0.002);
  expect(spend.uncertainUsd).toBe(0.007);
  expect(spend.settledUsd).toBe(0.014);
});

test("grounding uses only Exa returned highlights, never the model query or its summary", () => {
  const corpus = groundingCorpus([{ role: "tool", tool: "exa_search", status: "ok", content: "Search invented@fake.example", toolResult: { summary: "Query invented@fake.example", data: { results: [{ title: "Owner", url: "https://owner.example/", snippet: "Email priya@owner.example" }] } } }]);
  expect(corpus).toContain("priya@owner.example");
  expect(corpus).not.toContain("invented@fake.example");
  expect(ungroundedContacts([{ email: "priya@owner.example" }], corpus)).toEqual([]);
});

test("Exa page evidence strips an invented contact echoed from a URL query", () => {
  const corpus = groundingCorpus([{ role: "tool", tool: "exa_read", status: "ok", content: "Read pages", toolResult: { data: { pages: [{ url: "https://owner.example/search?q=phantom%40fake.example", title: "Results", body: "No results for phantom@fake.example. Contact priya@owner.example" }] } } }]);
  expect(corpus).toContain("priya@owner.example");
  expect(corpus).not.toContain("phantom@fake.example");
});

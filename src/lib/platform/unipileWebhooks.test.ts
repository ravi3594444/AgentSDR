import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isReplaceable, registerUnipileWebhooks, unipileWebhookEndpoints, unregisterUnipileWebhooks } from "./unipileWebhooks";

const ORG = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-8888-4777-8666-555555555555";
const ORIGIN = "https://sdr.example.com";
const credentials = { baseUrl: "https://api1.unipile.test:1000", apiKey: "key-123", notifySecret: "secret-abc" };

type Call = { method: string; url: string; body: Record<string, unknown> | null; headers: Record<string, string> };

let calls: Call[] = [];
let existing: Array<{ id: string; request_url: string }> = [];
let failCreate = false;
const realFetch = globalThis.fetch;
const savedUrl = process.env.BETTER_AUTH_URL;

beforeEach(() => {
  calls = [];
  failCreate = false;
  process.env.BETTER_AUTH_URL = ORIGIN;
  existing = [
    { id: "ours-old", request_url: `${ORIGIN}/api/webhooks/message-received?org=${ORG}` },
    { id: "manual", request_url: `${ORIGIN}/api/webhooks/whatsapp-message?secret=xyz` },
    { id: "other-org", request_url: `${ORIGIN}/api/webhooks/message-received?org=${OTHER}` },
    { id: "other-app", request_url: "https://elsewhere.example.org/hook" },
    { id: "other-path", request_url: `${ORIGIN}/api/something-else` },
  ];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, url, body, headers });
    if (method === "GET") return Response.json({ object: "WebhookList", items: existing, cursor: null });
    if (method === "DELETE") return Response.json({ object: "WebhookDeleted" });
    if (failCreate) return new Response("bad request", { status: 400 });
    return Response.json({ object: "WebhookCreated", webhook_id: `new-${calls.length}` }, { status: 201 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedUrl === undefined) delete process.env.BETTER_AUTH_URL;
  else process.env.BETTER_AUTH_URL = savedUrl;
});

describe("isReplaceable", () => {
  test("this organization's own registration", () => {
    expect(isReplaceable(`${ORIGIN}/api/webhooks/connection-accepted?org=${ORG}`, ORIGIN, ORG)).toBe(true);
  });
  test("a hand-made registration of one of our endpoints", () => {
    expect(isReplaceable(`${ORIGIN}/api/webhooks/whatsapp-message?secret=abc`, ORIGIN, ORG)).toBe(true);
    expect(isReplaceable(`${ORIGIN}/api/webhooks/connection-accepted`, ORIGIN, ORG)).toBe(true);
  });
  test("a retired endpoint, so a message never arrives twice", () => {
    expect(isReplaceable(`${ORIGIN}/api/webhooks/message-received?org=${ORG}`, ORIGIN, ORG)).toBe(true);
    expect(isReplaceable(`${ORIGIN}/api/webhooks/whatsapp-message?org=${ORG}`, ORIGIN, ORG)).toBe(true);
  });
  test("never another organization's", () => {
    expect(isReplaceable(`${ORIGIN}/api/webhooks/message-received?org=${OTHER}`, ORIGIN, ORG)).toBe(false);
  });
  test("never another origin, another path, or garbage", () => {
    expect(isReplaceable("https://elsewhere.example.org/api/webhooks/message-received", ORIGIN, ORG)).toBe(false);
    expect(isReplaceable(`${ORIGIN}/api/webhooks/unipile-account`, ORIGIN, ORG)).toBe(false);
    expect(isReplaceable("not a url", ORIGIN, ORG)).toBe(false);
  });
});

describe("unipileWebhookEndpoints", () => {
  test("one URL per webhook, each naming the organization", () => {
    const endpoints = unipileWebhookEndpoints(ORG)!;
    expect(endpoints.map((e) => e.url)).toEqual([
      `${ORIGIN}/api/webhooks/connection-accepted?org=${ORG}`,
      `${ORIGIN}/api/webhooks/unipile-message?org=${ORG}`,
      `${ORIGIN}/api/webhooks/unipile-email?org=${ORG}`,
    ]);
  });
  test("none without a public origin", () => {
    delete process.env.BETTER_AUTH_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(unipileWebhookEndpoints(ORG)).toBeNull();
  });
});

describe("registerUnipileWebhooks", () => {
  test("replaces ours and hand-made ones, keeps everyone else's, creates all three", async () => {
    const result = await registerUnipileWebhooks(ORG, credentials);
    expect(result.status).toBe("registered");
    expect(result.items?.map((i) => i.key)).toEqual(["connection-accepted", "unipile-message", "unipile-email"]);
    expect(result.items?.every((i) => i.id.startsWith("new-"))).toBe(true);

    const deleted = calls.filter((c) => c.method === "DELETE").map((c) => c.url.split("/webhooks/")[1]);
    expect(deleted.sort()).toEqual(["manual", "ours-old"]);

    const created = calls.filter((c) => c.method === "POST");
    expect(created).toHaveLength(3);
    for (const call of created) {
      expect(call.url).toBe(`${credentials.baseUrl}/api/v1/webhooks`);
      expect(call.headers["X-API-KEY"]).toBe("key-123");
      expect(String(call.body?.request_url)).toContain(`?org=${ORG}`);
      expect(call.body?.headers).toEqual([
        { key: "Content-Type", value: "application/json" },
        { key: "x-unipile-secret", value: "secret-abc" },
      ]);
    }
    const bySource = Object.fromEntries(created.map((c) => [String(c.body?.request_url).split("/api/webhooks/")[1].split("?")[0], c.body]));
    expect(bySource["connection-accepted"]).toMatchObject({ source: "users", events: ["new_relation"] });
    expect(bySource["unipile-message"]).toMatchObject({ source: "messaging", events: ["message_received", "message_read", "message_delivered"] });
    expect(bySource["unipile-email"]).toMatchObject({ source: "email", events: ["mail_received"] });
  });

  test("the secret never goes into a URL", async () => {
    await registerUnipileWebhooks(ORG, credentials);
    for (const call of calls.filter((c) => c.method === "POST")) {
      expect(String(call.body?.request_url)).not.toContain("secret");
    }
  });

  test("skips a local address without calling Unipile", async () => {
    process.env.BETTER_AUTH_URL = "http://localhost:3001";
    const result = await registerUnipileWebhooks(ORG, credentials);
    expect(result.status).toBe("skipped");
    expect(result.message).toContain("local address");
    expect(calls).toHaveLength(0);
  });

  test("reports Unipile's refusal instead of throwing", async () => {
    failCreate = true;
    const result = await registerUnipileWebhooks(ORG, credentials);
    expect(result.status).toBe("failed");
    expect(result.message).toContain("400");
  });
});

describe("unregisterUnipileWebhooks", () => {
  test("removes only this organization's own registrations", async () => {
    await unregisterUnipileWebhooks(ORG, credentials);
    const deleted = calls.filter((c) => c.method === "DELETE").map((c) => c.url.split("/webhooks/")[1]);
    expect(deleted).toEqual(["ours-old"]);
  });
});

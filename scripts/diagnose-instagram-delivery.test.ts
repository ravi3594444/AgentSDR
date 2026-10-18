import { expect, test } from "bun:test";
import { inspectInstagramProvider, redactDeliveryReport, type StoredDelivery } from "./diagnose-instagram-delivery";

const stored: StoredDelivery = {
  organizationId: "org-a", sender: "sender.shop", recipient: "dev__ravi_35",
  accountId: "account-a", messagingId: "17840000000000001", chatId: "chat-a",
  messageId: "message-a", body: "Hello\nHow can we help?", status: "sent",
};
const credentials = { baseUrl: "https://unipile.example.test", apiKey: "fixture-secret" };
function fixture(overrides: Record<string, unknown> = {}) {
  const calls: { path: string; method: string | undefined }[] = [];
  const bodies: Record<string, unknown> = {
    "/accounts/account-a": { type: "INSTAGRAM", connection_params: { im: { username: "sender.shop" } } },
    "/users/dev__ravi_35": { provider: "INSTAGRAM", username: "DEV__RAVI_35", provider_messaging_id: stored.messagingId },
    "/chats/chat-a": { id: "chat-a", account_id: "account-a", account_type: "INSTAGRAM" },
    "/messages/message-a": { id: "message-a", chat_id: "chat-a", account_id: "account-a", text: "Hello\r\nHow can we help?", is_sender: 1, delivered: 0, seen: 0 },
    "/chats/chat-a/attendees": { items: [{ is_self: 0, provider_id: stored.messagingId, profile_url: "https://instagram.com/dev__ravi_35/" }] },
    ...overrides,
  };
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname.replace(/^\/api\/v1/, "");
    calls.push({ path, method: init?.method });
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("X-API-KEY")).toBe(credentials.apiKey);
    const body = bodies[path];
    if (body instanceof Error) throw body;
    return body instanceof Response ? body : Response.json(body);
  }) as typeof fetch;
  return { calls, fetcher };
}

test("reads exactly the returned resources using GET, preserves handles and reports delivery false honestly", async () => {
  const f = fixture();
  const report = await inspectInstagramProvider(stored, credentials, f.fetcher);
  expect(f.calls).toHaveLength(5);
  expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  expect(report.account.matchesStoredSender).toBe(true);
  expect(report.recipient.matchesRequestedHandle).toBe(true);
  expect(report.recipient.matchesStoredMessagingId).toBe(true);
  expect(report.message.matchesStoredMessage).toBe(true);
  expect(report.message.matchesStoredChat).toBe(true);
  expect(report.message.matchesStoredAccount).toBe(true);
  expect(report.message.textMatchesApproved).toBe(true);
  expect(report.message.deliveredFlag).toBe(false);
  expect(report.message.seenFlag).toBe(false);
  expect(JSON.stringify(report)).not.toContain(stored.body);
  expect(JSON.stringify(report)).not.toContain(credentials.apiKey);
});

test("provider success never substitutes for missing message, account, body or receipt evidence", async () => {
  const f = fixture({ "/messages/message-a": {} });
  const report = await inspectInstagramProvider(stored, credentials, f.fetcher);
  expect(report.message.httpStatus).toBe(200);
  expect(report.message.matchesStoredMessage).toBeNull();
  expect(report.message.textMatchesApproved).toBeNull();
  expect(report.message.deliveredFlag).toBeNull();
  expect(report.message.seenFlag).toBeNull();
});

test("shows wrong account, chat, text and changed underscore identity without normalizing them away", async () => {
  const f = fixture({
    "/users/dev__ravi_35": { provider: "INSTAGRAM", username: "dev_ravi_35", provider_messaging_id: "other" },
    "/messages/message-a": { id: "message-a", account_id: "other-account", chat_id: "other-chat", text: "Different message", is_sender: 0 },
  });
  const report = await inspectInstagramProvider(stored, credentials, f.fetcher);
  expect(report.recipient.matchesRequestedHandle).toBe(false);
  expect(report.recipient.matchesStoredMessagingId).toBe(false);
  expect(report.message.matchesStoredAccount).toBe(false);
  expect(report.message.matchesStoredChat).toBe(false);
  expect(report.message.textMatchesApproved).toBe(false);
  expect(report.message.isFromConnectedSender).toBe(false);
});

test("a missing remote message and a timeout remain read failures and cause no retry or send", async () => {
  const f = fixture({
    "/messages/message-a": Response.json({ type: "errors/resource_not_found", detail: "private-provider-detail" }, { status: 404 }),
    "/chats/chat-a": new Error("network failure"),
  });
  const report = await inspectInstagramProvider(stored, credentials, f.fetcher);
  expect(f.calls).toHaveLength(5);
  expect(report.message.httpStatus).toBe(404);
  expect(report.message.problem).toBe("errors/resource_not_found");
  expect(report.chat.httpStatus).toBeNull();
  expect(JSON.stringify(report)).not.toContain("private-provider-detail");
});

test("refuses an unsafe DSN or missing IDs before any provider call", async () => {
  for (const baseUrl of ["http://example.test", "https://example.test/path", "https://user:password@example.test", "https://example.test?query=secret"]) {
    const f = fixture();
    await expect(inspectInstagramProvider(stored, { ...credentials, baseUrl }, f.fetcher)).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  }
  const f = fixture();
  await expect(inspectInstagramProvider({ ...stored, chatId: null }, credentials, f.fetcher)).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});

test("redacts credentials even if a provider echoes them in an allowed metadata field", () => {
  const secret = 'token"with-newline\nvalue';
  const output = redactDeliveryReport({ problem: secret, url: `https://example.test/?key=${encodeURIComponent(secret)}` }, [secret]);
  expect(output).not.toContain(JSON.stringify(secret).slice(1, -1));
  expect(output).not.toContain(encodeURIComponent(secret));
  expect(output).toContain("[REDACTED]");
});

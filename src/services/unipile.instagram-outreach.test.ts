import { expect, test } from "bun:test";
import { instagramOutreachTransport } from "./unipile.instagram-outreach";

test("raw v1 profile retains messaging ID and the DM uses it in multipart attendees_ids", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return Response.json(
      requests.length === 1
        ? {
            provider: "INSTAGRAM",
            username: "example.shop",
            pk: 123,
            provider_messaging_id: "dm-456",
          }
        : { chat_id: "chat-1", message_id: "message-1" },
    );
  }) as typeof fetch;
  const client = instagramOutreachTransport(
    { baseUrl: "https://unipile.example.test/api/v1/", apiKey: "fixture" },
    fetcher,
  );
  const recipient = await client.resolve("sender", "example.shop");
  expect(requests[0]?.url).toBe(
    "https://unipile.example.test/api/v1/users/example.shop?account_id=sender",
  );
  expect(await client.start("sender", recipient.messagingId, "Hello")).toEqual({
    chatId: "chat-1",
    messageId: "message-1",
  });
  const form = requests[1]?.init?.body as FormData;
  expect(form.getAll("attendees_ids")).toEqual(["dm-456"]);
  expect(form.get("account_id")).toBe("sender");
  expect(form.get("text")).toBe("Hello");
  expect(new Headers(requests[1]?.init?.headers).get("X-API-KEY")).toBe(
    "fixture",
  );
});

test("transport never retries a rejected, timed-out, unreadable or unconfirmed POST", async () => {
  for (const result of [
    () => Response.json({ title: "Recipient restricted" }, { status: 422 }),
    () => new Response("not JSON"),
    () => Response.json({}),
    () => {
      throw new Error("socket closed");
    },
  ]) {
    let calls = 0;
    const client = instagramOutreachTransport(
      { baseUrl: "https://unipile.example.test", apiKey: "fixture" },
      (async () => {
        calls++;
        return result();
      }) as unknown as typeof fetch,
    );
    await expect(client.start("sender", "dm-456", "Hello")).rejects.toThrow();
    expect(calls).toBe(1);
  }
});

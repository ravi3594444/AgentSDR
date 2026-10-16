import { describe, expect, test } from "bun:test";
import { INSTAGRAM_FRESH_MESSAGE_WINDOW_MS } from "./contract";
import {
  decideIngest,
  deliveryReceivedAt,
  instagramUsername,
  instagramWebhookEventKey,
  isHistoricalMessage,
  mapUnipileInstagramChat,
  mapUnipileInstagramMessage,
  messagePreview,
  parseInstagramWebhook,
  pickPendingSend,
} from "./parse";

const NOW = new Date("2026-10-16T10:00:00.000Z");
const ACCOUNT_ID = "17841400000000001";
const LEAD_ID = "17841400000000077";

/** A message_received delivery as Unipile v1 posts it for an Instagram account. */
function delivery(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: "message_received",
    account_type: "INSTAGRAM",
    account_id: "acc_ig_1",
    account_info: { type: "INSTAGRAM", user_id: ACCOUNT_ID },
    chat_id: "chat_1",
    message_id: "msg_1",
    message: "Do you deliver to Baner?",
    timestamp: "2026-10-16T09:59:58.000Z",
    is_sender: false,
    sender: {
      attendee_provider_id: LEAD_ID,
      attendee_name: "Jane Lead",
      attendee_profile_url: "https://www.instagram.com/jane.lead/",
    },
    attendees: [
      { attendee_provider_id: LEAD_ID, attendee_name: "Jane Lead", attendee_public_identifier: "jane.lead" },
      { attendee_provider_id: ACCOUNT_ID, attendee_name: "Bakery" },
    ],
    ...overrides,
  };
}

describe("parseInstagramWebhook", () => {
  test("reads an inbound message from the other person", () => {
    expect(parseInstagramWebhook(delivery(), NOW)).toEqual({
      kind: "message",
      unipileAccountId: "acc_ig_1",
      unipileChatId: "chat_1",
      unipileMessageId: "msg_1",
      isSender: false,
      counterpartyProviderId: LEAD_ID,
      counterpartyUsername: "jane.lead",
      counterpartyName: "Jane Lead",
      body: "Do you deliver to Baner?",
      attachments: [],
      sentAt: new Date("2026-10-16T09:59:58.000Z"),
    });
  });

  test("an echo flagged is_sender resolves the other person from the attendees", () => {
    const parsed = parseInstagramWebhook(delivery({
      is_sender: true,
      message: "Yes, every Saturday",
      sender: { attendee_provider_id: ACCOUNT_ID, attendee_name: "Bakery" },
    }), NOW);
    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") return;
    expect(parsed.isSender).toBe(true);
    expect(parsed.counterpartyProviderId).toBe(LEAD_ID);
    expect(parsed.counterpartyUsername).toBe("jane.lead");
    expect(parsed.counterpartyName).toBe("Jane Lead");
  });

  test("an echo is recognised by account_info.user_id even without is_sender", () => {
    const parsed = parseInstagramWebhook(delivery({
      is_sender: false,
      sender: { attendee_provider_id: ACCOUNT_ID, attendee_name: "Bakery" },
    }), NOW);
    expect(parsed.kind === "message" && parsed.isSender).toBe(true);
    expect(parsed.kind === "message" && parsed.counterpartyProviderId).toBe(LEAD_ID);
  });

  test("an echo is recognised by the account's stored id when the payload carries no account_info", () => {
    const payload = delivery({ account_info: undefined, is_sender: 0, sender: { attendee_provider_id: ACCOUNT_ID } });
    const unknown = parseInstagramWebhook(payload, NOW);
    // Without either hint the account's own message cannot be told apart from the lead's.
    expect(unknown.kind === "message" && unknown.isSender).toBe(false);
    const known = parseInstagramWebhook(payload, NOW, ACCOUNT_ID);
    expect(known.kind === "message" && known.isSender).toBe(true);
    expect(known.kind === "message" && known.counterpartyProviderId).toBe(LEAD_ID);
  });

  test("an echo without the other person among the attendees is ignored", () => {
    const parsed = parseInstagramWebhook(delivery({
      is_sender: true,
      sender: { attendee_provider_id: ACCOUNT_ID },
      attendees: [{ attendee_provider_id: ACCOUNT_ID }],
    }), NOW);
    expect(parsed).toEqual({ kind: "ignore", reason: "echo without a counterparty attendee" });
  });

  test("group chats are ignored, by flag or by attendee count", () => {
    expect(parseInstagramWebhook(delivery({ is_group: true }), NOW)).toEqual({ kind: "ignore", reason: "group chat" });
    expect(parseInstagramWebhook(delivery({ is_group: 1 }), NOW)).toEqual({ kind: "ignore", reason: "group chat" });
    const three = parseInstagramWebhook(delivery({
      attendees: [
        { attendee_provider_id: LEAD_ID },
        { attendee_provider_id: ACCOUNT_ID },
        { attendee_provider_id: "17841400000000099" },
      ],
    }), NOW);
    expect(three).toEqual({ kind: "ignore", reason: "group chat (several counterparties)" });
  });

  test("other providers' events are ignored, and a message must say it is Instagram", () => {
    expect(parseInstagramWebhook(delivery({ account_type: "WHATSAPP" }), NOW)).toEqual({ kind: "ignore", reason: "account_type WHATSAPP is not INSTAGRAM" });
    expect(parseInstagramWebhook(delivery({ account_type: "LINKEDIN" }), NOW).kind).toBe("ignore");
    expect(parseInstagramWebhook(delivery({ account_type: undefined }), NOW)).toEqual({ kind: "ignore", reason: "message_received without account_type" });
    expect(parseInstagramWebhook(delivery({ account_type: "instagram" }), NOW).kind).toBe("message");
  });

  test("a message without its ids is ignored", () => {
    expect(parseInstagramWebhook(delivery({ account_id: undefined }), NOW)).toEqual({ kind: "ignore", reason: "message_received without account_id" });
    expect(parseInstagramWebhook(delivery({ chat_id: "" }), NOW)).toEqual({ kind: "ignore", reason: "message_received without chat_id" });
    expect(parseInstagramWebhook(delivery({ message_id: undefined }), NOW)).toEqual({ kind: "ignore", reason: "message_received without message_id" });
    expect(parseInstagramWebhook(delivery({ sender: undefined }), NOW)).toEqual({ kind: "ignore", reason: "message without a sender" });
  });

  test("junk, other events and chat events are ignored", () => {
    expect(parseInstagramWebhook(null, NOW)).toEqual({ kind: "ignore", reason: "payload is not a JSON object" });
    expect(parseInstagramWebhook([], NOW).kind).toBe("ignore");
    expect(parseInstagramWebhook(delivery({ event: "message_reaction" }), NOW)).toEqual({ kind: "ignore", reason: 'event "message_reaction" is not handled' });
    expect(parseInstagramWebhook(delivery({ is_event: 1 }), NOW)).toEqual({ kind: "ignore", reason: "a chat event, not a message" });
  });

  test("read and delivered receipts are status events, even without account_type", () => {
    expect(parseInstagramWebhook({ event: "message_read", account_id: "acc_ig_1", message_id: "msg_1", timestamp: "2026-10-16T09:00:00.000Z" }, NOW)).toEqual({
      kind: "status",
      status: "read",
      unipileAccountId: "acc_ig_1",
      unipileMessageId: "msg_1",
      at: new Date("2026-10-16T09:00:00.000Z"),
    });
    const delivered = parseInstagramWebhook({ event: "message_delivered", account_type: "INSTAGRAM", message_id: "msg_2" }, NOW);
    expect(delivered).toEqual({ kind: "status", status: "delivered", unipileAccountId: null, unipileMessageId: "msg_2", at: NOW });
    expect(parseInstagramWebhook({ event: "message_read" }, NOW)).toEqual({ kind: "ignore", reason: "message_read without a message_id" });
  });

  test("attachments are read, and the time falls back to now", () => {
    const parsed = parseInstagramWebhook(delivery({
      message: "",
      timestamp: "not a date",
      attachments: [{ id: "a1", type: "img", mimetype: "image/jpeg" }, "junk"],
    }), NOW);
    expect(parsed.kind === "message" && parsed.attachments).toEqual([{ id: "a1", type: "img", name: null, mimeType: "image/jpeg" }]);
    expect(parsed.kind === "message" && parsed.sentAt).toEqual(NOW);
    expect(parsed.kind === "message" && parsed.body).toBe("");
  });
});

describe("instagramWebhookEventKey", () => {
  test("is prefixed and stable across retries of the same message", () => {
    const key = instagramWebhookEventKey(delivery());
    expect(key).toBe("instagram:message_received:v1:acc_ig_1:msg_1");
    expect(instagramWebhookEventKey({ ...delivery(), timestamp: "2026-10-16T10:05:00.000Z" })).toBe(key);
    expect(instagramWebhookEventKey(delivery({ message_id: "msg_2" }))).not.toBe(key);
  });

  test("without ids it falls back to a digest of the payload", () => {
    const key = instagramWebhookEventKey({ event: "message_read" });
    expect(key).toMatch(/^instagram:message_read:payload-sha256:[0-9a-f]{64}$/);
    expect(instagramWebhookEventKey({ event: "message_read" })).toBe(key);
    expect(instagramWebhookEventKey(null)).toMatch(/^instagram:unknown:payload-sha256:/);
  });
});

describe("isHistoricalMessage", () => {
  const cutoff = new Date("2026-10-16T08:00:00.000Z");

  test("a message sent before the account's cutoff is history; at or after it is not", () => {
    expect(isHistoricalMessage({ sentAt: new Date(cutoff.getTime() - 1), receivedAt: cutoff, historyCutoffAt: cutoff })).toBe(true);
    expect(isHistoricalMessage({ sentAt: cutoff, receivedAt: cutoff, historyCutoffAt: cutoff })).toBe(false);
    expect(isHistoricalMessage({ sentAt: new Date(cutoff.getTime() + 1), receivedAt: NOW, historyCutoffAt: cutoff })).toBe(false);
  });

  test("a message older than the fresh window when it arrives is history, exactly the window is not", () => {
    const edge = new Date(NOW.getTime() - INSTAGRAM_FRESH_MESSAGE_WINDOW_MS);
    expect(isHistoricalMessage({ sentAt: edge, receivedAt: NOW, historyCutoffAt: null })).toBe(false);
    expect(isHistoricalMessage({ sentAt: new Date(edge.getTime() - 1), receivedAt: NOW, historyCutoffAt: null })).toBe(true);
    expect(isHistoricalMessage({ sentAt: new Date(edge.getTime() - 1), receivedAt: NOW, historyCutoffAt: new Date(0) })).toBe(true);
  });

  test("a fresh message on an account without a cutoff is not history, nor is one from a clock running ahead", () => {
    expect(isHistoricalMessage({ sentAt: new Date(NOW.getTime() - 2000), receivedAt: NOW, historyCutoffAt: null })).toBe(false);
    expect(isHistoricalMessage({ sentAt: new Date(NOW.getTime() + 60_000), receivedAt: NOW, historyCutoffAt: null })).toBe(false);
  });
});

describe("deliveryReceivedAt", () => {
  test("a replay judges history from when the delivery first arrived, never from a time after now", () => {
    const arrived = new Date(NOW.getTime() - 40 * 60_000);
    expect(deliveryReceivedAt(arrived, NOW)).toEqual(arrived);
    expect(deliveryReceivedAt(NOW, NOW)).toEqual(NOW);
    // A database zone ahead of UTC makes the ledger's createdAt read hours late.
    expect(deliveryReceivedAt(new Date(NOW.getTime() + 5.5 * 3600_000), NOW)).toEqual(NOW);
  });
});

describe("echo matching", () => {
  const pending = [
    { id: "late", body: "See you Saturday", sentAt: new Date(NOW.getTime() - 10_000) },
    { id: "early", body: "See you Saturday ", sentAt: new Date(NOW.getTime() - 20_000) },
    { id: "stale", body: "See you Saturday", sentAt: new Date(NOW.getTime() - 10 * 60_000) },
    { id: "other", body: "Something else", sentAt: NOW },
  ];

  test("the oldest pending send with the same text, inside the window, wins", () => {
    expect(pickPendingSend(pending, { body: "See you Saturday" }, NOW)?.id).toBe("early");
    expect(pickPendingSend(pending, { body: "Unrelated" }, NOW)).toBeNull();
    expect(pickPendingSend([pending[2]!], { body: "See you Saturday" }, NOW)).toBeNull();
  });

  test("decideIngest: duplicate, lead, attach, phone", () => {
    expect(decideIngest({ isSender: false, alreadyStored: true, pendingMatch: null })).toEqual({ action: "duplicate" });
    expect(decideIngest({ isSender: false, alreadyStored: false, pendingMatch: null })).toEqual({ action: "store", origin: "lead" });
    expect(decideIngest({ isSender: true, alreadyStored: false, pendingMatch: pending[0]! })).toEqual({ action: "attach", pendingId: "late" });
    expect(decideIngest({ isSender: true, alreadyStored: false, pendingMatch: null })).toEqual({ action: "store", origin: "phone" });
  });
});

describe("Unipile list objects", () => {
  test("a one-to-one chat maps with the other person's id and username; a group has neither", () => {
    expect(mapUnipileInstagramChat({
      object: "Chat",
      id: "chat_9",
      type: 0,
      name: "Jane Lead",
      attendee_provider_id: LEAD_ID,
      attendee_public_identifier: "@jane.lead",
      timestamp: "2026-10-01T12:00:00.000Z",
      unread_count: 3,
    })).toEqual({
      unipileChatId: "chat_9",
      providerId: LEAD_ID,
      username: "jane.lead",
      name: "Jane Lead",
      isGroup: false,
      lastMessageAt: new Date("2026-10-01T12:00:00.000Z"),
    });
    const group = mapUnipileInstagramChat({ id: "chat_g", type: 1, name: "Team", attendee_provider_id: LEAD_ID });
    expect(group).toMatchObject({ isGroup: true, providerId: null, username: null });
    expect(mapUnipileInstagramChat({ id: "chat_h", is_group: true })?.isGroup).toBe(true);
    expect(mapUnipileInstagramChat({ name: "no id" })).toBeNull();
  });

  test("messages map; events, hidden, deleted and empty ones do not", () => {
    expect(mapUnipileInstagramMessage({ id: "m1", text: "Hello", timestamp: "2026-10-01T12:00:00.000Z", is_sender: 1, attachments: [] })).toEqual({
      unipileMessageId: "m1",
      isSender: true,
      body: "Hello",
      attachments: [],
      sentAt: new Date("2026-10-01T12:00:00.000Z"),
    });
    expect(mapUnipileInstagramMessage({ id: "m2", text: "", timestamp: "2026-10-01T12:00:00.000Z", attachments: [{ id: "a", type: "video" }] })?.attachments).toHaveLength(1);
    expect(mapUnipileInstagramMessage({ id: "m3", text: "x", timestamp: "2026-10-01T12:00:00.000Z", is_event: 1 })).toBeNull();
    expect(mapUnipileInstagramMessage({ id: "m4", text: "x", timestamp: "2026-10-01T12:00:00.000Z", hidden: true })).toBeNull();
    expect(mapUnipileInstagramMessage({ id: "m5", text: "x", timestamp: "2026-10-01T12:00:00.000Z", deleted: 1 })).toBeNull();
    expect(mapUnipileInstagramMessage({ id: "m6", text: "  ", timestamp: "2026-10-01T12:00:00.000Z" })).toBeNull();
    expect(mapUnipileInstagramMessage({ id: "m7", text: "x" })).toBeNull();
  });
});

describe("small readers", () => {
  test("usernames come from identifiers or profile URLs, never from anything else", () => {
    expect(instagramUsername("jane.lead")).toBe("jane.lead");
    expect(instagramUsername("@jane_lead")).toBe("jane_lead");
    expect(instagramUsername("https://www.instagram.com/jane.lead/?hl=en")).toBe("jane.lead");
    expect(instagramUsername("instagram.com/jane")).toBe("jane");
    expect(instagramUsername("https://example.com/jane")).toBeNull();
    expect(instagramUsername("not a username")).toBeNull();
    expect(instagramUsername(null)).toBeNull();
  });

  test("previews collapse whitespace and name attachments", () => {
    expect(messagePreview("  Hi\n there ", [])).toBe("Hi there");
    expect(messagePreview("", [{ id: null, type: "img", name: null, mimeType: null }])).toBe("Photo");
    expect(messagePreview("", [])).toBe("");
    expect(messagePreview("x".repeat(300), [])).toHaveLength(200);
  });
});

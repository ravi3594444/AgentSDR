import { createHash } from "node:crypto";
import { INSTAGRAM_FRESH_MESSAGE_WINDOW_MS, type InstagramAttachment, type InstagramMessageOrigin } from "./contract";

/**
 * Reading what Unipile (API v1) sends for Instagram — webhook deliveries and
 * the chat / message objects its list endpoints return — into plain
 * records. Pure and defensive: every field is optional here, and a payload
 * that cannot be understood becomes an "ignore" with a reason (logged on the
 * delivery), never a throw.
 *
 * Webhook payload fields relied on (Unipile's v1 "messaging" webhook, the
 * shape the WhatsApp and LinkedIn routes read): event, account_type,
 * account_id, chat_id, message_id, message, timestamp, is_sender, is_group,
 * is_event, sender.attendee_provider_id / attendee_name /
 * attendee_public_identifier / attendee_profile_url, attendees[] (the same
 * fields), account_info.user_id, attachments[].
 *
 * Instagram ids are opaque strings (Unipile's attendee_provider_id), compared
 * as given. The account's own sends also arrive as message_received: an echo
 * is told apart by is_sender, or by the sender being the account
 * (account_info.user_id, or the id stored for the account).
 */

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function str(value: unknown): string | null {
  if (typeof value === "string") return value.trim() ? value.trim() : null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** Unipile uses both booleans and 0/1 for flags. */
function flag(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function date(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function parseAttachments(value: unknown): InstagramAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const attachment = asObject(item);
    if (!attachment) return [];
    return [{
      id: str(attachment.id),
      type: str(attachment.type),
      name: str(attachment.file_name) ?? str(attachment.name),
      mimeType: str(attachment.mimetype) ?? str(attachment.mime_type) ?? str(attachment.mimeType),
    }];
  });
}

/** A one-line preview of a message for the chat list. */
export function messagePreview(body: string, attachments: InstagramAttachment[]): string {
  const text = body.replace(/\s+/g, " ").trim();
  if (text) return text.length > 200 ? `${text.slice(0, 199)}…` : text;
  const type = attachments[0]?.type;
  if (!type) return "";
  return type === "img" ? "Photo" : type === "audio" ? "Audio" : type === "video" ? "Video" : "Attachment";
}

const USERNAME = /^[A-Za-z0-9._]{1,30}$/;

/**
 * An Instagram username from a public identifier ("jane.doe", "@jane.doe")
 * or a profile URL ("https://www.instagram.com/jane.doe/"); null otherwise.
 */
export function instagramUsername(value: unknown): string | null {
  const text = str(value);
  if (!text) return null;
  const fromUrl = text.match(/^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([^/?#]+)/i);
  const candidate = (fromUrl ? fromUrl[1]! : text).replace(/^@/, "");
  return USERNAME.test(candidate) ? candidate : null;
}

// --- webhook -------------------------------------------------------------------

export type ParsedInstagramMessageEvent = {
  kind: "message";
  unipileAccountId: string;
  unipileChatId: string;
  unipileMessageId: string;
  /** true for a message the account itself sent (from AgentSDR or the Instagram app). */
  isSender: boolean;
  /** The other person's Instagram id (attendee_provider_id). */
  counterpartyProviderId: string;
  counterpartyUsername: string | null;
  counterpartyName: string | null;
  body: string;
  attachments: InstagramAttachment[];
  sentAt: Date;
};

export type ParsedInstagramStatusEvent = {
  kind: "status";
  status: "read" | "delivered";
  unipileAccountId: string | null;
  unipileMessageId: string;
  at: Date;
};

export type ParsedInstagramWebhook =
  | ParsedInstagramMessageEvent
  | ParsedInstagramStatusEvent
  | { kind: "ignore"; reason: string };

const STATUS_EVENTS: Record<string, ParsedInstagramStatusEvent["status"]> = {
  message_read: "read",
  message_delivered: "delivered",
};

type Attendee = { providerId: string | null; name: string | null; username: string | null };

function attendee(value: unknown): Attendee | null {
  const object = asObject(value);
  if (!object) return null;
  return {
    providerId: str(object.attendee_provider_id) ?? str(object.provider_id),
    name: str(object.attendee_name) ?? str(object.name),
    username:
      instagramUsername(object.attendee_public_identifier) ??
      instagramUsername(object.public_identifier) ??
      instagramUsername(object.attendee_profile_url) ??
      instagramUsername(object.profile_url),
  };
}

/**
 * One delivery of the messaging webhook. `accountProviderId` is the
 * account's own Instagram id when AgentSDR knows it (instagram_accounts.
 * provider_user_id): a message from that id is an echo even when the
 * payload says neither is_sender nor account_info.
 */
export function parseInstagramWebhook(payload: unknown, now = new Date(), accountProviderId: string | null = null): ParsedInstagramWebhook {
  const body = asObject(payload);
  if (!body) return { kind: "ignore", reason: "payload is not a JSON object" };

  const event = str(body.event) ?? "unknown";
  const accountType = str(body.account_type);
  if (accountType && accountType.toUpperCase() !== "INSTAGRAM") {
    return { kind: "ignore", reason: `account_type ${accountType} is not INSTAGRAM` };
  }
  const unipileAccountId = str(body.account_id);
  const unipileMessageId = str(body.message_id) ?? str(body.id);

  const statusEvent = STATUS_EVENTS[event];
  if (statusEvent) {
    if (!unipileMessageId) return { kind: "ignore", reason: `${event} without a message_id` };
    return {
      kind: "status",
      status: statusEvent,
      unipileAccountId,
      unipileMessageId,
      at: date(body.timestamp) ?? now,
    };
  }

  if (event !== "message_received") return { kind: "ignore", reason: `event "${event}" is not handled` };
  // Status events may omit account_type; a message must carry it, so a
  // LinkedIn or WhatsApp message can never be read as Instagram.
  if (!accountType) return { kind: "ignore", reason: "message_received without account_type" };
  if (!unipileAccountId) return { kind: "ignore", reason: "message_received without account_id" };
  const unipileChatId = str(body.chat_id);
  if (!unipileChatId) return { kind: "ignore", reason: "message_received without chat_id" };
  if (!unipileMessageId) return { kind: "ignore", reason: "message_received without message_id" };
  if (flag(body.is_event)) return { kind: "ignore", reason: "a chat event, not a message" };
  if (flag(body.is_group)) return { kind: "ignore", reason: "group chat" };

  // A one-to-one chat has at most two attendees, the account and the other
  // person; more is a group, which is never a lead.
  const attendees = (Array.isArray(body.attendees) ? body.attendees : [])
    .map(attendee)
    .filter((item): item is Attendee => Boolean(item?.providerId));
  if (new Set(attendees.map((item) => item.providerId)).size > 2) {
    return { kind: "ignore", reason: "group chat (several counterparties)" };
  }

  const ownIds = new Set([str(asObject(body.account_info)?.user_id), str(accountProviderId)].filter((id): id is string => Boolean(id)));
  const sender = attendee(body.sender);
  const senderId = sender?.providerId ?? null;
  const isSender = flag(body.is_sender) || (senderId !== null && ownIds.has(senderId));

  // The other person: the sender of an inbound message; on an echo the
  // attendee that is neither the account nor the sender (the account).
  let counterparty: Attendee | null;
  if (isSender) {
    counterparty = attendees.find((item) => !ownIds.has(item.providerId!) && item.providerId !== senderId) ?? null;
  } else {
    counterparty = senderId && !ownIds.has(senderId) ? sender : null;
  }
  if (!counterparty?.providerId) {
    return { kind: "ignore", reason: isSender ? "echo without a counterparty attendee" : "message without a sender" };
  }
  // The attendees' entry for the same person can carry what the sender lacks.
  const listed = attendees.find((item) => item.providerId === counterparty!.providerId);

  return {
    kind: "message",
    unipileAccountId,
    unipileChatId,
    unipileMessageId,
    isSender,
    counterpartyProviderId: counterparty.providerId,
    counterpartyUsername: counterparty.username ?? listed?.username ?? null,
    counterpartyName: counterparty.name ?? listed?.name ?? null,
    body: typeof body.message === "string" ? body.message : "",
    attachments: parseAttachments(body.attachments),
    sentAt: date(body.timestamp) ?? now,
  };
}

/**
 * The delivery's identity in the webhook ledger (WebhookEvent.providerEventKey),
 * collapsing Unipile's retries. Prefixed "instagram:" so it never collides
 * with another route's key for the same Unipile message.
 */
export function instagramWebhookEventKey(payload: unknown): string {
  const body = asObject(payload) ?? {};
  const event = str(body.event) ?? "unknown";
  const accountId = str(body.account_id);
  const messageId = str(body.message_id) ?? str(body.id);
  if (accountId && messageId) return `instagram:${event}:v1:${accountId}:${messageId}`;
  const digest = createHash("sha256").update(JSON.stringify(payload) ?? "null").digest("hex");
  return `instagram:${event}:payload-sha256:${digest}`;
}

// --- history ---------------------------------------------------------------------

/**
 * Whether a message is history rather than something to answer: sent before
 * the account's history cutoff (when AgentSDR first saw it connected), or
 * more than INSTAGRAM_FRESH_MESSAGE_WINDOW_MS before it reached AgentSDR (a
 * sync of old messages, e.g. right after linking). History is stored and
 * shown, but never counted unread, forwarded to the CRM or made an inquiry.
 */
export function isHistoricalMessage(input: { sentAt: Date; receivedAt: Date; historyCutoffAt: Date | null }): boolean {
  if (input.historyCutoffAt && input.sentAt.getTime() < input.historyCutoffAt.getTime()) return true;
  return input.receivedAt.getTime() - input.sentAt.getTime() > INSTAGRAM_FRESH_MESSAGE_WINDOW_MS;
}

// --- where a message came from -----------------------------------------------------

/** How long after an AgentSDR send its echo may arrive and still be recognised. */
export const ECHO_MATCH_WINDOW_MS = 2 * 60 * 1000;

export type PendingSend = { id: string; body: string; sentAt: Date };

function sameText(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/\r\n/g, "\n").trim();
  return normalize(left) === normalize(right);
}

/**
 * The AgentSDR send an echo belongs to: one stored without a Unipile id yet
 * (Unipile's echo can beat its own send response), same text, within the
 * window. The oldest wins, so two identical sends pair up in order.
 */
export function pickPendingSend(
  candidates: readonly PendingSend[],
  echo: { body: string },
  now: Date,
  windowMs = ECHO_MATCH_WINDOW_MS,
): PendingSend | null {
  const matches = candidates
    .filter((candidate) => sameText(candidate.body, echo.body))
    .filter((candidate) => Math.abs(now.getTime() - candidate.sentAt.getTime()) <= windowMs)
    .sort((left, right) => left.sentAt.getTime() - right.sentAt.getTime());
  return matches[0] ?? null;
}

export type IngestDecision =
  /** A row already has this Unipile id: a retried delivery, or the echo of our own send. */
  | { action: "duplicate" }
  /** The echo of an AgentSDR send still waiting for its id: attach it. */
  | { action: "attach"; pendingId: string }
  /** A new message to store, from the lead or typed in the Instagram app. */
  | { action: "store"; origin: InstagramMessageOrigin };

export function decideIngest(input: {
  isSender: boolean;
  alreadyStored: boolean;
  pendingMatch: PendingSend | null;
}): IngestDecision {
  if (input.alreadyStored) return { action: "duplicate" };
  if (!input.isSender) return { action: "store", origin: "lead" };
  if (input.pendingMatch) return { action: "attach", pendingId: input.pendingMatch.id };
  return { action: "store", origin: "phone" };
}

// --- Unipile list objects (history import) -------------------------------------------

export type UnipileInstagramChatRecord = {
  unipileChatId: string;
  /** The other person's Instagram id; null for a group. */
  providerId: string | null;
  username: string | null;
  name: string | null;
  isGroup: boolean;
  lastMessageAt: Date | null;
};

/** A Unipile Chat object (GET /chats). Null when it has no id. */
export function mapUnipileInstagramChat(item: unknown): UnipileInstagramChatRecord | null {
  const chat = asObject(item);
  const unipileChatId = str(chat?.id);
  if (!chat || !unipileChatId) return null;
  // type 0 is a one-to-one chat; 1 and 2 are groups and channels.
  const type = typeof chat.type === "number" ? chat.type : null;
  const isGroup = (type !== null && type !== 0) || flag(chat.is_group);
  const providerId = str(chat.attendee_provider_id);
  return {
    unipileChatId,
    providerId: isGroup ? null : providerId,
    username: isGroup
      ? null
      : instagramUsername(chat.attendee_public_identifier) ?? instagramUsername(chat.attendee_profile_url),
    name: str(chat.name),
    isGroup,
    lastMessageAt: date(chat.timestamp),
  };
}

export type UnipileInstagramMessageRecord = {
  unipileMessageId: string;
  isSender: boolean;
  body: string;
  attachments: InstagramAttachment[];
  sentAt: Date;
};

/**
 * A Unipile Message object (GET /chats/:id/messages). Null when it has no
 * id or time, or is not a real message (a chat event, hidden or deleted, or
 * empty).
 */
export function mapUnipileInstagramMessage(item: unknown): UnipileInstagramMessageRecord | null {
  const message = asObject(item);
  const unipileMessageId = str(message?.id);
  const sentAt = date(message?.timestamp);
  if (!message || !unipileMessageId || !sentAt) return null;
  if (flag(message.is_event) || flag(message.hidden) || flag(message.deleted)) return null;
  const body = typeof message.text === "string" ? message.text : "";
  const attachments = parseAttachments(message.attachments);
  if (!body.trim() && attachments.length === 0) return null;
  return { unipileMessageId, isSender: flag(message.is_sender), body, attachments, sentAt };
}

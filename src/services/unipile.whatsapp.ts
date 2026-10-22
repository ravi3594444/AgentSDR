import { getUnipileClient, unipileAccountItems } from "@/services/unipile.service";
import type { WhatsappAccountStatus } from "@/lib/whatsapp/contract";

/**
 * Unipile's WhatsApp side: the linked numbers, chats and sending. Kept apart
 * from unipile.service.ts, whose account reads are LinkedIn-only (type
 * LINKEDIN), so each provider syncs on its own.
 *
 * WhatsApp ids: a person is "<digits>@s.whatsapp.net" (digits = E.164
 * without the +); a group is "…@g.us" and is never a lead.
 *
 * Errors from the SDK propagate as thrown; callers read `.body?.status` /
 * `.status` to tell a refusal (4xx) from a failure.
 */

export type UnipileWhatsappAccount = {
  unipileAccountId: string;
  name: string | null;
  /** E.164, when Unipile reports one. */
  phone: string | null;
  status: WhatsappAccountStatus;
};

/** "+919876543210" → "919876543210@s.whatsapp.net". */
export function whatsappProviderId(e164: string): string {
  return `${e164.replace(/\D/g, "")}@s.whatsapp.net`;
}

/**
 * "919876543210@s.whatsapp.net" → "+919876543210"; null for a group, a
 * privacy id ("…@lid") or anything else. A device suffix
 * ("919876543210:12@s.whatsapp.net", how a linked account can report its own
 * id) is dropped.
 */
export function phoneFromProviderId(providerId: string | null | undefined): string | null {
  const match = providerId?.trim().match(/^(\d{6,15})(?::\d+)?@s\.whatsapp\.net$/);
  return match ? `+${match[1]}` : null;
}

/** A WhatsApp id without its device suffix, for comparing ids: "91…:12@s.whatsapp.net" → "91…@s.whatsapp.net". */
export function bareWhatsappJid(providerId: string | null | undefined): string | null {
  const value = providerId?.trim();
  if (!value) return null;
  return value.replace(/^([^@:]+):\d+@/, "$1@").toLowerCase();
}

/** A group chat id ("…@g.us") — never a lead. */
export function isWhatsappGroupId(providerId: string | null | undefined): boolean {
  return typeof providerId === "string" && providerId.trim().toLowerCase().endsWith("@g.us");
}

/** Unipile's account source status → ours. Exported for tests. */
export function whatsappAccountStatus(sourceStatus: unknown): WhatsappAccountStatus {
  switch (String(sourceStatus ?? "").toUpperCase()) {
    case "OK":
    case "RUNNING":
    case "CONNECTING":
      return "connected";
    case "CREDENTIALS":
      return "credentials";
    case "STOPPED":
    case "DISCONNECTED":
      return "disconnected";
    default:
      return "error";
  }
}

/** The account's own number: Unipile reports it in connection_params.im under varying keys. Exported for tests. */
export function whatsappAccountPhone(account: Record<string, unknown>): string | null {
  const im = ((account.connection_params as Record<string, unknown> | undefined)?.im ?? {}) as Record<string, unknown>;
  for (const value of [im.phone_number, im.phoneNumber, im.id, im.username, account.name]) {
    if (typeof value !== "string") continue;
    const fromId = phoneFromProviderId(value);
    if (fromId) return fromId;
    const digits = value.replace(/[\s()+-]/g, "");
    if (/^\d{8,15}$/.test(digits)) return `+${digits}`;
  }
  return null;
}

/** Every WhatsApp number linked to this Unipile workspace. */
export async function listUnipileWhatsappAccounts(): Promise<UnipileWhatsappAccount[]> {
  const response = (await (await getUnipileClient()).account.getAll({ limit: 250 })) as { items?: Record<string, unknown>[] };
  return unipileAccountItems(response)
    .filter((account) => account.type === "WHATSAPP")
    .map((account) => ({
      unipileAccountId: String(account.id),
      name: typeof account.name === "string" && account.name.trim() ? account.name.trim() : null,
      phone: whatsappAccountPhone(account),
      status: whatsappAccountStatus((account.sources as Array<{ status?: unknown }> | undefined)?.[0]?.status),
    }));
}

/** The existing chat between an account and a number, or null. */
export async function findUnipileWhatsappChat(unipileAccountId: string, e164: string): Promise<string | null> {
  try {
    const response = await (await getUnipileClient()).messaging.getAllChatsFromAttendee({
      attendee_id: whatsappProviderId(e164),
      account_id: unipileAccountId,
      limit: 1,
    });
    return (response.items?.[0] as { id?: string } | undefined)?.id ?? null;
  } catch {
    // Unipile answers 404 for a number it has never seen: no chat yet.
    return null;
  }
}

/** Starts a chat with a number and sends the first message. */
export async function startUnipileWhatsappChat(
  unipileAccountId: string,
  e164: string,
  text: string,
): Promise<{ chatId: string | null; messageId: string | null }> {
  const response = (await (await getUnipileClient()).messaging.startNewChat({
    account_id: unipileAccountId,
    attendees_ids: [whatsappProviderId(e164)],
    text,
  })) as { chat_id?: string | null; message_id?: string | null };
  return { chatId: response.chat_id ?? null, messageId: response.message_id ?? null };
}

/** Sends into an existing chat. */
export async function sendUnipileWhatsappMessage(chatId: string, text: string): Promise<{ messageId: string | null }> {
  const response = (await (await getUnipileClient()).messaging.sendMessage({ chat_id: chatId, text })) as {
    message_id?: string | null;
    id?: string | null;
  };
  return { messageId: response.message_id ?? response.id ?? null };
}

/** A page of an account's chats, newest first — for backfilling the Messages tab. */
export async function listUnipileWhatsappChats(
  unipileAccountId: string,
  cursor?: string,
): Promise<{ items: Record<string, unknown>[]; cursor: string | null }> {
  const response = (await (await getUnipileClient()).messaging.getAllChats({
    account_type: "WHATSAPP",
    account_id: unipileAccountId,
    limit: 50,
    ...(cursor ? { cursor } : {}),
  })) as { items?: Record<string, unknown>[]; cursor?: string | null };
  return { items: response.items ?? [], cursor: response.cursor ?? null };
}

/** A page of a chat's messages, newest first. */
export async function listUnipileWhatsappMessages(
  chatId: string,
  cursor?: string,
  limit = 100,
): Promise<{ items: Record<string, unknown>[]; cursor: string | null }> {
  const response = (await (await getUnipileClient()).messaging.getAllMessagesFromChat({
    chat_id: chatId,
    limit,
    ...(cursor ? { cursor } : {}),
  })) as { items?: Record<string, unknown>[]; cursor?: string | null };
  return { items: response.items ?? [], cursor: response.cursor ?? null };
}

/** The HTTP status a Unipile SDK error carries, when it does. */
export function unipileErrorStatus(error: unknown): number | null {
  const value = error as { status?: unknown; body?: { status?: unknown }; response?: { status?: unknown } } | null;
  const status = Number(value?.body?.status ?? value?.status ?? value?.response?.status);
  return Number.isInteger(status) && status > 0 ? status : null;
}

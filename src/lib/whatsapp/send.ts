import "server-only";

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { isPlatformNotConnectedError } from "@/lib/platform/credentials";
import { people } from "@/lib/leads/schema";
import { inOrg } from "@/lib/tenancy/scope";
import { normalizePhone } from "@/lib/calls/phone";
import { organizationPhoneCountry } from "@/lib/calls/phone.server";
import { callCampaignContacts, callCampaigns, callSessions } from "@/lib/calls/schema";
import { logCallMessage } from "@/lib/calls/campaigns";
import { isPersonDoNotContact } from "@/lib/crm/policies";
import {
  findUnipileWhatsappChat,
  sendUnipileWhatsappMessage,
  startUnipileWhatsappChat,
  unipileErrorStatus,
  whatsappProviderId,
} from "@/services/unipile.whatsapp";
import type { SendWhatsappRequest, SendWhatsappResponse } from "./contract";
import {
  getDefaultWhatsappAccountRow,
  getWhatsappAccountRow,
  type WhatsappAccountRow,
} from "./accounts";
import { recordWhatsappOutboundInCrm } from "./crmBridge";
import { WhatsappApiError, WhatsappSendRefusedError } from "./errors";
import { isRecipientNotOnWhatsapp } from "./refusal";
import { NEW_CHAT_WINDOW_MS, newChatRefusalDetail, secondsUntilNextSend, whatsappGuardrails } from "./guardrails";
import { channelRules } from "@/lib/channels/rules.server";
import {
  applyMessageToChat,
  chatInOrg,
  isPendingChatId,
  isUniqueViolation,
  matchPersonByPhone,
  messageInOrg,
  PENDING_CHAT_PREFIX,
  toWhatsappChatSummary,
  toWhatsappMessage,
  upsertWhatsappChat,
  visibleChat,
  type WhatsappChatRow,
  type WhatsappMessageRow,
} from "./messages";
import { whatsappAccounts, whatsappChats, whatsappMessages } from "./schema";

/**
 * Sending over WhatsApp through Unipile — POST /api/whatsapp/send and the
 * CRM's delivery (delivery.ts) share performWhatsappSend.
 *
 * Guardrails, per account and enforced here rather than in the UI (a banned
 * number also loses its calling): a new chat — a number this account has
 * never messaged — waits out the warm-up after linking and counts against
 * the daily new-chat cap; every AgentSDR send keeps the minimum spacing.
 * They are checked, and the send reserved, under a per-account advisory
 * lock, so two concurrent sends cannot both pass.
 *
 * The reservation is the message row itself, stored (origin "agentsdr", no
 * Unipile id yet) before Unipile is called: that is what the webhook matches
 * an early echo against. A new chat's row holds "pending:<uuid>" until
 * Unipile names the chat. If Unipile refuses or fails, both are removed.
 */

type SendTarget = {
  account: WhatsappAccountRow;
  /** The chat row when the conversation is already stored. */
  chat: WhatsappChatRow | null;
  /** A Unipile chat id known to the caller (the CRM conversation) but maybe not stored yet. */
  unipileChatId?: string | null;
  /** E.164; required when there is no chat. */
  phone: string | null;
  personId: string | null;
  text: string;
  callSessionId?: string | null;
};

type SendResult = { chat: WhatsappChatRow; message: WhatsappMessageRow };

const MAX_TEXT_LENGTH = 4096;

function sendLockKey(accountId: string): string {
  return `whatsapp-send:${accountId}`;
}

/** The stored chat with this number on this account, if any. */
async function storedChatWithPhone(accountId: string, phone: string): Promise<WhatsappChatRow | null> {
  const [row] = await db
    .select()
    .from(whatsappChats)
    .where(and(chatInOrg(), eq(whatsappChats.accountId, accountId), eq(whatsappChats.phone, phone), visibleChat))
    .orderBy(desc(whatsappChats.lastMessageAt), desc(whatsappChats.createdAt))
    .limit(1);
  return row ?? null;
}

export async function performWhatsappSend(target: SendTarget): Promise<SendResult> {
  const { account, text } = target;
  if (!text.trim()) throw new WhatsappSendRefusedError("The message is empty", 400, null, "empty");
  if (text.length > MAX_TEXT_LENGTH) throw new WhatsappSendRefusedError(`The message is longer than ${MAX_TEXT_LENGTH} characters`, 400, null, "too_long");
  if (account.status !== "connected") {
    throw new WhatsappSendRefusedError(`The WhatsApp number ${account.name ?? account.phone ?? ""} is ${account.status}, not connected`.replace(/\s+/g, " "), 409, null, "not_connected");
  }

  // Which chat: the stored one, else Unipile's existing chat with the
  // number, else a new chat.
  let chat = target.chat && !isPendingChatId(target.chat.unipileChatId) ? target.chat : null;
  let unipileChatId = chat?.unipileChatId ?? target.unipileChatId ?? null;
  const phone = chat?.phone ?? target.phone;
  if (!chat && !unipileChatId && phone) chat = await storedChatWithPhone(account.id, phone);
  unipileChatId = chat?.unipileChatId ?? unipileChatId;
  if (!unipileChatId && phone) unipileChatId = await findUnipileWhatsappChat(account.unipileAccountId, phone);
  if (!unipileChatId && !phone) throw new WhatsappSendRefusedError("There is no chat or number to send to", 400, null, "no_target");
  const isNewChat = !unipileChatId;

  const guardrails = whatsappGuardrails(await channelRules("whatsapp"), account);
  const reserved = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${sendLockKey(account.id)}, 0))`);
    const now = new Date();

    const [last] = await tx
      .select({ sentAt: whatsappMessages.sentAt })
      .from(whatsappMessages)
      .innerJoin(whatsappChats, eq(whatsappChats.id, whatsappMessages.chatId))
      .where(and(chatInOrg(), eq(whatsappChats.accountId, account.id), eq(whatsappMessages.origin, "agentsdr")))
      .orderBy(desc(whatsappMessages.sentAt))
      .limit(1);
    const lastSentAt = last?.sentAt ?? null;
    const wait = secondsUntilNextSend(lastSentAt, now, guardrails.minSecondsBetweenSends);
    if (wait > 0) {
      throw new WhatsappSendRefusedError(
        `This WhatsApp number sent a message moments ago. Wait ${wait} second${wait === 1 ? "" : "s"} between sends.`,
        429,
        wait,
        "send_gap",
      );
    }

    if (isNewChat) {
      // Chats this account started in the window: created then, and opened
      // by an AgentSDR send (a chat the lead opened, or the rep from their
      // phone, is not one AgentSDR started).
      const [started] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(whatsappChats)
        .where(and(
          chatInOrg(),
          eq(whatsappChats.accountId, account.id),
          gte(whatsappChats.createdAt, new Date(now.getTime() - NEW_CHAT_WINDOW_MS)),
          sql`(select m.origin from ${whatsappMessages} m where m.chat_id = ${whatsappChats.id} order by m.sent_at asc limit 1) = 'agentsdr'`,
        ));
      const [fresh] = await tx.select({ connectedAt: whatsappAccounts.connectedAt }).from(whatsappAccounts).where(and(inOrg(whatsappAccounts), eq(whatsappAccounts.id, account.id)));
      const refusal = newChatRefusalDetail({
        connectedAt: fresh?.connectedAt ?? account.connectedAt,
        newChatsInWindow: started?.count ?? 0,
        now,
        guardrails,
      });
      if (refusal) throw new WhatsappSendRefusedError(refusal.message, 409, null, refusal.reason);
    }

    let chatRow = chat;
    if (!chatRow && unipileChatId) {
      chatRow = await upsertWhatsappChat({
        accountId: account.id,
        unipileChatId,
        providerId: phone ? whatsappProviderId(phone) : null,
        phone,
        name: null,
      }, tx);
    }
    if (!chatRow) {
      const [placeholder] = await tx
        .insert(whatsappChats)
        .values({
          accountId: account.id,
          unipileChatId: `${PENDING_CHAT_PREFIX}${randomUUID()}`,
          providerId: whatsappProviderId(phone!),
          phone,
          personId: target.personId,
        })
        .returning();
      chatRow = placeholder;
    }
    if (!chatRow) throw new Error("whatsapp_chats insert returned no row");

    const [pending] = await tx
      .insert(whatsappMessages)
      .values({
        chatId: chatRow.id,
        unipileMessageId: null,
        direction: "outbound",
        origin: "agentsdr",
        body: text,
        attachments: [],
        sentAt: now,
        callSessionId: target.callSessionId ?? null,
      })
      .returning();
    if (!pending) throw new Error("whatsapp_messages insert returned no row");
    return { chat: chatRow, message: pending };
  });

  let unipileResult: { chatId: string | null; messageId: string | null };
  try {
    unipileResult = isNewChat
      ? await startUnipileWhatsappChat(account.unipileAccountId, phone!, text)
      : { chatId: unipileChatId, ...(await sendUnipileWhatsappMessage(unipileChatId!, text)) };
  } catch (error) {
    await db.delete(whatsappMessages).where(and(messageInOrg(), eq(whatsappMessages.id, reserved.message.id)));
    if (isNewChat) await db.delete(whatsappChats).where(and(chatInOrg(), eq(whatsappChats.id, reserved.chat.id)));
    if (isPlatformNotConnectedError(error)) throw error;
    throw unipileSendError(error);
  }

  return finalizeSend(account, reserved, isNewChat, phone, unipileResult);
}

function unipileSendError(error: unknown): Error {
  const status = unipileErrorStatus(error);
  const detail = (error as { body?: { detail?: unknown; title?: unknown } } | null)?.body;
  const reason = typeof detail?.detail === "string" ? detail.detail : typeof detail?.title === "string" ? detail.title : null;
  if (status === 429) return new WhatsappSendRefusedError(`WhatsApp is rate-limiting this number${reason ? `: ${reason}` : ""}. Try again later.`, 429, 60, "rate_limited");
  if (status && status >= 400 && status < 500) {
    // WhatsApp refused the recipient, not the request: the number has no
    // WhatsApp account (a Maps landline, a wrong number) or a locked profile.
    // Nothing was sent, and sending it again would be refused the same way.
    if (isRecipientNotOnWhatsapp(reason)) {
      return new WhatsappSendRefusedError(
        "This number is not on WhatsApp — WhatsApp refused the recipient, so nothing was sent",
        400,
        null,
        "not_on_whatsapp",
      );
    }
    // 401/403 is Unipile refusing the account or key, not this message.
    const cause = status === 401 || status === 403 ? "unauthorized" : "rejected";
    return new WhatsappSendRefusedError(`WhatsApp did not accept the message${reason ? `: ${reason}` : ` (${status})`}`, 400, null, cause);
  }
  console.error("Unipile WhatsApp send failed", error);
  return new WhatsappApiError(502, "WhatsApp (Unipile) could not be reached to send the message. Try again.");
}

/**
 * Gives the reserved rows their Unipile ids. The webhook may have been
 * first: it can have adopted the placeholder chat (fine), attached the
 * message id (fine), or — when it could not tell the echo was ours — stored
 * its own chat and message. Then AgentSDR's rows merge into those.
 */
async function finalizeSend(
  account: WhatsappAccountRow,
  reserved: SendResult,
  isNewChat: boolean,
  phone: string | null,
  result: { chatId: string | null; messageId: string | null },
): Promise<SendResult> {
  let chat = reserved.chat;
  let message = reserved.message;

  if (isNewChat) {
    const unipileChatId = result.chatId ?? (phone ? await findUnipileWhatsappChat(account.unipileAccountId, phone) : null);
    if (unipileChatId) chat = await settleNewChat(account, chat, message, unipileChatId);
    else console.warn(`[whatsapp/send] Unipile named no chat for new chat ${chat.id}; the first echo will adopt it`);
    if (chat.id !== message.chatId) message = { ...message, chatId: chat.id };
  }

  if (result.messageId) message = await settleMessageId(message, result.messageId);

  await applyMessageToChat(chat.id, { sentAt: message.sentAt, body: message.body, attachments: [], direction: "outbound", countUnread: false });
  const [freshChat] = await db.select().from(whatsappChats).where(and(chatInOrg(), eq(whatsappChats.id, chat.id))).limit(1);
  return { chat: freshChat ?? chat, message };
}

async function settleNewChat(
  account: WhatsappAccountRow,
  placeholder: WhatsappChatRow,
  message: WhatsappMessageRow,
  unipileChatId: string,
): Promise<WhatsappChatRow> {
  const [current] = await db.select().from(whatsappChats).where(and(chatInOrg(), eq(whatsappChats.id, placeholder.id))).limit(1);
  if (current?.unipileChatId === unipileChatId) return current; // the webhook adopted it
  const [other] = await db
    .select()
    .from(whatsappChats)
    .where(and(chatInOrg(), eq(whatsappChats.accountId, account.id), eq(whatsappChats.unipileChatId, unipileChatId)))
    .limit(1);
  if (!other && current) {
    try {
      const [renamed] = await db
        .update(whatsappChats)
        .set({ unipileChatId, updatedAt: new Date() })
        .where(and(chatInOrg(), eq(whatsappChats.id, placeholder.id)))
        .returning();
      if (renamed) return renamed;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    return settleNewChat(account, placeholder, message, unipileChatId);
  }
  if (!other) throw new Error(`WhatsApp chat ${placeholder.id} disappeared while sending`);
  // The webhook stored the chat first: move the send into it.
  await db.update(whatsappMessages).set({ chatId: other.id }).where(and(messageInOrg(), eq(whatsappMessages.id, message.id)));
  if (!other.personId && placeholder.personId) {
    await db.update(whatsappChats).set({ personId: placeholder.personId, updatedAt: new Date() }).where(and(chatInOrg(), eq(whatsappChats.id, other.id)));
  }
  await db.delete(whatsappChats).where(and(chatInOrg(), eq(whatsappChats.id, placeholder.id)));
  return other;
}

async function settleMessageId(message: WhatsappMessageRow, unipileMessageId: string): Promise<WhatsappMessageRow> {
  const [existing] = await db
    .select()
    .from(whatsappMessages)
    .where(and(messageInOrg(), eq(whatsappMessages.unipileMessageId, unipileMessageId)))
    .limit(1);
  if (existing?.id === message.id) return existing;
  if (existing) {
    // The echo was stored as typed on the phone before the send returned:
    // it is this send. Keep that row (it may already be on the CRM) as ours.
    const [merged] = await db
      .update(whatsappMessages)
      .set({
        origin: "agentsdr",
        chatId: message.chatId,
        callSessionId: sql`coalesce(${whatsappMessages.callSessionId}, ${message.callSessionId}::uuid)`,
      })
      .where(and(messageInOrg(), eq(whatsappMessages.id, existing.id)))
      .returning();
    await db.delete(whatsappMessages).where(and(messageInOrg(), eq(whatsappMessages.id, message.id)));
    return merged ?? existing;
  }
  try {
    const [updated] = await db
      .update(whatsappMessages)
      .set({ unipileMessageId })
      .where(and(messageInOrg(), eq(whatsappMessages.id, message.id)))
      .returning();
    return updated ?? message;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return settleMessageId(message, unipileMessageId);
  }
}

// --- POST /api/whatsapp/send ---------------------------------------------------------------

async function assertNotDoNotContact(personId: string | null): Promise<void> {
  if (personId && (await isPersonDoNotContact(db, personId))) {
    throw new WhatsappSendRefusedError("This lead is marked Do Not Contact", 409, null, "do_not_contact");
  }
}

/** The account to send from when the request names no chat. */
async function chooseAccount(accountId: string | undefined, phone: string): Promise<{ account: WhatsappAccountRow; chat: WhatsappChatRow | null }> {
  if (accountId) {
    const account = await getWhatsappAccountRow(accountId);
    if (!account) throw new WhatsappApiError(404, "WhatsApp account not found");
    return { account, chat: await storedChatWithPhone(account.id, phone) };
  }
  // The number already chatting with them, so the conversation stays on one number.
  const [existing] = await db
    .select({ chat: whatsappChats, account: whatsappAccounts })
    .from(whatsappChats)
    .innerJoin(whatsappAccounts, eq(whatsappAccounts.id, whatsappChats.accountId))
    .where(and(inOrg(whatsappAccounts), eq(whatsappChats.phone, phone), eq(whatsappAccounts.status, "connected"), visibleChat))
    .orderBy(desc(whatsappChats.lastMessageAt), asc(whatsappChats.createdAt))
    .limit(1);
  if (existing) return existing;
  const account = await getDefaultWhatsappAccountRow();
  if (!account) throw new WhatsappSendRefusedError("No WhatsApp number is linked. Link one in Unipile, then sync the accounts.", 409, null, "no_number");
  return { account, chat: null };
}

async function assertCallLinks(input: {
  personId: string | null;
  campaignContactId: string | null;
  callSessionId: string | null;
}): Promise<{ personId: string | null }> {
  let personId = input.personId;
  if (input.campaignContactId) {
    const [contact] = await db
      .select({ personId: callCampaignContacts.personId })
      .from(callCampaignContacts)
      .where(and(inArray(callCampaignContacts.campaignId, db.select({ id: callCampaigns.id }).from(callCampaigns).where(inOrg(callCampaigns))), eq(callCampaignContacts.id, input.campaignContactId)))
      .limit(1);
    if (!contact) throw new WhatsappApiError(404, "Campaign contact not found");
    if (personId && contact.personId !== personId) throw new WhatsappApiError(400, "campaignContactId belongs to another lead");
    if (!personId) throw new WhatsappApiError(400, "campaignContactId does not match this number's lead");
    personId = contact.personId;
  }
  if (input.callSessionId) {
    const [call] = await db
      .select({ personId: callSessions.personId, campaignContactId: callSessions.campaignContactId })
      .from(callSessions)
      .where(and(inOrg(callSessions), eq(callSessions.id, input.callSessionId)))
      .limit(1);
    if (!call) throw new WhatsappApiError(404, "Call not found");
    if (personId && call.personId !== personId) throw new WhatsappApiError(400, "callSessionId belongs to another lead");
    if (input.campaignContactId && call.campaignContactId !== input.campaignContactId) {
      throw new WhatsappApiError(400, "callSessionId does not belong to this campaign contact");
    }
  }
  return { personId };
}

export async function sendWhatsapp(request: SendWhatsappRequest): Promise<SendWhatsappResponse> {
  let account: WhatsappAccountRow;
  let chat: WhatsappChatRow | null = null;
  let phone: string | null;
  let personId: string | null;

  if (request.chatId) {
    const [row] = await db.select().from(whatsappChats).where(and(chatInOrg(), eq(whatsappChats.id, request.chatId), visibleChat)).limit(1);
    if (!row) throw new WhatsappApiError(404, "WhatsApp chat not found");
    if (request.accountId && request.accountId !== row.accountId) throw new WhatsappApiError(400, "chatId belongs to another WhatsApp number");
    const owner = await getWhatsappAccountRow(row.accountId);
    if (!owner) throw new WhatsappApiError(404, "WhatsApp account not found");
    account = owner;
    chat = row;
    phone = row.phone;
    personId = row.personId ?? (await matchPersonByPhone(row.phone));
  } else {
    if (request.personId) {
      const [person] = await db.select({ id: people.id, phone: people.phone }).from(people).where(and(inOrg(people), eq(people.id, request.personId))).limit(1);
      if (!person) throw new WhatsappApiError(404, "Person not found");
      if (!person.phone) throw new WhatsappSendRefusedError("This lead has no phone number", 400, null, "no_phone");
      phone = person.phone;
      personId = person.id;
    } else {
      phone = normalizePhone(request.phone ?? "", await organizationPhoneCountry());
      if (!phone) throw new WhatsappSendRefusedError("Enter the number with its country code, e.g. +91…", 400, null, "invalid_number");
      personId = await matchPersonByPhone(phone);
    }
    ({ account, chat } = await chooseAccount(request.accountId, phone));
  }

  const links = await assertCallLinks({
    personId,
    campaignContactId: request.campaignContactId ?? null,
    callSessionId: request.callSessionId ?? null,
  });
  personId = links.personId;
  await assertNotDoNotContact(personId);

  const sent = await performWhatsappSend({
    account,
    chat,
    phone,
    personId,
    text: request.text,
    callSessionId: request.callSessionId ?? null,
  });
  let message = sent.message;

  if (personId && message.unipileMessageId && !message.crmConversationMessageId) {
    const result = await recordWhatsappOutboundInCrm({
      personId,
      unipileAccountId: account.unipileAccountId,
      unipileChatId: sent.chat.unipileChatId,
      providerContactId: sent.chat.providerId,
      unipileMessageId: message.unipileMessageId,
      body: message.body,
      sentAt: message.sentAt,
      raw: null,
      origin: "agentsdr",
    });
    if (result.crmConversationMessageId) {
      const [updated] = await db
        .update(whatsappMessages)
        .set({ crmConversationMessageId: result.crmConversationMessageId })
        .where(and(messageInOrg(), eq(whatsappMessages.id, message.id)))
        .returning();
      message = updated ?? message;
    }
  }

  if (request.campaignContactId) {
    // The Calling panel's follow-up log (and its stage move), as when the
    // rep opened WhatsApp from there. The message is already sent, so a
    // failure here is logged, not returned.
    try {
      await logCallMessage(request.campaignContactId, { body: message.body, callId: request.callSessionId ?? undefined });
    } catch (error) {
      console.error("[whatsapp/send] call_messages log failed", error);
    }
  }

  return { chat: await toWhatsappChatSummary(sent.chat), message: toWhatsappMessage(message) };
}

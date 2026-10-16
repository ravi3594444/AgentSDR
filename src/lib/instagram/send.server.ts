import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { isPersonDoNotContact } from "@/lib/crm/policies";
import { featureEnabled } from "@/lib/features/flags.server";
import { isPlatformNotConnectedError } from "@/lib/platform/credentials";
import { inOrg } from "@/lib/tenancy/scope";
import { instagramAccountStatusFromError, instagramUnipileErrorStatus, sendUnipileInstagramMessage } from "@/services/unipile.instagram";
import { findInstagramAccountByUnipileId, markInstagramAccountUnusable } from "./accounts";
import {
  INSTAGRAM_MAX_MESSAGE_LENGTH,
  InstagramDeliveryError,
  InstagramSendRefusedError,
  type DeliverInstagramInput,
  type DeliverInstagramResult,
} from "./delivery";
import { applyMessageToChat, chatInOrg, isUniqueViolation, messageInOrg } from "./messages";
import { instagramAccounts, instagramChats, instagramMessages, type InstagramMessageRow } from "./schema";

/**
 * Sends one Instagram reply through Unipile — the CRM's delivery
 * (delivery.ts → src/lib/crm/send.ts). A reply only: into the chat the
 * person wrote in, from the account that chat is on. AgentSDR never starts
 * an Instagram chat.
 *
 * Refused (InstagramSendRefusedError, nothing reaches Instagram) when the
 * organization's Instagram feature is off, the account is unknown here or
 * not connected, the chat is not that account's in this organization, the
 * person is Do Not Contact, or the text is empty or longer than Instagram
 * allows.
 *
 * The reservation is the message row itself, stored (origin "agentsdr", no
 * Unipile id yet) under a per-account advisory lock before Unipile is
 * called: that is what the webhook matches an early echo against, and the
 * lock keeps an account's reservations in send order (the echo matcher
 * pairs identical texts oldest first). The Unipile call happens after the
 * reservation commits, so no pooled connection waits on Instagram. If
 * Unipile refuses (a 4xx other than a timeout — 409 and 429 included) the
 * row is removed and the failure is definite (InstagramDeliveryError
 * `definite`): the CRM fails the draft. If it cannot be reached, or answers
 * 408/5xx, the row stays — the message may have gone, and its echo will
 * attach to it (parse.ts ECHO_MATCH_WINDOW_MS) — and the CRM marks the
 * delivery uncertain. If it answers 2xx without naming the message, the
 * message was sent: the send succeeds without an id and the row waits for
 * its echo. When Unipile says the account itself is disconnected or its
 * credentials expired, the account is marked so (accounts.ts
 * markInstagramAccountUnusable): later sends are refused before Unipile.
 */

function sendLockKey(accountId: string): string {
  return `instagram-send:${accountId}`;
}

/** A 4xx other than a timeout: Unipile refused the request, so nothing reached Instagram. */
function refusedByUnipile(status: number | null): boolean {
  return status !== null && status >= 400 && status < 500 && status !== 408;
}

export async function performInstagramReply(input: DeliverInstagramInput): Promise<DeliverInstagramResult> {
  if (!(await featureEnabled("instagram"))) {
    throw new InstagramSendRefusedError("feature_off", "Instagram messages are off for this organization. An owner or admin can turn them on in Settings → Organization.");
  }
  const text = input.text;
  if (!text.trim()) throw new InstagramSendRefusedError("empty", "The message is empty");
  if (text.length > INSTAGRAM_MAX_MESSAGE_LENGTH) {
    throw new InstagramSendRefusedError("too_long", `Instagram messages are at most ${INSTAGRAM_MAX_MESSAGE_LENGTH.toLocaleString("en-US")} characters; this one is ${text.length.toLocaleString("en-US")}`);
  }

  const account = await findInstagramAccountByUnipileId(input.unipileAccountId);
  if (!account) throw new InstagramSendRefusedError("account_unknown", "This conversation's Instagram account is not linked to this organization");
  if (account.status !== "connected") {
    throw new InstagramSendRefusedError("not_connected", `The Instagram account ${account.username ? `@${account.username}` : account.name ?? ""} is ${account.status}, not connected`.replace(/\s+/g, " "));
  }

  if (!input.unipileChatId) throw new InstagramSendRefusedError("no_chat", "This conversation has no Instagram chat to reply in");
  const [chat] = await db
    .select()
    .from(instagramChats)
    .where(and(chatInOrg(), eq(instagramChats.accountId, account.id), eq(instagramChats.unipileChatId, input.unipileChatId)))
    .limit(1);
  if (!chat) throw new InstagramSendRefusedError("no_chat", "The Instagram chat to reply in is not one of this account's chats");

  for (const personId of new Set([input.personId, chat.personId].filter((id): id is string => Boolean(id)))) {
    if (await isPersonDoNotContact(db, personId)) {
      throw new InstagramSendRefusedError("do_not_contact", "This person is marked Do Not Contact");
    }
  }

  const reserved = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${sendLockKey(account.id)}, 0))`);
    // Re-read under the lock: the account may have been disconnected meanwhile.
    const [fresh] = await tx
      .select({ status: instagramAccounts.status })
      .from(instagramAccounts)
      .where(and(inOrg(instagramAccounts), eq(instagramAccounts.id, account.id)))
      .limit(1);
    if (fresh?.status !== "connected") throw new InstagramSendRefusedError("not_connected", "The Instagram account is no longer connected");
    const [pending] = await tx
      .insert(instagramMessages)
      .values({
        chatId: chat.id,
        unipileMessageId: null,
        direction: "outbound",
        origin: "agentsdr",
        body: text,
        attachments: [],
        sentAt: new Date(),
        historical: false,
      })
      .returning();
    if (!pending) throw new Error("instagram_messages insert returned no row");
    return pending;
  });

  let messageId: string | null;
  try {
    ({ messageId } = await sendUnipileInstagramMessage(chat.unipileChatId, text));
  } catch (error) {
    const status = instagramUnipileErrorStatus(error);
    if (isPlatformNotConnectedError(error) || refusedByUnipile(status)) {
      await db.delete(instagramMessages).where(and(messageInOrg(), eq(instagramMessages.id, reserved.id)));
    }
    if (isPlatformNotConnectedError(error)) throw error;
    const accountProblem = instagramAccountStatusFromError(error);
    if (accountProblem) {
      const marked = await markInstagramAccountUnusable(account.id, accountProblem).catch((markError: unknown) => {
        console.error("[instagram/send] could not mark the account", markError);
        return false;
      });
      if (marked) console.warn(`[instagram/send] Unipile says account ${account.unipileAccountId} is ${accountProblem === "credentials" ? "out of valid credentials" : "disconnected"} — marked ${accountProblem}`);
    }
    if (refusedByUnipile(status)) {
      const detail = error instanceof Error ? error.message : String(error);
      const reconnect = accountProblem ? " — the Instagram account needs to be reconnected (Settings → Instagram accounts)" : "";
      throw new InstagramDeliveryError(status, `Instagram (Unipile) did not accept the message — ${detail}${reconnect}`, true);
    }
    console.error("[instagram/send] Unipile send failed", error);
    throw new InstagramDeliveryError(status, "Instagram (Unipile) could not be reached to send the message; it may or may not have been sent");
  }

  let message: InstagramMessageRow = reserved;
  if (messageId) {
    message = await settleMessageId(reserved, messageId);
  } else {
    // Unipile took it (2xx) without naming it: it was sent. Its echo may
    // already have named it; otherwise the reserved row keeps waiting for
    // the echo, which attaches the id. Reporting this as uncertain would
    // invite a manual resend — a duplicate.
    const [current] = await db.select().from(instagramMessages).where(and(messageInOrg(), eq(instagramMessages.id, reserved.id))).limit(1);
    if (current) message = current;
    if (!message.unipileMessageId) console.warn(`[instagram/send] Unipile accepted message ${reserved.id} without an id; its echo will name it`);
  }

  await applyMessageToChat(chat.id, { sentAt: message.sentAt, body: message.body, attachments: [], direction: "outbound", countUnread: false });
  return {
    unipileMessageId: message.unipileMessageId,
    unipileChatId: chat.unipileChatId,
    instagramMessageId: message.id,
  };
}

/**
 * Gives the reserved row its Unipile id. The webhook may have been first: it
 * attached the id (fine), or — when it could not tell the echo was ours —
 * stored it as typed in the app. Then that row is this send: it is kept,
 * marked as AgentSDR's, and the reservation goes.
 */
async function settleMessageId(message: InstagramMessageRow, unipileMessageId: string): Promise<InstagramMessageRow> {
  const [existing] = await db
    .select()
    .from(instagramMessages)
    .where(and(messageInOrg(), eq(instagramMessages.unipileMessageId, unipileMessageId)))
    .limit(1);
  if (existing?.id === message.id) return existing;
  if (existing) {
    const [merged] = await db
      .update(instagramMessages)
      .set({ origin: "agentsdr", chatId: message.chatId, historical: false })
      .where(and(messageInOrg(), eq(instagramMessages.id, existing.id)))
      .returning();
    await db.delete(instagramMessages).where(and(messageInOrg(), eq(instagramMessages.id, message.id)));
    return merged ?? existing;
  }
  try {
    const [updated] = await db
      .update(instagramMessages)
      .set({ unipileMessageId })
      .where(and(messageInOrg(), eq(instagramMessages.id, message.id)))
      .returning();
    return updated ?? message;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return settleMessageId(message, unipileMessageId);
  }
}

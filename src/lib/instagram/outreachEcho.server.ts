import "server-only";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { isMissingTable } from "@/lib/features/flags.server";
import { inOrg } from "@/lib/tenancy/scope";
import {
  instagramChats,
  instagramMessages,
  instagramOutreachQueue,
  type InstagramAccountRow,
  type InstagramChatRow,
} from "./schema";
import type { ParsedInstagramMessageEvent } from "./parse";

/** Reconcile a webhook that arrives before the initial-DM HTTP response. */
export async function attachInitialInstagramEcho(
  account: InstagramAccountRow,
  chat: InstagramChatRow,
  event: ParsedInstagramMessageEvent,
): Promise<boolean> {
  if (!event.isSender || event.attachments.length) return false;
  try {
    return await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(instagramOutreachQueue)
        .where(
          and(
            inOrg(instagramOutreachQueue),
            eq(instagramOutreachQueue.accountId, account.id),
            eq(
              instagramOutreachQueue.messagingId,
              event.counterpartyProviderId,
            ),
            eq(instagramOutreachQueue.body, event.body),
            or(
              inArray(instagramOutreachQueue.status, ["sending", "uncertain"]),
              and(
                eq(instagramOutreachQueue.status, "sent"),
                isNull(instagramOutreachQueue.messageId),
              ),
            ),
            sql`${instagramOutreachQueue.attemptedAt} > now()-interval '15 minutes'`,
          ),
        )
        .for("update")
        .limit(2);
      if (rows.length !== 1) return false;
      const job = rows[0]!;
      if (chat.personId && chat.personId !== job.personId)
        throw new Error(
          "An Instagram outreach echo matched a different Person",
        );
      await tx
        .update(instagramChats)
        .set({ personId: job.personId, updatedAt: new Date() })
        .where(eq(instagramChats.id, chat.id));
      await tx
        .update(instagramChats)
        .set({
          lastMessageAt: event.sentAt,
          lastMessagePreview: event.body,
          lastDirection: "outbound",
        })
        .where(
          and(
            eq(instagramChats.id, chat.id),
            or(
              isNull(instagramChats.lastMessageAt),
              sql`${instagramChats.lastMessageAt} <= ${event.sentAt}`,
            ),
          ),
        );
      await tx
        .insert(instagramMessages)
        .values({
          id: job.id,
          chatId: chat.id,
          unipileMessageId: event.unipileMessageId,
          direction: "outbound",
          origin: "agentsdr",
          body: event.body,
          attachments: [],
          sentAt: event.sentAt,
          historical: false,
        })
        .onConflictDoUpdate({
          target: instagramMessages.id,
          set: { unipileMessageId: event.unipileMessageId },
        });
      await tx
        .update(instagramOutreachQueue)
        .set({
          status: "sent",
          sentAt: event.sentAt,
          chatId: event.unipileChatId,
          messageId: event.unipileMessageId,
          error: null,
          lockedBy: null,
          lockedUntil: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            inOrg(instagramOutreachQueue),
            eq(instagramOutreachQueue.id, job.id),
          ),
        );
      return true;
    });
  } catch (error) {
    if (isMissingTable(error)) return false;
    throw error;
  }
}

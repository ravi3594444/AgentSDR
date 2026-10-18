import "server-only";

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { normalizePhone } from "@/lib/calls/phone";
import { organizationPhoneCountry } from "@/lib/calls/phone.server";
import { isPersonDoNotContact } from "@/lib/crm/policies";
import { normalizeRoute } from "@/lib/crm/wrongNumber";
import { wrongRouteSendRefusal } from "@/lib/crm/wrongRoutes";
import { findUnipileWhatsappChat } from "@/services/unipile.whatsapp";
import { findWhatsappAccountByUnipileId } from "./accounts";
import { WhatsappSendRefusedError } from "./errors";
import { chatInOrg, isPendingChatId, matchPersonByPhone } from "./messages";
import { whatsappChats } from "./schema";
import { performWhatsappSend } from "./send";
import { BRAND } from "@/lib/brand";

/**
 * Sending a CRM draft over WhatsApp (src/lib/crm/send.ts's whatsapp branch).
 * Sends through Unipile — into the chat, or a new one with the number — and
 * stores the message in whatsapp_messages as origin "agentsdr", so the
 * webhook's echo of it is recognised rather than taken for a message typed
 * on the phone. Does NOT record it on the CRM conversation: send.ts does that
 * itself, inside its own send-attempt bookkeeping.
 *
 * The same guardrails as POST /api/whatsapp/send apply (warm-up, daily
 * new-chat cap, spacing); a refusal throws WhatsappSendRefusedError, which
 * send.ts treats as definite (not retried). Any other error (Unipile
 * unreachable, a 5xx) is a plain Error and nothing was stored.
 */

export { WhatsappSendRefusedError };

export type DeliverWhatsappInput = {
  /** The rep's number (whatsapp_accounts.unipile_account_id) — the CRM conversation's accountRef. */
  unipileAccountId: string;
  /** The chat, when the conversation already has one (providerThreadId). */
  unipileChatId: string | null;
  /** The lead's number, E.164 — used when there is no chat yet. */
  phone: string | null;
  text: string;
  /** A wrong-number closing acknowledgement in flight (its crm_wrong_routes row): the one send that route still takes. */
  wrongRouteAckId?: string | null;
};

export type DeliverWhatsappResult = {
  unipileChatId: string;
  unipileMessageId: string | null;
  /** The whatsapp_messages row. */
  whatsappMessageId: string;
};

export async function deliverWhatsappFromCrm(input: DeliverWhatsappInput): Promise<DeliverWhatsappResult> {
  const account = await findWhatsappAccountByUnipileId(input.unipileAccountId);
  if (!account) {
    throw new WhatsappSendRefusedError(`The conversation's WhatsApp number is not linked to ${BRAND.shortName} any more`, 409);
  }

  const [chat] = input.unipileChatId
    ? await db
      .select()
      .from(whatsappChats)
      .where(and(chatInOrg(), eq(whatsappChats.accountId, account.id), eq(whatsappChats.unipileChatId, input.unipileChatId)))
      .limit(1)
    : [];
  const phone = chat?.phone ?? (input.phone ? normalizePhone(input.phone, await organizationPhoneCountry()) : null);
  if (!chat && !input.unipileChatId && !phone) {
    throw new WhatsappSendRefusedError("The lead has no WhatsApp chat or phone number to send to", 400);
  }

  const personId = chat?.personId ?? (await matchPersonByPhone(phone));
  if (personId && (await isPersonDoNotContact(db, personId))) {
    throw new WhatsappSendRefusedError("This lead is marked Do Not Contact", 409);
  }
  const route = normalizeRoute("whatsapp", phone);
  const wrongNumber = route ? await wrongRouteSendRefusal(db, { channel: "whatsapp", routes: [route], ackRouteId: input.wrongRouteAckId ?? null }) : null;
  if (wrongNumber) throw new WhatsappSendRefusedError(wrongNumber, 409, null, "wrong_number");

  const sent = await performWhatsappSend({
    account,
    chat: chat ?? null,
    unipileChatId: input.unipileChatId,
    phone,
    personId,
    text: input.text,
  });

  let unipileChatId = sent.chat.unipileChatId;
  if (isPendingChatId(unipileChatId)) {
    // Unipile sent it but named no chat; the first echo will. Until then the
    // CRM keeps sending by number.
    unipileChatId = (phone ? await findUnipileWhatsappChat(account.unipileAccountId, phone) : null) ?? "";
  }
  return {
    unipileChatId,
    unipileMessageId: sent.message.unipileMessageId,
    whatsappMessageId: sent.message.id,
  };
}

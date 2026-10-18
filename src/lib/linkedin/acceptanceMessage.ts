import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { connections, leads, messages } from "@/lib/linkedin/schema";
import { deliverMessageToConnection, getChatIdForUser } from "@/services/unipile.service";
import { fillTemplate } from "@/lib/outreach/render";
import { isPersonDoNotContact } from "@/lib/crm/policies";
import { linkedinRouteIsWrong } from "@/lib/crm/wrongRoutes";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";

type AcceptanceLead = {
  id: string;
  personId: string;
  linkedinUrl: string;
  acceptanceMessage: string | null;
  variables: Record<string, string>;
};

type AcceptanceConnection = {
  id: string;
  providerId: string;
  chatId: string | null;
};

type AcceptanceAccount = {
  id: string;
  linkedinId: string;
};

const backfillInvitationConnection = (leadId: string, connectionId: string) =>
  db
    .update(messages)
    .set({ connectionId })
    .where(
      and(
        inOrg(messages),
        eq(messages.leadId, leadId),
        isNull(messages.connectionId),
        eq(messages.type, "INVITATION")
      )
    );

/** Resolve chatId, send acceptance (or start new chat), advance lead to ACCEPT_MESSAGE_SENT. */
export const processLeadAcceptance = async (
  lead: AcceptanceLead,
  connection: AcceptanceConnection,
  account: AcceptanceAccount,
  log: (msg: string) => void
): Promise<"sent" | "advanced" | "retry" | "blocked"> => {
  let chatId = connection.chatId;

  if (!chatId) {
    log("looking up chatId via Unipile");
    chatId = await getChatIdForUser(connection.providerId, account.linkedinId);
    if (chatId) {
      await db.update(connections).set({ chatId }).where(and(inOrg(connections), eq(connections.id, connection.id)));
      log(`chatId resolved: ${chatId}`);
    }
  }

  const acceptanceText = fillTemplate(lead.acceptanceMessage ?? "", lead.variables).trim();
  await backfillInvitationConnection(lead.id, connection.id);

  if (!acceptanceText) {
    await db
      .update(leads)
      .set({
        status: "ACCEPT_MESSAGE_SENT",
        linkedinAccountId: account.id,
        acceptMessageSentAt: new Date(),
      })
      .where(and(inOrg(leads), eq(leads.id, lead.id)));
    log("no acceptance message — advanced status without chat");
    return "advanced";
  }

  if (!chatId) {
    log("no existing chat — starting new chat via Unipile");
  }

  const [messageClaim] = await db.insert(messages).values({
    organizationId: currentOrganizationId(),
    type: "ACCEPTANCE",
    text: acceptanceText,
    connectionId: connection.id,
    leadId: lead.id,
    seen: true,
  }).onConflictDoNothing().returning({ id: messages.id });
  if (!messageClaim) {
    const [existingClaim] = await db.select({ providerMessageId: messages.linkedinMessageId })
      .from(messages)
      .where(and(inOrg(messages), eq(messages.leadId, lead.id), eq(messages.type, "ACCEPTANCE"), isNull(messages.duplicateOfMessageId)))
      .limit(1);
    if (!existingClaim?.providerMessageId) {
      log("acceptance has an uncertain provider outcome — reconciliation required");
      return "retry";
    }
    await db.update(leads).set({ status: "ACCEPT_MESSAGE_SENT", linkedinAccountId: account.id, acceptMessageSentAt: new Date() }).where(and(inOrg(leads), eq(leads.id, lead.id)));
    log("acceptance was already claimed or sent — advanced without duplicate delivery");
    return "advanced";
  }

  const barred = await isPersonDoNotContact(db, lead.personId) ? "Person-global DNC"
    : await linkedinRouteIsWrong(db, lead.personId, lead.linkedinUrl) ? "a wrong-number record" : null;
  if (barred) {
    await db.transaction(async (tx) => {
      await tx.delete(messages).where(and(inOrg(messages), eq(messages.id, messageClaim.id)));
      await tx.update(leads).set({ status: "FAILED" }).where(and(inOrg(leads), eq(leads.id, lead.id)));
    });
    log(`acceptance blocked by ${barred}`);
    return "blocked";
  }

  let delivered: Awaited<ReturnType<typeof deliverMessageToConnection>>;
  try {
    delivered = await deliverMessageToConnection(
      connection.providerId,
      account.linkedinId,
      acceptanceText,
      chatId
    );
  } catch (error) {
    // Keep the claim because the provider may have accepted the send before
    // the transport failed. Reconciliation, not an automatic retry, decides.
    throw error;
  }

  if (!delivered.chatId) {
    return "retry";
  }

  if (delivered.chatId !== chatId) {
    chatId = delivered.chatId;
    await db.update(connections).set({ chatId }).where(and(inOrg(connections), eq(connections.id, connection.id)));
  }

  await db.update(messages).set({ linkedinMessageId: delivered.messageId }).where(and(inOrg(messages), eq(messages.id, messageClaim.id)));

  await db
    .update(leads)
    .set({
      status: "ACCEPT_MESSAGE_SENT",
      linkedinAccountId: account.id,
      acceptMessageSentAt: new Date(),
    })
    .where(and(inOrg(leads), eq(leads.id, lead.id)));

  log(`acceptance sent — chatId: ${chatId}`);
  return "sent";
};

import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { people } from "@/lib/leads/schema";
import { CrmConflictError, CrmNotFoundError } from "./repository";
import { crmIdentityExceptions, type CrmChannel } from "./schema";
import { ingestInboundReplyInTransaction, type IngestInboundReplyInput } from "./conversations";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredText(value: unknown, label: string): string {
  const text = optionalText(value);
  if (!text) throw new CrmConflictError(`Cannot replay identity exception: ${label} is missing`);
  return text;
}

function replayDate(value: unknown, fallback: Date): Date {
  if (typeof value !== "string" && !(value instanceof Date)) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function providerContactId(payload: Record<string, unknown>, fallback: string | null): string | null {
  const canonical = optionalText(payload.providerContactId);
  if (canonical) return canonical;
  const historical = Object.entries(payload).find(([key, value]) =>
    key.toLowerCase().endsWith("leadid") && optionalText(value),
  );
  return optionalText(historical?.[1]) ?? fallback;
}

type IdentityException = typeof crmIdentityExceptions.$inferSelect;

/** Convert the durable quarantine payload back into canonical CRM ingestion. */
export function identityExceptionReplayInput(
  exception: IdentityException,
  personId: string,
): IngestInboundReplyInput {
  const payload = exception.payload;
  if (exception.channel === "linkedin") {
    return {
      personId,
      channel: "linkedin",
      accountRef: exception.accountRef,
      providerThreadId: optionalText(payload.chatId),
      providerContactId: optionalText(payload.providerId) ?? exception.identityValue,
      idempotencyKey: exception.sourceEventKey,
      providerMessageId: optionalText(payload.linkedinMessageId),
      bodyText: requiredText(payload.messageText, "LinkedIn message text"),
      raw: payload,
      sentAt: replayDate(payload.sentAt, exception.createdAt),
      actorRef: "identity-review",
    };
  }

  if (exception.channel === "whatsapp") {
    // The payload is the WhatsappCrmMessageInput crmBridge.ts quarantined.
    return {
      personId,
      channel: "whatsapp",
      accountRef: exception.accountRef,
      providerThreadId: optionalText(payload.unipileChatId),
      providerContactId: optionalText(payload.providerContactId) ?? exception.identityValue,
      idempotencyKey: exception.sourceEventKey,
      providerMessageId: optionalText(payload.unipileMessageId),
      bodyText: requiredText(payload.body, "WhatsApp message text"),
      raw: payload,
      sentAt: replayDate(payload.sentAt, exception.createdAt),
      actorRef: "identity-review",
    };
  }

  if (exception.channel === "instagram") {
    // The payload is the InstagramCrmMessageInput src/lib/instagram/crmBridge.ts quarantined.
    return {
      personId,
      channel: "instagram",
      accountRef: exception.accountRef,
      providerThreadId: optionalText(payload.unipileChatId),
      providerContactId: optionalText(payload.providerContactId) ?? exception.identityValue,
      idempotencyKey: exception.sourceEventKey,
      providerMessageId: optionalText(payload.unipileMessageId),
      bodyText: requiredText(payload.body, "Instagram message text"),
      raw: payload,
      sentAt: replayDate(payload.sentAt, exception.createdAt),
      actorRef: "identity-review",
    };
  }

  const gmailMessageId = optionalText(payload.gmailMessageId);
  if (gmailMessageId) {
    return {
      personId,
      channel: "email",
      accountRef: exception.accountRef,
      providerThreadId: optionalText(payload.threadId),
      providerContactId: exception.identityValue,
      idempotencyKey: exception.sourceEventKey,
      providerMessageId: optionalText(payload.messageId) ?? gmailMessageId,
      subject: optionalText(payload.subject),
      bodyText: requiredText(payload.bodyText, "Gmail message text"),
      raw: payload,
      sentAt: replayDate(payload.internalDate, exception.createdAt),
      actorRef: "identity-review",
    };
  }

  return {
    personId,
    channel: "email",
    accountRef: exception.accountRef,
    providerContactId: providerContactId(payload, exception.identityValue),
    idempotencyKey: exception.sourceEventKey,
    providerMessageId: optionalText(payload.messageId),
    subject: optionalText(payload.subject),
    bodyText: requiredText(payload.replyBody, "email reply text"),
    raw: payload,
    sentAt: replayDate(payload.repliedAt, exception.createdAt),
    actorRef: "identity-review",
  };
}

export async function quarantineCrmIdentity(input: {
  channel: CrmChannel;
  accountRef: string;
  sourceEventKey: string;
  identityValue?: string | null;
  reason: string;
  payload: Record<string, unknown>;
}) {
  const [row] = await db.insert(crmIdentityExceptions).values({
    organizationId: currentOrganizationId(),
    channel: input.channel,
    accountRef: input.accountRef.trim() || "unknown",
    sourceEventKey: input.sourceEventKey.trim(),
    identityValue: input.identityValue?.trim() || null,
    reason: input.reason.trim(),
    payload: input.payload,
  }).onConflictDoUpdate({
    target: [crmIdentityExceptions.channel, crmIdentityExceptions.accountRef, crmIdentityExceptions.sourceEventKey],
    set: { identityValue: input.identityValue?.trim() || null, reason: input.reason.trim(), payload: input.payload, updatedAt: new Date() },
    // The key is globally unique; never rewrite another organization's row.
    setWhere: inOrg(crmIdentityExceptions),
  }).returning();
  if (!row) throw new Error("CRM identity exception write did not return a row");
  return row;
}

export async function listCrmIdentityExceptions(status: "open" | "resolved" | "ignored" = "open") {
  return db.select().from(crmIdentityExceptions)
    .where(and(inOrg(crmIdentityExceptions), eq(crmIdentityExceptions.status, status)))
    .orderBy(desc(crmIdentityExceptions.createdAt));
}

export async function resolveCrmIdentityException(input: {
  id: string;
  status: "resolved" | "ignored";
  personId?: string | null;
}) {
  if (input.status === "resolved" && !input.personId) throw new Error("personId is required when resolving an identity exception");
  if (input.status === "ignored" && input.personId) throw new Error("Ignored identity exceptions cannot have a personId");
  return db.transaction(async (tx) => {
    const [exception] = await tx.select().from(crmIdentityExceptions)
      .where(and(inOrg(crmIdentityExceptions), eq(crmIdentityExceptions.id, input.id))).limit(1).for("update");
    if (!exception) throw new CrmNotFoundError("CRM identity exception", input.id);
    if (exception.status !== "open") throw new CrmConflictError("Only open identity exceptions can be reviewed");
    if (input.personId) {
      const [person] = await tx.select({ id: people.id }).from(people)
        .where(and(inOrg(people), eq(people.id, input.personId))).limit(1);
      if (!person) throw new CrmNotFoundError("Person", input.personId);
      // Resolution is not merely an administrative acknowledgement: replay
      // the quarantined inbound event so it reaches classification and the
      // Action Required queue. The exception and replay commit atomically.
      await ingestInboundReplyInTransaction(tx, identityExceptionReplayInput(exception, person.id));
    }
    const now = new Date();
    const [updated] = await tx.update(crmIdentityExceptions).set({
      status: input.status,
      resolvedPersonId: input.status === "resolved" ? input.personId! : null,
      resolvedAt: now,
      updatedAt: now,
    }).where(and(inOrg(crmIdentityExceptions), eq(crmIdentityExceptions.id, exception.id))).returning();
    return updated!;
  });
}

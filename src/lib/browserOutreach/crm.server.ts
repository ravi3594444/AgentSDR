import "server-only";

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ingestInboundReply } from "@/lib/crm/conversations";
import { recordManualOutboundInTransaction } from "@/lib/crm/manualOutbound";
import { resolvePipelineId } from "@/lib/crm/records";
import { type CrmTransaction, withCrmTransaction } from "@/lib/crm/repository";
import { crmConversations, crmRecords } from "@/lib/crm/schema";
import { inOrg } from "@/lib/tenancy/scope";
import type { MessagingSite } from "./routes";

/**
 * Browser messages in the CRM, on the "browser" channel. A conversation is
 * the person's route on a site (provider thread = the route's id), seen
 * from the account the owner's browser is signed in as there (account ref
 * "<site>:<handle>"). Like every outreach channel, a first message joins
 * the CRM with the person's first reply (the reply creates the record and
 * copies the browser messages already sent, outreachHistory.ts); a message
 * to someone who already has a record is recorded at once.
 */

export function browserAccountRef(site: MessagingSite, account: string): string {
  return `${site}:${account.trim()}`;
}

/** The record an outbound browser message belongs to, or null (no record yet: the first reply brings it in). */
async function recordFor(tx: CrmTransaction, personId: string, accountRef: string, routeId: string): Promise<string | null> {
  const [conversation] = await tx.select({ crmRecordId: crmConversations.crmRecordId, personId: crmConversations.personId }).from(crmConversations)
    .where(and(inOrg(crmConversations), eq(crmConversations.channel, "browser"), eq(crmConversations.accountRef, accountRef), eq(crmConversations.providerThreadId, routeId)))
    .limit(1);
  if (conversation) return conversation.personId === personId ? conversation.crmRecordId : null;
  const pipelineId = await resolvePipelineId(tx, undefined);
  const [record] = await tx.select({ id: crmRecords.id }).from(crmRecords)
    .where(and(inOrg(crmRecords), eq(crmRecords.personId, personId), eq(crmRecords.pipelineId, pipelineId))).limit(1);
  return record?.id ?? null;
}

/** A message the courier delivered (the page showed it) → the person's CRM conversation, when they have a record. */
export async function recordBrowserOutboundInCrm(input: {
  sendId: string;
  personId: string;
  routeId: string;
  site: MessagingSite;
  recipientHandle: string;
  account: string;
  body: string;
  sentAt: Date;
  threadUrl: string | null;
}): Promise<string | null> {
  const accountRef = browserAccountRef(input.site, input.account);
  try {
    return await withCrmTransaction(async (tx) => {
      const recordId = await recordFor(tx, input.personId, accountRef, input.routeId);
      if (!recordId) return null;
      const result = await recordManualOutboundInTransaction(tx, {
        recordId,
        personId: input.personId,
        channel: "browser",
        accountRef,
        providerThreadId: input.routeId,
        providerContactId: `${input.site}:${input.recipientHandle}`,
        idempotencyKey: `browser:${input.sendId}`,
        providerMessageId: null,
        bodyText: input.body,
        raw: { source: "browser_outreach_sends", id: input.sendId, origin: "agentsdr", threadUrl: input.threadUrl },
        sentAt: input.sentAt,
        reason: "manual_outbound_browser",
        actorType: "integration",
        actorRef: "browser",
        meta: { origin: "agentsdr" },
      });
      return result.message.id;
    });
  } catch (error) {
    console.error("[browser/crm] outbound recording failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

/** The idempotency key of a reply read from the page: the same words in the same conversation are the same message. */
export function browserReplyKey(routeId: string, text: string, seenBefore: number): string {
  return `browser-in:${routeId}:${createHash("sha256").update(`${seenBefore}\n${text.trim()}`).digest("hex").slice(0, 32)}`;
}

/** A reply read from the conversation in the owner's browser → the CRM, like any channel's reply. */
export async function forwardBrowserReplyToCrm(input: {
  personId: string;
  routeId: string;
  site: MessagingSite;
  recipientHandle: string;
  account: string;
  text: string;
  key: string;
  readAt: Date;
  threadUrl: string;
}): Promise<{ messageId: string; duplicate: boolean }> {
  const result = await ingestInboundReply({
    personId: input.personId,
    channel: "browser",
    accountRef: browserAccountRef(input.site, input.account),
    providerThreadId: input.routeId,
    providerContactId: `${input.site}:${input.recipientHandle}`,
    idempotencyKey: input.key,
    providerMessageId: null,
    bodyText: input.text.trim(),
    raw: { source: "browser_conversation", threadUrl: input.threadUrl, readAt: input.readAt.toISOString() },
    sentAt: input.readAt,
    actorRef: "browser",
  });
  return { messageId: result.message.id, duplicate: result.duplicate };
}

import "server-only";

import { and, eq } from "drizzle-orm";
import { featureEnabled } from "@/lib/features/flags.server";
import { cleanJson, cleanString } from "@/lib/grid/sanitize";
import { createProvisionalPerson, withLeadTransaction } from "@/lib/leads/records";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { LIMITS, truncate } from "./fields";
import { inquiries } from "./schema";

/**
 * Instagram inquiries: the first fresh message in a new chat from someone
 * AgentSDR does not know, on an account whose owner turned inquiry intake on
 * (and with the organization's Inquiry intake feature on). Called by the
 * Instagram webhook ingest (src/lib/instagram/messages.ts) inside the
 * organization's scope. Never called for imported or late (historical)
 * messages.
 *
 * One inquiry per sender per linked account: the de-duplication key is
 * `<unipileAccountId>:<providerId>`, so a retried webhook or a second chat
 * from the same sender returns the first inquiry's person instead of making
 * another. The person has no email or phone — Instagram is how to reach
 * them — and is created with createProvisionalPerson (source
 * "intake:instagram", raw.instagram = { username, providerId }). Nothing
 * here calls Unipile or sends anything. Every string is stored through
 * cleanString / cleanJson (no NUL bytes, no lone surrogates).
 */

export const INTAKE_INSTAGRAM_PERSON_SOURCE = "intake:instagram";

export type InstagramInquiryInput = {
  /** instagram_chats.id */
  chatId: string;
  /** The linked account's Unipile id (part of the de-duplication key). */
  unipileAccountId: string;
  /** The sender's Instagram id (Unipile attendee_provider_id). */
  providerId: string;
  username: string | null;
  name: string | null;
  /** Their message, word for word. */
  messageText: string;
  unipileMessageId: string;
  sentAt: Date;
};

export type InstagramInquiryResult = {
  /** The person the chat now belongs to; null when no inquiry was recorded. */
  personId: string | null;
  inquiryId: string | null;
  /** True when this sender already had an inquiry on this account (a retry, or a second chat). */
  duplicate: boolean;
};

export async function recordInstagramInquiry(input: InstagramInquiryInput): Promise<InstagramInquiryResult> {
  if (!(await featureEnabled("inquiry_intake"))) return { personId: null, inquiryId: null, duplicate: false };

  const providerId = cleanString(input.providerId);
  const dedupeKey = cleanString(`${input.unipileAccountId}:${input.providerId}`);
  const username = cleanString(input.username?.trim().replace(/^@/, "") ?? "") || null;
  const displayName = cleanString(input.name?.trim() ?? "") || (username ? `@${username}` : null);
  const message = input.messageText.trim() ? cleanString(truncate(input.messageText, LIMITS.message)) : null;

  return withLeadTransaction(async (tx): Promise<InstagramInquiryResult> => {
    const [inserted] = await tx.insert(inquiries).values({
      organizationId: currentOrganizationId(),
      source: "instagram",
      instagramChatId: input.chatId,
      dedupeKey,
      name: displayName ? cleanString(truncate(displayName, LIMITS.name)) : null,
      message,
      submittedAt: input.sentAt,
      raw: cleanJson({
        instagram: {
          username,
          providerId,
          unipileAccountId: input.unipileAccountId,
          unipileMessageId: input.unipileMessageId,
        },
      }),
    }).onConflictDoNothing({
      target: [inquiries.organizationId, inquiries.source, inquiries.dedupeKey],
    }).returning({ id: inquiries.id });

    if (!inserted) {
      const [original] = await tx.select({ id: inquiries.id, personId: inquiries.personId })
        .from(inquiries)
        .where(and(inOrg(inquiries), eq(inquiries.source, "instagram"), eq(inquiries.dedupeKey, dedupeKey)))
        .limit(1);
      return { personId: original?.personId ?? null, inquiryId: original?.id ?? null, duplicate: true };
    }

    const person = await createProvisionalPerson(tx, {
      fullName: displayName,
      raw: { instagram: { username, providerId } },
      source: INTAKE_INSTAGRAM_PERSON_SOURCE,
    });
    await tx.update(inquiries).set({ personId: person.id }).where(and(inOrg(inquiries), eq(inquiries.id, inserted.id)));
    return { personId: person.id, inquiryId: inserted.id, duplicate: false };
  });
}

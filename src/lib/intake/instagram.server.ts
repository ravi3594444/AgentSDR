import "server-only";

/**
 * Instagram inquiries: the first fresh message in a new chat from someone
 * AgentSDR does not know, on an account whose owner turned inquiry intake on
 * (and with the organization's Inquiry intake feature on). Called by the
 * Instagram webhook ingest (src/lib/instagram/messages.ts) inside the
 * organization's scope. Never called for imported or late (historical)
 * messages.
 */

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

/** Placeholder until inquiry intake lands: records nothing. */
export async function recordInstagramInquiry(input: InstagramInquiryInput): Promise<InstagramInquiryResult> {
  void input;
  return { personId: null, inquiryId: null, duplicate: false };
}

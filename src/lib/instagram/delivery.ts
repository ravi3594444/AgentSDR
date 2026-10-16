import "server-only";

/**
 * The CRM's way to send an Instagram reply (src/lib/crm/send.ts). Replies
 * only: into the chat the lead wrote in. AgentSDR never starts a new
 * Instagram chat. A refusal (`InstagramSendRefusedError`) means nothing
 * reached Instagram, so the CRM fails the draft instead of marking the
 * delivery uncertain.
 */

export type DeliverInstagramInput = {
  /** The Unipile account the conversation runs through (the CRM conversation's accountRef). */
  unipileAccountId: string;
  /** The Unipile chat to answer in (the CRM conversation's providerThreadId). */
  unipileChatId: string | null;
  text: string;
  personId: string | null;
};

export type DeliverInstagramResult = {
  unipileMessageId: string;
  unipileChatId: string;
  /** The instagram_messages row stored for the send. */
  instagramMessageId: string;
};

export type InstagramRefusalReason =
  | "feature_off"
  | "no_chat"
  | "not_connected"
  | "do_not_contact"
  | "empty"
  | "too_long"
  | "account_unknown";

export class InstagramSendRefusedError extends Error {
  constructor(readonly reason: InstagramRefusalReason, message: string) {
    super(message);
    this.name = "InstagramSendRefusedError";
  }
}

/** Instagram's own limit is 1,000 characters per direct message; longer replies are refused, never cut. */
export const INSTAGRAM_MAX_MESSAGE_LENGTH = 1_000;

export async function deliverInstagramFromCrm(input: DeliverInstagramInput): Promise<DeliverInstagramResult> {
  const { performInstagramReply } = await import("./send.server");
  return performInstagramReply(input);
}

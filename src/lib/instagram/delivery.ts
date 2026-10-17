import "server-only";

/**
 * The CRM's way to send an Instagram reply (src/lib/crm/send.ts). Replies
 * only: into the chat the lead wrote in. Approved initial DMs use the
 * separate outreach queue. A refusal (`InstagramSendRefusedError`), or Unipile
 * refusing the request (`InstagramDeliveryError` with `definite`), means
 * nothing reached Instagram, so the CRM fails the draft instead of marking
 * the delivery uncertain.
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
  /**
   * Unipile's id for the sent message; null when Unipile accepted it
   * without naming it — it was sent, and its echo attaches the id to the
   * stored row later.
   */
  unipileMessageId: string | null;
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

/**
 * Unipile did not take the message, or could not be reached. `status` is
 * Unipile's HTTP status when it answered. `definite` is true when Unipile
 * refused the request (a 4xx other than a timeout): nothing was sent and
 * nothing is kept, so the CRM fails the draft. Otherwise (a timeout, 5xx or
 * no answer) the message may have gone: its reserved row stays for the
 * echo, and the CRM marks the delivery uncertain to reconcile.
 */
export class InstagramDeliveryError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
    readonly definite = false,
  ) {
    super(message);
    this.name = "InstagramDeliveryError";
  }
}

/** Instagram's own limit is 1,000 characters per direct message; longer replies are refused, never cut. */
export const INSTAGRAM_MAX_MESSAGE_LENGTH = 1_000;

export async function deliverInstagramFromCrm(input: DeliverInstagramInput): Promise<DeliverInstagramResult> {
  const { performInstagramReply } = await import("./send.server");
  return performInstagramReply(input);
}

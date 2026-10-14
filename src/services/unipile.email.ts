import { getUnipileClient } from "@/services/unipile.service";
import { unipileEmailAccount, type UnipileEmailAccount } from "@/lib/outreach/unipileMail";

/**
 * Unipile's email side: the inboxes linked in the workspace, sending, and
 * reading one email. Kept apart from the LinkedIn (unipile.service.ts) and
 * WhatsApp (unipile.whatsapp.ts) reads, so each provider syncs on its own.
 *
 * Errors from the SDK propagate as thrown; callers read the status with
 * unipileErrorStatus (unipile.whatsapp.ts) to tell a refusal from a failure.
 */

/** Every email inbox linked to this organization's Unipile workspace. */
export async function listUnipileEmailAccounts(): Promise<UnipileEmailAccount[]> {
  const response = (await (await getUnipileClient()).account.getAll({ limit: 250 })) as { items?: Record<string, unknown>[] };
  return (response.items ?? []).map(unipileEmailAccount).filter((account): account is UnipileEmailAccount => Boolean(account));
}

/** One linked account, re-read; null when it is gone or not an email inbox. */
export async function getUnipileEmailAccount(unipileAccountId: string): Promise<UnipileEmailAccount | null> {
  const account = (await (await getUnipileClient()).account.getOne(unipileAccountId)) as unknown as Record<string, unknown>;
  return unipileEmailAccount(account);
}

export type UnipileEmailSend = {
  accountId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  /** HTML (or plain text); Unipile sends it as the body as given. */
  body: string;
  /** Unipile's id or the provider's id of the email this answers, to send it as a reply in that thread. */
  replyTo?: string | null;
};

/**
 * Sends one email from a linked inbox (POST /api/v1/emails). Unipile answers
 * with a tracking id and, when the provider reports it, the sent message's
 * provider id; the SDK's declared type lists only the first, so the second
 * is read off the response as returned.
 */
export async function sendUnipileEmail(input: UnipileEmailSend): Promise<{ providerId: string | null; trackingId: string | null }> {
  const address = (identifier: string) => ({ identifier });
  const response = (await (await getUnipileClient()).email.send({
    account_id: input.accountId,
    to: input.to.map(address),
    ...(input.cc?.length ? { cc: input.cc.map(address) } : {}),
    ...(input.bcc?.length ? { bcc: input.bcc.map(address) } : {}),
    subject: input.subject,
    body: input.body,
    ...(input.replyTo ? { reply_to: input.replyTo } : {}),
  })) as { tracking_id?: unknown; provider_id?: unknown };
  return {
    providerId: typeof response.provider_id === "string" && response.provider_id ? response.provider_id : null,
    trackingId: typeof response.tracking_id === "string" && response.tracking_id ? response.tracking_id : null,
  };
}

/** One email in full (GET /api/v1/emails/{id}), for a webhook delivery that came without its body. */
export async function getUnipileEmail(emailId: string): Promise<Record<string, unknown>> {
  return (await (await getUnipileClient()).email.getOne(emailId)) as unknown as Record<string, unknown>;
}

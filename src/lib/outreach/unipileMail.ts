import { dedupeAddresses, isValidEmail, normalizeEmail, type EmailAddress } from "@/lib/email/recipients";
import type { InboundMessage } from "./gmail";
import type { MailboxStatus } from "./schema";

/**
 * Email through Unipile: an inbox (Gmail, Outlook, iCloud, Exchange or any
 * IMAP account) that someone linked in their Unipile workspace, used as a
 * sending mailbox without Google Workspace. Pure shapes and mappers here, so
 * they are unit-tested; the API calls are in src/services/unipile.email.ts
 * and the mailbox rows in mailboxProviders.ts.
 */

/** Unipile account types that are an email inbox (checked against unipile-node-sdk 1.9.3's account types). */
export const UNIPILE_EMAIL_ACCOUNT_TYPES = ["GOOGLE_OAUTH", "OUTLOOK", "MAIL", "ICLOUD", "EXCHANGE"] as const;

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  GOOGLE_OAUTH: "Gmail",
  OUTLOOK: "Outlook",
  MAIL: "IMAP",
  ICLOUD: "iCloud",
  EXCHANGE: "Exchange",
};

export type UnipileEmailAccount = {
  unipileAccountId: string;
  /** Unipile's account type, e.g. GOOGLE_OAUTH. */
  type: string;
  /** "Gmail", "Outlook", … for messages. */
  typeLabel: string;
  /** The inbox address, lowercased; null when Unipile does not report one. */
  emailAddress: string | null;
  name: string | null;
  status: MailboxStatus;
  /** Why it cannot send, in words, when it cannot. */
  problem: string | null;
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function emailOrNull(value: unknown): string | null {
  const candidate = text(value);
  if (!candidate) return null;
  const email = normalizeEmail(candidate);
  return isValidEmail(email) ? email : null;
}

/** Unipile's account source status → the mailbox's, with the reason when it cannot send. */
export function unipileEmailAccountStatus(sourceStatus: unknown): { status: MailboxStatus; problem: string | null } {
  switch (String(sourceStatus ?? "").toUpperCase()) {
    case "OK":
    case "RUNNING":
      return { status: "connected", problem: null };
    case "CONNECTING":
      return { status: "connecting", problem: "Unipile is still connecting this account." };
    case "CREDENTIALS":
      return { status: "failed", problem: "Unipile lost access to this inbox: reconnect it in the Unipile dashboard." };
    case "PERMISSIONS":
      return { status: "failed", problem: "This inbox did not grant Unipile the permissions it needs: reconnect it in the Unipile dashboard." };
    case "STOPPED":
      return { status: "failed", problem: "This account is stopped in Unipile." };
    default:
      return { status: "failed", problem: "Unipile reports an error on this account; check it in the Unipile dashboard." };
  }
}

/**
 * One account from Unipile's GET /accounts as a sending mailbox; null for an
 * account that is not an email inbox (LinkedIn, WhatsApp, a calendar).
 * OAuth inboxes report the address at connection_params.mail.username, IMAP
 * ones at imap_user (or smtp_user).
 */
export function unipileEmailAccount(account: Record<string, unknown>): UnipileEmailAccount | null {
  const type = text(account.type)?.toUpperCase() ?? "";
  if (!(UNIPILE_EMAIL_ACCOUNT_TYPES as readonly string[]).includes(type)) return null;
  const id = text(account.id);
  if (!id) return null;
  const mail = (((account.connection_params as Record<string, unknown> | undefined)?.mail ?? {}) as Record<string, unknown>);
  const emailAddress = [mail.username, mail.imap_user, mail.smtp_user, mail.id, account.name].map(emailOrNull).find(Boolean) ?? null;
  const sources = Array.isArray(account.sources) ? (account.sources as Array<{ status?: unknown }>) : [];
  const { status, problem } = unipileEmailAccountStatus(sources[0]?.status);
  const name = text(account.name);
  return {
    unipileAccountId: id,
    type,
    typeLabel: ACCOUNT_TYPE_LABELS[type] ?? type,
    emailAddress,
    // An account named after its own address has no display name worth keeping.
    name: name && normalizeEmail(name) !== emailAddress ? name : null,
    status,
    problem,
  };
}

function attendee(value: unknown): EmailAddress | null {
  if (!value || typeof value !== "object") return null;
  const { identifier, display_name: displayName } = value as { identifier?: unknown; display_name?: unknown };
  const email = emailOrNull(identifier);
  if (!email) return null;
  const name = text(displayName);
  return { email, name: name && normalizeEmail(name) !== email ? name : null };
}

function attendees(value: unknown): EmailAddress[] {
  if (!Array.isArray(value)) return [];
  return dedupeAddresses(value.map(attendee).filter((address): address is EmailAddress => Boolean(address)));
}

/** An RFC 5322 Message-ID with its angle brackets, the form the CRM's threading reads; null otherwise. */
export function rfcMessageId(value: unknown): string | null {
  const id = text(value);
  if (!id) return null;
  if (/^<[^<>\s@]+@[^<>\s@]+>$/.test(id)) return id;
  return /^[^<>\s@]+@[^<>\s@]+$/.test(id) ? `<${id}>` : null;
}

function date(value: unknown): Date | null {
  const raw = text(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** An inbound email as the reply bridge takes it, plus Unipile's own id of it (what a reply is sent against). */
export type UnipileInboundMessage = InboundMessage & { unipileEmailId: string };

/**
 * A Unipile email (the `mail_received` webhook payload, or GET /emails/{id})
 * as the provider-neutral InboundMessage that ingestGmailReply files into the
 * Master Inbox and CRM. Null when it carries no id.
 *
 * `gmailMessageId` is the durable identity of the delivery: the provider's
 * own id (for a Gmail inbox, Gmail's message id) when Unipile reports it,
 * else Unipile's. `unipileEmailId` stays on the stored message so a reply
 * from the CRM can name it to Unipile.
 */
export function unipileMailToInbound(mail: Record<string, unknown>): UnipileInboundMessage | null {
  const unipileEmailId = text(mail.email_id) ?? text(mail.id);
  if (!unipileEmailId) return null;
  const from = attendee(mail.from_attendee);
  const to = attendees(mail.to_attendees);
  const cc = attendees(mail.cc_attendees);
  const inReplyTo = mail.in_reply_to && typeof mail.in_reply_to === "object"
    ? rfcMessageId((mail.in_reply_to as { message_id?: unknown }).message_id)
    : null;
  return {
    gmailMessageId: text(mail.provider_id) ?? unipileEmailId,
    unipileEmailId,
    threadId: text(mail.thread_id),
    fromEmail: from?.email ?? null,
    fromName: from?.name ?? null,
    toEmail: to[0]?.email ?? null,
    to,
    cc,
    replyTo: attendees(mail.reply_to_attendees),
    ccEmails: cc.map((address) => address.email),
    subject: text(mail.subject),
    // Plain text when Unipile has it; the bridge converts an HTML body itself.
    bodyText: text(mail.body_plain) ?? text(mail.body),
    messageId: rfcMessageId(mail.message_id),
    inReplyTo,
    internalDate: date(mail.date),
  };
}

/** The durable key of a Unipile email webhook delivery in the webhook ledger. */
export function unipileEmailEventKey(payload: Record<string, unknown>): string {
  const accountId = text(payload.account_id) ?? "unknown";
  const event = text(payload.event) ?? "unknown";
  const emailId = text(payload.email_id) ?? text(payload.id) ?? text(payload.message_id) ?? "unknown";
  return `email:${event}:v1:${accountId}:${emailId}`;
}

/**
 * How the provider id of an email sent through Unipile is stored (in
 * outreach_emails.gmail_message_id and as the CRM message's provider id):
 * prefixed with the account, because that column is unique across every
 * mailbox and an IMAP provider's ids need not be. unipileReplyId undoes it.
 */
export function unipileStoredMessageId(accountId: string, providerId: string): string {
  return `unipile:${accountId}:${providerId}`;
}

/** The id Unipile takes as reply_to, from a stored one (prefixed by unipileStoredMessageId or not). */
export function unipileReplyId(stored: string): string {
  const match = /^unipile:[^:]+:(.+)$/.exec(stored);
  return match ? match[1]! : stored;
}

/**
 * The email a reply should be sent against in Unipile (its `reply_to`):
 * the latest message in the conversation that Unipile can identify — an
 * inbound email carries its Unipile id, an email sent through a Unipile
 * mailbox its provider id. RFC Message-IDs are not ids Unipile accepts.
 */
export function unipileReplyTarget(
  history: ReadonlyArray<{ raw: unknown; providerMessageId: string | null }>,
): string | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]!;
    const raw = message.raw && typeof message.raw === "object" ? (message.raw as Record<string, unknown>) : {};
    const unipileId = text(raw.unipileEmailId);
    if (unipileId) return unipileId;
    if (raw.provider === "unipile" && text(message.providerMessageId) && !rfcMessageId(message.providerMessageId)) {
      return text(message.providerMessageId);
    }
  }
  return null;
}

/** A plain-text body as minimal HTML (escaped, line breaks kept), for a send that has no HTML part. */
export function plainTextHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\r?\n/g, "<br>\n");
}

/** The two ways email can send, for Connect prompts. */
export const EMAIL_PROVIDERS_DESCRIPTION =
  "Email sends through Google Workspace (addresses on your own domain) or through an inbox linked in Unipile (Gmail, Outlook, iCloud or IMAP; no domain needed). Connect either one.";

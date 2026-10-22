import "server-only";

import { and, eq, isNotNull, ne, notInArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { channelRules } from "@/lib/channels/rules.server";
import { isPlatformConnected } from "@/lib/platform/credentials";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { syncableAccountIds } from "@/lib/unipile/ownership.server";
import { getUnipileEmailAccount, listUnipileEmailAccounts, sendUnipileEmail } from "@/services/unipile.email";
import { unipileErrorStatus } from "@/services/unipile.whatsapp";
import { sendEmail, type SendEmailParams, type SendEmailResult } from "./gmail";
import { mailboxes, type MailboxProvider } from "./schema";
import { plainTextHtml, unipileReplyId, unipileStoredMessageId, type UnipileEmailAccount } from "./unipileMail";
import { alwaysOpenHours } from "./workingHours";

/**
 * What a newly connected mailbox starts with: the organization's emails a
 * day, and hours that are always open in the organization's time zone (the
 * day its daily counter resets on). Sending hours are no setting: no mailbox
 * is ever given restricted hours.
 */
export async function newMailboxSending(): Promise<Pick<Mailbox, "dailySendLimit" | "workingHours">> {
  const [email, general] = await Promise.all([channelRules("email"), channelRules("general")]);
  return { dailySendLimit: email.dailySendLimit, workingHours: alwaysOpenHours(general.timeZone) };
}

/**
 * What sends for a mailbox. A mailbox is either a Google Workspace address
 * the service account impersonates (gmail.ts, replies by Gmail push) or an
 * inbox linked in Unipile (any Gmail, Outlook, iCloud, Exchange or IMAP
 * account, no domain needed; replies by Unipile's email webhook,
 * /api/webhooks/unipile-email). Everything that sends picks the path here,
 * so the campaign scheduler, CRM replies and the test send cannot drift.
 */

export type Mailbox = typeof mailboxes.$inferSelect;
export type SendingMailbox = Pick<Mailbox, "provider" | "emailAddress" | "unipileAccountId">;

export const MAILBOX_PROVIDER_PLATFORM: Record<MailboxProvider, "google" | "unipile"> = {
  google: "google",
  unipile: "unipile",
};

/** Whether the integration a mailbox sends through is connected for this organization. */
export function mailboxProviderConnected(provider: MailboxProvider): Promise<boolean> {
  return isPlatformConnected(MAILBOX_PROVIDER_PLATFORM[provider]);
}

/** Unipile refuses (4xx) before sending: these mean the reply target it was given is unknown or malformed. */
const REPLY_TARGET_REFUSED = new Set([400, 404, 422]);

/**
 * The SDK's error for a non-2xx answer has an empty message and keeps the
 * HTTP status in its body. Re-thrown with both readable: the status on
 * `.status` is what the CRM reads to tell a refusal (4xx: nothing sent)
 * from an uncertain delivery, and the message is what the mailbox and the
 * send attempt show. Anything without a status (a network failure, which
 * may have sent) is left as it is.
 */
function readableUnipileError(error: unknown): unknown {
  const status = unipileErrorStatus(error);
  if (status === null) return error;
  const body = (error as { body?: { title?: unknown; detail?: unknown } }).body;
  const detail = [body?.title, body?.detail].filter((part): part is string => typeof part === "string" && part.trim() !== "").join(": ");
  return Object.assign(new Error(`Unipile refused the email (HTTP ${status})${detail ? `: ${detail}` : ""}`, { cause: error }), { status });
}

/** Sends one email from the mailbox through its own provider. Throws what the provider throws. */
export async function sendFromMailbox(mailbox: SendingMailbox, params: SendEmailParams): Promise<SendEmailResult> {
  if (mailbox.provider !== "unipile") return sendEmail(params);
  if (!mailbox.unipileAccountId) throw new Error(`${mailbox.emailAddress} has no linked Unipile account; sync it again in Settings → Email → Mailboxes`);
  const message = {
    accountId: mailbox.unipileAccountId,
    to: params.to,
    cc: params.cc,
    bcc: params.bcc,
    subject: params.subject,
    body: params.html ?? plainTextHtml(params.text),
  };
  const replyTo = params.providerReplyTo ? unipileReplyId(params.providerReplyTo) : undefined;
  let sent: Awaited<ReturnType<typeof sendUnipileEmail>>;
  try {
    sent = await sendUnipileEmail({ ...message, replyTo });
  } catch (error) {
    // Nothing was sent on a refusal. An earlier email Unipile no longer knows
    // must not block the reply: send it on its own (the subject keeps "Re:").
    const status = unipileErrorStatus(error);
    if (!replyTo || status === null || !REPLY_TARGET_REFUSED.has(status)) throw readableUnipileError(error);
    console.warn(`[outreach/mailboxProviders] Unipile refused reply_to ${replyTo} (${status}); sending without it`);
    try {
      sent = await sendUnipileEmail(message);
    } catch (retryError) {
      throw readableUnipileError(retryError);
    }
  }
  // Unipile reports no RFC Message-ID or thread on send; its provider id is
  // what a later follow-up or reply names as reply_to.
  return { id: sent.providerId ? unipileStoredMessageId(mailbox.unipileAccountId, sent.providerId) : null, messageId: null, threadId: null };
}

export type UnipileMailboxSync = {
  /** Inboxes linked in Unipile now present as mailboxes (added or refreshed). */
  synced: { emailAddress: string; status: Mailbox["status"]; added: boolean }[];
  /** Linked inboxes that could not become a mailbox, and why. */
  skipped: { account: string; reason: string }[];
  /** Mailboxes whose inbox is no longer linked in Unipile. */
  unlinked: string[];
};

function mailboxState(account: UnipileEmailAccount, now: Date) {
  return {
    status: account.status,
    lastError: account.problem,
    lastTestedAt: now,
    updatedAt: now,
  };
}

/**
 * Makes every email inbox linked in this organization's Unipile workspace a
 * sending mailbox, and refreshes the status of those already added. An
 * address can be one mailbox only (email_address is unique across
 * organizations): one already added here through Google Workspace is
 * switched to Unipile only while it cannot send through Google; one in
 * another organization is skipped. A mailbox whose inbox is gone from
 * Unipile is marked failed, never deleted (its sent history stays).
 */
export async function syncUnipileMailboxes(): Promise<UnipileMailboxSync> {
  // Only the inboxes this organization owns (unipile_account_owners); see src/lib/unipile/ownership.server.ts.
  const all = await listUnipileEmailAccounts();
  const syncable = await syncableAccountIds("email", all.map((account) => account.unipileAccountId));
  const accounts = all.filter((account) => syncable.has(account.unipileAccountId));
  const now = new Date();
  const result: UnipileMailboxSync = { synced: [], skipped: [], unlinked: [] };
  let sending: Awaited<ReturnType<typeof newMailboxSending>> | null = null;

  for (const account of accounts) {
    const label = account.emailAddress ?? `${account.typeLabel} account ${account.unipileAccountId}`;
    if (!account.emailAddress) {
      result.skipped.push({ account: label, reason: "Unipile reports no email address for it" });
      continue;
    }
    // Unipile account ids and addresses are provider identities, unique across
    // organizations, so these two reads are deliberately unscoped: they only
    // decide whether another organization already holds the inbox.
    const [linked] = await db.select().from(mailboxes)
      .where(eq(mailboxes.unipileAccountId, account.unipileAccountId)).limit(1);
    if (linked && linked.organizationId !== currentOrganizationId()) {
      result.skipped.push({ account: label, reason: "it is a mailbox of another organization" });
      continue;
    }
    if (linked) {
      await db.update(mailboxes)
        .set({ ...mailboxState(account, now), displayName: linked.displayName ?? account.name })
        .where(and(inOrg(mailboxes), eq(mailboxes.id, linked.id)));
      result.synced.push({ emailAddress: account.emailAddress, status: account.status, added: false });
      continue;
    }

    const [sameAddress] = await db.select().from(mailboxes).where(eq(mailboxes.emailAddress, account.emailAddress)).limit(1);
    if (sameAddress && sameAddress.organizationId !== currentOrganizationId()) {
      result.skipped.push({ account: label, reason: "this address is a mailbox of another organization" });
      continue;
    }
    if (sameAddress) {
      if (sameAddress.provider === "google" && sameAddress.status === "connected") {
        result.skipped.push({ account: label, reason: "it already sends through Google Workspace; remove that mailbox first to send through Unipile" });
        continue;
      }
      await db.update(mailboxes)
        .set({
          ...mailboxState(account, now),
          provider: "unipile",
          unipileAccountId: account.unipileAccountId,
          lastHistoryId: null,
          displayName: sameAddress.displayName ?? account.name,
        })
        .where(and(inOrg(mailboxes), eq(mailboxes.id, sameAddress.id)));
      result.synced.push({ emailAddress: account.emailAddress, status: account.status, added: false });
      continue;
    }

    // A new mailbox starts like one added by hand (newMailboxSending); an existing one keeps its own.
    sending ??= await newMailboxSending();
    await db.insert(mailboxes).values({
      organizationId: currentOrganizationId(),
      emailAddress: account.emailAddress,
      provider: "unipile",
      unipileAccountId: account.unipileAccountId,
      displayName: account.name,
      ...sending,
      ...mailboxState(account, now),
    });
    result.synced.push({ emailAddress: account.emailAddress, status: account.status, added: true });
  }

  const listedIds = accounts.map((account) => account.unipileAccountId);
  const gone = await db.update(mailboxes)
    .set({ status: "failed", lastError: "This inbox is no longer linked in Unipile.", lastTestedAt: now, updatedAt: now })
    .where(and(
      inOrg(mailboxes),
      eq(mailboxes.provider, "unipile"),
      isNotNull(mailboxes.unipileAccountId),
      ne(mailboxes.status, "failed"),
      ...(listedIds.length ? [notInArray(mailboxes.unipileAccountId, listedIds)] : []),
    ))
    .returning({ emailAddress: mailboxes.emailAddress });
  result.unlinked = gone.map((row) => row.emailAddress);
  return result;
}

/** Re-reads a Unipile mailbox's account and records whether it can send. */
export async function retestUnipileMailbox(mailbox: Mailbox): Promise<{ ok: true } | { ok: false; error: string }> {
  const now = new Date();
  let account: UnipileEmailAccount | null;
  try {
    account = mailbox.unipileAccountId ? await getUnipileEmailAccount(mailbox.unipileAccountId) : null;
  } catch (error) {
    const status = unipileErrorStatus(error);
    if (status !== 404) {
      const message = `Could not reach Unipile: ${error instanceof Error ? error.message : String(error)}`;
      await db.update(mailboxes).set({ lastError: message, lastTestedAt: now, updatedAt: now })
        .where(and(inOrg(mailboxes), eq(mailboxes.id, mailbox.id)));
      return { ok: false, error: message };
    }
    account = null;
  }
  if (!account) {
    const error = "This inbox is no longer linked in Unipile.";
    await db.update(mailboxes).set({ status: "failed", lastError: error, lastTestedAt: now, updatedAt: now })
      .where(and(inOrg(mailboxes), eq(mailboxes.id, mailbox.id)));
    return { ok: false, error };
  }
  await db.update(mailboxes).set(mailboxState(account, now)).where(and(inOrg(mailboxes), eq(mailboxes.id, mailbox.id)));
  return account.status === "connected" ? { ok: true } : { ok: false, error: account.problem ?? `Unipile reports ${account.status}` };
}

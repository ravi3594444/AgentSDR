import "server-only";

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import type { StepLogger } from "@/lib/debugLog";
import { inboundEvents } from "@/lib/inbox/schema";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { getUnipileEmail } from "@/services/unipile.email";
import { ingestGmailReply } from "./replyBridge";
import { mailboxes } from "./schema";
import { unipileMailToInbound } from "./unipileMail";

/** Folders an email can arrive in that are never a reply to file. */
const NOT_INBOUND_ROLES = new Set(["sent", "drafts", "draft"]);

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * One `mail_received` delivery of Unipile's email webhook, inside the
 * organization of the mailbox it names. The email is filed exactly like a
 * Gmail reply (ingestGmailReply: bounces, Master Inbox, and the CRM for a
 * known outreach recipient, which stops that lead's follow-ups), and the
 * processing log is kept with the inbound diagnostics, as Gmail's are.
 * Throws on a failure worth a retry.
 */
export async function ingestUnipileEmail(payload: Record<string, unknown>, log: StepLogger): Promise<"ok" | "skipped"> {
  const accountId = text(payload.account_id);
  const [mailbox] = accountId
    ? await db.select().from(mailboxes)
      .where(and(inOrg(mailboxes), eq(mailboxes.unipileAccountId, accountId), eq(mailboxes.provider, "unipile"))).limit(1)
    : [];
  if (!mailbox) {
    log.info(`Unipile account ${accountId ?? "(none)"} is not a mailbox here — skipping`);
    return "skipped";
  }
  const role = text(payload.role)?.toLowerCase();
  if (role && NOT_INBOUND_ROLES.has(role)) {
    log.info(`Email in the ${role} folder — not a reply, skipping`);
    return "skipped";
  }

  // The webhook normally carries the whole email; one without its body (or
  // marked incomplete) is read in full from Unipile.
  let mail = payload;
  const emailId = text(payload.email_id);
  if (emailId && (payload.is_complete === false || (!text(payload.body) && !text(payload.body_plain)))) {
    log.info(`Webhook carried no complete body — reading email ${emailId} from Unipile`);
    mail = { ...payload, ...(await getUnipileEmail(emailId)) };
  }
  const msg = unipileMailToInbound(mail);
  if (!msg) {
    log.warn("Email has no Unipile id — skipping");
    return "skipped";
  }

  log.info(`Unipile email ${msg.unipileEmailId} to ${mailbox.emailAddress} — processing`);
  const record = async (status: "ok" | "skipped" | "error", error: string | null) => {
    log.finish(status);
    await db.insert(inboundEvents).values({
      organizationId: currentOrganizationId(),
      source: "unipile",
      eventType: "inbound_message",
      title: msg.fromName || msg.fromEmail || null,
      status: log.status,
      steps: log.steps,
      payload: msg as unknown as object,
      processed: status !== "error",
      error,
    });
  };
  try {
    const result = await ingestGmailReply(mailbox.emailAddress, msg, log);
    await record(result.skipped ? "skipped" : "ok", null);
    return result.skipped ? "skipped" : "ok";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(message);
    await record("error", message);
    throw error;
  }
}

/**
 * The organization of the mailbox a Unipile account is, for the webhook
 * route. Unipile account ids are globally unique, so this is the one
 * deliberately unscoped read, and nothing is trusted until that
 * organization's secret matches.
 */
export async function organizationOfUnipileMailbox(accountId: string): Promise<string | null> {
  const [row] = await db
    .select({ organizationId: mailboxes.organizationId })
    .from(mailboxes)
    .where(eq(mailboxes.unipileAccountId, accountId))
    .limit(1);
  return row?.organizationId ?? null;
}

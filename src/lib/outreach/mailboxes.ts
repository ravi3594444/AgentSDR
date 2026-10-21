import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { mailboxes } from "./schema";
import { testMailboxConnection } from "./gmail";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { newMailboxSending, retestUnipileMailbox } from "./mailboxProviders";

export async function listMailboxes() {
  return db.select().from(mailboxes).where(inOrg(mailboxes)).orderBy(mailboxes.createdAt);
}

export async function getMailbox(id: string) {
  const [row] = await db.select().from(mailboxes).where(and(inOrg(mailboxes), eq(mailboxes.id, id))).limit(1);
  return row ?? null;
}

export type ConnectMailboxResult =
  | { ok: true; mailboxId: string; status: "connected" }
  | { ok: false; error: string };

/**
 * Adds (or re-tests) a mailbox: stores the row, calls Gmail to verify our
 * service account can actually impersonate this address, then records the
 * outcome. This is the entire "connect" flow — no OAuth screen, no password.
 */
export async function connectMailbox(input: {
  emailAddress: string;
  displayName?: string | null;
  /** Undefined leaves any existing signature untouched (e.g. on a retest); pass "" to explicitly clear it. */
  signatureHtml?: string | null;
}): Promise<ConnectMailboxResult> {
  const emailAddress = input.emailAddress.trim().toLowerCase();
  if (!emailAddress || !emailAddress.includes("@")) {
    return { ok: false, error: `invalid email: "${input.emailAddress}"` };
  }

  const [existing] = await db
    .select()
    .from(mailboxes)
    .where(and(inOrg(mailboxes), eq(mailboxes.emailAddress, emailAddress)))
    .limit(1);
  if (existing?.provider === "unipile") {
    return { ok: false, error: `${emailAddress} sends through Unipile; delete that mailbox first to send through Google Workspace` };
  }
  if (!existing) {
    // A Gmail mailbox belongs to exactly one organization (email_address is
    // globally unique), so one already connected elsewhere cannot be added.
    const [elsewhere] = await db
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(eq(mailboxes.emailAddress, emailAddress))
      .limit(1);
    if (elsewhere) return { ok: false, error: `${emailAddress} is already connected to another organization` };
  }

  // A new mailbox starts with the organization's emails a day and always-open
  // hours (newMailboxSending); an existing one keeps its own.
  const mailboxId =
    existing?.id ??
    (
      await db
        .insert(mailboxes)
        .values({
          organizationId: currentOrganizationId(),
          emailAddress,
          displayName: input.displayName?.trim() || null,
          signatureHtml: input.signatureHtml?.trim() || null,
          status: "connecting",
          ...(await newMailboxSending()),
        })
        .returning({ id: mailboxes.id })
    )[0].id;

  const test = await testMailboxConnection(emailAddress);

  if (test.ok) {
    await db
      .update(mailboxes)
      .set({
        status: "connected",
        lastError: null,
        lastTestedAt: new Date(),
        lastHistoryId: test.historyId,
        displayName: input.displayName?.trim() || existing?.displayName || null,
        ...(input.signatureHtml !== undefined ? { signatureHtml: input.signatureHtml?.trim() || null } : {}),
        updatedAt: new Date(),
      })
      .where(and(inOrg(mailboxes), eq(mailboxes.id, mailboxId)));
    return { ok: true, mailboxId, status: "connected" };
  }

  await db
    .update(mailboxes)
    .set({ status: "failed", lastError: test.error, lastTestedAt: new Date(), updatedAt: new Date() })
    .where(and(inOrg(mailboxes), eq(mailboxes.id, mailboxId)));
  return { ok: false, error: test.error };
}

/**
 * Re-runs the connection test for an already-added mailbox: Gmail impersonation
 * for a Google Workspace mailbox, the linked account's status for a Unipile
 * one. Leaves its signature untouched.
 */
export async function retestMailbox(id: string): Promise<ConnectMailboxResult> {
  const mailbox = await getMailbox(id);
  if (!mailbox) return { ok: false, error: "mailbox not found" };
  if (mailbox.provider === "unipile") {
    const result = await retestUnipileMailbox(mailbox);
    return result.ok ? { ok: true, mailboxId: mailbox.id, status: "connected" } : result;
  }
  return connectMailbox({ emailAddress: mailbox.emailAddress, displayName: mailbox.displayName });
}

export async function deleteMailbox(id: string) {
  await db.delete(mailboxes).where(and(inOrg(mailboxes), eq(mailboxes.id, id)));
}

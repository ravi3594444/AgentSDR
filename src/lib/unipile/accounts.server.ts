import "server-only";

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { instagramAccounts } from "@/lib/instagram/schema";
import { linkedInAccounts } from "@/lib/linkedin/schema";
import { mailboxes } from "@/lib/outreach/schema";
import { inOrg } from "@/lib/tenancy/scope";
import { whatsappAccounts } from "@/lib/whatsapp/schema";
import { getUnipileClient } from "@/services/unipile.service";
import { ownsAccount, releaseAccount } from "./ownership.server";
import type { UnipileChannel } from "./schema";

/**
 * A workspace's connected Unipile accounts addressed by its own row ids (the
 * ids its pages hold), never by a Unipile account id from the browser: the
 * row is read inside the workspace, then its account must be owned by it.
 */

/** The Unipile account behind one of this organization's rows, or null (not found here). */
export async function unipileAccountIdForRow(channel: UnipileChannel, rowId: string): Promise<string | null> {
  if (!rowId || rowId.length > 64) return null;
  if (channel === "linkedin") {
    const [row] = await db.select({ accountId: linkedInAccounts.linkedinId }).from(linkedInAccounts).where(and(inOrg(linkedInAccounts), eq(linkedInAccounts.id, rowId))).limit(1);
    return row?.accountId ?? null;
  }
  if (!/^[0-9a-f-]{36}$/i.test(rowId)) return null;
  if (channel === "whatsapp") {
    const [row] = await db.select({ accountId: whatsappAccounts.unipileAccountId }).from(whatsappAccounts).where(and(inOrg(whatsappAccounts), eq(whatsappAccounts.id, rowId))).limit(1);
    return row?.accountId ?? null;
  }
  if (channel === "instagram") {
    const [row] = await db.select({ accountId: instagramAccounts.unipileAccountId }).from(instagramAccounts).where(and(inOrg(instagramAccounts), eq(instagramAccounts.id, rowId))).limit(1);
    return row?.accountId ?? null;
  }
  const [row] = await db.select({ accountId: mailboxes.unipileAccountId }).from(mailboxes).where(and(inOrg(mailboxes), eq(mailboxes.id, rowId), eq(mailboxes.provider, "unipile"))).limit(1);
  return row?.accountId ?? null;
}

/**
 * Disconnects one of this organization's accounts: removed from Unipile (it
 * stops costing a seat and can no longer send), its row marked disconnected
 * (its history stays), and its ownership released (the id is never given to
 * anyone else). Null when the row or its ownership is not this
 * organization's.
 */
export async function disconnectUnipileAccount(channel: UnipileChannel, rowId: string): Promise<{ accountId: string } | null> {
  const accountId = await unipileAccountIdForRow(channel, rowId);
  if (!accountId || !(await ownsAccount(accountId))) return null;
  try {
    await (await getUnipileClient()).account.delete(accountId);
  } catch (error) {
    const status = Number((error as { body?: { status?: unknown }; status?: unknown })?.body?.status ?? (error as { status?: unknown })?.status);
    // Already gone from Unipile: nothing more to remove there.
    if (status !== 404) throw error;
  }
  const now = new Date();
  if (channel === "linkedin") await db.update(linkedInAccounts).set({ status: "DISCONNECTED", updatedAt: now }).where(and(inOrg(linkedInAccounts), eq(linkedInAccounts.id, rowId)));
  else if (channel === "whatsapp") await db.update(whatsappAccounts).set({ status: "disconnected", updatedAt: now }).where(and(inOrg(whatsappAccounts), eq(whatsappAccounts.id, rowId)));
  else if (channel === "instagram") await db.update(instagramAccounts).set({ status: "disconnected", updatedAt: now }).where(and(inOrg(instagramAccounts), eq(instagramAccounts.id, rowId)));
  else await db.update(mailboxes).set({ status: "failed", lastError: "Disconnected in AgentSDR.", updatedAt: now }).where(and(inOrg(mailboxes), eq(mailboxes.id, rowId)));
  await releaseAccount(accountId);
  return { accountId };
}

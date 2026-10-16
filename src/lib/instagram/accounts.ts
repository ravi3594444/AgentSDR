import "server-only";

import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { members, users } from "@/lib/auth/schema";
import { listUnipileInstagramAccounts } from "@/services/unipile.instagram";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import type { InstagramAccountSummary } from "./contract";
import { InstagramApiError } from "./errors";
import { instagramAccounts, type InstagramAccountRow } from "./schema";

/**
 * The Instagram accounts linked in Unipile, as instagram_accounts. Unipile is
 * the source of truth: sync re-reads it (type INSTAGRAM only — LinkedIn and
 * WhatsApp sync separately), and nothing here creates an account Unipile
 * does not list or deletes one it stops listing (that one becomes
 * disconnected, keeping its chats).
 *
 * The first time an account is seen connected, its history cutoff is set:
 * messages sent before it are history (stored, never answered).
 */

export type { InstagramAccountRow };

export function toInstagramAccountSummary(row: InstagramAccountRow, connectedByName: string | null): InstagramAccountSummary {
  return {
    id: row.id,
    unipileAccountId: row.unipileAccountId,
    username: row.username,
    name: row.name,
    status: row.status,
    connectedAt: row.connectedAt?.toISOString() ?? null,
    historyCutoffAt: row.historyCutoffAt?.toISOString() ?? null,
    connectedBy: row.connectedBy ? { id: row.connectedBy, name: connectedByName } : null,
    inquiryIntake: row.inquiryIntake,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    lastImportedAt: row.lastImportedAt?.toISOString() ?? null,
  };
}

/** Rows → summaries, with the names of the members who linked them. */
async function summaries(rows: InstagramAccountRow[]): Promise<InstagramAccountSummary[]> {
  const ids = [...new Set(rows.flatMap((row) => (row.connectedBy ? [row.connectedBy] : [])))];
  const names = new Map(
    ids.length
      ? (await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))).map((user) => [user.id, user.name])
      : [],
  );
  return rows.map((row) => toInstagramAccountSummary(row, row.connectedBy ? names.get(row.connectedBy) ?? null : null));
}

export async function listInstagramAccounts(): Promise<InstagramAccountSummary[]> {
  const rows = await db
    .select()
    .from(instagramAccounts)
    .where(inOrg(instagramAccounts))
    .orderBy(asc(instagramAccounts.createdAt), asc(instagramAccounts.id));
  return summaries(rows);
}

/**
 * Re-reads the linked Instagram accounts from Unipile: upserts each by its
 * Unipile id (never taking a row another organization holds), stamps
 * connected_at and history_cutoff_at the first time one is seen connected,
 * and marks accounts Unipile no longer lists as disconnected.
 */
export async function syncInstagramAccounts(): Promise<InstagramAccountSummary[]> {
  const listed = await listUnipileInstagramAccounts();
  const now = new Date();
  const stamp = sql`${now.toISOString()}::timestamptz`;

  for (const account of listed) {
    const connected = account.status === "connected";
    await db
      .insert(instagramAccounts)
      .values({
        organizationId: currentOrganizationId(),
        unipileAccountId: account.unipileAccountId,
        username: account.username,
        name: account.name,
        providerUserId: account.providerUserId,
        status: account.status,
        connectedAt: connected ? now : null,
        historyCutoffAt: connected ? now : null,
        lastSyncedAt: now,
      })
      .onConflictDoUpdate({
        target: instagramAccounts.unipileAccountId,
        // A Unipile account belongs to one organization; never touch another's row.
        setWhere: inOrg(instagramAccounts),
        set: {
          username: sql`coalesce(${account.username}::text, ${instagramAccounts.username})`,
          name: sql`coalesce(${account.name}::text, ${instagramAccounts.name})`,
          providerUserId: sql`coalesce(${account.providerUserId}::text, ${instagramAccounts.providerUserId})`,
          status: account.status,
          connectedAt: connected ? sql`coalesce(${instagramAccounts.connectedAt}, ${stamp})` : sql`${instagramAccounts.connectedAt}`,
          historyCutoffAt: connected ? sql`coalesce(${instagramAccounts.historyCutoffAt}, ${stamp})` : sql`${instagramAccounts.historyCutoffAt}`,
          lastSyncedAt: now,
          updatedAt: now,
        },
      });
  }

  const listedIds = listed.map((account) => account.unipileAccountId);
  await db
    .update(instagramAccounts)
    .set({ status: "disconnected", lastSyncedAt: now, updatedAt: now })
    .where(listedIds.length
      ? and(inOrg(instagramAccounts), notInArray(instagramAccounts.unipileAccountId, listedIds), sql`${instagramAccounts.status} <> 'disconnected'`)
      : and(inOrg(instagramAccounts), sql`${instagramAccounts.status} <> 'disconnected'`));

  return listInstagramAccounts();
}

/**
 * Records who linked an account from AgentSDR (the hosted sign-in's `name`
 * names them). Only a member of this organization, only on this
 * organization's account; false when either is not so.
 */
export async function applyInstagramAccountOwner(unipileAccountId: string, userId: string): Promise<boolean> {
  const [member] = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.organizationId, currentOrganizationId()), eq(members.userId, userId)))
    .limit(1);
  if (!member) return false;
  const updated = await db
    .update(instagramAccounts)
    .set({ connectedBy: userId, updatedAt: new Date() })
    .where(and(inOrg(instagramAccounts), eq(instagramAccounts.unipileAccountId, unipileAccountId)))
    .returning({ id: instagramAccounts.id });
  return updated.length > 0;
}

export async function getInstagramAccountRow(id: string): Promise<InstagramAccountRow | null> {
  const [row] = await db.select().from(instagramAccounts).where(and(inOrg(instagramAccounts), eq(instagramAccounts.id, id))).limit(1);
  return row ?? null;
}

export async function findInstagramAccountByUnipileId(unipileAccountId: string): Promise<InstagramAccountRow | null> {
  const [row] = await db
    .select()
    .from(instagramAccounts)
    .where(and(inOrg(instagramAccounts), eq(instagramAccounts.unipileAccountId, unipileAccountId)))
    .limit(1);
  return row ?? null;
}

/** Whether new messages from people AgentSDR does not know become inquiries on this account. */
export async function setInstagramInquiryIntake(id: string, enabled: boolean): Promise<InstagramAccountSummary> {
  const [row] = await db
    .update(instagramAccounts)
    .set({ inquiryIntake: enabled, updatedAt: new Date() })
    .where(and(inOrg(instagramAccounts), eq(instagramAccounts.id, id)))
    .returning();
  if (!row) throw new InstagramApiError(404, "Instagram account not found");
  return (await summaries([row]))[0]!;
}

import "server-only";

import { and, asc, eq, notInArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { listUnipileWhatsappAccounts } from "@/services/unipile.whatsapp";
import type { WhatsappAccountSummary } from "./contract";
import { WhatsappApiError } from "./errors";
import { warmUpEndsAt } from "./guardrails";
import { channelRules } from "@/lib/channels/rules.server";
import { whatsappAccounts } from "./schema";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { syncableAccountIds } from "@/lib/unipile/ownership.server";

/**
 * The WhatsApp numbers linked in Unipile, as whatsapp_accounts. Unipile is
 * the source of truth: sync re-reads it, and nothing here creates an account
 * Unipile does not list. LinkedIn accounts sync separately
 * (src/functions/syncAllAccounts.ts, type LINKEDIN only).
 */

export type WhatsappAccountRow = typeof whatsappAccounts.$inferSelect;

/** One default per organization, so the advisory lock is per organization too. */
function defaultLockKey(): string {
  return `whatsapp-accounts:default:${currentOrganizationId()}`;
}

/** `warmUpHours` is the organization's rule (Settings → WhatsApp → Sending rules). */
export function toWhatsappAccountSummary(row: WhatsappAccountRow, warmUpHours: number, now = new Date()): WhatsappAccountSummary {
  const ends = warmUpEndsAt(row.connectedAt, now, warmUpHours);
  return {
    id: row.id,
    unipileAccountId: row.unipileAccountId,
    name: row.name,
    phone: row.phone,
    status: row.status,
    connectedAt: row.connectedAt?.toISOString() ?? null,
    warmUpEndsAt: ends?.toISOString() ?? null,
    isDefault: row.isDefault,
    newChatsPerDay: row.newChatsPerDay,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
  };
}

export async function listWhatsappAccounts(): Promise<WhatsappAccountSummary[]> {
  const rows = await db.select().from(whatsappAccounts).where(inOrg(whatsappAccounts)).orderBy(asc(whatsappAccounts.createdAt), asc(whatsappAccounts.id));
  const now = new Date();
  const { warmupHours } = await channelRules("whatsapp");
  return rows.map((row) => toWhatsappAccountSummary(row, warmupHours, now));
}

/**
 * Re-reads the linked numbers from Unipile: upserts each by its Unipile id,
 * stamps connected_at the first time one is seen connected (that starts its
 * new-chat warm-up), marks numbers Unipile no longer lists as disconnected,
 * and makes one account the default when none is.
 */
export async function syncWhatsappAccounts(): Promise<WhatsappAccountSummary[]> {
  // Only the numbers this organization owns (unipile_account_owners); see src/lib/unipile/ownership.server.ts.
  const all = await listUnipileWhatsappAccounts();
  const syncable = await syncableAccountIds("whatsapp", all.map((account) => account.unipileAccountId));
  const listed = all.filter((account) => syncable.has(account.unipileAccountId));
  const now = new Date();

  for (const account of listed) {
    const connected = account.status === "connected";
    await db
      .insert(whatsappAccounts)
      .values({
        organizationId: currentOrganizationId(),
        unipileAccountId: account.unipileAccountId,
        name: account.name,
        phone: account.phone,
        status: account.status,
        connectedAt: connected ? now : null,
        lastSyncedAt: now,
      })
      .onConflictDoUpdate({
        target: whatsappAccounts.unipileAccountId,
        // A Unipile account belongs to one organization; never touch another's row.
        setWhere: inOrg(whatsappAccounts),
        set: {
          name: account.name,
          phone: sql`coalesce(${account.phone}::text, ${whatsappAccounts.phone})`,
          status: account.status,
          connectedAt: connected
            ? sql`coalesce(${whatsappAccounts.connectedAt}, ${now.toISOString()}::timestamptz)`
            : sql`${whatsappAccounts.connectedAt}`,
          lastSyncedAt: now,
          updatedAt: now,
        },
      });
  }

  const listedIds = listed.map((account) => account.unipileAccountId);
  await db
    .update(whatsappAccounts)
    .set({ status: "disconnected", lastSyncedAt: now, updatedAt: now })
    .where(listedIds.length
      ? and(inOrg(whatsappAccounts), notInArray(whatsappAccounts.unipileAccountId, listedIds), sql`${whatsappAccounts.status} <> 'disconnected'`)
      : and(inOrg(whatsappAccounts), sql`${whatsappAccounts.status} <> 'disconnected'`));

  await ensureDefaultAccount();
  return listWhatsappAccounts();
}

/** When no account is the default, the oldest connected one (else the oldest) becomes it. */
async function ensureDefaultAccount(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${defaultLockKey()}, 0))`);
    const [current] = await tx
      .select({ id: whatsappAccounts.id })
      .from(whatsappAccounts)
      .where(and(inOrg(whatsappAccounts), eq(whatsappAccounts.isDefault, true)))
      .limit(1);
    if (current) return;
    const [candidate] = await tx
      .select({ id: whatsappAccounts.id })
      .from(whatsappAccounts)
      .where(inOrg(whatsappAccounts))
      .orderBy(sql`(${whatsappAccounts.status} = 'connected') desc`, asc(whatsappAccounts.createdAt), asc(whatsappAccounts.id))
      .limit(1);
    if (!candidate) return;
    await tx
      .update(whatsappAccounts)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(and(inOrg(whatsappAccounts), eq(whatsappAccounts.id, candidate.id)));
  });
}

/** Makes one account the default — and every other one not. */
export async function setDefaultWhatsappAccount(id: string): Promise<WhatsappAccountSummary> {
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${defaultLockKey()}, 0))`);
    const [target] = await tx.select().from(whatsappAccounts).where(and(inOrg(whatsappAccounts), eq(whatsappAccounts.id, id))).limit(1);
    if (!target) throw new WhatsappApiError(404, "WhatsApp account not found");
    const now = new Date();
    await tx
      .update(whatsappAccounts)
      .set({ isDefault: sql`${whatsappAccounts.id} = ${id}::uuid`, updatedAt: now })
      .where(and(inOrg(whatsappAccounts), sql`(${whatsappAccounts.isDefault} or ${whatsappAccounts.id} = ${id}::uuid)`));
    return { ...target, isDefault: true, updatedAt: now };
  });
  return toWhatsappAccountSummary(row, (await channelRules("whatsapp")).warmupHours);
}

/** The number's own new-chats-a-day limit; null follows the organization's rule. */
export async function setWhatsappNewChatsPerDay(id: string, newChatsPerDay: number | null): Promise<WhatsappAccountSummary> {
  const [row] = await db
    .update(whatsappAccounts)
    .set({ newChatsPerDay, updatedAt: new Date() })
    .where(and(inOrg(whatsappAccounts), eq(whatsappAccounts.id, id)))
    .returning();
  if (!row) throw new WhatsappApiError(404, "WhatsApp account not found");
  return toWhatsappAccountSummary(row, (await channelRules("whatsapp")).warmupHours);
}

export async function getWhatsappAccountRow(id: string): Promise<WhatsappAccountRow | null> {
  const [row] = await db.select().from(whatsappAccounts).where(and(inOrg(whatsappAccounts), eq(whatsappAccounts.id, id))).limit(1);
  return row ?? null;
}

export async function findWhatsappAccountByUnipileId(unipileAccountId: string): Promise<WhatsappAccountRow | null> {
  const [row] = await db
    .select()
    .from(whatsappAccounts)
    .where(and(inOrg(whatsappAccounts), eq(whatsappAccounts.unipileAccountId, unipileAccountId)))
    .limit(1);
  return row ?? null;
}

export async function getDefaultWhatsappAccountRow(): Promise<WhatsappAccountRow | null> {
  const [row] = await db.select().from(whatsappAccounts).where(and(inOrg(whatsappAccounts), eq(whatsappAccounts.isDefault, true))).limit(1);
  return row ?? null;
}

export async function hasConnectedWhatsappAccount(): Promise<boolean> {
  const [row] = await db
    .select({ id: whatsappAccounts.id })
    .from(whatsappAccounts)
    .where(and(inOrg(whatsappAccounts), eq(whatsappAccounts.status, "connected")))
    .limit(1);
  return Boolean(row);
}

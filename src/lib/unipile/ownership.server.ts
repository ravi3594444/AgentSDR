import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { credentialFingerprint, platformCredentialFingerprint } from "@/lib/managed/store.server";
import { getOwnPlatformCredentials, platformCredentialSource } from "@/lib/platform/credentials";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { unipileAccountOwners, type ClaimedVia, type OwnerSource, type UnipileChannel } from "./schema";

/**
 * Who owns each Unipile account (unipile_account_owners), and the checks
 * built on it. On the Included Unipile every workspace shares the
 * platform's key, which sees every account; ownership is what keeps them
 * apart:
 *
 * - a sync (LinkedIn, WhatsApp, Instagram, email) touches only accounts the
 *   organization owns (`syncableAccountIds`);
 * - a call naming an `account_id` on the platform's key is refused unless
 *   the organization owns it (`assertAccountOwned`, the guarded client in
 *   services/unipile.service.ts);
 * - a webhook is accepted only for the owning organization
 *   (organizations.server.ts).
 *
 * An account gets an owner only from a verified hosted-auth callback
 * (connect.server.ts), the one-time backfill of accounts organizations
 * already held, an operator command, or, on an organization's OWN Unipile
 * key, a sync that lists it unowned (its own workspace, as before) — never
 * when that key is the platform's. An owner is never replaced: a conflict is
 * refused and reported.
 */

export class UnipileAccountNotOwnedError extends Error {
  constructor(readonly accountId: string) {
    super("That account is not one of this workspace's connected accounts");
    this.name = "UnipileAccountNotOwnedError";
  }
}

export type AccountOwner = { organizationId: string; channel: UnipileChannel; credentialSource: OwnerSource; status: "active" | "released" };

const OWNED_TTL_MS = 30_000;
const ownedCache = new Map<string, { owned: boolean; expires: number }>();

export function clearOwnershipCache(): void {
  ownedCache.clear();
}

/** The owner of an account, whichever organization it is (webhooks, callbacks); null when nobody owns it. */
export async function accountOwner(accountId: string): Promise<AccountOwner | null> {
  const [row] = await db
    .select({ organizationId: unipileAccountOwners.organizationId, channel: unipileAccountOwners.channel, credentialSource: unipileAccountOwners.credentialSource, status: unipileAccountOwners.status })
    .from(unipileAccountOwners)
    .where(eq(unipileAccountOwners.accountId, accountId))
    .limit(1);
  return row ?? null;
}

/** The organization that owns an active account, or null. */
export async function organizationOwningAccount(accountId: string | null | undefined): Promise<string | null> {
  if (!accountId) return null;
  const owner = await accountOwner(accountId);
  return owner?.status === "active" ? owner.organizationId : null;
}

/** The organization in scope's active accounts, of one channel or all. */
export async function ownedAccountIds(channel?: UnipileChannel): Promise<Set<string>> {
  const rows = await db
    .select({ accountId: unipileAccountOwners.accountId })
    .from(unipileAccountOwners)
    .where(and(inOrg(unipileAccountOwners), eq(unipileAccountOwners.status, "active"), ...(channel ? [eq(unipileAccountOwners.channel, channel)] : [])));
  return new Set(rows.map((row) => row.accountId));
}

/** Whether the organization in scope owns this active account (cached 30 s). */
export async function ownsAccount(accountId: string): Promise<boolean> {
  const key = `${currentOrganizationId()}:${accountId}`;
  const hit = ownedCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.owned;
  const owner = await accountOwner(accountId);
  const owned = owner?.status === "active" && owner.organizationId === currentOrganizationId();
  ownedCache.set(key, { owned, expires: Date.now() + OWNED_TTL_MS });
  return owned;
}

export async function assertAccountOwned(accountId: string): Promise<void> {
  if (!(await ownsAccount(accountId))) throw new UnipileAccountNotOwnedError(accountId);
}

type Executor = Pick<typeof db, "insert" | "select" | "update">;

/**
 * Records the organization in scope as the account's owner. Returns
 * "claimed" (new), "ours" (already this organization's, active again if it
 * was released by it) or "elsewhere" (another organization owns it: nothing
 * changes).
 */
export async function claimAccount(
  executor: Executor,
  input: { accountId: string; channel: UnipileChannel; source: OwnerSource; via: ClaimedVia; userId?: string | null },
): Promise<"claimed" | "ours" | "elsewhere"> {
  const organizationId = currentOrganizationId();
  const inserted = await executor.insert(unipileAccountOwners).values({
    accountId: input.accountId,
    organizationId,
    channel: input.channel,
    credentialSource: input.source,
    claimedVia: input.via,
    claimedBy: input.userId ?? null,
  }).onConflictDoNothing({ target: unipileAccountOwners.accountId }).returning({ accountId: unipileAccountOwners.accountId });
  ownedCache.delete(`${organizationId}:${input.accountId}`);
  if (inserted.length) return "claimed";
  const [existing] = await executor.select({ organizationId: unipileAccountOwners.organizationId, status: unipileAccountOwners.status }).from(unipileAccountOwners).where(eq(unipileAccountOwners.accountId, input.accountId)).limit(1);
  if (existing?.organizationId !== organizationId) return "elsewhere";
  // Its own account connected again after it released it: active again (still never anyone else's).
  if (existing.status === "released") {
    await (executor as Pick<typeof db, "update">).update(unipileAccountOwners).set({ status: "active", releasedAt: null })
      .where(and(eq(unipileAccountOwners.accountId, input.accountId), eq(unipileAccountOwners.organizationId, organizationId)));
  }
  return "ours";
}

/** Marks the organization's own account released (disconnected by it). The row stays: the id is never given to anyone else. */
export async function releaseAccount(accountId: string): Promise<boolean> {
  const released = await db.update(unipileAccountOwners)
    .set({ status: "released", releasedAt: new Date() })
    .where(and(inOrg(unipileAccountOwners), eq(unipileAccountOwners.accountId, accountId)))
    .returning({ accountId: unipileAccountOwners.accountId });
  ownedCache.delete(`${currentOrganizationId()}:${accountId}`);
  return released.length > 0;
}

/**
 * Whether this organization's own Unipile key may claim the accounts it
 * lists: it is on My own provider, its key is saved, and that key is not the
 * platform's (then it would list every Included workspace's accounts).
 */
async function ownKeyMayClaim(): Promise<boolean> {
  if ((await platformCredentialSource("unipile")) !== "own") return false;
  const own = await getOwnPlatformCredentials("unipile");
  if (!own?.apiKey) return false;
  const platform = await platformCredentialFingerprint("unipile");
  return !platform || credentialFingerprint("unipile", own as unknown as Record<string, string>) !== platform;
}

/**
 * Of the accounts a Unipile listing returned for `channel`, the ones this
 * organization may sync: those it owns. On its own key (not the platform's),
 * a listed account nobody owns is claimed for it first, as a sync always
 * did; on the Included Unipile, never — those come only through a verified
 * connection.
 */
export async function syncableAccountIds(channel: UnipileChannel, listedIds: readonly string[]): Promise<Set<string>> {
  const listed = [...new Set(listedIds.filter(Boolean))];
  if (!listed.length) return new Set();
  if (await ownKeyMayClaim()) {
    const known = await db.select({ accountId: unipileAccountOwners.accountId }).from(unipileAccountOwners).where(inArray(unipileAccountOwners.accountId, listed));
    const knownIds = new Set(known.map((row) => row.accountId));
    for (const accountId of listed) {
      if (!knownIds.has(accountId)) await claimAccount(db, { accountId, channel, source: "own", via: "own_sync" });
    }
  }
  const rows = await db.select({ accountId: unipileAccountOwners.accountId }).from(unipileAccountOwners).where(and(
    inOrg(unipileAccountOwners),
    eq(unipileAccountOwners.status, "active"),
    eq(unipileAccountOwners.channel, channel),
    inArray(unipileAccountOwners.accountId, listed),
  ));
  return new Set(rows.map((row) => row.accountId));
}

/** Organizations owning at least one active account (the workers' loop on the Included Unipile). */
export async function organizationsOwningAccounts(): Promise<string[]> {
  const rows = await db.selectDistinct({ organizationId: unipileAccountOwners.organizationId }).from(unipileAccountOwners).where(eq(unipileAccountOwners.status, "active"));
  return rows.map((row) => row.organizationId);
}

/** Active accounts by channel for the organization in scope (the connected-account allowance). */
export async function ownedAccountCounts(): Promise<Record<UnipileChannel, number>> {
  const rows = await db.select({ channel: unipileAccountOwners.channel, n: sql<number>`count(*)::int` }).from(unipileAccountOwners)
    .where(and(inOrg(unipileAccountOwners), eq(unipileAccountOwners.status, "active"))).groupBy(unipileAccountOwners.channel);
  const counts: Record<UnipileChannel, number> = { linkedin: 0, whatsapp: 0, instagram: 0, email: 0 };
  for (const row of rows) counts[row.channel] = Number(row.n);
  return counts;
}

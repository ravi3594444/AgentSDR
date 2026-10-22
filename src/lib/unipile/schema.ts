import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "@/lib/auth/schema";

/**
 * Unipile account ownership (ownership.server.ts) and the hosted-auth links
 * the server minted (connect.server.ts). Created by scripts/add-managed-saas.ts.
 */

export type UnipileChannel = "linkedin" | "whatsapp" | "instagram" | "email";
export type OwnerSource = "managed" | "own";
export type ClaimedVia = "hosted_auth" | "existing" | "own_sync" | "operator";

/**
 * Which organization owns each Unipile account: the authority for every
 * list, sync, send and webhook. Scoped by organization_id; the account id is
 * a provider identity, unique across organizations, never reassigned.
 */
export const unipileAccountOwners = pgTable(
  "unipile_account_owners",
  {
    accountId: text("account_id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    channel: text("channel").notNull().$type<UnipileChannel>(),
    /** Whose Unipile it was connected through when claimed. */
    credentialSource: text("credential_source").notNull().$type<OwnerSource>(),
    claimedVia: text("claimed_via").notNull().$type<ClaimedVia>(),
    claimedBy: uuid("claimed_by"),
    /** The Unipile v2 Scope it belongs to, once Scopes are used (docs/plans/MANAGED_SAAS_IMPLEMENTATION_2026-10-22.md). */
    scopeId: text("scope_id"),
    status: text("status").notNull().default("active").$type<"active" | "released">(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  (table) => [
    index("unipile_account_owners_org_idx").on(table.organizationId, table.channel, table.status),
    check("unipile_account_owners_channel_chk", sql`${table.channel} IN ('linkedin', 'whatsapp', 'instagram', 'email')`),
    check("unipile_account_owners_source_chk", sql`${table.credentialSource} IN ('managed', 'own')`),
    check("unipile_account_owners_via_chk", sql`${table.claimedVia} IN ('hosted_auth', 'existing', 'own_sync', 'operator')`),
    check("unipile_account_owners_status_chk", sql`${table.status} IN ('active', 'released')`),
  ],
);

/** One hosted-auth link minted for a signed-in workspace; its id is the link's opaque name. */
export const unipileConnectStates = pgTable(
  "unipile_connect_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    userId: uuid("user_id").notNull(),
    channel: text("channel").notNull().$type<UnipileChannel>(),
    kind: text("kind").notNull().$type<"create" | "reconnect">(),
    reconnectAccountId: text("reconnect_account_id"),
    credentialSource: text("credential_source").notNull().$type<OwnerSource>(),
    /** sha256 of the per-link secret carried in notify_url; never the secret. */
    tokenHash: text("token_hash").notNull(),
    status: text("status").notNull().default("pending").$type<"pending" | "claimed" | "rejected" | "expired">(),
    accountId: text("account_id"),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("unipile_connect_states_org_idx").on(table.organizationId, table.createdAt),
    check("unipile_connect_states_channel_chk", sql`${table.channel} IN ('linkedin', 'whatsapp', 'instagram', 'email')`),
    check("unipile_connect_states_kind_chk", sql`${table.kind} IN ('create', 'reconnect')`),
    check("unipile_connect_states_source_chk", sql`${table.credentialSource} IN ('managed', 'own')`),
    check("unipile_connect_states_status_chk", sql`${table.status} IN ('pending', 'claimed', 'rejected', 'expired')`),
  ],
);

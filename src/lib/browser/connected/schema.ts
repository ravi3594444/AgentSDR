import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations, users } from "@/lib/auth/schema";
import type { BrowserResearchAction, BrowserResearchResult, ResearchAttention, ResearchSiteKey, SharedTab } from "./contract";

export type BrowserConnectionStatus = "pending" | "active" | "revoked";

/**
 * A person's own Chrome, connected for research (connections.server.ts).
 * One row per pairing: "pending" while its one-time code waits for the
 * extension, "active" once paired (the device token's hash), "revoked" when
 * the person or the extension disconnects, or a newer pairing replaces it.
 * Created by scripts/create-browser-research-tables.ts.
 */
export const browserConnections = pgTable(
  "browser_connections",
  {
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    status: text("status").notNull().$type<BrowserConnectionStatus>().default("pending"),
    /** SHA-256 of the one-time pairing code; cleared once used. */
    pairingCodeHash: text("pairing_code_hash"),
    pairingExpiresAt: timestamp("pairing_expires_at", { withTimezone: true }),
    /** SHA-256 of the device token the extension holds. */
    tokenHash: text("token_hash"),
    /** The extension's own random id: a token is only accepted beside it. */
    deviceId: text("device_id"),
    deviceLabel: text("device_label"),
    extensionVersion: text("extension_version"),
    /** The sites the owner enabled in the extension, as it last reported them. */
    sites: text("sites").array().$type<ResearchSiteKey[]>().notNull().default(sql`ARRAY[]::text[]`),
    /** Tabs the owner shared from the toolbar button, as last reported. */
    sharedTabs: jsonb("shared_tabs").$type<SharedTab[]>().notNull().default([]),
    /** The last page that needs the owner (a sign-in, a CAPTCHA), until a later read of that site works. */
    attention: jsonb("attention").$type<(ResearchAttention & { host: string | null; at: string }) | null>(),
    /** The owner pressed Stop in the extension: commands wait for them. */
    paused: boolean("paused").notNull().default(false),
    /** The last command's sequence number. */
    commandSeq: bigint("command_seq", { mode: "number" }).notNull().default(0),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    pairedAt: timestamp("paired_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("browser_connections_org_user_idx").on(table.organizationId, table.userId, table.status),
    uniqueIndex("browser_connections_token_uq").on(table.tokenHash).where(sql`${table.tokenHash} IS NOT NULL`),
    uniqueIndex("browser_connections_pairing_uq").on(table.pairingCodeHash).where(sql`${table.pairingCodeHash} IS NOT NULL`),
    check("browser_connections_status_chk", sql`${table.status} IN ('pending', 'active', 'revoked')`),
  ],
);

export type BrowserCommandStatus = "pending" | "delivered" | "done" | "failed" | "expired";

/**
 * One step the assistant asked a connected browser to take, for one request
 * (or chat). Delivered once (pending → delivered under the poll's claim),
 * answered once (delivered → done/failed), never sent again: a command the
 * extension lost to a restart expires and the model decides what next.
 */
export const browserCommands = pgTable(
  "browser_commands",
  {
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id").notNull().references(() => browserConnections.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    threadId: uuid("thread_id"),
    requestId: uuid("request_id").notNull(),
    action: jsonb("action").$type<BrowserResearchAction>().notNull(),
    status: text("status").notNull().$type<BrowserCommandStatus>().default("pending"),
    result: jsonb("result").$type<BrowserResearchResult>(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("browser_commands_connection_seq_uq").on(table.connectionId, table.seq),
    index("browser_commands_connection_status_idx").on(table.connectionId, table.status, table.seq),
    index("browser_commands_org_idx").on(table.organizationId, table.createdAt),
    check("browser_commands_status_chk", sql`${table.status} IN ('pending', 'delivered', 'done', 'failed', 'expired')`),
  ],
);

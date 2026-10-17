import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "@/lib/auth/schema";
import { crmConversationMessages } from "@/lib/crm/schema";
import { people } from "@/lib/leads/schema";
import { outreachRuns } from "@/lib/assistant/schema";
import type {
  InstagramAccountStatus,
  InstagramAttachment,
  InstagramChatSource,
  InstagramDirection,
  InstagramMessageOrigin,
} from "./contract";

/**
 * Instagram accounts linked in Unipile, their chats and messages (see
 * contract.ts). Created by scripts/add-instagram-intake-discovery.ts.
 * Accounts are scoped by organization; chats and messages inherit it through
 * their account, as WhatsApp's do.
 */
export const instagramAccounts = pgTable(
  "instagram_accounts",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    /** Unipile's account id: a provider identity, unique across organizations (webhooks find the organization through it). */
    unipileAccountId: text("unipile_account_id").notNull(),
    username: text("username"),
    name: text("name"),
    /** The account's own Instagram user id, when Unipile reports it (echo detection). */
    providerUserId: text("provider_user_id"),
    status: text("status").notNull().default("connected").$type<InstagramAccountStatus>(),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    /** Messages sent before this are history: never forwarded to the CRM, never answered. Set when first seen connected. */
    historyCutoffAt: timestamp("history_cutoff_at", { withTimezone: true }),
    /** The member who linked it from AgentSDR (hosted sign-in); null when it was linked in the Unipile dashboard. */
    connectedBy: uuid("connected_by"),
    /** New messages from people AgentSDR does not know become inquiries (with the Inquiry intake feature on). Off by default. */
    inquiryIntake: boolean("inquiry_intake").notNull().default(false),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastImportedAt: timestamp("last_imported_at", { withTimezone: true }),
    outreachNextSendAt: timestamp("outreach_next_send_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("instagram_accounts_organization_idx").on(table.organizationId),
    unique("instagram_accounts_unipile_account_uq").on(table.unipileAccountId),
    check("instagram_accounts_status_chk", sql`${table.status} IN ('connected', 'disconnected', 'credentials', 'error')`),
  ],
);

/** One Instagram direct-message chat on a linked account. */
export const instagramChats = pgTable(
  "instagram_chats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    unipileChatId: text("unipile_chat_id").notNull(),
    /** The other person's Instagram id (Unipile's attendee_provider_id). */
    providerId: text("provider_id"),
    username: text("username"),
    name: text("name"),
    /** The AgentSDR person this chat belongs to, once known. */
    personId: uuid("person_id"),
    firstSeenVia: text("first_seen_via").notNull().default("webhook").$type<InstagramChatSource>(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    lastMessagePreview: text("last_message_preview"),
    lastDirection: text("last_direction").$type<InstagramDirection>(),
    unreadCount: integer("unread_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({ columns: [table.accountId], foreignColumns: [instagramAccounts.id], name: "instagram_chats_account_fk" }).onDelete("cascade"),
    foreignKey({ columns: [table.personId], foreignColumns: [people.id], name: "instagram_chats_person_fk" }).onDelete("set null"),
    unique("instagram_chats_account_chat_uq").on(table.accountId, table.unipileChatId),
    index("instagram_chats_account_last_message_idx").on(table.accountId, table.lastMessageAt),
    index("instagram_chats_person_idx").on(table.personId),
    index("instagram_chats_provider_idx").on(table.providerId),
    check("instagram_chats_unread_chk", sql`${table.unreadCount} >= 0`),
    check("instagram_chats_last_direction_chk", sql`${table.lastDirection} IS NULL OR ${table.lastDirection} IN ('inbound', 'outbound')`),
    check("instagram_chats_first_seen_chk", sql`${table.firstSeenVia} IN ('webhook', 'import', 'send')`),
  ],
);

/** A message in an Instagram chat. `historical` ones were imported (or arrived late) and are never answered. */
export const instagramMessages = pgTable(
  "instagram_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chatId: uuid("chat_id").notNull(),
    /** Null only between an AgentSDR send and Unipile's answer. */
    unipileMessageId: text("unipile_message_id"),
    direction: text("direction").notNull().$type<InstagramDirection>(),
    origin: text("origin").notNull().$type<InstagramMessageOrigin>(),
    body: text("body").notNull().default(""),
    attachments: jsonb("attachments").$type<InstagramAttachment[]>().notNull().default([]),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    historical: boolean("historical").notNull().default(false),
    crmConversationMessageId: uuid("crm_conversation_message_id"),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({ columns: [table.chatId], foreignColumns: [instagramChats.id], name: "instagram_messages_chat_fk" }).onDelete("cascade"),
    foreignKey({ columns: [table.crmConversationMessageId], foreignColumns: [crmConversationMessages.id], name: "instagram_messages_crm_message_fk" }).onDelete("set null"),
    uniqueIndex("instagram_messages_unipile_message_uq").on(table.unipileMessageId).where(sql`${table.unipileMessageId} IS NOT NULL`),
    index("instagram_messages_chat_sent_idx").on(table.chatId, table.sentAt),
    check("instagram_messages_direction_chk", sql`${table.direction} IN ('inbound', 'outbound')`),
    check("instagram_messages_origin_chk", sql`${table.origin} IN ('lead', 'agentsdr', 'phone')`),
    check("instagram_messages_origin_direction_chk", sql`(${table.direction} = 'inbound') = (${table.origin} = 'lead')`),
  ],
);

export type InstagramAccountRow = typeof instagramAccounts.$inferSelect;
export type InstagramChatRow = typeof instagramChats.$inferSelect;
export type InstagramMessageRow = typeof instagramMessages.$inferSelect;

/** A single approved initial DM. Sending/uncertain reservations never auto-send again. */
export const instagramOutreachQueue = pgTable("instagram_outreach_queue", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  runId: uuid("run_id").notNull().references(() => outreachRuns.id, { onDelete: "cascade" }),
  personId: uuid("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
  accountId: uuid("account_id").notNull().references(() => instagramAccounts.id),
  username: text("username").notNull(),
  messagingId: text("messaging_id"),
  body: text("body").notNull(),
  status: text("status").notNull().default("queued").$type<"queued" | "resolving" | "sending" | "sent" | "failed" | "uncertain" | "cancelled">(),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  lockedBy: text("locked_by"),
  attemptedAt: timestamp("attempted_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  chatId: text("chat_id"),
  messageId: text("message_id"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("instagram_outreach_run_person_uq").on(t.runId, t.personId),
  index("instagram_outreach_due_idx").on(t.status, t.createdAt),
  index("instagram_outreach_org_account_idx").on(t.organizationId, t.accountId, t.attemptedAt),
  check("instagram_outreach_status_chk", sql`${t.status} IN ('queued','resolving','sending','sent','failed','uncertain','cancelled')`),
]);

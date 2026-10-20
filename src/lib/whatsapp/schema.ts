import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { callSessions } from "@/lib/calls/schema";
import { crmConversationMessages } from "@/lib/crm/schema";
import { people } from "@/lib/leads/schema";
import type {
  WhatsappAccountStatus,
  WhatsappAttachment,
  WhatsappDirection,
  WhatsappMessageOrigin,
} from "./contract";
import type {
  WhatsappCampaignLeadStatus,
  WhatsappCampaignSendStatus,
  WhatsappCampaignStatus,
  WhatsappCampaignStep,
} from "./campaigns/contract";
import { organizations } from "@/lib/auth/schema";

/**
 * WhatsApp numbers linked in Unipile, as AgentSDR last read them. Created by
 * scripts/create-whatsapp-tables.ts; see src/lib/whatsapp/contract.ts.
 */
export const whatsappAccounts = pgTable(
  "whatsapp_accounts",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    unipileAccountId: text("unipile_account_id").notNull(),
    name: text("name"),
    /** E.164, when Unipile reports it. */
    phone: text("phone"),
    status: text("status").notNull().default("connected").$type<WhatsappAccountStatus>(),
    /** First seen connected — starts the new-chat warm-up. */
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    isDefault: boolean("is_default").notNull().default(false),
    /** New chats a day for this number; null = the organization's rule (Settings → WhatsApp → Sending rules). */
    newChatsPerDay: integer("new_chats_per_day"),
    /** Why the campaign sender last held this number back (a refusal, a gap or cap); cleared by the next accepted send. */
    lastRefusal: text("last_refusal"),
    lastRefusalAt: timestamp("last_refusal_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("whatsapp_accounts_organization_idx").on(table.organizationId),
    unique("whatsapp_accounts_unipile_account_uq").on(table.unipileAccountId),
    check(
      "whatsapp_accounts_status_chk",
      sql`${table.status} IN ('connected', 'disconnected', 'credentials', 'error')`,
    ),
  ],
);

/** One WhatsApp chat on a linked number: the Messages tab's list. */
export const whatsappChats = pgTable(
  "whatsapp_chats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    unipileChatId: text("unipile_chat_id").notNull(),
    /** The lead's WhatsApp id, "<digits>@s.whatsapp.net". */
    providerId: text("provider_id"),
    /** The lead's number, E.164. */
    phone: text("phone"),
    /** The AgentSDR person with that number, when there is one. */
    personId: uuid("person_id"),
    name: text("name"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    lastMessagePreview: text("last_message_preview"),
    lastDirection: text("last_direction").$type<WhatsappDirection>(),
    unreadCount: integer("unread_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.accountId],
      foreignColumns: [whatsappAccounts.id],
      name: "whatsapp_chats_account_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.personId],
      foreignColumns: [people.id],
      name: "whatsapp_chats_person_fk",
    }).onDelete("set null"),
    unique("whatsapp_chats_account_chat_uq").on(table.accountId, table.unipileChatId),
    index("whatsapp_chats_account_last_message_idx").on(table.accountId, table.lastMessageAt),
    index("whatsapp_chats_person_idx").on(table.personId),
    index("whatsapp_chats_phone_idx").on(table.phone),
    check("whatsapp_chats_unread_chk", sql`${table.unreadCount} >= 0`),
    check("whatsapp_chats_last_direction_chk", sql`${table.lastDirection} IS NULL OR ${table.lastDirection} IN ('inbound', 'outbound')`),
  ],
);

/** A message in a WhatsApp chat — the lead's, AgentSDR's, or one the rep sent from their phone. */
export const whatsappMessages = pgTable(
  "whatsapp_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chatId: uuid("chat_id").notNull(),
    /** Null only between an AgentSDR send and Unipile's answer. */
    unipileMessageId: text("unipile_message_id"),
    direction: text("direction").notNull().$type<WhatsappDirection>(),
    origin: text("origin").notNull().$type<WhatsappMessageOrigin>(),
    body: text("body").notNull().default(""),
    attachments: jsonb("attachments").$type<WhatsappAttachment[]>().notNull().default([]),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
    /** The same message on the lead's CRM conversation, when it was recorded there. */
    crmConversationMessageId: uuid("crm_conversation_message_id"),
    /** The call this message followed up, when sent from Calling. */
    callSessionId: uuid("call_session_id"),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.chatId],
      foreignColumns: [whatsappChats.id],
      name: "whatsapp_messages_chat_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.crmConversationMessageId],
      foreignColumns: [crmConversationMessages.id],
      name: "whatsapp_messages_crm_message_fk",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.callSessionId],
      foreignColumns: [callSessions.id],
      name: "whatsapp_messages_call_session_fk",
    }).onDelete("set null"),
    uniqueIndex("whatsapp_messages_unipile_message_uq")
      .on(table.unipileMessageId)
      .where(sql`${table.unipileMessageId} IS NOT NULL`),
    index("whatsapp_messages_chat_sent_idx").on(table.chatId, table.sentAt),
    check("whatsapp_messages_direction_chk", sql`${table.direction} IN ('inbound', 'outbound')`),
    check("whatsapp_messages_origin_chk", sql`${table.origin} IN ('lead', 'agentsdr', 'phone')`),
    check(
      "whatsapp_messages_origin_direction_chk",
      sql`(${table.direction} = 'inbound') = (${table.origin} = 'lead')`,
    ),
  ],
);

// --- Message campaigns ----------------------------------------------------------------------
// Created by scripts/create-whatsapp-campaign-tables.ts; see
// docs/whatsapp-campaigns/plan.md and ./campaigns/contract.ts.

/** A cold-outreach sequence over WhatsApp: a first message and timed follow-ups. */
export const whatsappCampaigns = pgTable(
  "whatsapp_campaigns",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("paused").$type<WhatsappCampaignStatus>(),
    steps: jsonb("steps").notNull().default([]).$type<WhatsappCampaignStep[]>(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("whatsapp_campaigns_organization_idx").on(table.organizationId),
    check("whatsapp_campaigns_status_chk", sql`${table.status} IN ('active', 'paused')`),
  ],
);

/** The numbers that may send for a campaign. */
export const whatsappCampaignAccounts = pgTable(
  "whatsapp_campaign_accounts",
  {
    campaignId: uuid("campaign_id").notNull(),
    accountId: uuid("account_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "whatsapp_campaign_accounts_pk", columns: [table.campaignId, table.accountId] }),
    foreignKey({
      columns: [table.campaignId],
      foreignColumns: [whatsappCampaigns.id],
      name: "whatsapp_campaign_accounts_campaign_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.accountId],
      foreignColumns: [whatsappAccounts.id],
      name: "whatsapp_campaign_accounts_account_fk",
    }).onDelete("cascade"),
    index("whatsapp_campaign_accounts_account_idx").on(table.accountId),
  ],
);

/** A person enrolled in a campaign, and where their sequence stands. */
export const whatsappCampaignLeads = pgTable(
  "whatsapp_campaign_leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id").notNull(),
    personId: uuid("person_id").notNull(),
    /** E.164 at enrollment. Sends go to the Person's number; this is what the list shows. */
    phone: text("phone").notNull(),
    /** Spreadsheet columns that map to no field, usable as {{mergeFields}}. */
    customFields: jsonb("custom_fields").notNull().default({}).$type<Record<string, string>>(),
    status: text("status").notNull().default("queued").$type<WhatsappCampaignLeadStatus>(),
    /** Messages sent so far; the index of the next step. */
    currentStep: integer("current_step").notNull().default(0),
    nextSendAt: timestamp("next_send_at", { withTimezone: true }),
    /** The number that sent the first message; follow-ups stay on it. */
    accountId: uuid("account_id"),
    /** Consecutive transient failures; the lead fails after a few. */
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
    repliedAt: timestamp("replied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.campaignId],
      foreignColumns: [whatsappCampaigns.id],
      name: "whatsapp_campaign_leads_campaign_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.personId],
      foreignColumns: [people.id],
      name: "whatsapp_campaign_leads_person_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.accountId],
      foreignColumns: [whatsappAccounts.id],
      name: "whatsapp_campaign_leads_account_fk",
    }).onDelete("set null"),
    unique("whatsapp_campaign_leads_campaign_person_uq").on(table.campaignId, table.personId),
    index("whatsapp_campaign_leads_due_idx").on(table.status, table.nextSendAt),
    index("whatsapp_campaign_leads_person_idx").on(table.personId),
    check(
      "whatsapp_campaign_leads_status_chk",
      sql`${table.status} IN ('queued', 'in_sequence', 'completed', 'replied', 'stopped', 'failed')`,
    ),
    check("whatsapp_campaign_leads_step_chk", sql`${table.currentStep} >= 0`),
  ],
);

/**
 * One row per (lead, step): the claim that makes a step impossible to send
 * twice, and the step's history.
 */
export const whatsappCampaignSends = pgTable(
  "whatsapp_campaign_sends",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id").notNull(),
    /** Index into the campaign's steps at send time. */
    step: integer("step").notNull(),
    /** The step's id, so per-step stats survive reordering. */
    stepId: text("step_id"),
    status: text("status").notNull().default("sending").$type<WhatsappCampaignSendStatus>(),
    accountId: uuid("account_id"),
    whatsappMessageId: uuid("whatsapp_message_id"),
    body: text("body"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.leadId],
      foreignColumns: [whatsappCampaignLeads.id],
      name: "whatsapp_campaign_sends_lead_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.accountId],
      foreignColumns: [whatsappAccounts.id],
      name: "whatsapp_campaign_sends_account_fk",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.whatsappMessageId],
      foreignColumns: [whatsappMessages.id],
      name: "whatsapp_campaign_sends_message_fk",
    }).onDelete("set null"),
    unique("whatsapp_campaign_sends_lead_step_uq").on(table.leadId, table.step),
    check("whatsapp_campaign_sends_status_chk", sql`${table.status} IN ('sending', 'sent', 'failed')`),
  ],
);

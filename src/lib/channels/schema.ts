import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "@/lib/auth/schema";
import { people } from "@/lib/leads/schema";
import type { Channel } from "./rules";

/**
 * Each organization's sending rules, one row per channel (rules.ts declares
 * them). `values` holds only what the organization changed; everything else
 * resolves to the rule's default, so a missing row means "today's defaults".
 */
export const channelSettings = pgTable(
  "channel_settings",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    channel: text("channel").notNull().$type<Channel>(),
    values: jsonb("values").$type<Record<string, unknown>>().notNull().default({}),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ name: "channel_settings_pkey", columns: [table.organizationId, table.channel] })],
);

export type ChannelSettingsRow = typeof channelSettings.$inferSelect;

/**
 * The daily lead limit's ledger (dailyLeadLimit.server.ts): each person's
 * first automated contact, written in the engine's claim transaction. It
 * outlives the campaign, lead and claim rows, so deleting them gives no
 * place back; an engine's definite failure releases it.
 */
export const leadFirstContacts = pgTable(
  "lead_first_contacts",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    firstAt: timestamp("first_at", { withTimezone: true }).notNull(),
    channel: text("channel").notNull().$type<"email" | "linkedin" | "whatsapp" | "instagram">(),
  },
  (table) => [
    primaryKey({ name: "lead_first_contacts_pkey", columns: [table.organizationId, table.personId] }),
    index("lead_first_contacts_day_idx").on(table.organizationId, table.firstAt),
    check("lead_first_contacts_channel_chk", sql`${table.channel} IN ('email', 'linkedin', 'whatsapp', 'instagram')`),
  ],
);

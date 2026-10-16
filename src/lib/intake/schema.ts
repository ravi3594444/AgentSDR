import { sql } from "drizzle-orm";
import { boolean, check, index, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "@/lib/auth/schema";
import { instagramChats } from "@/lib/instagram/schema";
import { people } from "@/lib/leads/schema";

/**
 * Inquiry intake (docs/product/INSTAGRAM_INTAKE_DISCOVERY.md): website-form
 * webhooks the owner adds to their form tool, and new Instagram messages
 * from people AgentSDR did not know. Created by
 * scripts/add-instagram-intake-discovery.ts; both tables are scoped by
 * organization.
 */

/** Which form field holds what. Keys are AgentSDR's; values are the form's own field names. */
export type IntakeFieldMap = {
  email?: string;
  phone?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  message?: string;
  pageUrl?: string;
  /** The form's own id for a submission, for de-duplicating retries (otherwise a hash of the content). */
  submissionId?: string;
  submittedAt?: string;
};

/**
 * One authenticated website-form webhook. The secret token is shown once
 * when the endpoint is made; only its SHA-256 is stored (`token_hash`,
 * unique, which is how a delivery finds its organization).
 */
export const intakeEndpoints = pgTable(
  "intake_endpoints",
  {
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    /** The token's last four characters, so the owner can tell endpoints apart. */
    tokenHint: text("token_hint").notNull(),
    fieldMap: jsonb("field_map").$type<IntakeFieldMap>().notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),
    createdBy: uuid("created_by"),
    lastReceivedAt: timestamp("last_received_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("intake_endpoints_token_hash_uq").on(table.tokenHash),
    index("intake_endpoints_organization_idx").on(table.organizationId),
  ],
);

export type InquirySource = "website_form" | "instagram";
export type InquiryStatus = "received" | "unusable";

/**
 * One inquiry: a form submission or the first message of a new Instagram
 * chat. `historical` inquiries came from an import and never start replies.
 * `dedupe_key` (unique per organization and source) makes a retried
 * delivery a no-op.
 */
export const inquiries = pgTable(
  "inquiries",
  {
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source").notNull().$type<InquirySource>(),
    endpointId: uuid("endpoint_id").references(() => intakeEndpoints.id, { onDelete: "set null" }),
    instagramChatId: uuid("instagram_chat_id").references(() => instagramChats.id, { onDelete: "set null" }),
    dedupeKey: text("dedupe_key").notNull(),
    personId: uuid("person_id").references(() => people.id, { onDelete: "set null" }),
    name: text("name"),
    email: text("email"),
    phone: text("phone"),
    /** What they wrote, word for word: the only evidence of need an inquiry carries. */
    message: text("message"),
    /** Other mapped and unmapped form fields, as sent. */
    fields: jsonb("fields").$type<Record<string, string>>().notNull().default({}),
    pageUrl: text("page_url"),
    historical: boolean("historical").notNull().default(false),
    status: text("status").notNull().default("received").$type<InquiryStatus>(),
    /** Why an unusable inquiry could not become a contact. */
    reason: text("reason"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
  },
  (table) => [
    uniqueIndex("inquiries_org_source_dedupe_uq").on(table.organizationId, table.source, table.dedupeKey),
    index("inquiries_organization_received_idx").on(table.organizationId, table.receivedAt),
    index("inquiries_person_idx").on(table.personId),
    check("inquiries_source_chk", sql`${table.source} IN ('website_form', 'instagram')`),
    check("inquiries_status_chk", sql`${table.status} IN ('received', 'unusable')`),
  ],
);

export type IntakeEndpointRow = typeof intakeEndpoints.$inferSelect;
export type InquiryRow = typeof inquiries.$inferSelect;

import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { people } from "@/lib/leads/schema";
import { organizations } from "@/lib/auth/schema";

export type MailboxStatus = "connecting" | "connected" | "failed" | "disabled";

export type MailboxProvider = "google" | "unipile";

export type WorkingDay = { enabled: boolean; from: string; to: string }; // from/to as "HH:mm" 24h

export type WorkingHours = {
  timezone: string;
  days: {
    monday: WorkingDay;
    tuesday: WorkingDay;
    wednesday: WorkingDay;
    thursday: WorkingDay;
    friday: WorkingDay;
    saturday: WorkingDay;
    sunday: WorkingDay;
  };
};

/** Mon–Fri 9am–6pm IST, weekends off — a sane default so a mailbox sends immediately after connecting without extra setup. */
export const DEFAULT_WORKING_HOURS: WorkingHours = {
  timezone: "Asia/Kolkata",
  days: {
    monday: { enabled: true, from: "09:00", to: "18:00" },
    tuesday: { enabled: true, from: "09:00", to: "18:00" },
    wednesday: { enabled: true, from: "09:00", to: "18:00" },
    thursday: { enabled: true, from: "09:00", to: "18:00" },
    friday: { enabled: true, from: "09:00", to: "18:00" },
    saturday: { enabled: false, from: "09:00", to: "18:00" },
    sunday: { enabled: false, from: "09:00", to: "18:00" },
  },
};

/**
 * A sending inbox connected via our Google service account's domain-wide
 * delegation — connecting a mailbox is just naming an email address the
 * service account is authorized to impersonate (no per-mailbox OAuth/password).
 */
export const mailboxes = pgTable("outreach_mailboxes", {
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  id: uuid("id").primaryKey().defaultRandom(),
  emailAddress: text("email_address").notNull().unique(),
  /**
   * What sends and receives for this mailbox: Google Workspace (service
   * account, Gmail push) or Unipile (an email account linked in Unipile —
   * Gmail, Outlook or IMAP — sent through Unipile's API, replies by its email
   * webhook). See src/lib/outreach/mailboxProviders.ts.
   */
  provider: text("provider").notNull().default("google").$type<MailboxProvider>(),
  /** Unipile only: the linked account. A provider identity, so unique across organizations. */
  unipileAccountId: text("unipile_account_id"),
  displayName: text("display_name"),
  status: text("status").notNull().default("connecting").$type<MailboxStatus>(),
  lastError: text("last_error"),
  lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
  /** Gmail History API cursor — set once the first successful sync/watch runs. */
  lastHistoryId: text("last_history_id"),
  dailySendLimit: integer("daily_send_limit").notNull().default(30),
  todayEmailsSent: integer("today_emails_sent").notNull().default(0),
  sendCounterResetAt: timestamp("send_counter_reset_at", { withTimezone: true }),
  nextEmailTime: timestamp("next_email_time", { withTimezone: true }),
  signatureHtml: text("signature_html"),
  /** Per-day send window + timezone — the scheduler won't send outside this window. Defaults to Mon-Fri 9-6 ET. */
  workingHours: jsonb("working_hours").$type<WorkingHours>().notNull().default(DEFAULT_WORKING_HOURS),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
},
  (t) => [
    index("outreach_mailboxes_organization_idx").on(t.organizationId),
    uniqueIndex("outreach_mailboxes_unipile_account_uq").on(t.unipileAccountId).where(sql`${t.unipileAccountId} IS NOT NULL`),
    check("outreach_mailboxes_provider_chk", sql`${t.provider} IN ('google', 'unipile')`),
  ],
);

export type SuppressionReason = "unsubscribed" | "bounced" | "manual" | "complaint";

/** Emails that must never receive outreach sends — checked before every send. */
export const suppressionList = pgTable("outreach_suppression_list", {
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  reason: text("reason").notNull().$type<SuppressionReason>(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
},
  (t) => [
    index("outreach_suppression_list_organization_idx").on(t.organizationId),
    uniqueIndex("outreach_suppression_org_email_uq").on(t.organizationId, t.email),
  ],
);

export type CampaignStatus = "draft" | "active" | "paused" | "completed";

/** One step of an authored sequence, e.g. "initial" or "follow-up 2, 3 days later". */
export type SequenceStep = {
  stepNumber: number;
  subject: string;
  body: string;
  /** Days after the previous step before this one sends. 0 for the initial step. */
  waitDays: number;
};

/**
 * No mailboxId here — mailbox assignment is per-lead (see outreachLeads),
 * not per-campaign, so multiple active campaigns can share the same pool of
 * connected mailboxes without starving each other (matches AgentSDR-app's
 * make-mailbox-queue-for-team.ts model).
 */
export const outreachCampaigns = pgTable("outreach_campaigns", {
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  status: text("status").notNull().default("draft").$type<CampaignStatus>(),
  sequence: jsonb("sequence").notNull().default([]).$type<SequenceStep[]>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
},
  (t) => [index("outreach_campaigns_organization_idx").on(t.organizationId)],
);

export type OutreachLeadStatus =
  | "pending"
  | "initial_sent"
  | "in_follow_up"
  | "reply_processing"
  | "sequence_completed"
  | "reply_received"
  | "bounced"
  | "suppressed";

/**
 * A CSV-imported lead assigned to a campaign's sequence. mailboxId is
 * assigned round-robin across connected mailboxes with spare capacity when
 * the lead's first email actually sends (not at import time) — this is what
 * lets several active campaigns share one mailbox pool.
 */
export const outreachLeads = pgTable("outreach_leads", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Canonical recipient. Populated for every row before this code is deployed. */
  personId: uuid("person_id").notNull().references(() => people.id, { onDelete: "restrict" }),
  campaignId: uuid("campaign_id")
    .notNull()
    .references(() => outreachCampaigns.id, { onDelete: "cascade" }),
  mailboxId: uuid("mailbox_id").references(() => mailboxes.id),
  /** @deprecated Legacy pre-migration snapshot. New sends resolve through personId. */
  email: text("email"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  company: text("company"),
  /** Extra per-lead fields beyond the standard ones — any CSV column not recognized as email/name/company, keyed by its lowercased header. Usable in a sequence as {{columnHeader}}. */
  customFields: jsonb("custom_fields").$type<Record<string, string>>().default({}),
  sequenceStatus: text("sequence_status").notNull().default("pending").$type<OutreachLeadStatus>(),
  currentStep: integer("current_step").notNull().default(0),
  nextSendAt: timestamp("next_send_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [uniqueIndex("outreach_leads_person_campaign_uq").on(t.personId, t.campaignId)]);

/**
 * The Postgres equivalent of AgentSDR-app's per-mailbox Redis send queue.
 * buildMailboxQueues() (run once daily) fills this with the leads due to
 * send today, in priority order; the tick handler pops the lowest-position
 * row for each mailbox and deletes it after a successful send.
 */
export const outreachMailboxQueue = pgTable("outreach_mailbox_queue", {
  id: uuid("id").primaryKey().defaultRandom(),
  mailboxId: uuid("mailbox_id")
    .notNull()
    .references(() => mailboxes.id, { onDelete: "cascade" }),
  leadId: uuid("lead_id")
    .notNull()
    .references(() => outreachLeads.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => [uniqueIndex("outreach_mailbox_queue_lead_uq").on(t.leadId)]);

export type OutreachEmailStatus = "scheduled" | "sent" | "failed";

/** One scheduled/sent step for a lead — mirrors AgentSDR-app's `email` table, scoped down. */
export const outreachEmails = pgTable("outreach_emails", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: uuid("lead_id")
    .notNull()
    .references(() => outreachLeads.id, { onDelete: "cascade" }),
  mailboxId: uuid("mailbox_id").references(() => mailboxes.id),
  stepNumber: integer("step_number").notNull(),
  subject: text("subject"),
  body: text("body"),
  status: text("status").notNull().default("scheduled").$type<OutreachEmailStatus>(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  gmailMessageId: text("gmail_message_id"),
  messageId: text("message_id"),
  threadId: text("thread_id"),
  inReplyTo: text("in_reply_to"),
  references: text("references").array(),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => [uniqueIndex("outreach_emails_lead_step_uq").on(t.leadId, t.stepNumber)]);

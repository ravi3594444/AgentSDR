import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "@/lib/auth/schema";
import { companies, people } from "@/lib/leads/schema";

/**
 * The owner's assistant (src/lib/assistant/): a chat that takes the owner's
 * business information, documents and contact lists, finds leads, proposes
 * outreach and runs it through the existing campaign, CRM and knowledge
 * services. Every table is scoped by organization (src/lib/tenancy/registry.ts)
 * and created by scripts/create-assistant-tables.ts.
 */

export type AssistantRole = "user" | "assistant" | "tool" | "event";
export type AssistantToolStatus = "running" | "ok" | "error";

/** A file attached to a user message, as the chat shows it. */
export type AssistantAttachment = {
  name: string;
  kind: "document" | "contacts";
  bytes: number;
};

export const assistantThreads = pgTable(
  "assistant_threads",
  {
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull().default("Conversation"),
    createdBy: uuid("created_by"),
    /** Set while a turn is being worked on, so a second message waits instead of racing it. */
    busySince: timestamp("busy_since", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("assistant_threads_organization_idx").on(t.organizationId, t.updatedAt)],
);

/**
 * One line of the chat. `tool` rows are actions the server actually ran,
 * with their input and result: the chat shows these, so what the assistant
 * says it did can always be checked against what happened.
 */
export const assistantMessages = pgTable(
  "assistant_messages",
  {
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id").notNull().references(() => assistantThreads.id, { onDelete: "cascade" }),
    role: text("role").notNull().$type<AssistantRole>(),
    content: text("content").notNull().default(""),
    tool: text("tool"),
    toolInput: jsonb("tool_input").$type<Record<string, unknown>>(),
    toolResult: jsonb("tool_result").$type<Record<string, unknown>>(),
    status: text("status").$type<AssistantToolStatus>(),
    attachments: jsonb("attachments").$type<AssistantAttachment[]>().notNull().default([]),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("assistant_messages_organization_idx").on(t.organizationId),
    index("assistant_messages_thread_idx").on(t.threadId, t.createdAt),
    check("assistant_messages_role_chk", sql`${t.role} IN ('user', 'assistant', 'tool', 'event')`),
    check("assistant_messages_status_chk", sql`${t.status} IS NULL OR ${t.status} IN ('running', 'ok', 'error')`),
  ],
);

/** What the owner told the assistant about the business and how to reach out; see profile.ts. */
export type BusinessProfile = {
  businessName?: string;
  website?: string;
  /** What is sold, to whom, and why it helps. */
  offer?: string;
  /** Who the customers are: kinds of businesses or roles, sizes, signals. */
  targetCustomers?: string;
  /** Cities, regions or countries to look in. */
  locations?: string;
  /** How messages should sound and what they must or must not say. */
  outreachInstructions?: string;
  /** The name and role messages are signed with. */
  senderName?: string;
  senderRole?: string;
  /** How a meeting gets booked (a calendar link, a phone number). */
  bookingDetails?: string;
  /** Preferred channels, in order. */
  preferredChannels?: ("email" | "whatsapp" | "linkedin")[];
  /** Two-letter language for discovery and messages, e.g. "en". */
  language?: string;
  /** Anything else worth remembering, as the owner said it. */
  notes?: string;
};

export const assistantProfiles = pgTable("assistant_profiles", {
  organizationId: uuid("organization_id").primaryKey().references(() => organizations.id),
  profile: jsonb("profile").$type<BusinessProfile>().notNull().default({}),
  /** The knowledge document this profile is mirrored into, so CRM reply drafts use it too. */
  knowledgeDocumentId: uuid("knowledge_document_id"),
  updatedBy: uuid("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AudienceSource = "discovery" | "list";

/** A set of leads the assistant found or was given, which one outreach run works through. */
export const leadAudiences = pgTable(
  "lead_audiences",
  {
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id").references(() => assistantThreads.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    source: text("source").notNull().$type<AudienceSource>(),
    /** For discovery: what was searched, where, and with which source. */
    criteria: jsonb("criteria").$type<Record<string, unknown>>().notNull().default({}),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("lead_audiences_organization_idx").on(t.organizationId, t.createdAt),
    check("lead_audiences_source_chk", sql`${t.source} IN ('discovery', 'list')`),
  ],
);

export type AudienceChannel = "email" | "whatsapp" | "linkedin";

/** Where a contact detail came from: the page or listing a person can open to check it. */
export type ContactEvidence = { kind: "email" | "phone" | "linkedin" | "website"; value: string; sourceUrl: string | null; source: string };

/**
 * One lead in an audience: a person who can be contacted (eligible) or a
 * business that was found but cannot be (excluded, with the reason, e.g. no
 * public email or phone). Excluded rows have no person.
 */
export const leadAudienceMembers = pgTable(
  "lead_audience_members",
  {
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    audienceId: uuid("audience_id").notNull().references(() => leadAudiences.id, { onDelete: "cascade" }),
    personId: uuid("person_id").references(() => people.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    status: text("status").notNull().$type<"eligible" | "excluded">(),
    reason: text("reason"),
    channels: text("channels").array().$type<AudienceChannel[]>().notNull().default(sql`ARRAY[]::text[]`),
    /** "google_maps", "list", … */
    source: text("source").notNull(),
    sourceUrl: text("source_url"),
    evidence: jsonb("evidence").$type<ContactEvidence[]>().notNull().default([]),
    /** Facts the messages may use: category, city, rating, … */
    facts: jsonb("facts").$type<Record<string, string>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("lead_audience_members_organization_idx").on(t.organizationId),
    index("lead_audience_members_audience_idx").on(t.audienceId, t.status),
    uniqueIndex("lead_audience_members_person_uq").on(t.audienceId, t.personId).where(sql`${t.personId} IS NOT NULL`),
    check("lead_audience_members_status_chk", sql`${t.status} IN ('eligible', 'excluded')`),
  ],
);

export type AssistantJobKind = "discovery" | "outreach_start";
export type AssistantJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/**
 * Work that outlives a request: a lead discovery (minutes: the scraper,
 * then website visits) or starting an approved outreach run (writing each
 * lead's message, then launching). Run by the in-process worker in
 * worker.ts, which claims a row, works one stage, and records progress the
 * chat polls. `heartbeat_at` keeps a long stage from being reclaimed.
 */
export const assistantJobs = pgTable(
  "assistant_jobs",
  {
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull().$type<AssistantJobKind>(),
    status: text("status").notNull().default("queued").$type<AssistantJobStatus>(),
    stage: text("stage").notNull().default("queued"),
    threadId: uuid("thread_id").references(() => assistantThreads.id, { onDelete: "set null" }),
    audienceId: uuid("audience_id").references(() => leadAudiences.id, { onDelete: "set null" }),
    runId: uuid("run_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    progress: jsonb("progress").$type<Record<string, unknown>>().notNull().default({}),
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: text("error"),
    /** The scraper's job id, while a discovery waits on it. */
    externalId: text("external_id"),
    attempts: integer("attempts").notNull().default(0),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    lockedBy: text("locked_by"),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("assistant_jobs_organization_idx").on(t.organizationId, t.createdAt),
    index("assistant_jobs_claim_idx").on(t.status, t.runAfter),
    check("assistant_jobs_kind_chk", sql`${t.kind} IN ('discovery', 'outreach_start')`),
    check("assistant_jobs_status_chk", sql`${t.status} IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')`),
  ],
);

export type OutreachRunStatus = "proposed" | "starting" | "running" | "paused" | "completed" | "failed" | "cancelled";

/** One message of a generated sequence, before per-lead personalization. */
export type PlannedStep = { subject: string | null; body: string; waitDays: number };

/** What the owner approves: audience, channels, messages, limits and what it costs. */
export type OutreachPlan = {
  /** The people the run will contact, per channel (each person gets one channel). */
  assignments: { personId: string; channel: AudienceChannel }[];
  sequences: Partial<Record<AudienceChannel, PlannedStep[]>>;
  /** The per-lead line's merge key, e.g. "p_1a2b3c4d" (stored on people.raw). */
  personalizationKey: string;
  /** A few leads' messages as they will be sent, for the owner to read. */
  samples: { personId: string; name: string; channel: AudienceChannel; messages: { subject: string | null; body: string }[] }[];
  limits: { maxLeads: number; emailPerMailboxPerDay: number | null; whatsappNewChatsPerDay: number | null };
  /** Leads left out and why, counted by reason. */
  excluded: { reason: string; count: number }[];
  estimate: { aiCalls: number; aiCostUsd: number | null; days: number | null };
  /** Answer ordinary replies without asking (see src/lib/crm/autopilot.ts). */
  autopilot: boolean;
  instructions: string | null;
};

export const outreachRuns = pgTable(
  "outreach_runs",
  {
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id").references(() => assistantThreads.id, { onDelete: "set null" }),
    audienceId: uuid("audience_id").notNull().references(() => leadAudiences.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    status: text("status").notNull().default("proposed").$type<OutreachRunStatus>(),
    channels: text("channels").array().$type<AudienceChannel[]>().notNull().default(sql`ARRAY[]::text[]`),
    plan: jsonb("plan").$type<OutreachPlan>().notNull(),
    /** The campaigns the run created, per channel. */
    campaigns: jsonb("campaigns").$type<Partial<Record<AudienceChannel, string>>>().notNull().default({}),
    autopilot: boolean("autopilot").notNull().default(false),
    error: text("error"),
    approvedBy: uuid("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("outreach_runs_organization_idx").on(t.organizationId, t.createdAt),
    check("outreach_runs_status_chk", sql`${t.status} IN ('proposed', 'starting', 'running', 'paused', 'completed', 'failed', 'cancelled')`),
  ],
);

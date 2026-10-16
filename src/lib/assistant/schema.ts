import { boolean, check, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
  /** The problems the offer solves and how, in the owner's words: what replies connect a lead's problem to. */
  problemsSolved?: string;
  /** What an interested lead is offered next ("a 10-minute call with Ravi", "a free visit", "a quote"); default: a short call with the sender. */
  nextStep?: string;
  /** Prices, packages or rates, in the owner's words (a price list document works too). */
  prices?: string;
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

/** discovery: found by a search; list: an upload or contacts typed in the chat; existing: chosen from the lead database; inquiries: people who wrote in. */
export type AudienceSource = "discovery" | "list" | "existing" | "inquiries";

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
    check("lead_audiences_source_chk", sql`${t.source} IN ('discovery', 'list', 'existing', 'inquiries')`),
  ],
);

export type AudienceChannel = "email" | "whatsapp" | "linkedin";

/** Where a contact detail came from: the page or listing a person can open to check it. */
export type ContactEvidence = { kind: "email" | "phone" | "linkedin" | "website" | "instagram"; value: string; sourceUrl: string | null; source: string };

/**
 * Something a lead actually said or did that bears on whether they need the
 * offer, quoted with where it was found. Only `need` signals are evidence of
 * a need: a follow, like or generic comment is recorded as `engagement` and
 * never counts as buying intent (qualification.ts).
 */
export type LeadSignal = {
  kind: "need" | "engagement";
  /** Their words, exactly as found (an inquiry, a comment, a post caption). */
  text: string;
  sourceUrl: string | null;
  /** "website form", "Instagram comment", "Instagram message", … */
  source: string;
  /** When they said it, when known (ISO). */
  at: string | null;
};

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
    /** Why the search or list matched this lead, in a sentence (never shown to the lead). */
    matchReason: text("match_reason"),
    /** What the lead actually said or did, quoted with its source (LeadSignal). Empty: no evidence of need. */
    signals: jsonb("signals").$type<LeadSignal[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("lead_audience_members_organization_idx").on(t.organizationId),
    index("lead_audience_members_audience_idx").on(t.audienceId, t.status),
    uniqueIndex("lead_audience_members_person_uq").on(t.audienceId, t.personId).where(sql`${t.personId} IS NOT NULL`),
    check("lead_audience_members_status_chk", sql`${t.status} IN ('eligible', 'excluded')`),
  ],
);

export type AssistantJobKind = "discovery" | "outreach_start" | "linkedin_search" | "web_discovery";
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
    check("assistant_jobs_kind_chk", sql`${t.kind} IN ('discovery', 'outreach_start', 'linkedin_search', 'web_discovery')`),
    check("assistant_jobs_status_chk", sql`${t.status} IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')`),
  ],
);

/** `stopped` is final: the owner ended the run; nothing more is sent for it. */
export type OutreachRunStatus = "proposed" | "starting" | "running" | "paused" | "stopped" | "completed" | "failed" | "cancelled";

/** One message of a generated sequence, before per-lead personalization. */
export type PlannedStep = { subject: string | null; body: string; waitDays: number };

/** What the owner approves: audience, channels, messages, limits and what it costs. */
export type OutreachPlan = {
  /**
   * "outreach" (absent on every plan written before inquiry runs): first
   * messages and follow-ups to an audience. "inquiries": no first message
   * at all — the run only answers people whose fresh inquiry arrives while
   * it runs (see inquiryRuns.server.ts); its members are added as they
   * write in, never from imported history.
   */
  kind?: "outreach" | "inquiries";
  /** For an inquiry run: which inbound channels and accounts it answers. */
  inquiry?: { channels: "instagram"[]; accounts: { unipileAccountId: string; username: string | null }[] };
  /** The people the run will contact, per channel (each person gets one channel). */
  assignments: { personId: string; channel: AudienceChannel }[];
  sequences: Partial<Record<AudienceChannel, PlannedStep[]>>;
  /** The per-lead line's merge key, e.g. "p_1a2b3c4d" (stored on people.raw). */
  personalizationKey: string;
  /** A few leads' messages as they will be sent, for the owner to read. */
  samples: { personId: string; name: string; channel: AudienceChannel; groupId?: string; approach?: "standard" | "personal"; messages: { subject: string | null; body: string }[] }[];
  limits: { maxLeads: number; emailPerMailboxPerDay: number | null; whatsappNewChatsPerDay: number | null };
  /** Leads left out and why, counted by reason. */
  excluded: { reason: string; count: number }[];
  estimate: { aiCalls: number; aiCostUsd: number | null; days: number | null };
  /** Automatic mode: answer ordinary replies without asking (see src/lib/crm/autopilot.ts). */
  autopilot: boolean;
  instructions: string | null;
  /** A follow-on plan reusing an earlier run's messages (an expansion the owner confirms again). */
  basedOnRunId?: string | null;
  /** The owner's words that asked for this outreach (checked against the chat). */
  ownerRequest?: string | null;
  /**
   * Plans written since leads are sorted: the kinds of lead, each with its
   * own messages; how each lead is approached; the first messages written
   * for single leads; and the leads left out, with the reason. Each lead's
   * texts are stored on it at Start (messages.ts leadTextKey) and the
   * campaigns' steps point at them; older plans use `sequences` directly.
   */
  groups?: PlanGroup[];
  leadPlans?: Record<string, { groupId: string; approach: "standard" | "personal"; reason: string }>;
  personal?: { personId: string; name: string; channel: AudienceChannel; groupId: string; subject: string | null; body: string; reason: string }[];
  skipped?: { personId: string; name: string; reason: string }[];
};

export type PlanGroup = {
  id: string;
  label: string;
  count: number;
  sequences: Partial<Record<AudienceChannel, PlannedStep[]>>;
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
    /** Reply mode of this run: true = Automatic, false = Review. Only this run's conversations. */
    autopilot: boolean("autopilot").notNull().default(false),
    error: text("error"),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    approvedBy: uuid("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("outreach_runs_organization_idx").on(t.organizationId, t.createdAt),
    check("outreach_runs_status_chk", sql`${t.status} IN ('proposed', 'starting', 'running', 'paused', 'stopped', 'completed', 'failed', 'cancelled')`),
  ],
);

export type RunLeadStatus = "active" | "stopped" | "opted_out";

/**
 * The channel a run member is answered on: the outreach channels, plus
 * "instagram" for an inquiry run (plan.kind "inquiries"), which only answers
 * people who wrote in on Instagram and never starts a conversation.
 */
export type RunLeadChannel = AudienceChannel | "instagram";

/**
 * Who a started run covers, on which channel: the approved audience. The
 * reply autopilot answers a conversation only through the run its person
 * belongs to on that channel (its mode, its state); nothing outside it.
 */
export const outreachRunLeads = pgTable(
  "outreach_run_leads",
  {
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => outreachRuns.id, { onDelete: "cascade" }),
    personId: uuid("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
    channel: text("channel").notNull().$type<RunLeadChannel>(),
    status: text("status").notNull().default("active").$type<RunLeadStatus>(),
    stopReason: text("stop_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("outreach_run_leads_run_person_uq").on(t.runId, t.personId),
    index("outreach_run_leads_person_idx").on(t.organizationId, t.personId),
    check("outreach_run_leads_channel_chk", sql`${t.channel} IN ('email', 'whatsapp', 'linkedin', 'instagram')`),
    check("outreach_run_leads_status_chk", sql`${t.status} IN ('active', 'stopped', 'opted_out')`),
  ],
);

export type AutopilotReplyStatus = "reserved" | "sent" | "failed" | "held";

/** What the support check found, kept with each decision for the owner to read. */
export type ReplyCheck = {
  intent: string;
  questions: { question: string; answered: boolean; evidence: string; supported: boolean; clarification?: string; clarifies?: boolean }[];
  claims: { claim: string; evidence: string; supported: boolean }[];
  commitments: string[];
  problems: string[];
};

/**
 * One row per draft revision the autopilot decided on: a reservation taken
 * under the organization's lock before sending (it counts toward the
 * limits, so concurrent jobs cannot exceed them), then sent or failed; or
 * held, with the reason. Unique per (draft, revision): never two sends.
 */
export const autopilotReplies = pgTable(
  "autopilot_replies",
  {
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    draftId: uuid("draft_id").notNull(),
    revision: integer("revision").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    runId: uuid("run_id"),
    personId: uuid("person_id"),
    status: text("status").notNull().$type<AutopilotReplyStatus>(),
    reason: text("reason"),
    check: jsonb("check").$type<ReplyCheck>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("autopilot_replies_draft_revision_uq").on(t.draftId, t.revision),
    index("autopilot_replies_organization_idx").on(t.organizationId, t.createdAt),
    index("autopilot_replies_conversation_idx").on(t.conversationId),
    check("autopilot_replies_status_chk", sql`${t.status} IN ('reserved', 'sent', 'failed', 'held')`),
  ],
);

export type OwnerDecisionKind = "missing_info" | "complaint" | "negotiation" | "commitment" | "uncertain" | "meeting" | "opt_out" | "interested" | "ready" | "person" | "limit";
export type OwnerDecisionStatus = "open" | "answered" | "resolved";

/**
 * Something only the owner can settle, with the reason and the decision
 * needed: a question the saved information does not answer (the answer is
 * saved to knowledge for every later conversation), a complaint, a
 * negotiation or promise outside the owner's rules, an uncertain answer, a
 * meeting to arrange. `opt_out` and `interested` are reports, not questions.
 */
export const ownerDecisions = pgTable(
  "owner_decisions",
  {
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull().$type<OwnerDecisionKind>(),
    status: text("status").notNull().default("open").$type<OwnerDecisionStatus>(),
    /** Why the assistant stopped, in a sentence. */
    reason: text("reason").notNull(),
    /** What the owner is asked to decide or answer. */
    decision: text("decision").notNull(),
    /** The lead's words the decision is about. */
    leadMessage: text("lead_message"),
    personId: uuid("person_id"),
    crmRecordId: uuid("crm_record_id"),
    conversationId: uuid("conversation_id"),
    draftId: uuid("draft_id"),
    runId: uuid("run_id"),
    /** A few lines on the lead and what they want, for the Needs you list and the alert. */
    brief: text("brief"),
    /** When the lead was told a person takes over (one message, see handoff.ts). */
    handoverSentAt: timestamp("handover_sent_at", { withTimezone: true }),
    /** When the owners were emailed about it, and reminded. */
    alertedAt: timestamp("alerted_at", { withTimezone: true }),
    remindedAt: timestamp("reminded_at", { withTimezone: true }),
    answer: text("answer"),
    answeredBy: uuid("answered_by"),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("owner_decisions_organization_idx").on(t.organizationId, t.status, t.createdAt),
    uniqueIndex("owner_decisions_draft_kind_uq").on(t.draftId, t.kind).where(sql`${t.draftId} IS NOT NULL AND ${t.status} = 'open'`),
    index("owner_decisions_conversation_idx").on(t.conversationId).where(sql`${t.status} = 'open'`),
    check("owner_decisions_kind_chk", sql`${t.kind} IN ('missing_info', 'complaint', 'negotiation', 'commitment', 'uncertain', 'meeting', 'opt_out', 'interested', 'ready', 'person', 'limit')`),
    check("owner_decisions_status_chk", sql`${t.status} IN ('open', 'answered', 'resolved')`),
  ],
);

/** The owner (or a team member) answers this conversation personally: the autopilot stays out. */
export const autopilotTakeovers = pgTable(
  "autopilot_takeovers",
  {
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id").notNull(),
    reason: text("reason").notNull(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("autopilot_takeovers_conversation_uq").on(t.conversationId),
    index("autopilot_takeovers_organization_idx").on(t.organizationId),
  ],
);

export type UsageKind = "assistant" | "outreach_writing" | "personal_lines" | "lead_sorting" | "reply_check" | "handoff_brief" | "linkedin_search";

/**
 * Recorded AI spending of the assistant's own model calls: the provider's
 * reported cost when it gives one (`cost_usd`), else null with the tokens,
 * so reports separate recorded cost from calls whose cost is unknown.
 */
export const assistantUsage = pgTable(
  "assistant_usage",
  {
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull().$type<UsageKind>(),
    model: text("model"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    runId: uuid("run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("assistant_usage_organization_idx").on(t.organizationId, t.createdAt),
  ],
);

/** The day's results, written at the start of the organization's next day (its time zone). */
export const dailySummaries = pgTable(
  "daily_summaries",
  {
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    /** The local day summarised, YYYY-MM-DD in `time_zone`. */
    day: text("day").notNull(),
    timeZone: text("time_zone").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("daily_summaries_organization_day_uq").on(t.organizationId, t.day),
  ],
);

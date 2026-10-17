import type { Config } from "drizzle-kit";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set — drizzle-kit needs it to reach the database");
}

/**
 * This database is shared with the linkedin-automation-next platform, which
 * manages its own tables through Prisma. Without a filter, drizzle-kit diffs
 * our schema against EVERY table in the database, sees Prisma's as unknown,
 * and offers to drop them — including _prisma_migrations, which is that
 * platform's entire migration history.
 *
 * This is an allowlist rather than a blocklist on purpose: a new Prisma table
 * added tomorrow is protected automatically, whereas a blocklist would have to
 * be updated by someone who remembered this constraint existed.
 *
 * Keep in sync with the pgTable() names in src/lib/**\/schema.ts.
 *
 * ---------------------------------------------------------------------------
 * DO NOT ADD THE LEAD DATABASE TABLES HERE
 * ---------------------------------------------------------------------------
 * `people`, `companies`, `entity_columns` and `import_runs` are absent on
 * purpose, breaking the "every snake_case table
 * goes in the allowlist" rule in CLAUDE.md.
 *
 * `people` and `companies` gain columns at RUNTIME — the column settings UI
 * runs ALTER TABLE ... ADD COLUMN (src/lib/leads/columns.ts). Their Drizzle
 * definitions describe the core columns only and are structurally incomplete
 * by design. Listing them here would make drizzle-kit read that partial
 * definition as the truth, see every user-added column as drift, and offer to
 * DROP it — silently destroying user data on the next `push`.
 *
 * The other two are excluded so the rule stays one sentence: the lead database
 * is hand-maintained through scripts/create-lead-tables.ts, exactly like the
 * ex-Prisma LinkedIn tables.
 */
const OWNED_TABLES = [
  // Better Auth (src/lib/auth/schema.ts)
  "users",
  "sessions",
  "accounts",
  "verifications",
  "organizations",
  "members",
  "invitations",
  "teams",
  "team_members",
  "call_campaign_contacts",
  "call_campaigns",
  "call_messages",
  "call_sessions",
  "campaigns",
  "clean_domains",
  "crm_email_drafts",
  "crm_lead_ccs",
  "crm_leads",
  "crm_messages",
  "crm_notes",
  "crm_tasks",
  "crm_webhook_events",
  "crm_pipelines",
  "crm_categories",
  "crm_subcategories",
  "crm_settings",
  "crm_person_contact_policies",
  "crm_records",
  "crm_conversations",
  "crm_conversation_messages",
  "crm_classifications",
  "crm_events",
  "crm_sequences",
  "crm_sequence_versions",
  "crm_sequence_steps",
  "crm_subcategory_sequence_assignments",
  "crm_record_sequence_overrides",
  "crm_sequence_runs",
  "crm_sequence_step_runs",
  "crm_drafts",
  "crm_send_attempts",
  "crm_knowledge_documents",
  "crm_knowledge_document_versions",
  "crm_draft_knowledge_citations",
  "crm_jobs",
  "domains",
  "grid_cell_runs",
  "grid_columns",
  "grid_folders",
  "grid_jobs",
  "grid_provider_credentials",
  "grid_providers",
  "channel_settings",
  "grid_rows",
  "grid_tables",
  "grid_workbooks",
  "lead_research",
  // The owner's assistant (src/lib/assistant/schema.ts)
  "assistant_threads",
  "assistant_messages",
  "assistant_profiles",
  "lead_audiences",
  "lead_audience_members",
  "assistant_jobs",
  "outreach_runs",
  "outreach_run_leads",
  "autopilot_replies",
  "reply_agent_runs",
  "owner_decisions",
  "autopilot_takeovers",
  "assistant_usage",
  "daily_summaries",
  "outreach_campaigns",
  "outreach_emails",
  "outreach_leads",
  "outreach_mailbox_queue",
  "outreach_mailboxes",
  "outreach_suppression_list",
  "qualification_jobs",
  "scheduled_job_runs",
  "targeted_domains",
  "whatsapp_accounts",
  "whatsapp_campaign_accounts",
  "whatsapp_campaign_leads",
  "whatsapp_campaign_sends",
  "whatsapp_campaigns",
  "whatsapp_chats",
  "whatsapp_messages",
  "instagram_accounts",
  "instagram_chats",
  "instagram_messages",
  "intake_endpoints",
  "inquiries",
  "organization_features",
  "lead_audience_member_insights",
  "apify_settings",
  "apify_runs",
  "treg_settings",
  "treg_calls",
  "tavily_settings",
];

export default {
  schema: "./src/lib/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: connectionString },
  tablesFilter: OWNED_TABLES,
} satisfies Config;

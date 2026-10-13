/**
 * Which tables belong to an organization, and how. The one list that the
 * scope migration (scripts/add-organization-scope.ts), the scope audit
 * (scripts/check-organization-scope.ts) and the isolation tests all read, so
 * they cannot disagree. Pure data — safe to import anywhere.
 *
 * A table is here when it holds an organization's data and either has no
 * NOT NULL path to a scoped parent, or is read often enough without its
 * parent that filtering it directly matters. Tables not listed are either
 * children that inherit scope through a NOT NULL foreign key to a listed
 * table (they are named in `INHERITED`), or genuinely global (`GLOBAL`).
 *
 * Live-only legacy tables with no code (crm_linkedin_*, campaign_members,
 * crm_lead_events, _category_map, the channel audit) are
 * deliberately left alone: nothing reads or writes them.
 */

export type ScopedTable = {
  table: string;
  /** organization_id, or "organizationId" on the ex-Prisma LinkedIn tables. */
  column: string;
};

const snake = (table: string): ScopedTable => ({ table, column: "organization_id" });
const pascal = (table: string): ScopedTable => ({ table, column: "organizationId" });

export const SCOPED_TABLES: readonly ScopedTable[] = [
  // Lead database
  snake("people"),
  snake("companies"),
  snake("entity_columns"),
  snake("import_runs"),
  snake("lead_research"),
  // Prospecting / qualification
  snake("campaigns"),
  snake("targeted_domains"),
  // Email outreach
  snake("outreach_mailboxes"),
  snake("outreach_suppression_list"),
  snake("outreach_campaigns"),
  // CRM
  snake("crm_pipelines"),
  snake("crm_records"),
  snake("crm_conversations"),
  snake("crm_events"),
  snake("crm_identity_exceptions"),
  snake("crm_sequences"),
  snake("crm_sequence_runs"),
  snake("crm_knowledge_documents"),
  snake("crm_jobs"),
  // Legacy email CRM (Master Inbox)
  snake("crm_leads"),
  snake("crm_notes"),
  snake("crm_tasks"),
  snake("crm_webhook_events"),
  // Tables (grid)
  snake("grid_folders"),
  snake("grid_workbooks"),
  snake("grid_tables"),
  snake("grid_providers"),
  // Sending rules
  snake("channel_settings"),
  // Calling and WhatsApp
  snake("call_campaigns"),
  snake("call_sessions"),
  snake("call_messages"),
  snake("whatsapp_accounts"),
  snake("whatsapp_campaigns"),
  // LinkedIn (ex-Prisma, camelCase columns)
  pascal("LinkedInAccount"),
  pascal("Campaign"),
  pascal("Lead"),
  pascal("Connection"),
  pascal("Message"),
  pascal("SearchBatch"),
  pascal("WebhookEvent"),
];

/** Children scoped through a NOT NULL foreign key to a scoped table. */
export const INHERITED: Readonly<Record<string, string>> = {
  qualification_jobs: "campaigns",
  outreach_leads: "outreach_campaigns",
  outreach_emails: "outreach_leads",
  outreach_mailbox_queue: "outreach_mailboxes",
  crm_settings: "crm_pipelines",
  crm_subcategories: "crm_pipelines",
  crm_person_contact_policies: "people",
  crm_conversation_messages: "crm_conversations",
  crm_classifications: "crm_records",
  crm_sequence_versions: "crm_sequences",
  crm_sequence_steps: "crm_sequence_versions",
  crm_subcategory_sequence_assignments: "crm_subcategories",
  crm_record_sequence_overrides: "crm_records",
  crm_sequence_step_runs: "crm_sequence_runs",
  crm_drafts: "crm_records",
  crm_send_attempts: "crm_drafts",
  crm_knowledge_document_versions: "crm_knowledge_documents",
  crm_draft_knowledge_citations: "crm_drafts",
  crm_messages: "crm_leads",
  crm_lead_ccs: "crm_leads",
  crm_email_drafts: "crm_leads",
  grid_columns: "grid_tables",
  grid_rows: "grid_tables",
  grid_jobs: "grid_tables",
  grid_cell_runs: "grid_tables",
  grid_provider_credentials: "grid_providers",
  call_campaign_contacts: "call_campaigns",
  whatsapp_chats: "whatsapp_accounts",
  whatsapp_messages: "whatsapp_chats",
  whatsapp_campaign_accounts: "whatsapp_campaigns",
  whatsapp_campaign_leads: "whatsapp_campaigns",
  whatsapp_campaign_sends: "whatsapp_campaign_leads",
  CampaignAccount: "Campaign",
  SearchQuery: "SearchBatch",
  SearchResult: "SearchQuery",
};

/** Shared by every organization: public reference data, fixed system rows, job logs. */
export const GLOBAL: readonly string[] = [
  "domains",
  "clean_domains",
  "crm_categories",
  // Legacy Master Inbox lead statuses; nothing writes them now, but
  // crm_leads.current_status_key still references them.
  "crm_status_config",
  "JobRun",
  "JobLog",
  // The scheduler's slot claims; a per-organization job names its
  // organization in `job` (src/lib/scheduler/schema.ts).
  "scheduled_job_runs",
];

/**
 * Uniques that held "per workspace" and now hold per organization. The
 * per-org index is added first; the global one is dropped only in the
 * contract step, once no code's ON CONFLICT targets it.
 *
 * Provider identities stay globally unique on purpose — a Unipile account,
 * LinkedIn id, Gmail mailbox or provider message id belongs to exactly one
 * organization, and inbound webhooks find the organization through them.
 */
export const PER_ORG_UNIQUES: readonly { table: string; name: string; global: string; definition: string }[] = [
  { table: "people", name: "people_org_email_uq", global: "people_email_uq", definition: "(organization_id, lower(email)) WHERE email IS NOT NULL" },
  { table: "people", name: "people_org_linkedin_url_uq", global: "people_linkedin_url_uq", definition: "(organization_id, linkedin_url) WHERE linkedin_url IS NOT NULL" },
  { table: "companies", name: "companies_org_domain_uq", global: "companies_domain_key", definition: "(organization_id, domain)" },
  { table: "entity_columns", name: "entity_columns_org_entity_key_uq", global: "entity_columns_entity_key_uq", definition: "(organization_id, entity, key)" },
  { table: "outreach_suppression_list", name: "outreach_suppression_org_email_uq", global: "outreach_suppression_list_email_key", definition: "(organization_id, email)" },
  { table: "crm_pipelines", name: "crm_pipelines_org_name_uq", global: "crm_pipelines_name_uq", definition: "(organization_id, name)" },
  { table: "crm_pipelines", name: "crm_pipelines_org_one_default_uq", global: "crm_pipelines_one_default_uq", definition: "(organization_id) WHERE is_default IS TRUE" },
  { table: "grid_providers", name: "grid_providers_org_key_uq", global: "grid_providers_key_key", definition: "(organization_id, key)" },
  { table: "targeted_domains", name: "targeted_domains_org_domain_uq", global: "targeted_domains_domain_key", definition: "(organization_id, domain)" },
  { table: "crm_leads", name: "crm_leads_org_email_uq", global: "crm_leads_email_key", definition: "(organization_id, email)" },
];

/** Live tables no code reads or writes (legacy imports and one-off audits); left as they are. */
export const LEGACY_UNUSED: readonly string[] = [
  // Prisma's migration ledger from before the move to Drizzle; only in
  // databases that came from that era.
  "_prisma_migrations",
  "campaign_members",
  "crm_lead_events",
  "crm_linkedin_leads",
  "crm_linkedin_accounts",
  "crm_linkedin_messages",
  "crm_linkedin_lead_events",
  "crm_sequence_channel_migration_audit",
  "_category_map",
];

/** Better Auth's own tables (src/lib/auth/schema.ts) — the tenancy itself, not tenant data. */
export const AUTH_TABLES: readonly string[] = [
  "users",
  "sessions",
  "accounts",
  "verifications",
  "organizations",
  "members",
  "invitations",
  "teams",
  "team_members",
];

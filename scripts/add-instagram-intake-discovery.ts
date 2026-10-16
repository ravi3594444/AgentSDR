/**
 * Instagram messages, inquiry intake, website discovery and prospect
 * qualification (docs/product/INSTAGRAM_INTAKE_DISCOVERY.md). Matches
 * src/lib/features/schema.ts, src/lib/instagram/schema.ts,
 * src/lib/intake/schema.ts, src/lib/assistant/schema.ts and
 * src/lib/crm/schema.ts.
 *
 * Run with:  bun scripts/add-instagram-intake-discovery.ts
 * In Docker: docker compose exec app agentsdr-entrypoint bun scripts/add-instagram-intake-discovery.ts
 *
 * Additive and backward compatible:
 * - new tables only (organization_features, instagram_accounts,
 *   instagram_chats, instagram_messages, intake_endpoints, inquiries,
 *   lead_audience_member_insights, apify_settings, apify_runs, treg_settings,
 *   treg_calls);
 * - CHECK constraints are only widened (a superset of today's values, so
 *   every existing row and every running deployment keeps working):
 *   'instagram' joins the CRM channels and assistant run memberships;
 *   'web_discovery' and 'apify_instagram' join the assistant job kinds,
 *   'apify_discovery' and 'treg' the optional features;
 * - no column is added to an existing table, so the code of this release
 *   also runs before the migration: everything new is behind a feature
 *   switch (off without organization_features) or reads its new table as
 *   absent.
 * Nothing is enabled: every organization starts with every new feature off
 * (organization_features has no rows). Re-runnable: every statement is
 * guarded, and the constraint swaps run in one transaction.
 *
 * Locking: each swap adds the wider CHECK as NOT VALID, so the transaction
 * holds its brief exclusive locks without scanning a table (CRM replies and
 * sends wait milliseconds, not the length of a scan of
 * crm_conversation_messages). The constraints are validated afterwards, one
 * at a time, under a lock that lets reads and writes continue. A wider check
 * cannot fail on existing rows; if a validation is interrupted, the
 * constraint still applies to every new row and re-running finishes it.
 */
import { SQL } from "bun";

const CRM_CHANNELS = "('email', 'linkedin', 'whatsapp', 'instagram')";

const TABLES = [
  `CREATE TABLE IF NOT EXISTS organization_features (
     organization_id uuid NOT NULL REFERENCES organizations(id),
     key text NOT NULL,
     enabled boolean NOT NULL DEFAULT false,
     updated_by uuid,
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT organization_features_pkey PRIMARY KEY (organization_id, key),
     CONSTRAINT organization_features_key_chk CHECK (key IN ('instagram', 'web_discovery', 'inquiry_intake', 'apify_discovery', 'treg'))
   )`,

  `CREATE TABLE IF NOT EXISTS instagram_accounts (
     organization_id uuid NOT NULL REFERENCES organizations(id),
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     unipile_account_id text NOT NULL,
     username text,
     name text,
     provider_user_id text,
     status text NOT NULL DEFAULT 'connected',
     connected_at timestamptz,
     history_cutoff_at timestamptz,
     connected_by uuid,
     inquiry_intake boolean NOT NULL DEFAULT false,
     last_synced_at timestamptz,
     last_imported_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT instagram_accounts_unipile_account_uq UNIQUE (unipile_account_id),
     CONSTRAINT instagram_accounts_status_chk CHECK (status IN ('connected', 'disconnected', 'credentials', 'error'))
   )`,
  `CREATE INDEX IF NOT EXISTS instagram_accounts_organization_idx ON instagram_accounts (organization_id)`,

  `CREATE TABLE IF NOT EXISTS instagram_chats (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     account_id uuid NOT NULL,
     unipile_chat_id text NOT NULL,
     provider_id text,
     username text,
     name text,
     person_id uuid,
     first_seen_via text NOT NULL DEFAULT 'webhook',
     last_message_at timestamptz,
     last_message_preview text,
     last_direction text,
     unread_count integer NOT NULL DEFAULT 0,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT instagram_chats_account_fk FOREIGN KEY (account_id) REFERENCES instagram_accounts(id) ON DELETE CASCADE,
     CONSTRAINT instagram_chats_person_fk FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE SET NULL,
     CONSTRAINT instagram_chats_account_chat_uq UNIQUE (account_id, unipile_chat_id),
     CONSTRAINT instagram_chats_unread_chk CHECK (unread_count >= 0),
     CONSTRAINT instagram_chats_last_direction_chk CHECK (last_direction IS NULL OR last_direction IN ('inbound', 'outbound')),
     CONSTRAINT instagram_chats_first_seen_chk CHECK (first_seen_via IN ('webhook', 'import', 'send'))
   )`,
  `CREATE INDEX IF NOT EXISTS instagram_chats_account_last_message_idx ON instagram_chats (account_id, last_message_at)`,
  `CREATE INDEX IF NOT EXISTS instagram_chats_person_idx ON instagram_chats (person_id)`,
  `CREATE INDEX IF NOT EXISTS instagram_chats_provider_idx ON instagram_chats (provider_id)`,

  `CREATE TABLE IF NOT EXISTS instagram_messages (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     chat_id uuid NOT NULL,
     unipile_message_id text,
     direction text NOT NULL,
     origin text NOT NULL,
     body text NOT NULL DEFAULT '',
     attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
     sent_at timestamptz NOT NULL,
     historical boolean NOT NULL DEFAULT false,
     crm_conversation_message_id uuid,
     raw jsonb,
     created_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT instagram_messages_chat_fk FOREIGN KEY (chat_id) REFERENCES instagram_chats(id) ON DELETE CASCADE,
     CONSTRAINT instagram_messages_crm_message_fk FOREIGN KEY (crm_conversation_message_id) REFERENCES crm_conversation_messages(id) ON DELETE SET NULL,
     CONSTRAINT instagram_messages_direction_chk CHECK (direction IN ('inbound', 'outbound')),
     CONSTRAINT instagram_messages_origin_chk CHECK (origin IN ('lead', 'agentsdr', 'phone')),
     CONSTRAINT instagram_messages_origin_direction_chk CHECK ((direction = 'inbound') = (origin = 'lead'))
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS instagram_messages_unipile_message_uq ON instagram_messages (unipile_message_id) WHERE unipile_message_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS instagram_messages_chat_sent_idx ON instagram_messages (chat_id, sent_at)`,

  `CREATE TABLE IF NOT EXISTS intake_endpoints (
     organization_id uuid NOT NULL REFERENCES organizations(id),
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     name text NOT NULL,
     token_hash text NOT NULL,
     token_hint text NOT NULL,
     field_map jsonb NOT NULL DEFAULT '{}'::jsonb,
     enabled boolean NOT NULL DEFAULT true,
     created_by uuid,
     last_received_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT intake_endpoints_token_hash_uq UNIQUE (token_hash)
   )`,
  `CREATE INDEX IF NOT EXISTS intake_endpoints_organization_idx ON intake_endpoints (organization_id)`,

  `CREATE TABLE IF NOT EXISTS inquiries (
     organization_id uuid NOT NULL REFERENCES organizations(id),
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     source text NOT NULL,
     endpoint_id uuid REFERENCES intake_endpoints(id) ON DELETE SET NULL,
     instagram_chat_id uuid REFERENCES instagram_chats(id) ON DELETE SET NULL,
     dedupe_key text NOT NULL,
     person_id uuid REFERENCES people(id) ON DELETE SET NULL,
     name text,
     email text,
     phone text,
     message text,
     fields jsonb NOT NULL DEFAULT '{}'::jsonb,
     page_url text,
     historical boolean NOT NULL DEFAULT false,
     status text NOT NULL DEFAULT 'received',
     reason text,
     submitted_at timestamptz,
     received_at timestamptz NOT NULL DEFAULT now(),
     raw jsonb,
     CONSTRAINT inquiries_source_chk CHECK (source IN ('website_form', 'instagram')),
     CONSTRAINT inquiries_status_chk CHECK (status IN ('received', 'unusable'))
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS inquiries_org_source_dedupe_uq ON inquiries (organization_id, source, dedupe_key)`,
  `CREATE INDEX IF NOT EXISTS inquiries_organization_received_idx ON inquiries (organization_id, received_at)`,
  `CREATE INDEX IF NOT EXISTS inquiries_person_idx ON inquiries (person_id)`,

  `CREATE TABLE IF NOT EXISTS lead_audience_member_insights (
     member_id uuid PRIMARY KEY REFERENCES lead_audience_members(id) ON DELETE CASCADE,
     match_reason text,
     signals jsonb NOT NULL DEFAULT '[]'::jsonb,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  // Apify as an optional discovery provider (src/lib/apify/).
  `CREATE TABLE IF NOT EXISTS apify_settings (
     organization_id uuid PRIMARY KEY REFERENCES organizations(id),
     encrypted_token text,
     token_hint text,
     approved_actors text[] NOT NULL DEFAULT '{}'::text[],
     monthly_budget_usd double precision NOT NULL DEFAULT 10,
     max_charge_per_run_usd double precision NOT NULL DEFAULT 2,
     max_results_per_run integer NOT NULL DEFAULT 100,
     updated_by uuid,
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT apify_settings_limits_chk CHECK (monthly_budget_usd >= 0 AND max_charge_per_run_usd > 0 AND max_results_per_run BETWEEN 1 AND 500)
   )`,
  `CREATE TABLE IF NOT EXISTS apify_runs (
     organization_id uuid NOT NULL REFERENCES organizations(id),
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     job_id uuid,
     request_id text,
     actor_key text NOT NULL,
     actor_id text NOT NULL,
     apify_run_id text,
     dataset_id text,
     status text NOT NULL DEFAULT 'starting',
     max_charge_usd double precision NOT NULL,
     max_items integer NOT NULL,
     usage_usd double precision,
     items_read integer NOT NULL DEFAULT 0,
     partial boolean NOT NULL DEFAULT false,
     error text,
     created_at timestamptz NOT NULL DEFAULT now(),
     finished_at timestamptz,
     CONSTRAINT apify_runs_apify_run_id_uq UNIQUE (apify_run_id),
     CONSTRAINT apify_runs_status_chk CHECK (status IN ('starting', 'running', 'succeeded', 'partial', 'failed', 'refused'))
   )`,
  `CREATE INDEX IF NOT EXISTS apify_runs_org_created_idx ON apify_runs (organization_id, created_at)`,
  // Treg as an optional, keyed tool source (src/lib/treg/).
  `CREATE TABLE IF NOT EXISTS treg_settings (
     organization_id uuid PRIMARY KEY REFERENCES organizations(id),
     encrypted_key text,
     key_hint text,
     team text,
     daily_cap_usd double precision NOT NULL DEFAULT 2,
     updated_by uuid,
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT treg_settings_cap_chk CHECK (daily_cap_usd >= 0 AND daily_cap_usd <= 100)
   )`,
  `CREATE TABLE IF NOT EXISTS treg_calls (
     organization_id uuid NOT NULL REFERENCES organizations(id),
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     thread_id uuid,
     endpoint_id text NOT NULL,
     status text NOT NULL DEFAULT 'calling',
     ceiling_usd double precision NOT NULL,
     cost_usd double precision,
     http_status integer,
     treg_call_id text,
     error text,
     created_at timestamptz NOT NULL DEFAULT now(),
     finished_at timestamptz,
     CONSTRAINT treg_calls_status_chk CHECK (status IN ('calling', 'succeeded', 'failed'))
   )`,
  `CREATE INDEX IF NOT EXISTS treg_calls_org_created_idx ON treg_calls (organization_id, created_at)`,
];

/** [table, constraint, definition]: dropped and added again with the wider set. */
const WIDENED: [string, string, string][] = [
  ["crm_identity_exceptions", "crm_identity_exceptions_channel_chk", `CHECK (channel IN ${CRM_CHANNELS})`],
  ["crm_conversations", "crm_conversations_channel_chk", `CHECK (channel IN ${CRM_CHANNELS})`],
  ["crm_conversation_messages", "crm_conversation_messages_channel_chk", `CHECK (channel IN ${CRM_CHANNELS})`],
  ["crm_drafts", "crm_drafts_channel_chk", `CHECK (channel IN ${CRM_CHANNELS})`],
  ["crm_drafts", "crm_drafts_instagram_subject_chk", `CHECK (channel <> 'instagram' OR subject IS NULL)`],
  ["crm_records", "crm_records_active_channel_chk", `CHECK (active_channel IS NULL OR active_channel IN ${CRM_CHANNELS})`],
  ["outreach_run_leads", "outreach_run_leads_channel_chk", `CHECK (channel IN ('email', 'whatsapp', 'linkedin', 'instagram'))`],
  ["assistant_jobs", "assistant_jobs_kind_chk", `CHECK (kind IN ('discovery', 'outreach_start', 'linkedin_search', 'web_discovery', 'apify_instagram'))`],
  ["organization_features", "organization_features_key_chk", `CHECK (key IN ('instagram', 'web_discovery', 'inquiry_intake', 'apify_discovery', 'treg'))`],
];

const EXPECTED_TABLES = ["organization_features", "instagram_accounts", "instagram_chats", "instagram_messages", "intake_endpoints", "inquiries", "lead_audience_member_insights", "apify_settings", "apify_runs", "treg_settings", "treg_calls"];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — check .env.local");
  const sql = new SQL(url, {
    max: 1,
    tls: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false },
  });
  try {
    await sql.unsafe("SET lock_timeout = '5s'");
    await sql.unsafe("SET statement_timeout = '2min'");
    for (const statement of TABLES) await sql.unsafe(statement);
    await sql.begin(async (tx) => {
      for (const [table, constraint, definition] of WIDENED) {
        await tx.unsafe(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${constraint}`);
        await tx.unsafe(`ALTER TABLE ${table} ADD CONSTRAINT ${constraint} ${definition} NOT VALID`);
      }
    });
    // Validation scans each table without blocking its reads and writes; no time limit.
    await sql.unsafe("SET statement_timeout = 0");
    for (const [table, constraint] of WIDENED) {
      await sql.unsafe(`ALTER TABLE ${table} VALIDATE CONSTRAINT ${constraint}`);
    }
    const present: { name: string }[] = await sql`
      select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ${sql(EXPECTED_TABLES)}`;
    const missing = EXPECTED_TABLES.filter((table) => !present.some((row) => row.name === table));
    console.log(missing.length ? `MISSING: ${missing.join(", ")}` : `present: ${EXPECTED_TABLES.join(", ")}`);
    const constraints: { conname: string; def: string; validated: boolean }[] = await sql`
      select conname, pg_get_constraintdef(oid) as def, convalidated as validated from pg_constraint
      where conname in ${sql(WIDENED.map(([, name]) => name))} order by conname`;
    for (const row of constraints) console.log(`${row.conname}: ${row.def}${row.validated ? "" : " (NOT VALIDATED — re-run)"}`);
    if (missing.length || constraints.length !== WIDENED.length || constraints.some((row) => !row.validated)) process.exitCode = 1;
  } finally {
    await sql.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

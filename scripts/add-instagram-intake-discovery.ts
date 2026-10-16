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
 *   instagram_chats, instagram_messages, intake_endpoints, inquiries);
 * - CHECK constraints are only widened (a superset of today's values, so
 *   every existing row and every running deployment keeps working):
 *   'instagram' joins the CRM channels and assistant run memberships;
 *   'web_discovery' joins the assistant job kinds; 'existing' and
 *   'inquiries' join the lead-list sources;
 * - two nullable/defaulted columns on lead_audience_members (why a lead
 *   matched, and evidence of need).
 * Nothing is enabled: every organization starts with every new feature off
 * (organization_features has no rows). Re-runnable: every statement is
 * guarded, and the constraint swaps run in one transaction.
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
     CONSTRAINT organization_features_key_chk CHECK (key IN ('instagram', 'web_discovery', 'inquiry_intake'))
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

  `ALTER TABLE lead_audience_members ADD COLUMN IF NOT EXISTS match_reason text`,
  `ALTER TABLE lead_audience_members ADD COLUMN IF NOT EXISTS signals jsonb NOT NULL DEFAULT '[]'::jsonb`,
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
  ["assistant_jobs", "assistant_jobs_kind_chk", `CHECK (kind IN ('discovery', 'outreach_start', 'linkedin_search', 'web_discovery'))`],
  ["lead_audiences", "lead_audiences_source_chk", `CHECK (source IN ('discovery', 'list', 'existing', 'inquiries'))`],
];

const EXPECTED_TABLES = ["organization_features", "instagram_accounts", "instagram_chats", "instagram_messages", "intake_endpoints", "inquiries"];

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
        await tx.unsafe(`ALTER TABLE ${table} ADD CONSTRAINT ${constraint} ${definition}`);
      }
    });
    const present: { name: string }[] = await sql`
      select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ${sql(EXPECTED_TABLES)}`;
    const missing = EXPECTED_TABLES.filter((table) => !present.some((row) => row.name === table));
    console.log(missing.length ? `MISSING: ${missing.join(", ")}` : `present: ${EXPECTED_TABLES.join(", ")}`);
    const constraints: { conname: string; def: string }[] = await sql`
      select conname, pg_get_constraintdef(oid) as def from pg_constraint
      where conname in ${sql(WIDENED.map(([, name]) => name))} order by conname`;
    for (const row of constraints) console.log(`${row.conname}: ${row.def}`);
    if (missing.length || constraints.length !== WIDENED.length) process.exitCode = 1;
  } finally {
    await sql.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

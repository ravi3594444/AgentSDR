/**
 * The owner's assistant (src/lib/assistant/schema.ts): chat threads and
 * messages, the business profile, lead audiences and their members,
 * background jobs (lead discovery, starting outreach) and outreach runs.
 * Also lets the CRM queue hold `auto_send` jobs and makes
 * crm_settings.human_send_only a real setting (it was pinned on by a CHECK),
 * which the reply autopilot (src/lib/crm/autopilot.ts) turns off only when
 * the owner enables it.
 *
 * Run with:  bun scripts/create-assistant-tables.ts
 * In Docker: docker compose exec app agentsdr-entrypoint bun scripts/create-assistant-tables.ts
 *
 * A fresh database gets all of this from db/schema.sql. Additive and
 * re-runnable: every statement is guarded. Uses Bun's built-in PostgreSQL
 * client and no packages, so it also runs inside the Docker image.
 */
import { SQL } from "bun";

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS assistant_threads (
     organization_id uuid NOT NULL REFERENCES organizations(id),
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     title text NOT NULL DEFAULT 'Conversation',
     created_by uuid,
     busy_since timestamptz,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS assistant_threads_organization_idx ON assistant_threads (organization_id, updated_at)`,

  `CREATE TABLE IF NOT EXISTS assistant_messages (
     organization_id uuid NOT NULL REFERENCES organizations(id),
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     thread_id uuid NOT NULL REFERENCES assistant_threads(id) ON DELETE CASCADE,
     role text NOT NULL,
     content text NOT NULL DEFAULT '',
     tool text,
     tool_input jsonb,
     tool_result jsonb,
     status text,
     attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
     created_by uuid,
     created_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT assistant_messages_role_chk CHECK (role IN ('user', 'assistant', 'tool', 'event')),
     CONSTRAINT assistant_messages_status_chk CHECK (status IS NULL OR status IN ('running', 'ok', 'error'))
   )`,
  `CREATE INDEX IF NOT EXISTS assistant_messages_organization_idx ON assistant_messages (organization_id)`,
  `CREATE INDEX IF NOT EXISTS assistant_messages_thread_idx ON assistant_messages (thread_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS assistant_profiles (
     organization_id uuid PRIMARY KEY REFERENCES organizations(id),
     profile jsonb NOT NULL DEFAULT '{}'::jsonb,
     knowledge_document_id uuid,
     updated_by uuid,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS lead_audiences (
     organization_id uuid NOT NULL REFERENCES organizations(id),
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     thread_id uuid REFERENCES assistant_threads(id) ON DELETE SET NULL,
     name text NOT NULL,
     source text NOT NULL,
     criteria jsonb NOT NULL DEFAULT '{}'::jsonb,
     created_by uuid,
     created_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT lead_audiences_source_chk CHECK (source IN ('discovery', 'list'))
   )`,
  `CREATE INDEX IF NOT EXISTS lead_audiences_organization_idx ON lead_audiences (organization_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS lead_audience_members (
     organization_id uuid NOT NULL REFERENCES organizations(id),
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     audience_id uuid NOT NULL REFERENCES lead_audiences(id) ON DELETE CASCADE,
     person_id uuid REFERENCES people(id) ON DELETE CASCADE,
     company_id uuid REFERENCES companies(id) ON DELETE SET NULL,
     name text NOT NULL,
     status text NOT NULL,
     reason text,
     channels text[] NOT NULL DEFAULT ARRAY[]::text[],
     source text NOT NULL,
     source_url text,
     evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
     facts jsonb NOT NULL DEFAULT '{}'::jsonb,
     created_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT lead_audience_members_status_chk CHECK (status IN ('eligible', 'excluded'))
   )`,
  `CREATE INDEX IF NOT EXISTS lead_audience_members_organization_idx ON lead_audience_members (organization_id)`,
  `CREATE INDEX IF NOT EXISTS lead_audience_members_audience_idx ON lead_audience_members (audience_id, status)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS lead_audience_members_person_uq ON lead_audience_members (audience_id, person_id) WHERE person_id IS NOT NULL`,

  `CREATE TABLE IF NOT EXISTS assistant_jobs (
     organization_id uuid NOT NULL REFERENCES organizations(id),
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     kind text NOT NULL,
     status text NOT NULL DEFAULT 'queued',
     stage text NOT NULL DEFAULT 'queued',
     thread_id uuid REFERENCES assistant_threads(id) ON DELETE SET NULL,
     audience_id uuid REFERENCES lead_audiences(id) ON DELETE SET NULL,
     run_id uuid,
     payload jsonb NOT NULL DEFAULT '{}'::jsonb,
     progress jsonb NOT NULL DEFAULT '{}'::jsonb,
     result jsonb,
     error text,
     external_id text,
     attempts integer NOT NULL DEFAULT 0,
     run_after timestamptz NOT NULL DEFAULT now(),
     locked_by text,
     heartbeat_at timestamptz,
     created_by uuid,
     created_at timestamptz NOT NULL DEFAULT now(),
     finished_at timestamptz,
     CONSTRAINT assistant_jobs_kind_chk CHECK (kind IN ('discovery', 'outreach_start')),
     CONSTRAINT assistant_jobs_status_chk CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled'))
   )`,
  `CREATE INDEX IF NOT EXISTS assistant_jobs_organization_idx ON assistant_jobs (organization_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS assistant_jobs_claim_idx ON assistant_jobs (status, run_after)`,

  `CREATE TABLE IF NOT EXISTS outreach_runs (
     organization_id uuid NOT NULL REFERENCES organizations(id),
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     thread_id uuid REFERENCES assistant_threads(id) ON DELETE SET NULL,
     audience_id uuid NOT NULL REFERENCES lead_audiences(id) ON DELETE RESTRICT,
     name text NOT NULL,
     status text NOT NULL DEFAULT 'proposed',
     channels text[] NOT NULL DEFAULT ARRAY[]::text[],
     plan jsonb NOT NULL,
     campaigns jsonb NOT NULL DEFAULT '{}'::jsonb,
     autopilot boolean NOT NULL DEFAULT false,
     error text,
     approved_by uuid,
     approved_at timestamptz,
     created_by uuid,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT outreach_runs_status_chk CHECK (status IN ('proposed', 'starting', 'running', 'paused', 'completed', 'failed', 'cancelled'))
   )`,
  `CREATE INDEX IF NOT EXISTS outreach_runs_organization_idx ON outreach_runs (organization_id, created_at)`,

  // The CRM queue may hold auto_send jobs (entity: the draft).
  `ALTER TABLE crm_jobs DROP CONSTRAINT IF EXISTS crm_jobs_kind_chk`,
  `ALTER TABLE crm_jobs ADD CONSTRAINT crm_jobs_kind_chk CHECK (kind IN ('classification', 'initial_draft', 'due_followup_draft', 'auto_send'))`,
  `ALTER TABLE crm_jobs DROP CONSTRAINT IF EXISTS crm_jobs_entity_type_chk`,
  `ALTER TABLE crm_jobs ADD CONSTRAINT crm_jobs_entity_type_chk CHECK (entity_type IN ('message', 'classification', 'sequence_step_run', 'draft'))`,
  `ALTER TABLE crm_jobs DROP CONSTRAINT IF EXISTS crm_jobs_kind_entity_chk`,
  `ALTER TABLE crm_jobs ADD CONSTRAINT crm_jobs_kind_entity_chk CHECK (
     (kind = 'classification' AND entity_type = 'message')
     OR (kind = 'initial_draft' AND entity_type = 'classification')
     OR (kind = 'due_followup_draft' AND entity_type = 'sequence_step_run')
     OR (kind = 'auto_send' AND entity_type = 'draft'))`,
  // human_send_only becomes a real setting; every existing pipeline keeps it on.
  `ALTER TABLE crm_settings DROP CONSTRAINT IF EXISTS crm_settings_human_send_only_chk`,
];

const TABLES = ["assistant_threads", "assistant_messages", "assistant_profiles", "lead_audiences", "lead_audience_members", "assistant_jobs", "outreach_runs"];

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
    await sql.begin(async (tx) => {
      for (const statement of STATEMENTS) await tx.unsafe(statement);
    });
    const missing: string[] = [];
    for (const table of TABLES) {
      const [{ present }] = await sql`select to_regclass(${`public.${table}`}) is not null as present`;
      if (!present) missing.push(table);
    }
    console.log(missing.length ? `MISSING: ${missing.join(", ")}` : `assistant tables present (${TABLES.length})`);
    if (missing.length) process.exitCode = 1;
  } finally {
    await sql.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

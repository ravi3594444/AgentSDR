/**
 * The assistant's reply automation and reporting (src/lib/assistant/schema.ts):
 * per-run membership and reply mode, the autopilot's decision ledger,
 * owner decisions, conversation takeovers, the AI usage ledger and the
 * daily summaries. Also:
 * - outreach_runs gains the final `stopped` status and pause/stop times;
 * - assistant_jobs may be a LinkedIn search;
 * - the reply autopilot is per run now, so crm_settings.human_send_only is
 *   pinned back on (its CHECK restored): no organization-wide switch can
 *   make unrelated conversations automatic;
 * - started runs get their membership from the plan they were approved with.
 *
 * Run with:  bun scripts/add-assistant-automation.ts
 * In Docker: docker compose exec app agentsdr-entrypoint bun scripts/add-assistant-automation.ts
 *
 * Needs scripts/create-assistant-tables.ts first. A fresh database gets all
 * of this from db/schema.sql. Additive and re-runnable: every statement is
 * guarded. Uses Bun's built-in PostgreSQL client and no packages.
 */
import { SQL } from "bun";

const STATEMENTS = [
  `ALTER TABLE outreach_runs ADD COLUMN IF NOT EXISTS paused_at timestamptz`,
  `ALTER TABLE outreach_runs ADD COLUMN IF NOT EXISTS stopped_at timestamptz`,
  `ALTER TABLE outreach_runs DROP CONSTRAINT IF EXISTS outreach_runs_status_chk`,
  `ALTER TABLE outreach_runs ADD CONSTRAINT outreach_runs_status_chk CHECK (status IN ('proposed', 'starting', 'running', 'paused', 'stopped', 'completed', 'failed', 'cancelled'))`,

  `ALTER TABLE assistant_jobs DROP CONSTRAINT IF EXISTS assistant_jobs_kind_chk`,
  `ALTER TABLE assistant_jobs ADD CONSTRAINT assistant_jobs_kind_chk CHECK (kind IN ('discovery', 'outreach_start', 'linkedin_search'))`,

  `CREATE TABLE IF NOT EXISTS outreach_run_leads (
     organization_id uuid NOT NULL REFERENCES organizations(id),
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     run_id uuid NOT NULL REFERENCES outreach_runs(id) ON DELETE CASCADE,
     person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
     channel text NOT NULL,
     status text NOT NULL DEFAULT 'active',
     stop_reason text,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT outreach_run_leads_channel_chk CHECK (channel IN ('email', 'whatsapp', 'linkedin')),
     CONSTRAINT outreach_run_leads_status_chk CHECK (status IN ('active', 'stopped', 'opted_out'))
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS outreach_run_leads_run_person_uq ON outreach_run_leads (run_id, person_id)`,
  `CREATE INDEX IF NOT EXISTS outreach_run_leads_person_idx ON outreach_run_leads (organization_id, person_id)`,

  `CREATE TABLE IF NOT EXISTS autopilot_replies (
     organization_id uuid NOT NULL REFERENCES organizations(id),
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     draft_id uuid NOT NULL,
     revision integer NOT NULL,
     conversation_id uuid NOT NULL,
     run_id uuid,
     person_id uuid,
     status text NOT NULL,
     reason text,
     "check" jsonb,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT autopilot_replies_status_chk CHECK (status IN ('reserved', 'sent', 'failed', 'held'))
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS autopilot_replies_draft_revision_uq ON autopilot_replies (draft_id, revision)`,
  `CREATE INDEX IF NOT EXISTS autopilot_replies_organization_idx ON autopilot_replies (organization_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS autopilot_replies_conversation_idx ON autopilot_replies (conversation_id)`,

  `CREATE TABLE IF NOT EXISTS owner_decisions (
     organization_id uuid NOT NULL REFERENCES organizations(id),
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     kind text NOT NULL,
     status text NOT NULL DEFAULT 'open',
     reason text NOT NULL,
     decision text NOT NULL,
     lead_message text,
     person_id uuid,
     crm_record_id uuid,
     conversation_id uuid,
     draft_id uuid,
     run_id uuid,
     answer text,
     answered_by uuid,
     answered_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT owner_decisions_kind_chk CHECK (kind IN ('missing_info', 'complaint', 'negotiation', 'commitment', 'uncertain', 'meeting', 'opt_out', 'interested')),
     CONSTRAINT owner_decisions_status_chk CHECK (status IN ('open', 'answered', 'resolved'))
   )`,
  `CREATE INDEX IF NOT EXISTS owner_decisions_organization_idx ON owner_decisions (organization_id, status, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS owner_decisions_draft_kind_uq ON owner_decisions (draft_id, kind) WHERE draft_id IS NOT NULL AND status = 'open'`,

  `CREATE TABLE IF NOT EXISTS autopilot_takeovers (
     organization_id uuid NOT NULL REFERENCES organizations(id),
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     conversation_id uuid NOT NULL,
     reason text NOT NULL,
     created_by uuid,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS autopilot_takeovers_conversation_uq ON autopilot_takeovers (conversation_id)`,
  `CREATE INDEX IF NOT EXISTS autopilot_takeovers_organization_idx ON autopilot_takeovers (organization_id)`,

  `CREATE TABLE IF NOT EXISTS assistant_usage (
     organization_id uuid NOT NULL REFERENCES organizations(id),
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     kind text NOT NULL,
     model text,
     cost_usd numeric(12, 6),
     input_tokens integer,
     output_tokens integer,
     run_id uuid,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS assistant_usage_organization_idx ON assistant_usage (organization_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS daily_summaries (
     organization_id uuid NOT NULL REFERENCES organizations(id),
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     day text NOT NULL,
     time_zone text NOT NULL,
     data jsonb NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS daily_summaries_organization_day_uq ON daily_summaries (organization_id, day)`,

  // Runs started before this migration: membership from the approved plan.
  `INSERT INTO outreach_run_leads (organization_id, run_id, person_id, channel)
   SELECT r.organization_id, r.id, (a->>'personId')::uuid, a->>'channel'
   FROM outreach_runs r
   CROSS JOIN LATERAL jsonb_array_elements(r.plan->'assignments') a
   JOIN people p ON p.id = (a->>'personId')::uuid AND p.organization_id = r.organization_id
   WHERE r.status IN ('starting', 'running', 'paused', 'completed')
   ON CONFLICT (run_id, person_id) DO NOTHING`,

  // No organization-wide reply automation: it is per run.
  `UPDATE crm_settings SET human_send_only = true, updated_at = now() WHERE human_send_only IS NOT TRUE`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_settings_human_send_only_chk') THEN
       ALTER TABLE crm_settings ADD CONSTRAINT crm_settings_human_send_only_chk CHECK (human_send_only IS TRUE);
     END IF;
   END $$`,
];

const TABLES = ["outreach_run_leads", "autopilot_replies", "owner_decisions", "autopilot_takeovers", "assistant_usage", "daily_summaries"];

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
    const [{ ready }] = await sql`select to_regclass('public.outreach_runs') is not null as ready`;
    if (!ready) throw new Error("Run scripts/create-assistant-tables.ts first.");
    await sql.begin(async (tx) => {
      for (const statement of STATEMENTS) await tx.unsafe(statement);
    });
    const missing: string[] = [];
    for (const table of TABLES) {
      const [{ present }] = await sql`select to_regclass(${`public.${table}`}) is not null as present`;
      if (!present) missing.push(table);
    }
    console.log(missing.length ? `MISSING: ${missing.join(", ")}` : `assistant automation tables present (${TABLES.length})`);
    if (missing.length) process.exitCode = 1;
  } finally {
    await sql.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

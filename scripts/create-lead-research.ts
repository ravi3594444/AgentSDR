/**
 * lead_research: web research about imported companies (src/lib/research/).
 * Matches src/lib/research/schema.ts; scoped in src/lib/tenancy/registry.ts.
 *
 * Run with:  bun scripts/create-lead-research.ts
 * In Docker: docker compose exec app agentsdr-entrypoint bun scripts/create-lead-research.ts
 *            (the entrypoint supplies DATABASE_URL for the bundled database)
 *
 * A fresh database gets the table from db/schema.sql; an existing install
 * needs this once, or Research answers with a message pointing here.
 *
 * Additive and re-runnable: every statement is guarded. Uses Bun's built-in
 * PostgreSQL client and no packages, so it also runs inside the Docker image.
 */
import { SQL } from "bun";

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS lead_research (
     organization_id uuid NOT NULL REFERENCES organizations(id),
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
     kind text NOT NULL,
     question text NOT NULL,
     status text NOT NULL,
     answer text,
     sources jsonb NOT NULL DEFAULT '[]'::jsonb,
     provider text,
     model text,
     cost_usd numeric(12, 6),
     error text,
     created_by uuid,
     created_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT lead_research_kind_chk CHECK (kind IN ('company', 'website', 'parent', 'question')),
     CONSTRAINT lead_research_status_chk CHECK (status IN ('succeeded', 'not_found', 'failed'))
   )`,
  `CREATE INDEX IF NOT EXISTS lead_research_organization_idx ON lead_research (organization_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS lead_research_company_idx ON lead_research (company_id, created_at)`,
];

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
    for (const statement of STATEMENTS) await sql.unsafe(statement);
    const [{ present }] = await sql`select to_regclass('public.lead_research') is not null as present`;
    console.log(`lead_research ${present ? "present" : "MISSING"}`);
    if (!present) process.exitCode = 1;
  } finally {
    await sql.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

/**
 * The handoff to the owner (src/lib/assistant/handoff.ts): owner decisions
 * gain the kinds `ready` (the lead wants the next step), `person` (asked for
 * a human) and `limit` (the conversation reached the automatic-reply
 * limit), a short brief of the conversation, when the lead was told a
 * person takes over, and when the owner was alerted and reminded.
 *
 * Run with:  bun scripts/add-handoff.ts
 * In Docker: docker compose exec app agentsdr-entrypoint bun scripts/add-handoff.ts
 *
 * Needs scripts/add-assistant-automation.ts first. A fresh database gets all
 * of this from db/schema.sql. Additive and re-runnable: every statement is
 * guarded. Uses Bun's built-in PostgreSQL client and no packages.
 */
import { SQL } from "bun";

const STATEMENTS = [
  `ALTER TABLE owner_decisions DROP CONSTRAINT IF EXISTS owner_decisions_kind_chk`,
  `ALTER TABLE owner_decisions ADD CONSTRAINT owner_decisions_kind_chk CHECK (kind IN ('missing_info', 'complaint', 'negotiation', 'commitment', 'uncertain', 'meeting', 'opt_out', 'interested', 'ready', 'person', 'limit'))`,
  `ALTER TABLE owner_decisions ADD COLUMN IF NOT EXISTS brief text`,
  `ALTER TABLE owner_decisions ADD COLUMN IF NOT EXISTS handover_sent_at timestamptz`,
  `ALTER TABLE owner_decisions ADD COLUMN IF NOT EXISTS alerted_at timestamptz`,
  `ALTER TABLE owner_decisions ADD COLUMN IF NOT EXISTS reminded_at timestamptz`,
  `CREATE INDEX IF NOT EXISTS owner_decisions_conversation_idx ON owner_decisions (conversation_id) WHERE status = 'open'`,
  // Earlier code took a chat away from the assistant on its own whenever a
  // message went out from the business number after a handoff, and the
  // Needs you "Done" button did the same. Neither was the owner asking for
  // it; those takeovers are removed so the assistant answers again. Only
  // "I'll reply myself" creates one now, and "Let the assistant reply"
  // undoes it.
  `DELETE FROM autopilot_takeovers WHERE reason IN ('You replied to this lead yourself after the handoff.', 'The owner is answering this conversation personally.')`,
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
    const [{ ready }] = await sql`select to_regclass('public.owner_decisions') is not null as ready`;
    if (!ready) throw new Error("Run scripts/create-assistant-tables.ts and scripts/add-assistant-automation.ts first.");
    await sql.begin(async (tx) => {
      for (const statement of STATEMENTS) await tx.unsafe(statement);
    });
    const [{ columns }] = await sql`
      select count(*)::int as columns from information_schema.columns
      where table_name = 'owner_decisions' and column_name in ('brief', 'handover_sent_at', 'alerted_at', 'reminded_at')`;
    console.log(columns === 4 ? "handoff columns present (4)" : `MISSING handoff columns: ${4 - columns}`);
    if (columns !== 4) process.exitCode = 1;
  } finally {
    await sql.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

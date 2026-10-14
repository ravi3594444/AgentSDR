/**
 * outreach_mailboxes.provider and unipile_account_id: a mailbox can send
 * through Unipile (a Gmail, Outlook or IMAP account linked in Unipile) as
 * well as through Google Workspace. Matches src/lib/outreach/schema.ts.
 *
 * Run with:  bun scripts/add-mailbox-provider.ts
 * In Docker: docker compose exec app agentsdr-entrypoint bun scripts/add-mailbox-provider.ts
 *
 * Every existing mailbox is a Google Workspace one, which is the default.
 * Additive and re-runnable: every statement is guarded. Uses Bun's built-in
 * PostgreSQL client and no packages, so it also runs inside the Docker image.
 */
import { SQL } from "bun";

const STATEMENTS = [
  `ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'google'`,
  `ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS unipile_account_id text`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outreach_mailboxes_provider_chk') THEN
       ALTER TABLE outreach_mailboxes ADD CONSTRAINT outreach_mailboxes_provider_chk CHECK (provider IN ('google', 'unipile'));
     END IF;
   END $$`,
  `CREATE UNIQUE INDEX IF NOT EXISTS outreach_mailboxes_unipile_account_uq
     ON outreach_mailboxes (unipile_account_id) WHERE unipile_account_id IS NOT NULL`,
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
    const [{ n }] = await sql`select count(*)::int as n from information_schema.columns
      where table_name = 'outreach_mailboxes' and column_name in ('provider', 'unipile_account_id')`;
    console.log(`outreach_mailboxes provider columns ${n === 2 ? "present" : "MISSING"}`);
    if (n !== 2) process.exitCode = 1;
  } finally {
    await sql.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

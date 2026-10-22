/**
 * Managed SaaS: the platform operator grant table, the platform's default
 * credentials, each organization's Included / My own provider choice, the
 * usage attribution columns, and Unipile account ownership (every account an
 * organization already holds gets its ownership row; conflicts are printed,
 * never resolved). Applies db/migrations/20261022-managed-saas.sql in one
 * transaction; safe to re-run, and deploy.sh runs it on every deploy.
 *
 *   bun run scripts/add-managed-saas.ts
 */
import { SQL } from "bun";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const db = new SQL(url, { max: 1, tls: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false } });
try {
  const ddl = await readFile(join(import.meta.dir, "../db/migrations/20261022-managed-saas.sql"), "utf8");
  await db.begin(async (tx) => {
    // Fail fast rather than wait for, and hold up, the running app's locks.
    await tx.unsafe("SET LOCAL lock_timeout = '10s'; SET LOCAL statement_timeout = '120s'").simple();
    await tx.unsafe(ddl).simple();
  });
  const [{ operators }] = await db`select count(*)::int as operators from platform_operators`;
  const [{ owners }] = await db`select count(*)::int as owners from unipile_account_owners`;
  console.log(`Managed SaaS ready: platform_operators (${operators} granted), unipile_account_owners (${owners} accounts).`);
  // An account a table holds for one organization while another owns it: never reassigned, only reported.
  // Sync marks such a row disconnected (it is not the organization's to use); an operator decides the rest.
  const conflicts: { channel: string; account_id: string; held_by: string; owner: string }[] = await db`
    select 'linkedin' as channel, a."linkedinId" as account_id, a."organizationId"::text as held_by, o.organization_id::text as owner
      from "LinkedInAccount" a join unipile_account_owners o on o.account_id = a."linkedinId" where o.organization_id <> a."organizationId"
    union all
    select 'whatsapp', a.unipile_account_id, a.organization_id::text, o.organization_id::text
      from whatsapp_accounts a join unipile_account_owners o on o.account_id = a.unipile_account_id where o.organization_id <> a.organization_id
    union all
    select 'instagram', a.unipile_account_id, a.organization_id::text, o.organization_id::text
      from instagram_accounts a join unipile_account_owners o on o.account_id = a.unipile_account_id where o.organization_id <> a.organization_id
    union all
    select 'email', a.unipile_account_id, a.organization_id::text, o.organization_id::text
      from outreach_mailboxes a join unipile_account_owners o on o.account_id = a.unipile_account_id where o.organization_id <> a.organization_id`;
  if (conflicts.length) {
    console.log(`Unipile ownership conflicts (${conflicts.length}), not reassigned:`);
    for (const c of conflicts) console.log(`  ${c.channel} account ${c.account_id}: held by organization ${c.held_by}, owned by ${c.owner}`);
  } else {
    console.log("No Unipile ownership conflicts.");
  }
  if (!operators) {
    console.log("No platform operator is granted yet. Grant one explicitly: bun scripts/grant-platform-operator.ts --email <address>");
  }
} finally {
  await db.close();
}

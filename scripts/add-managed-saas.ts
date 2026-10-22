/**
 * Managed SaaS: the platform operator grant table, and (in later sections of
 * the same file) the platform's default credentials, each organization's
 * Included / My own provider choice, Unipile account ownership and the usage
 * columns. Applies db/migrations/20261022-managed-saas.sql in one
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
  console.log(`Managed SaaS ready: platform_operators (${operators} granted).`);
  if (!operators) {
    console.log("No platform operator is granted yet. Grant one explicitly: bun scripts/grant-platform-operator.ts --email <address>");
  }
} finally {
  await db.close();
}

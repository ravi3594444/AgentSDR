/**
 * Pilot fixes: lead_audience_members.fit_* (each lead's verdict against the
 * request its list serves; only matches count toward the request's target)
 * and whatsapp_accounts.last_refusal* (why the campaign sender last held a
 * number back). Applies db/migrations/20261020-pilot-fixes.sql in one
 * transaction; safe to re-run. Run it before deploying the code that reads
 * these.
 *
 *   bun run scripts/add-pilot-fixes.ts
 */
import { SQL } from "bun";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const db = new SQL(url, { max: 1, tls: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false } });
try {
  const ddl = await readFile(join(import.meta.dir, "../db/migrations/20261020-pilot-fixes.sql"), "utf8");
  await db.begin(async (tx) => {
    // Fail fast rather than wait for, and hold up, the running app's locks.
    await tx.unsafe("SET LOCAL lock_timeout = '10s'; SET LOCAL statement_timeout = '60s'").simple();
    await tx.unsafe(ddl).simple();
  });
  console.log("Pilot fixes ready: lead_audience_members.fit_*, whatsapp_accounts.last_refusal*.");
} finally {
  await db.close();
}

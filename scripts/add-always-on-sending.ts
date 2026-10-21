/**
 * Always-on sending: every mailbox's hours always open (its time zone, the
 * day its daily counter resets on, kept), the column default always open,
 * LinkedIn accounts' working hours cleared, and the retired hour rules'
 * stored values removed from channel_settings. Applies
 * db/migrations/20261022-always-on-sending.sql in one transaction; safe to
 * re-run (each statement touches only rows that still differ), and safe to
 * run again after the new app is serving, which also covers anything the old
 * one wrote during the deploy.
 *
 *   bun run scripts/add-always-on-sending.ts
 */
import { SQL } from "bun";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const db = new SQL(url, { max: 1, tls: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false } });
try {
  const ddl = await readFile(join(import.meta.dir, "../db/migrations/20261022-always-on-sending.sql"), "utf8");
  await db.begin(async (tx) => {
    // Fail fast rather than wait for, and hold up, the running app's locks
    // (the email tick and the LinkedIn run update these rows).
    await tx.unsafe("SET LOCAL lock_timeout = '10s'; SET LOCAL statement_timeout = '60s'").simple();
    await tx.unsafe(ddl).simple();
  });
  console.log("Always-on sending ready: mailbox hours always open (time zones kept), LinkedIn working hours cleared, stored sending hours removed.");
} finally {
  await db.close();
}

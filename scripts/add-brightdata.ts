/**
 * Bright Data research: brightdata_settings (the organization's key, credit
 * limit, records per search, SERP zone and Reddit switch), an index on
 * provider_usage.job_id, the social_research kind of assistant_jobs and the brightdata feature switch.
 * Applies db/migrations/20261021-brightdata.sql in one transaction; safe to
 * re-run. Run it before deploying the code that reads these.
 *
 *   bun run scripts/add-brightdata.ts
 */
import { SQL } from "bun";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const db = new SQL(url, { max: 1, tls: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false } });
try {
  const ddl = await readFile(join(import.meta.dir, "../db/migrations/20261021-brightdata.sql"), "utf8");
  await db.begin(async (tx) => {
    // Fail fast rather than wait for, and hold up, the running app's locks
    // (the CHECK swap on assistant_jobs needs the table the worker polls).
    await tx.unsafe("SET LOCAL lock_timeout = '10s'; SET LOCAL statement_timeout = '60s'").simple();
    await tx.unsafe(ddl).simple();
  });
  console.log("Bright Data ready: brightdata_settings, the social_research job kind.");
} finally {
  await db.close();
}

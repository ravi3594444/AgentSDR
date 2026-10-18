/**
 * Durable completion reports: assistant_jobs.report_key and reported_at
 * (src/lib/assistant/worker.ts). Applies
 * db/migrations/20261018-assistant-job-reports.sql in one transaction; safe
 * to re-run. Run it before deploying the code that writes these columns.
 *
 *   bun run scripts/add-assistant-job-reports.ts
 */
import { SQL } from "bun";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const db = new SQL(url, { max: 1, tls: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false } });
try {
  const ddl = await readFile(join(import.meta.dir, "../db/migrations/20261018-assistant-job-reports.sql"), "utf8");
  await db.begin(async (tx) => {
    await tx.unsafe(ddl).simple();
  });
  console.log("Assistant job report columns ready.");
} finally {
  await db.close();
}

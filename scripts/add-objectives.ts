/**
 * Objectives: assistant_objectives (one per owner request: its lead target,
 * time limit, spend cap, status, stop reason and final report), the
 * "objective" kind of assistant_jobs, and treg_calls.request_id
 * (src/lib/assistant/objective*.ts). Applies
 * db/migrations/20261019-objectives.sql in one transaction; safe to re-run.
 * Run it before deploying the code that reads these.
 *
 *   bun run scripts/add-objectives.ts
 */
import { SQL } from "bun";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const db = new SQL(url, { max: 1, tls: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false } });
try {
  const ddl = await readFile(join(import.meta.dir, "../db/migrations/20261019-objectives.sql"), "utf8");
  await db.begin(async (tx) => {
    // Fail fast rather than wait for, and hold up, the running app's locks
    // (the CHECK swap on assistant_jobs needs the table the worker polls).
    await tx.unsafe("SET LOCAL lock_timeout = '10s'; SET LOCAL statement_timeout = '60s'").simple();
    await tx.unsafe(ddl).simple();
  });
  console.log("Objectives ready: assistant_objectives, the objective job kind, treg_calls.request_id.");
} finally {
  await db.close();
}

/**
 * Research sources: research_settings (scoped), where an organization
 * records Reddit's approval (src/lib/research/sourcesSchema.ts). Applies
 * db/migrations/20261018-research-sources.sql in one transaction; safe to
 * re-run.
 *
 *   bun run scripts/add-research-sources.ts
 */
import { SQL } from "bun";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const db = new SQL(url, { max: 1, tls: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false } });
try {
  const ddl = await readFile(join(import.meta.dir, "../db/migrations/20261018-research-sources.sql"), "utf8");
  await db.begin(async (tx) => {
    // Fail fast rather than wait for, and hold up, the running app's locks.
    await tx.unsafe("SET LOCAL lock_timeout = '10s'; SET LOCAL statement_timeout = '60s'").simple();
    await tx.unsafe(ddl).simple();
  });
  console.log("Research source settings table ready.");
} finally {
  await db.close();
}

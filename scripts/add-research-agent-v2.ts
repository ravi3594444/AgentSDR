/**
 * Research agent v2: assistant_objectives.stop_reason accepts 'finished' (a
 * request the assistant finished as the owner asked). Applies
 * db/migrations/20261021-research-agent-v2.sql in one transaction; safe to
 * re-run. Run it before deploying the code that writes it.
 *
 *   bun run scripts/add-research-agent-v2.ts
 */
import { SQL } from "bun";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const db = new SQL(url, { max: 1, tls: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false } });
try {
  const ddl = await readFile(join(import.meta.dir, "../db/migrations/20261021-research-agent-v2.sql"), "utf8");
  await db.begin(async (tx) => {
    // Fail fast rather than wait for, and hold up, the running app's locks.
    await tx.unsafe("SET LOCAL lock_timeout = '10s'; SET LOCAL statement_timeout = '60s'").simple();
    await tx.unsafe(ddl).simple();
  });
  console.log("Research agent v2 ready: assistant_objectives.stop_reason accepts 'finished'.");
} finally {
  await db.close();
}

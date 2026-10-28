/**
 * Connected browsers' website access: browser_connections.domains, the
 * specific websites a selected-sites connection lists. Applies
 * db/migrations/20261028-browser-access.sql in one transaction; safe to
 * re-run. Run before the new image takes traffic.
 *
 *   bun run scripts/add-browser-access.ts
 */
import { SQL } from "bun";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const db = new SQL(url, { max: 1, tls: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false } });
try {
  const ddl = await readFile(join(import.meta.dir, "../db/migrations/20261028-browser-access.sql"), "utf8");
  await db.begin(async (tx) => {
    await tx.unsafe("SET LOCAL lock_timeout = '10s'; SET LOCAL statement_timeout = '60s'").simple();
    await tx.unsafe(ddl).simple();
  });
  console.log("Browser access ready: specific websites per connection.");
} finally {
  await db.close();
}

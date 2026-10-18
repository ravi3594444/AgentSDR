/**
 * TinyFish settings and provider quotas: tinyfish_settings, provider_usage
 * (scoped) and provider_quota_state (global, see src/lib/quota/schema.ts).
 * Applies db/migrations/20261018-tinyfish.sql in one transaction; safe to
 * re-run.
 *
 *   bun run scripts/add-tinyfish.ts
 */
import { SQL } from "bun";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const db = new SQL(url, { max: 1, tls: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false } });
try {
  const ddl = await readFile(join(import.meta.dir, "../db/migrations/20261018-tinyfish.sql"), "utf8");
  await db.begin(async (tx) => {
    await tx.unsafe(ddl).simple();
  });
  console.log("TinyFish settings and provider quota tables ready.");
} finally {
  await db.close();
}

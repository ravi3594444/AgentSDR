/**
 * Activity: activity_seen (scoped; src/lib/activity/schema.ts). Applies
 * db/migrations/20261018-activity.sql in one transaction; safe to re-run.
 *
 *   bun run scripts/add-activity.ts
 */
import { SQL } from "bun";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const db = new SQL(url, { max: 1, tls: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false } });
try {
  const ddl = await readFile(join(import.meta.dir, "../db/migrations/20261018-activity.sql"), "utf8");
  await db.begin(async (tx) => {
    await tx.unsafe(ddl).simple();
  });
  console.log("Activity table ready.");
} finally {
  await db.close();
}

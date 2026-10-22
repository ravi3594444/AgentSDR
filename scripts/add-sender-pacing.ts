/** One-time upgrade to 30-second sender pacing. Daily counts and follow-ups stay intact. */
import { SQL } from "bun";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
const db = new SQL(process.env.DATABASE_URL, { max: 1, tls: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false } });
try {
  const sql = await readFile(join(import.meta.dir, "../db/migrations/20261022-sender-pacing.sql"), "utf8");
  await db.begin(async (tx) => {
    await tx.unsafe("SET LOCAL lock_timeout = '10s'; SET LOCAL statement_timeout = '60s'").simple();
    if (process.argv.includes("--refresh")) await tx.unsafe("SET LOCAL agentsdr.refresh_sender_pacing = 'on'").simple();
    await tx.unsafe(sql).simple();
  });
  console.log("Sender pacing ready: email, WhatsApp and Instagram default to 30 seconds; daily usage and follow-up dates preserved.");
} finally {
  await db.close();
}

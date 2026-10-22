/** One-time upgrade: the WhatsApp new-chat warm-up is off (0 hours) for every organization. */
import { SQL } from "bun";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
const db = new SQL(process.env.DATABASE_URL, { max: 1, tls: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false } });
try {
  const sql = await readFile(join(import.meta.dir, "../db/migrations/20261023-whatsapp-warmup-off.sql"), "utf8");
  await db.begin(async (tx) => {
    await tx.unsafe("SET LOCAL lock_timeout = '10s'; SET LOCAL statement_timeout = '60s'").simple();
    await tx.unsafe(sql).simple();
  });
  console.log("WhatsApp warm-up off: newly linked numbers start new chats right away; new-chat limits and spacing unchanged.");
} finally {
  await db.close();
}

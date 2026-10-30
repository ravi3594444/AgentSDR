/**
 * Browser outreach: messages delivered through the owner's own signed-in
 * Chrome on X, Instagram, Facebook and LinkedIn. Creates
 * browser_contact_routes, browser_sender_accounts and browser_outreach_sends,
 * and lets "browser" be a channel in the CRM, first contacts and run leads.
 * Applies db/migrations/20261030-browser-outreach.sql in one transaction;
 * safe to re-run. Run before the new image takes traffic.
 *
 *   bun run scripts/add-browser-outreach.ts
 */
import { SQL } from "bun";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const db = new SQL(url, { max: 1, tls: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false } });
try {
  const ddl = await readFile(join(import.meta.dir, "../db/migrations/20261030-browser-outreach.sql"), "utf8");
  await db.begin(async (tx) => {
    await tx.unsafe("SET LOCAL lock_timeout = '10s'; SET LOCAL statement_timeout = '120s'").simple();
    await tx.unsafe(ddl).simple();
  });
  console.log("Browser outreach ready: contact routes, sender accounts, the send queue, and the browser channel.");
} finally {
  await db.close();
}

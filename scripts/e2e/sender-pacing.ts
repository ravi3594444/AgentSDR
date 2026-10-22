/** Rollback-only SQL regression for the sender-pacing upgrade. No providers or sends.
 * bun --conditions=react-server scripts/e2e/sender-pacing.ts
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) throw new Error("Use a local disposable database");
const sql = postgres(process.env.DATABASE_URL!, { max: 1, ssl: false });
const migration = await readFile(resolve("db/migrations/20261022-sender-pacing.sql"), "utf8");
const rollback = new Error("ROLLBACK_TEST");
let checks = 0;
const check = (name: string, value: unknown) => { assert.ok(value, name); checks += 1; console.log(`ok ${checks}: ${name}`); };
try {
  await sql.begin(async (tx) => {
    // Shadow the product tables with isolated fixtures on this connection.
    // Public names in to_regclass only decide whether the optional path exists.
    await tx.unsafe(`
      CREATE TEMP TABLE platform_settings (key text PRIMARY KEY, value jsonb NOT NULL);
      CREATE TEMP TABLE channel_settings (organization_id text, channel text, values jsonb, updated_at timestamptz DEFAULT now());
      CREATE TEMP TABLE outreach_mailboxes (id text, organization_id text, next_email_time timestamptz, today_emails_sent int, daily_send_limit int, updated_at timestamptz DEFAULT now());
      CREATE TEMP TABLE outreach_emails (mailbox_id text, status text, sent_at timestamptz, created_at timestamptz);
      CREATE TEMP TABLE outreach_leads (next_send_at timestamptz, sequence_status text);
      CREATE TEMP TABLE instagram_accounts (id text, organization_id text, outreach_next_send_at timestamptz, status text);
      CREATE TEMP TABLE instagram_outreach_queue (account_id text, organization_id text, attempted_at timestamptz, status text);
      INSERT INTO channel_settings VALUES
        ('a','email','{"dailySendLimit":17,"sendGapMinutes":[18,24]}'),
        ('b','email','{"dailySendLimit":19,"sendGapMinutes":[12,20]}'),
        ('a','whatsapp','{"newChatsPerDay":23,"secondsBetweenSends":5}'),
        ('b','instagram','{"newChatsPerDay":7,"sendGapMinutes":[5,10]}'),
        ('a','general','{"newLeadsPerDay":29}'),
        ('b','linkedin','{"runGapMinutes":[30,60]}');
      INSERT INTO outreach_mailboxes (id,organization_id,next_email_time,today_emails_sent,daily_send_limit) VALUES
        ('ma','a',now()+interval '20 minutes',9,17),
        ('mb','b',now()+interval '20 minutes',3,19),
        ('mc','b',NULL,0,19);
      INSERT INTO outreach_emails VALUES
        ('ma','sent',now()-interval '5 minutes',now()-interval '5 minutes'),
        ('ma','failed',now()-interval '1 second',now()-interval '1 second'),
        ('mb','sent',now()-interval '5 seconds',now()-interval '5 seconds');
      INSERT INTO outreach_leads VALUES (now()+interval '4 days','initial_sent');
      INSERT INTO instagram_accounts VALUES
        ('ia','a',now()+interval '10 minutes','connected'),
        ('ib','b',now()+interval '10 minutes','connected');
      INSERT INTO instagram_outreach_queue VALUES
        ('ia','a',now()-interval '5 minutes','uncertain'),
        ('ib','b',now()-interval '5 seconds','sent');
    `).simple();
    const originalQueue = JSON.stringify(await tx`SELECT * FROM instagram_outreach_queue ORDER BY account_id`);
    await tx.unsafe(migration).simple();
    const settings = await tx`SELECT organization_id,channel,values FROM channel_settings ORDER BY organization_id,channel`;
    check("both organizations lose legacy pacing only", settings.filter((row) => ["email", "instagram", "whatsapp"].includes(row.channel)).every((row) => !("sendGapMinutes" in row.values) && !("secondsBetweenSends" in row.values)));
    check("per-channel daily limits are preserved", settings.some((row) => row.organization_id === "a" && row.values.dailySendLimit === 17) && settings.some((row) => row.organization_id === "b" && row.values.newChatsPerDay === 7));
    check("general daily limit and LinkedIn rules are preserved", settings.some((row) => row.values.newLeadsPerDay === 29) && settings.some((row) => row.values.runGapMinutes?.[1] === 60));
    const mailboxes = await tx`SELECT *,extract(epoch FROM (next_email_time-now()))::float8 AS wait FROM outreach_mailboxes ORDER BY id`;
    check("an old email cooldown is ready, not another 20-minute wait", mailboxes[0].wait === 0);
    check("a recently sent email still waits its remaining 25 seconds", mailboxes[1].wait === 25);
    check("a null mailbox cooldown stays null", mailboxes[2].next_email_time === null);
    check("email usage and sender limits are not reset", mailboxes[0].today_emails_sent === 9 && mailboxes[0].daily_send_limit === 17 && mailboxes[1].today_emails_sent === 3);
    const follow = await tx`SELECT extract(epoch FROM (next_send_at-now()))::float8 AS wait,sequence_status FROM outreach_leads`;
    check("a four-day follow-up remains four days away", follow[0].wait === 4 * 86400 && follow[0].sequence_status === "initial_sent");
    const optional = await tx`SELECT to_regclass('public.instagram_outreach_queue') IS NOT NULL AS present`;
    if (optional[0].present) {
      const accounts = await tx`SELECT id,extract(epoch FROM (outreach_next_send_at-now()))::float8 AS wait FROM instagram_accounts ORDER BY id`;
      check("Instagram legacy cooldowns become ready or retain the remaining 30-second gap", accounts[0].wait === 0 && accounts[1].wait === 25);
    }
    check("sent and uncertain Instagram claims are untouched", JSON.stringify(await tx`SELECT * FROM instagram_outreach_queue ORDER BY account_id`) === originalQueue);
    const marker = await tx`SELECT value FROM platform_settings WHERE key='sender-pacing-30s-v1'`;
    await tx`UPDATE channel_settings SET values=values || '{"secondsBetweenSends":90}'::jsonb WHERE channel='email'`;
    await tx`UPDATE outreach_mailboxes SET next_email_time=now()+interval '1 hour' WHERE id='ma'`;
    await tx.unsafe(migration).simple();
    check("ordinary reruns preserve later explicit settings", (await tx`SELECT values FROM channel_settings WHERE channel='email'`).every((row) => row.values.secondsBetweenSends === 90));
    check("ordinary reruns do not rewrite the marker or cooldown", JSON.stringify(await tx`SELECT value FROM platform_settings WHERE key='sender-pacing-30s-v1'`) === JSON.stringify(marker) && (await tx`SELECT extract(epoch FROM (next_email_time-now()))::float8 AS wait FROM outreach_mailboxes WHERE id='ma'`)[0].wait === 3600);
    await tx.unsafe("SET LOCAL agentsdr.refresh_sender_pacing='on'").simple();
    await tx.unsafe(migration).simple();
    check("the explicit post-switch refresh catches a late legacy timer", (await tx`SELECT extract(epoch FROM (next_email_time-now()))::float8 AS wait FROM outreach_mailboxes WHERE id='ma'`)[0].wait === 0);
    check("refresh still preserves usage, follow-up dates and claims", (await tx`SELECT today_emails_sent FROM outreach_mailboxes WHERE id='ma'`)[0].today_emails_sent === 9 && (await tx`SELECT extract(epoch FROM (next_send_at-now()))::float8 AS wait FROM outreach_leads`)[0].wait === 4 * 86400 && JSON.stringify(await tx`SELECT * FROM instagram_outreach_queue ORDER BY account_id`) === originalQueue);
    throw rollback;
  });
} catch (error) {
  if (error !== rollback) throw error;
} finally {
  await sql.end();
}
console.log(`${checks} sender-pacing checks passed; all fixtures rolled back`);

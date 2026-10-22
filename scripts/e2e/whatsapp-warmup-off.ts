/** Rollback-only SQL regression for the WhatsApp warm-up-off upgrade. No providers or sends.
 * bun --conditions=react-server scripts/e2e/whatsapp-warmup-off.ts
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import postgres from "postgres";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) throw new Error("Use a local disposable database");
const sql = postgres(process.env.DATABASE_URL!, { max: 1, ssl: false });
const migration = await readFile(resolve("db/migrations/20261023-whatsapp-warmup-off.sql"), "utf8");
const rollback = new Error("ROLLBACK_TEST");
let checks = 0;
const check = (name: string, value: unknown) => { assert.ok(value, name); checks += 1; console.log(`ok ${checks}: ${name}`); };
const values = async (tx: postgres.TransactionSql, organization: string, channel: string) =>
  (await tx`SELECT values FROM channel_settings WHERE organization_id = ${organization} AND channel = ${channel}`)[0]?.values as Record<string, unknown>;
try {
  await sql.begin(async (tx) => {
    // Shadow the product tables with isolated fixtures on this connection.
    await tx.unsafe(`
      CREATE TEMP TABLE platform_settings (key text PRIMARY KEY, value jsonb NOT NULL);
      CREATE TEMP TABLE channel_settings (organization_id text, channel text, values jsonb, updated_at timestamptz DEFAULT now());
      INSERT INTO channel_settings VALUES
        ('a','whatsapp','{"warmupHours":24,"newChatsPerDay":12}'),
        ('b','whatsapp','{"warmupHours":48}'),
        ('c','whatsapp','{"secondsBetweenSends":60}'),
        ('a','email','{"dailySendLimit":40,"warmupHours":24}'),
        ('a','general','{"newLeadsPerDay":5}');
    `);
    await tx.unsafe(migration).simple();
    check("a stored warm-up is removed, other WhatsApp rules stay", isDeepStrictEqual(await values(tx, "a", "whatsapp"), { newChatsPerDay: 12 }));
    check("a warm-up-only row becomes empty, so it follows the 0 default", isDeepStrictEqual(await values(tx, "b", "whatsapp"), {}));
    check("a WhatsApp row without a warm-up is unchanged", isDeepStrictEqual(await values(tx, "c", "whatsapp"), { secondsBetweenSends: 60 }));
    // jsonb keeps its own key order, so values are compared as objects, never as text.
    check("other channels are untouched", isDeepStrictEqual(await values(tx, "a", "email"), { dailySendLimit: 40, warmupHours: 24 }) && isDeepStrictEqual(await values(tx, "a", "general"), { newLeadsPerDay: 5 }));
    const marker = await tx`SELECT value FROM platform_settings WHERE key = 'whatsapp-warmup-off-v1'`;
    check("the marker is written once", marker.length === 1);

    // An owner sets a warm-up after the upgrade: later deploys keep it.
    await tx`UPDATE channel_settings SET values = values || '{"warmupHours":6}'::jsonb WHERE organization_id = 'b' AND channel = 'whatsapp'`;
    await tx.unsafe(migration).simple();
    check("ordinary reruns keep a warm-up set after the upgrade", (await values(tx, "b", "whatsapp")).warmupHours === 6);
    check("ordinary reruns do not rewrite the marker", JSON.stringify(await tx`SELECT value FROM platform_settings WHERE key = 'whatsapp-warmup-off-v1'`) === JSON.stringify(marker));
    throw rollback;
  });
} catch (error) {
  if (error !== rollback) throw error;
} finally {
  await sql.end();
}
console.log(`All ${checks} WhatsApp warm-up-off checks passed (rolled back).`);

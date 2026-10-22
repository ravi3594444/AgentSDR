/**
 * The deployed upgrade gap: an older database can lack tavily_settings even
 * after all deploy.sh predecessors ran. Fresh-schema tests cannot catch it.
 *
 * Runs the real managed-SaaS SQL with the table missing and with saved keys.
 * Each scenario rolls back all fixture/DDL changes. Local disposable DB only.
 *
 *   bun scripts/e2e/managed-saas-upgrade.ts
 */
import { SQL } from "bun";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const url = process.env.DATABASE_URL ?? "";
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}

const db = new SQL(url, { max: 1, tls: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false } });
const ddl = await readFile(join(import.meta.dir, "../../db/migrations/20261022-managed-saas.sql"), "utf8");
let failures = 0;
let passes = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (ok) passes++;
  else failures++;
}
const rollbackOnly = new Error("rollback completed upgrade scenario");

try {
  const expectedColumns = await db`
    select column_name, data_type, is_nullable, column_default
    from information_schema.columns
    where table_schema = 'public' and table_name = 'tavily_settings'
    order by ordinal_position`;
  const expectedConstraints = await db`
    select conname, pg_get_constraintdef(oid) as definition
    from pg_constraint where conrelid = 'public.tavily_settings'::regclass
    order by conname`;

  for (const scenario of ["missing table", "existing settings"] as const) {
    try {
      await db.begin(async (tx) => {
        if (scenario === "missing table") {
          await tx.unsafe("DROP TABLE tavily_settings").simple();
          await tx.unsafe(ddl).simple();
          const columns = await tx`
            select column_name, data_type, is_nullable, column_default
            from information_schema.columns
            where table_schema = 'public' and table_name = 'tavily_settings'
            order by ordinal_position`;
          const constraints = await tx`
            select conname, pg_get_constraintdef(oid) as definition
            from pg_constraint where conrelid = 'public.tavily_settings'::regclass
            order by conname`;
          check("upgrade creates the missing Tavily table with the fresh-install columns", JSON.stringify(columns) === JSON.stringify(expectedColumns));
          check("the restored table has the fresh-install primary key, organization foreign key and daily cap", JSON.stringify(constraints) === JSON.stringify(expectedConstraints));
          await tx.unsafe(ddl).simple();
          const [{ n }] = await tx`select count(*)::int as n from tavily_settings`;
          check("re-running the missing-table upgrade adds no settings or keys", n === 0);
        } else {
          const [a] = await tx`insert into organizations (id, name, slug, created_at)
            values (gen_random_uuid(), 'Upgrade test: own', gen_random_uuid()::text, now()) returning id`;
          const [b] = await tx`insert into organizations (id, name, slug, created_at)
            values (gen_random_uuid(), 'Upgrade test: Included', gen_random_uuid()::text, now()) returning id`;
          const [c] = await tx`insert into organizations (id, name, slug, created_at)
            values (gen_random_uuid(), 'Upgrade test: no key', gen_random_uuid()::text, now()) returning id`;
          const savedAt = new Date("2026-10-01T00:00:00Z");
          for (const org of [a, b]) {
            await tx`insert into tavily_settings (organization_id, encrypted_key, key_hint, daily_searches, updated_at)
              values (${org!.id}, 'encrypted-fixture-only', '…test', 137, ${savedAt})`;
          }
          await tx`insert into tavily_settings (organization_id) values (${c!.id})`;
          await tx`insert into provider_credential_modes (organization_id, service, mode, reason)
            values (${b!.id}, 'tavily', 'managed', 'explicit choice')`;
          const before = await tx`select * from tavily_settings where organization_id in (${a!.id}, ${b!.id}, ${c!.id}) order by organization_id`;

          await tx.unsafe(ddl).simple();
          const modes: { organization_id: string; mode: string }[] = await tx`select organization_id, mode from provider_credential_modes
            where service = 'tavily' and organization_id in (${a!.id}, ${b!.id}, ${c!.id})`;
          check("a saved Tavily key stays on the workspace's own provider", modes.find((row) => row.organization_id === a!.id)?.mode === "own");
          check("an explicit Included choice is not overwritten", modes.find((row) => row.organization_id === b!.id)?.mode === "managed");
          check("an empty settings row does not force My own provider", !modes.some((row) => row.organization_id === c!.id));

          await tx.unsafe(ddl).simple();
          const after = await tx`select * from tavily_settings where organization_id in (${a!.id}, ${b!.id}, ${c!.id}) order by organization_id`;
          check("two migration runs preserve encrypted keys, hints, caps and timestamps", JSON.stringify(after) === JSON.stringify(before));
          const [choice] = await tx`select mode, reason from provider_credential_modes where organization_id = ${b!.id} and service = 'tavily'`;
          check("an explicit Included choice and its reason survive a second run", choice?.mode === "managed" && choice.reason === "explicit choice");
        }
        throw rollbackOnly;
      });
    } catch (error) {
      if (error !== rollbackOnly) {
        failures++;
        console.error(`FAIL  ${scenario}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
} finally {
  await db.close();
}
console.log(`${passes} pass, ${failures} fail`);
process.exit(failures ? 1 : 0);

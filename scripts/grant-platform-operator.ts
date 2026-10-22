/**
 * Grants (or revokes) platform operator access: the operator panel at
 * /platform (default provider keys, the Included AI engine, usage) and the
 * platform-wide LinkedIn job logs. The only way to become an operator; no
 * route or role grants it, and owning a customer organization never does.
 *
 *   bun scripts/grant-platform-operator.ts --email someone@example.com [--note "why"]
 *   bun scripts/grant-platform-operator.ts --email someone@example.com --revoke
 *   bun scripts/grant-platform-operator.ts --list
 *
 * Run by whoever runs the server, against its database (in the container:
 * `docker compose exec app bun scripts/grant-platform-operator.ts …`). The
 * person must already have an account. Uses Bun's built-in PostgreSQL client
 * and no packages, so it also runs inside the Docker image.
 */
import { SQL } from "bun";
import { userInfo } from "node:os";

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? (process.argv[index + 1] ?? null) : null;
}

const email = arg("email")?.trim().toLowerCase() ?? null;
const note = arg("note");
const revoke = process.argv.includes("--revoke");
const list = process.argv.includes("--list");

if (!list && !email) {
  console.error("Usage: bun scripts/grant-platform-operator.ts --email <address> [--note <text>] [--revoke] | --list");
  process.exit(2);
}

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const db = new SQL(url, { max: 1, tls: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false } });

let exitCode = 0;
try {
  if (list) {
    const rows: { email: string; granted_by: string; granted_at: Date; note: string | null }[] = await db`
      select u.email, o.granted_by, o.granted_at, o.note
      from platform_operators o join users u on u.id = o.user_id
      order by o.granted_at`;
    if (!rows.length) console.log("No platform operators.");
    for (const row of rows) console.log(`${row.email}  granted ${new Date(row.granted_at).toISOString()} by ${row.granted_by}${row.note ? ` (${row.note})` : ""}`);
  } else {
    const [user]: { id: string; email: string }[] = await db`select id, email from users where lower(email) = ${email} limit 1`;
    if (!user) {
      console.error(`No account with the email ${email}. The person signs up first.`);
      exitCode = 1;
    } else if (revoke) {
      const removed = await db`delete from platform_operators where user_id = ${user.id} returning user_id`;
      console.log(removed.length ? `Revoked platform operator access for ${user.email}.` : `${user.email} was not a platform operator.`);
    } else {
      const grantedBy = `script:${(() => { try { return userInfo().username; } catch { return "unknown"; } })()}`;
      const added = await db`
        insert into platform_operators (user_id, granted_by, note) values (${user.id}, ${grantedBy}, ${note})
        on conflict (user_id) do nothing returning user_id`;
      console.log(added.length ? `Granted platform operator access to ${user.email}.` : `${user.email} already is a platform operator.`);
    }
  }
} finally {
  await db.close();
}
process.exit(exitCode);

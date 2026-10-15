/**
 * Tenant isolation, end to end: a member of a second organization must not
 * be able to see, change or count anything of the first.
 *
 *   BASE_URL=http://localhost:3100 bun run scripts/e2e/tenancy-isolation.ts
 *
 * Runs against a RUNNING server and its database (DATABASE_URL) — a disposable
 * copy, never production: it creates a user and an organization, and it
 * deliberately fires mutations at another organization's ids. It refuses to
 * run unless DATABASE_URL points at localhost.
 *
 * How it decides "leaked": it collects identifiers that only organization A's
 * data contains — row ids from every scoped and inherited table, people
 * emails and LinkedIn URLs, mailbox addresses, company domains — and scans
 * every response organization B receives for any of them.
 *
 * 1. Positive control: A's owner calls every plain GET API; the detector must
 *    find A's identifiers (otherwise a clean result would mean nothing).
 * 2. Reads: B calls every plain GET API and every GET under a dynamic route,
 *    with A's ids in the path. Any A identifier in a response is a leak; any
 *    2xx on an A id is flagged.
 * 3. Writes: B sends POST/PATCH/PUT/DELETE to every dynamic route with A's ids.
 *    Each must be refused, and the targeted A row must be byte-identical
 *    afterwards.
 * 4. Pages: B loads every page (dynamic ones with A ids); no A identifier may
 *    appear in the HTML.
 *
 * Needs: INITIAL_OWNER_EMAIL / INITIAL_OWNER_PASSWORD (organization A's owner),
 * and the server under test started with AUTH_SIGNUP=open, so the test can
 * sign up organization B (sign-up is invite-only by default).
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import postgres from "postgres";
import { INHERITED, SCOPED_TABLES } from "@/lib/tenancy/registry";

const BASE = process.env.BASE_URL ?? "http://localhost:3100";
const ROOT = join(import.meta.dir, "..", "..", "src", "app");

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}
const sql = postgres(process.env.DATABASE_URL!, { ssl: false, max: 2, onnotice: () => {} });

// ---------------------------------------------------------------- sessions

type Session = { cookie: string; label: string };

function cookiesFrom(res: Response, previous = ""): string {
  const jar = new Map(previous.split("; ").filter(Boolean).map((c) => [c.split("=")[0], c] as const));
  for (const c of res.headers.getSetCookie()) {
    const pair = c.split(";")[0];
    jar.set(pair.split("=")[0], pair);
  }
  return [...jar.values()].join("; ");
}

async function authPost(path: string, body: unknown, cookie = ""): Promise<Response> {
  return fetch(`${BASE}/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, cookie },
    body: JSON.stringify(body),
    redirect: "manual",
  });
}

async function signIn(email: string, password: string, label: string): Promise<Session> {
  const res = await authPost("/sign-in/email", { email, password });
  if (!res.ok) {
    const hint = label === "B" ? " — organization B could not be created: start the server under test with AUTH_SIGNUP=open (sign-up is invite-only by default)" : "";
    throw new Error(`${label}: sign-in failed (${res.status}) ${await res.text()}${hint}`);
  }
  return { cookie: cookiesFrom(res), label };
}

async function organizationB(): Promise<{ session: Session; organizationId: string }> {
  const stamp = Date.now();
  const email = `isolation-b+${stamp}@example.test`;
  const password = "isolation-b-password-1";
  const signUp = await authPost("/sign-up/email", { name: "Isolation B", email, password });
  if (!signUp.ok) throw new Error(`B sign-up failed (${signUp.status}) ${await signUp.text()}`);
  await sql`update users set email_verified = true where email = ${email}`;
  let session = await signIn(email, password, "B");
  const created = await authPost("/organization/create", { name: `Isolation B ${stamp}`, slug: `isolation-b-${stamp}` }, session.cookie);
  if (!created.ok) throw new Error(`B org create failed (${created.status}) ${await created.text()}`);
  const org = (await created.json()) as { id: string };
  session = { ...session, cookie: cookiesFrom(created, session.cookie) };
  // A fresh sign-in so the session cookie cache carries the new active org.
  session = await signIn(email, password, "B");
  return { session, organizationId: org.id };
}

// ------------------------------------------------------- A's fingerprints

const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

async function fingerprintsOfA(orgA: string): Promise<{ markers: Set<string>; idsByTable: Map<string, string[]> }> {
  const markers = new Set<string>();
  const idsByTable = new Map<string, string[]>();
  const scopedColumn = new Map(SCOPED_TABLES.map((s) => [s.table, s.column]));

  for (const { table, column } of SCOPED_TABLES) {
    const rows = await sql.unsafe<{ id: string }[]>(
      `select id::text as id from ${quote(table)} where ${quote(column)} = $1 order by random() limit 25`,
      [orgA],
    ).catch(() => [] as { id: string }[]); // a table keyed by (organization, …) has no id to fingerprint
    idsByTable.set(table, rows.map((r) => r.id));
  }
  // Inherited tables: through their parent chain up to a scoped table.
  for (const child of Object.keys(INHERITED)) {
    const chain: string[] = [child];
    while (!scopedColumn.has(chain[chain.length - 1])) chain.push(INHERITED[chain[chain.length - 1]]);
    const fks = await Promise.all(chain.slice(0, -1).map((table, i) => foreignKeyColumn(table, chain[i + 1])));
    if (fks.some((fk) => !fk)) continue;
    const joins = chain.slice(1).map((table, i) => `join ${quote(table)} t${i + 1} on t${i + 1}.id = t${i}.${quote(fks[i]!)}`).join(" ");
    const top = chain.length - 1;
    const rows = await sql.unsafe<{ id: string }[]>(
      `select t0.id::text as id from ${quote(child)} t0 ${joins} where t${top}.${quote(scopedColumn.get(chain[top])!)} = $1 order by random() limit 25`,
      [orgA],
    ).catch(() => [] as { id: string }[]);
    idsByTable.set(child, rows.map((r) => r.id));
  }
  for (const ids of idsByTable.values()) for (const id of ids) if (id.length >= 16) markers.add(id);

  const strings = await sql<{ v: string }[]>`
    (select email as v from people where organization_id = ${orgA} and email is not null order by random() limit 60)
    union all (select linkedin_url from people where organization_id = ${orgA} and linkedin_url is not null order by random() limit 60)
    union all (select email_address from outreach_mailboxes where organization_id = ${orgA} limit 40)
    union all (select domain from companies where organization_id = ${orgA} and length(domain) >= 8 order by random() limit 40)`;
  for (const { v } of strings) if (v && v.length >= 8 && !/^(gmail|yahoo|outlook|hotmail)\./i.test(v)) markers.add(v);
  return { markers, idsByTable };
}

async function foreignKeyColumn(child: string, parent: string): Promise<string | null> {
  const [row] = await sql<{ col: string }[]>`
    select a.attname as col from pg_constraint con
    join pg_class c on c.oid = con.conrelid join pg_class p on p.oid = con.confrelid
    join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
    where con.contype = 'f' and c.relname = ${child} and p.relname = ${parent} and a.attnotnull limit 1`;
  return row?.col ?? null;
}

/**
 * A's identifiers present in `body`, ignoring any the caller put in the URL
 * themselves — a 404 that says "record <id> not found", or a page whose HTML
 * carries its own route params, repeats B's input and reveals nothing.
 */
function leaksIn(body: string, markers: Set<string>, requestedUrl = ""): string[] {
  const found: string[] = [];
  for (const marker of markers) if (body.includes(marker) && !requestedUrl.includes(marker)) found.push(marker);
  return found;
}

// --------------------------------------------------------------- routes

type Route = { url: string; methods: string[]; dynamic: boolean; file: string };

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

/** Path segment → which of A's tables supplies a value for it. First matching prefix wins. */
const PARAM_TABLE: [RegExp, Record<string, string>][] = [
  [/^\/api\/assistant\/runs\//, { id: "outreach_runs" }],
  [/^\/api\/assistant\/decisions\//, { id: "owner_decisions" }],
  [/^\/api\/crm\/records\//, { id: "crm_records" }],
  [/^\/api\/crm\/drafts\//, { id: "crm_drafts" }],
  [/^\/api\/crm\/classifications\//, { id: "crm_classifications" }],
  [/^\/api\/crm\/sequences\//, { id: "crm_sequences" }],
  [/^\/api\/crm\/subcategories\//, { id: "crm_subcategories" }],
  [/^\/api\/crm\/knowledge\//, { id: "crm_knowledge_documents" }],
  [/^\/api\/crm\/identity-exceptions\//, { id: "crm_identity_exceptions" }],
  [/^\/api\/crm\/send-attempts\//, { id: "crm_send_attempts" }],
  [/^\/api\/calls\//, { id: "call_sessions" }],
  [/^\/api\/calling\/campaigns\//, { id: "call_campaigns" }],
  [/^\/api\/calling\/contacts\//, { id: "call_campaign_contacts" }],
  [/^\/api\/whatsapp\/accounts\//, { id: "whatsapp_accounts" }],
  [/^\/api\/whatsapp\/chats\//, { id: "whatsapp_chats" }],
  [/^\/api\/grid\/ai\/connections\//, { connectionId: "grid_providers" }],
  [/^\/api\/grid\/folders\//, { folderId: "grid_folders" }],
  [/^\/api\/grid\/workbooks\//, { workbookId: "grid_workbooks" }],
  [/^\/api\/grid\/tables\//, { tableId: "grid_tables", columnId: "grid_columns" }],
  [/^\/api\/leads\/columns\//, { id: "entity_columns" }],
  [/^\/api\/linkedin\/accounts\//, { id: "LinkedInAccount" }],
  [/^\/api\/linkedin\/campaigns\//, { id: "Campaign" }],
  [/^\/api\/linkedin\/leads\//, { id: "Lead" }],
  [/^\/api\/linkedin\/search\/batches\//, { id: "SearchBatch" }],
  [/^\/api\/linkedin\/search\/queue\//, { id: "SearchQuery" }],
  [/^\/api\/webhooks\//, { id: "WebhookEvent" }],
  [/^\/api\/outreach\/campaigns\//, { id: "outreach_campaigns", leadId: "outreach_leads" }],
  [/^\/api\/outreach\/inbox\/leads\//, { id: "crm_leads" }],
  [/^\/api\/outreach\/inbox\/messages\//, { id: "crm_messages" }],
  [/^\/api\/outreach\/inbox\/drafts\//, { id: "crm_email_drafts" }],
  [/^\/api\/outreach\/inbox\/notes\//, { id: "crm_notes" }],
  [/^\/api\/outreach\/inbox\/tasks\//, { id: "crm_tasks" }],
  [/^\/api\/outreach\/mailboxes\//, { id: "outreach_mailboxes" }],
  [/^\/api\/campaigns\//, { id: "campaigns" }],
  [/^\/linkedin\/campaigns\//, { id: "Campaign" }],
  [/^\/linkedin\/search\//, { id: "SearchBatch" }],
  [/^\/crm\/records\//, { id: "crm_records" }],
  [/^\/campaigns\//, { id: "campaigns" }],
  [/^\/tables\//, { workbookId: "grid_workbooks", tableId: "grid_tables" }],
];
const FIXED_PARAMS: Record<string, string> = {
  personId: "people",
  view: "overview",
  action: "acknowledge",
  providerKey: "openrouter",
  integrationKey: "hunter",
  key: "unipile",
};
/** Not tenant-session routes: Better Auth itself, the recorder extension (bearer tokens), public webhooks/links. */
const SKIP = [/^\/api\/auth\//, /^\/api\/call-recorder\//, /^\/api\/webhooks\/(connection-accepted|message-received|unipile-account|whatsapp-message)/, /^\/api\/outreach\/(tick|build-queue|webhooks|unsubscribe|mailboxes\/watch)/, /^\/api\/linkedin\/jobs\/(run|reset|replay)/];

function fill(pattern: string, idsByTable: Map<string, string[]>, aTargetedDomain: string | null, aPhotoPerson: string | null): { url: string; table: string | null; id: string | null } | null {
  const rule = PARAM_TABLE.find(([re]) => re.test(pattern))?.[1] ?? {};
  let table: string | null = null;
  let id: string | null = null;
  const url = pattern.replace(/\[(\.\.\.)?([A-Za-z]+)\]/g, (_, __, name: string) => {
    if (name === "domain") return aTargetedDomain ?? "example.com";
    if (name === "file") return "missing.jpg";
    const source = rule[name] ?? (FIXED_PARAMS[name] === "people" ? "people" : null);
    if (source) {
      const value = idsByTable.get(source)?.[0];
      if (!table) { table = source; id = value ?? null; }
      return value ?? "00000000-0000-0000-0000-000000000000";
    }
    if (name === "personId") return aPhotoPerson ?? "00000000-0000-0000-0000-000000000000";
    return FIXED_PARAMS[name] ?? "00000000-0000-0000-0000-000000000000";
  });
  return { url, table, id };
}

function routes(): Route[] {
  const files = walk(join(ROOT, "api")).filter((f) => f.endsWith("route.ts"));
  return files.map((file) => {
    const rel = "/" + relative(ROOT, file).replace(/\/route\.ts$/, "");
    return { url: rel, methods: [], dynamic: rel.includes("["), file };
  });
}

async function methodsOf(file: string): Promise<string[]> {
  const src = await Bun.file(file).text();
  return ["GET", "POST", "PUT", "PATCH", "DELETE"].filter((m) =>
    new RegExp(`export\\s+(async\\s+)?function\\s+${m}\\b|export\\s+const\\s+${m}\\b|export\\s+const\\s+\\{[^}]*\\b${m}\\b`).test(src),
  );
}

function pages(): string[] {
  return walk(ROOT)
    .filter((f) => f.endsWith("page.tsx") && !f.includes("/api/") && !f.includes("/@modal/"))
    .map((f) => "/" + relative(ROOT, f).replace(/\/?page\.tsx$/, ""))
    .map((p) => (p === "/" ? "/" : p.replace(/\/$/, "")));
}

async function rowSnapshot(table: string, id: string): Promise<string> {
  const rows = await sql.unsafe(`select * from ${quote(table)} where id::text = $1`, [id]);
  return JSON.stringify(rows);
}

// ------------------------------------------------------------------ run

type Finding = { kind: string; where: string; detail: string };

async function main() {
  const ownerEmail = process.env.INITIAL_OWNER_EMAIL;
  const ownerPassword = process.env.INITIAL_OWNER_PASSWORD;
  if (!ownerEmail || !ownerPassword) throw new Error("INITIAL_OWNER_EMAIL / INITIAL_OWNER_PASSWORD are required");
  // A is the organization flagged initial (an install migrated from the
  // single-workspace version), else the first one this owner owns (a fresh
  // install, e.g. the demo organization from db:seed:demo).
  const [orgA] = await sql<{ id: string }[]>`
    select id from (
      select o.id, 0 as rank, o.created_at from organizations o where o.metadata::jsonb ->> 'initial' = 'true'
      union all
      select o.id, 1, o.created_at from organizations o
        join members m on m.organization_id = o.id
        join users u on u.id = m.user_id
       where lower(u.email) = lower(${ownerEmail}) and m.role like '%owner%'
    ) candidates order by rank, created_at limit 1`;
  if (!orgA) throw new Error(`No organization to test: none is flagged initial and ${ownerEmail} owns none`);

  const { markers, idsByTable } = await fingerprintsOfA(orgA.id);
  const [{ domain: aDomain } = { domain: null }] = await sql<{ domain: string | null }[]>`select domain from targeted_domains where organization_id = ${orgA.id} limit 1`;
  console.log(`A = ${orgA.id}; ${markers.size} fingerprints from ${[...idsByTable.values()].filter((v) => v.length).length} tables`);

  const sessionA = await signIn(ownerEmail, ownerPassword, "A");
  const { session: sessionB, organizationId: orgB } = await organizationB();
  console.log(`B = ${orgB} (fresh, empty)`);

  const all = routes().filter((r) => !SKIP.some((re) => re.test(r.url)));
  for (const r of all) r.methods = await methodsOf(r.file);

  const findings: Finding[] = [];
  const call = (s: Session, method: string, url: string, body?: unknown) =>
    fetch(`${BASE}${url}`, {
      method,
      headers: {
        cookie: s.cookie,
        origin: BASE,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        "idempotency-key": `isolation-${crypto.randomUUID()}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    }).then(async (res) => ({ status: res.status, text: await res.text() }))
      .catch((error: Error) => ({ status: 0, text: String(error.message) }));

  // 1. Positive control.
  const plainGets = all.filter((r) => !r.dynamic && r.methods.includes("GET"));
  let controlHits = 0;
  for (const r of plainGets) {
    const res = await call(sessionA, "GET", r.url);
    if (leaksIn(res.text, markers).length) controlHits++;
  }
  console.log(`positive control: A sees its own data in ${controlHits}/${plainGets.length} plain GET routes`);
  if (controlHits === 0) findings.push({ kind: "CONTROL", where: "all", detail: "A saw none of its own identifiers — the detector proves nothing" });

  // 2. Reads as B.
  let reads = 0;
  for (const r of all.filter((x) => x.methods.includes("GET"))) {
    const target = r.dynamic ? fill(r.url, idsByTable, aDomain, idsByTable.get("people")?.[0] ?? null) : { url: r.url, table: null, id: null };
    if (!target) continue;
    const res = await call(sessionB, "GET", target.url);
    reads++;
    const leaked = leaksIn(res.text, markers, target.url);
    if (leaked.length) findings.push({ kind: "READ LEAK", where: `GET ${target.url} → ${res.status}`, detail: leaked.slice(0, 3).join(", ") });
    else if (r.dynamic && target.id && res.status >= 200 && res.status < 300) findings.push({ kind: "READ 2xx", where: `GET ${target.url}`, detail: `B got ${res.status} for A's ${target.table} — check it returns nothing of A` });
    if (res.status >= 500) findings.push({ kind: "ERROR", where: `GET ${target.url}`, detail: `${res.status} ${res.text.slice(0, 160)}` });
  }

  // 3. Writes as B against A's ids (ISOLATION_SKIP_WRITES=1 skips them).
  let writes = 0;
  for (const r of process.env.ISOLATION_SKIP_WRITES ? [] : all.filter((x) => x.dynamic)) {
    for (const method of r.methods.filter((m) => m !== "GET")) {
      const target = fill(r.url, idsByTable, aDomain, idsByTable.get("people")?.[0] ?? null);
      if (!target?.table || !target.id) continue;
      const before = await rowSnapshot(target.table, target.id);
      const res = await call(sessionB, method, target.url, {});
      const after = await rowSnapshot(target.table, target.id);
      writes++;
      if (before !== after) findings.push({ kind: "WRITE LEAK", where: `${method} ${target.url} → ${res.status}`, detail: `A's ${target.table} row changed` });
      else if (res.status >= 200 && res.status < 300) findings.push({ kind: "WRITE 2xx", where: `${method} ${target.url}`, detail: `B got ${res.status} on A's ${target.table} (row unchanged) — check` });
      const leaked = leaksIn(res.text, markers, target.url);
      if (leaked.length) findings.push({ kind: "WRITE RESPONSE LEAK", where: `${method} ${target.url}`, detail: leaked.slice(0, 3).join(", ") });
    }
  }

  // 4. Pages as B.
  let pageCount = 0;
  for (const p of pages()) {
    if (/^\/(sign-in|sign-up|forgot-password|reset-password|accept-invitation|login|unsubscribe|onboarding)/.test(p)) continue;
    const target = p.includes("[") ? fill(p, idsByTable, aDomain, null) : { url: p, table: null, id: null };
    if (!target) continue;
    const res = await call(sessionB, "GET", target.url);
    pageCount++;
    const leaked = leaksIn(res.text, markers, target.url);
    if (leaked.length) findings.push({ kind: "PAGE LEAK", where: `${target.url} → ${res.status}`, detail: leaked.slice(0, 3).join(", ") });
  }

  console.log(`checked: ${reads} reads, ${writes} writes, ${pageCount} pages as B`);
  const order = ["CONTROL", "WRITE LEAK", "READ LEAK", "PAGE LEAK", "WRITE RESPONSE LEAK", "WRITE 2xx", "READ 2xx", "ERROR"];
  findings.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  for (const f of findings) console.log(`${f.kind.padEnd(20)} ${f.where}\n${" ".repeat(21)}${f.detail}`);
  const fatal = findings.filter((f) => /LEAK|CONTROL/.test(f.kind));
  console.log(fatal.length ? `\n✗ ${fatal.length} isolation failure(s)` : `\n✓ no isolation failures (${findings.length} item(s) to review)`);
  await sql.end();
  process.exit(fatal.length ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await sql.end();
  process.exit(1);
});

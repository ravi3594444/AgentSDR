/**
 * Owner controls, end to end: what an organization's owner can change and a
 * member cannot, plus the owner's everyday workflow over the API — Getting
 * Started, sending rules, a people import, and an email campaign created,
 * started, paused and resumed.
 *
 *   INITIAL_OWNER_EMAIL=… INITIAL_OWNER_PASSWORD=… BASE_URL=http://localhost:3000 \
 *     bun run scripts/e2e/owner-controls.ts
 *
 * Runs against a RUNNING server and its database (DATABASE_URL) — a disposable
 * copy, never production: it invites a member into the owner's organization,
 * creates that member's account (marked verified directly in the database, as
 * the invitation email is only logged without RESEND_API_KEY), and removes the
 * member and the test campaign again at the end. It refuses to run unless
 * DATABASE_URL points at localhost. The server can keep the default
 * AUTH_SIGNUP=invite-only: the member signs up through their invitation.
 */
import postgres from "postgres";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}
const OWNER_EMAIL = process.env.INITIAL_OWNER_EMAIL;
const OWNER_PASSWORD = process.env.INITIAL_OWNER_PASSWORD;
if (!OWNER_EMAIL || !OWNER_PASSWORD) {
  console.error("Set INITIAL_OWNER_EMAIL and INITIAL_OWNER_PASSWORD to the organization owner's sign-in.");
  process.exit(2);
}
const sql = postgres(process.env.DATABASE_URL!, { ssl: false, max: 1, onnotice: () => {} });

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// ---------------------------------------------------------------- sessions

function cookiesFrom(res: Response, previous = ""): string {
  const jar = new Map(previous.split("; ").filter(Boolean).map((c) => [c.split("=")[0], c] as const));
  for (const c of res.headers.getSetCookie()) {
    const pair = c.split(";")[0];
    jar.set(pair.split("=")[0], pair);
  }
  return [...jar.values()].join("; ");
}

async function call(method: string, path: string, cookie: string, body?: unknown): Promise<Response> {
  const isForm = body instanceof FormData;
  return fetch(`${BASE}${path}`, {
    method,
    headers: { origin: BASE, cookie, ...(body !== undefined && !isForm ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    redirect: "manual",
  });
}

async function signIn(email: string, password: string): Promise<string> {
  const res = await call("POST", "/api/auth/sign-in/email", "", { email, password });
  if (!res.ok) throw new Error(`sign-in as ${email} failed (${res.status}) ${await res.text()}`);
  return cookiesFrom(res);
}

const status = async (res: Response) => `${res.status} ${(await res.text()).slice(0, 160)}`;

// ---------------------------------------------------------------- owner

const owner = await signIn(OWNER_EMAIL, OWNER_PASSWORD);

{
  const res = await call("GET", "/getting-started", owner);
  const html = await res.text();
  check("owner: Getting Started renders", res.status === 200 && html.includes("Getting started"), `${res.status}`);
  check("owner: Getting Started does not tell an owner to ask an admin", !html.includes("Only an owner or admin"));
}

// Sending rules: change one, read it back, put it back.
{
  const before = (await (await call("GET", "/api/settings/channel-rules/email", owner)).json()) as { values: Record<string, unknown> };
  const original = Number(before.values.dailySendLimit);
  const changed = original === 30 ? 31 : 30;
  const put = await call("PUT", "/api/settings/channel-rules/email", owner, { dailySendLimit: changed });
  const after = put.ok ? ((await put.json()) as { values: Record<string, unknown> }) : null;
  check("owner: can change a sending rule", put.ok && Number(after?.values.dailySendLimit) === changed, put.ok ? "" : await status(put));
  const restore = await call("PUT", "/api/settings/channel-rules/email", owner, { dailySendLimit: original });
  check("owner: can put the sending rule back", restore.ok);
  const invalid = await call("PUT", "/api/settings/channel-rules/email", owner, { dailySendLimit: -5 });
  check("owner: an out-of-range sending rule is refused", invalid.status === 400, `${invalid.status}`);
}

// People import: a UTF-8 CSV, imported twice (the second time only updates).
{
  const stamp = Date.now();
  const csv = `Email,Full Name,Company\nowner-controls+${stamp}@example.test,José Müller,Café Lda\n\nnot-an-email,Bad Row,Nope\n`;
  const upload = () => {
    const form = new FormData();
    form.append("file", new File([csv], "people.csv", { type: "text/csv" }));
    return call("POST", "/api/leads/people/import", owner, form);
  };
  const first = await upload();
  const firstBody = first.ok ? ((await first.json()) as { created: number; updated: number; failed: { row: number }[] }) : null;
  check(
    "owner: CSV import creates the person and reports the bad row by its file row",
    firstBody?.created === 1 && firstBody.failed.length === 1 && firstBody.failed[0].row === 4,
    first.ok ? JSON.stringify(firstBody) : await status(first),
  );
  const second = await upload();
  const secondBody = second.ok ? ((await second.json()) as { created: number; updated: number }) : null;
  check("owner: importing the same file again updates, never duplicates", secondBody?.created === 0 && secondBody.updated === 1, JSON.stringify(secondBody));
  const [person] = await sql<{ full_name: string }[]>`select full_name from people where email = ${`owner-controls+${stamp}@example.test`}`;
  check("owner: accented names survive a UTF-8 CSV", person?.full_name === "José Müller", person?.full_name);
  await sql`delete from people where email = ${`owner-controls+${stamp}@example.test`}`;
}

// Email campaign: create, start, pause, resume, refuse a bogus status, delete.
{
  const created = await call("POST", "/api/outreach/campaigns", owner, { name: `Owner controls ${Date.now()}` });
  const campaignId = created.ok ? ((await created.json()) as { campaign: { id: string; status: string } }).campaign.id : null;
  check("owner: can create an email campaign", created.status === 201 && Boolean(campaignId), created.ok ? "" : await status(created));
  if (campaignId) {
    for (const next of ["active", "paused", "active", "paused"] as const) {
      const res = await call("PATCH", `/api/outreach/campaigns/${campaignId}`, owner, { status: next });
      const body = res.ok ? ((await res.json()) as { campaign: { status: string } }) : null;
      check(`owner: campaign → ${next}`, body?.campaign.status === next, res.ok ? "" : await status(res));
    }
    const bogus = await call("PATCH", `/api/outreach/campaigns/${campaignId}`, owner, { status: "launched" });
    check("owner: an unknown campaign status is refused", bogus.status === 400, `${bogus.status}`);
    const deleted = await call("DELETE", `/api/outreach/campaigns/${campaignId}`, owner);
    check("owner: can delete the test campaign", deleted.ok, deleted.ok ? "" : await status(deleted));
  }
}

// ---------------------------------------------------------------- member

const memberEmail = `owner-controls-member+${Date.now()}@example.test`;
const memberPassword = "owner-controls-member-1";
const invite = await call("POST", "/api/auth/organization/invite-member", owner, { email: memberEmail, role: "member" });
const invitation = invite.ok ? ((await invite.json()) as { id: string }) : null;
check("owner: can invite a member", Boolean(invitation?.id), invite.ok ? "" : await status(invite));
if (!invitation) {
  await sql.end();
  process.exit(1);
}

const signUp = await call("POST", "/api/auth/sign-up/email", "", { name: "Owner Controls Member", email: memberEmail, password: memberPassword });
check("member: an invited address can sign up on an invite-only instance", signUp.ok, signUp.ok ? "" : await status(signUp));
await sql`update users set email_verified = true where email = ${memberEmail}`;
let member = await signIn(memberEmail, memberPassword);
const accepted = await call("POST", "/api/auth/organization/accept-invitation", member, { invitationId: invitation.id });
check("member: can accept the invitation", accepted.ok, accepted.ok ? "" : await status(accepted));
// A fresh sign-in so the session (and its cookie cache) carries the organization.
member = await signIn(memberEmail, memberPassword);

{
  const res = await call("GET", "/getting-started", member);
  const html = await res.text();
  check("member: Getting Started renders", res.status === 200 && html.includes("Getting started"), `${res.status}`);
  check("member: integration steps say an owner or admin must do them", html.includes("Only an owner or admin"));
}

// Privileged mutations: every one refused for a member. The payloads are
// invalid on purpose, so the owner's positive control (refused for the input,
// never as forbidden) writes nothing. Two have no invalid form and would act
// for the owner (disconnect, re-register webhooks), so only the member tries them.
const privileged: { label: string; method: string; path: string; body?: unknown; ownerProbe: boolean }[] = [
  { label: "change a sending rule", method: "PUT", path: "/api/settings/channel-rules/email", body: { dailySendLimit: -5 }, ownerProbe: true },
  { label: "save the Google Workspace integration", method: "PUT", path: "/api/settings/integrations/google", body: {}, ownerProbe: true },
  {
    label: "change AI settings",
    method: "PUT",
    path: "/api/ai/openrouter/settings",
    body: { providers: ["openai"], modelsByProvider: { openai: ["openai/gpt-test"] } },
    ownerProbe: true,
  },
  { label: "disconnect the Unipile integration", method: "DELETE", path: "/api/settings/integrations/unipile", ownerProbe: false },
  { label: "re-register Unipile webhooks", method: "POST", path: "/api/settings/integrations/unipile/webhooks", ownerProbe: false },
];
for (const action of privileged) {
  const res = await call(action.method, action.path, member, action.body);
  check(`member: cannot ${action.label}`, res.status === 403, await status(res));
}
for (const action of privileged.filter((a) => a.ownerProbe)) {
  const res = await call(action.method, action.path, owner, action.body);
  check(`owner: may ${action.label} (refused only for the invalid input)`, res.status === 400, await status(res));
}
{
  const res = await call("POST", "/api/auth/organization/invite-member", member, { email: `nobody+${Date.now()}@example.test`, role: "admin" });
  check("member: cannot invite people", !res.ok, `${res.status}`);
}
{
  const [row] = await sql<{ id: string }[]>`
    select m.id from members m join users u on u.id = m.user_id where u.email = ${OWNER_EMAIL} limit 1`;
  const res = await call("POST", "/api/auth/organization/update-member-role", member, { memberId: row?.id, role: "member" });
  check("member: cannot change the owner's role", !res.ok, `${res.status}`);
}
{
  const res = await call("GET", "/api/outreach/campaigns", member);
  check("member: can still use the product (list campaigns)", res.ok, `${res.status}`);
}

// ---------------------------------------------------------------- cleanup

const removed = await call("POST", "/api/auth/organization/remove-member", owner, { memberIdOrEmail: memberEmail });
check("owner: can remove the member again", removed.ok, removed.ok ? "" : await status(removed));
await sql.end();

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll owner-control checks passed.");
process.exit(failures ? 1 : 0);

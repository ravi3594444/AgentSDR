/**
 * Who may get into an instance: sign-up modes, organization creation and
 * the platform operator, checked end to end through Better Auth against a
 * real database.
 *
 *   bun --conditions=react-server scripts/e2e/auth-policies.ts
 *
 * Needs an EMPTY schema'd database (`bun run db:setup`, then
 * `bun scripts/add-managed-saas.ts`) — it asserts on the "first account" and
 * "first organization" rules — and refuses to run against anything but
 * localhost. No server is needed.
 */
import { eq } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}
process.env.BETTER_AUTH_SECRET ||= "auth-policies-test-secret-auth-policies-test";
process.env.BETTER_AUTH_URL ||= "http://localhost:3000";

const { db } = await import("@/lib/db");
const { auth } = await import("@/lib/auth/server");
const { isPlatformOperator, requireOrgContext } = await import("@/lib/auth/context");
const { publicSignupAvailable, signupMode } = await import("@/lib/auth/signup");
const { users } = await import("@/lib/auth/schema");

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const cookie = (headers: Headers) => new Headers({ cookie: headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") });

/**
 * Whether an account now EXISTS for `email`. Better Auth answers a blocked
 * sign-up like a successful one (so the endpoint does not reveal which
 * addresses have accounts); the account row is the real outcome.
 */
async function signUp(email: string): Promise<{ ok: boolean; message: string }> {
  let message = "";
  try {
    await auth.api.signUpEmail({ body: { name: email.split("@")[0], email, password: "policy-test-password-1" } });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  const created = await db.update(users).set({ emailVerified: true }).where(eq(users.email, email)).returning({ id: users.id });
  return { ok: created.length === 1, message: message || (created.length ? "" : "no account created") };
}
async function signIn(email: string): Promise<Headers> {
  const res = await auth.api.signInEmail({ body: { email, password: "policy-test-password-1" }, returnHeaders: true });
  return cookie(res.headers);
}
async function createOrg(headers: Headers, slug: string): Promise<{ ok: boolean; id?: string }> {
  try {
    const org = await auth.api.createOrganization({ headers, body: { name: slug, slug } });
    return { ok: Boolean(org?.id), id: org?.id };
  } catch {
    return { ok: false };
  }
}

const [existing] = await db.select({ id: users.id }).from(users).limit(1);
if (existing) {
  console.error("This database already has users; run against a fresh `bun run db:setup` database.");
  process.exit(2);
}

// ---- default: closed ------------------------------------------------------
delete process.env.AUTH_SIGNUP;
check("default: sign-up is invite-only when AUTH_SIGNUP is unset", signupMode() === "invite-only");
check("default: a fresh install still offers sign-up for its first account", await publicSignupAvailable());

// ---- invite-only ---------------------------------------------------------
process.env.AUTH_SIGNUP = "invite-only";
const stamp = Date.now();
const operator = `operator+${stamp}@example.com`;
check("invite-only: the first account can always be created", (await signUp(operator)).ok);
const operatorHeaders = await signIn(operator);
const firstOrg = await createOrg(operatorHeaders, `operator-org-${stamp}`);
check("invite-only: the first user can create the first organization", firstOrg.ok);

check("invite-only: once an account exists, the sign-in page stops offering sign-up", !(await publicSignupAvailable()));
const stranger = await signUp(`stranger+${stamp}@example.com`);
check("invite-only: an uninvited stranger cannot sign up", !stranger.ok, stranger.message.slice(0, 70));

const invitee = `invitee+${stamp}@example.com`;
const freshOperator = await signIn(operator);
await auth.api.createInvitation({ headers: freshOperator, body: { email: invitee, role: "member", organizationId: firstOrg.id! } });
check("invite-only: an invited address can sign up", (await signUp(invitee)).ok);
const inviteeOrg = await createOrg(await signIn(invitee), `invitee-org-${stamp}`);
check("invite-only: an invited member cannot create organizations", !inviteeOrg.ok);
const secondOperatorOrg = await createOrg(await signIn(operator), `operator-second-${stamp}`);
check("invite-only: the operator can create further organizations", secondOperatorOrg.ok);

// ---- operator ------------------------------------------------------------
// Operator access is an explicit grant (platform_operators), never a role: the
// first organization's owner is not an operator until the grant script names them.
await auth.api.setActiveOrganization({ headers: await signIn(operator), body: { organizationId: firstOrg.id! } });
const operatorCtx = await requireOrgContext({ headers: await signIn(operator) });
check(
  "fresh install: the first organization's owner is NOT a platform operator before a grant",
  operatorCtx.organizationId === firstOrg.id && !(await isPlatformOperator(operatorCtx)),
);
const grantScript = (args: string[]) => {
  const run = Bun.spawnSync(["bun", "scripts/grant-platform-operator.ts", ...args], { env: process.env, stdout: "pipe", stderr: "pipe" });
  return { code: run.exitCode, out: `${run.stdout.toString()}${run.stderr.toString()}`.trim() };
};
const granted = grantScript(["--email", operator, "--note", "auth-policies e2e"]);
check("grant script: names an existing account and grants it", granted.code === 0 && /Granted/.test(granted.out), granted.out);
check("after the grant: that person is a platform operator, whatever organization is active", await isPlatformOperator(operatorCtx));
check("grant script: granting twice changes nothing", /already/.test(grantScript(["--email", operator]).out));
const unknown = grantScript(["--email", `nobody+${stamp}@example.com`]);
check("grant script: refuses an address with no account", unknown.code !== 0, unknown.out);
const inviteeCtxUser = await db.select({ id: users.id }).from(users).where(eq(users.email, invitee)).limit(1);
check(
  "a member of the first organization is not an operator without a grant",
  !(await isPlatformOperator({ userId: inviteeCtxUser[0]!.id })),
);
const revoked = grantScript(["--email", operator, "--revoke"]);
check("grant script: --revoke removes the grant", revoked.code === 0 && !(await isPlatformOperator(operatorCtx)), revoked.out);
grantScript(["--email", operator]);

// ---- open ----------------------------------------------------------------
process.env.AUTH_SIGNUP = "open";
const walkIn = `walk-in+${stamp}@example.com`;
check("open: anyone can sign up", (await signUp(walkIn)).ok);
check("open: anyone can create an organization", (await createOrg(await signIn(walkIn), `walk-in-org-${stamp}`)).ok);
const [walkInUser] = await db.select({ id: users.id }).from(users).where(eq(users.email, walkIn)).limit(1);
check("open: the owner of a workspace they created is not a platform operator", !(await isPlatformOperator({ userId: walkInUser!.id })));

console.log(failures ? `\n✗ ${failures} failure(s)` : "\n✓ all auth policy checks pass");
process.exit(failures ? 1 : 0);

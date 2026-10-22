/**
 * The operator panel's routes end to end, through Better Auth sessions and
 * the route handlers themselves, against the local database. Providers are
 * stand-ins (fetch intercepted for *.platform.test and api.anthropic.com;
 * nothing leaves the machine).
 *
 * - Every /api/platform route answers 404 to a customer organization's
 *   owner, admin and member, and 401 to a visitor without a session; only a
 *   person granted by scripts/grant-platform-operator.ts gets through.
 * - No response carries a stored secret, to the operator either: masked
 *   hints only.
 * - A state-changing operator call from another origin is refused.
 * - Store, replace (a blank secret keeps the stored one) and remove work; an
 *   Included AI engine whose key is not stored is refused.
 * - Adopting copies one named organization's own key and leaves its own
 *   rows and choice exactly as they were.
 * - A customer's own settings read "Included", never the platform's key.
 *
 *   bun run --conditions=react-server scripts/e2e/platform-admin.ts
 *
 * Needs the managed-saas migration. Creates its own users and
 * organizations, removes the platform credentials and the operator grant it
 * made, and refuses a non-local DATABASE_URL.
 */
import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}
process.env.BETTER_AUTH_SECRET ||= "platform-admin-test-secret-platform-admin-test";
process.env.BETTER_AUTH_URL ||= "http://localhost:3000";
process.env.AUTH_SIGNUP = "open";
const ORIGIN = new URL(process.env.BETTER_AUTH_URL).origin;

const stamp = Date.now();
const PLATFORM_TAVILY = `tvly-platform-admin-${stamp}`;
const OWN_TAVILY = `tvly-owner-own-${stamp}`;
const ANTHROPIC = `sk-ant-platform-admin-${stamp}`;
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "api.anthropic.com") return json(200, { data: [], has_more: false, first_id: null, last_id: null });
  if (url.hostname === "tavily.platform.test") return json(200, { account: { plan: "free" } });
  return realFetch(input, init);
}) as typeof fetch;

const { db } = await import("@/lib/db");
const { auth } = await import("@/lib/auth/server");
const { members, users } = await import("@/lib/auth/schema");
const { tavilySettings } = await import("@/lib/tavily/schema");
const { platformCredentials, providerCredentialModes } = await import("@/lib/managed/schema");
const { setTavilyApiBase } = await import("@/services/tavily");
const { runInOrganization } = await import("@/lib/tenancy/scope");
const { saveTavilySettings } = await import("@/lib/tavily/tavily.server");
const { setFeature } = await import("@/lib/features/flags.server");
const store = await import("@/lib/managed/store.server");
const credentialsRoute = await import("@/app/api/platform/credentials/route");
const credentialRoute = await import("@/app/api/platform/credentials/[key]/route");
const aiRoute = await import("@/app/api/platform/ai/route");
const usageRoute = await import("@/app/api/platform/usage/route");
const adoptRoute = await import("@/app/api/platform/adopt/route");
const tavilySettingsRoute = await import("@/app/api/settings/tavily/route");
setTavilyApiBase("https://tavily.platform.test");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const cookie = (headers: Headers) => new Headers({ cookie: headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") });
async function account(label: string): Promise<{ email: string; id: string }> {
  const email = `${label}+${stamp}@platform-admin.test`;
  await auth.api.signUpEmail({ body: { name: label, email, password: "platform-admin-password-1" } }).catch(() => undefined);
  const [row] = await db.update(users).set({ emailVerified: true }).where(eq(users.email, email)).returning({ id: users.id });
  if (!row) throw new Error(`could not create ${label}`);
  return { email, id: row.id };
}
async function session(email: string, organizationId?: string): Promise<Headers> {
  const signed = await auth.api.signInEmail({ body: { email, password: "platform-admin-password-1" }, returnHeaders: true });
  const headers = cookie(signed.headers);
  if (organizationId) {
    const active = await auth.api.setActiveOrganization({ headers, body: { organizationId }, returnHeaders: true });
    // The answer's cookies (the session cache with the new active organization) replace the ones of the same name.
    const jar = new Map<string, string>();
    for (const part of [...(headers.get("cookie") ?? "").split("; "), ...active.headers.getSetCookie().map((c) => c.split(";")[0]!)]) {
      const at = part.indexOf("=");
      if (at > 0) jar.set(part.slice(0, at), part);
    }
    return new Headers({ cookie: [...jar.values()].join("; ") });
  }
  return headers;
}

type Reply = { status: number; text: string; body: Record<string, unknown> | null };
async function send(handler: (request: never, context: never) => Promise<Response>, path: string, options: { method?: string; headers?: Headers; body?: unknown; origin?: string | null; key?: string } = {}): Promise<Reply> {
  const headers = new Headers(options.headers ?? {});
  const method = options.method ?? "GET";
  if (method !== "GET") {
    if (options.origin !== null) headers.set("origin", options.origin ?? ORIGIN);
    headers.set("content-type", "application/json");
  }
  const request = new NextRequest(`${ORIGIN}${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const response = await handler(request as never, { params: Promise.resolve({ key: options.key ?? "" }) } as never);
  const text = await response.text();
  let body: Record<string, unknown> | null = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: response.status, text, body };
}

const routes: { label: string; run: (headers?: Headers) => Promise<Reply> }[] = [
  { label: "GET credentials", run: (h) => send(credentialsRoute.GET as never, "/api/platform/credentials", { headers: h }) },
  { label: "PUT credentials/tavily", run: (h) => send(credentialRoute.PUT as never, "/api/platform/credentials/tavily", { method: "PUT", headers: h, body: { apiKey: `tvly-forged-${stamp}` }, key: "tavily" }) },
  { label: "DELETE credentials/tavily", run: (h) => send(credentialRoute.DELETE as never, "/api/platform/credentials/tavily", { method: "DELETE", headers: h, key: "tavily" }) },
  { label: "PUT ai", run: (h) => send(aiRoute.PUT as never, "/api/platform/ai", { method: "PUT", headers: h, body: { engine: null } }) },
  { label: "GET usage", run: (h) => send(usageRoute.GET as never, "/api/platform/usage", { headers: h }) },
  { label: "GET adopt", run: (h) => send(adoptRoute.GET as never, "/api/platform/adopt", { headers: h }) },
  { label: "POST adopt", run: (h) => send(adoptRoute.POST as never, "/api/platform/adopt", { method: "POST", headers: h, body: { organizationId: "00000000-0000-0000-0000-000000000000", keys: ["tavily"] } }) },
];

const operator = await account("operator");
const owner = await account("owner");
const admin = await account("admin");
const member = await account("member");
const ownerHeaders = await session(owner.email);
const org = await auth.api.createOrganization({ headers: ownerHeaders, body: { name: `Platform admin check ${stamp}`, slug: `platform-admin-check-${stamp}` } });
await db.insert(members).values([{ organizationId: org!.id, userId: admin.id, role: "admin" }, { organizationId: org!.id, userId: member.id, role: "member" }]);
const fresh = await auth.api.createOrganization({ headers: await session(owner.email), body: { name: `Platform admin fresh ${stamp}`, slug: `platform-admin-fresh-${stamp}` } });
const grant = (args: string[]) => Bun.spawnSync(["bun", "scripts/grant-platform-operator.ts", ...args], { env: process.env, stdout: "pipe", stderr: "pipe" });

try {
  // ------------------------------------------------------------ customers and visitors
  for (const [role, person] of [["owner", owner], ["admin", admin], ["member", member]] as const) {
    const headers = await session(person.email, org!.id);
    for (const route of routes) {
      const reply = await route.run(headers);
      check(`a customer ${role}: ${route.label} is 404`, reply.status === 404, `${reply.status} ${reply.text.slice(0, 80)}`);
    }
  }
  for (const route of routes) {
    const reply = await route.run(new Headers());
    check(`no session: ${route.label} is 401`, reply.status === 401, String(reply.status));
  }
  check("nothing a customer sent was stored", (await db.select().from(platformCredentials)).every((row) => row.provider !== "tavily"));

  // ------------------------------------------------------------ the operator
  check("the grant script names the operator", grant(["--email", operator.email]).exitCode === 0);
  const op = await session(operator.email);
  const listed = await send(credentialsRoute.GET as never, "/api/platform/credentials", { headers: op });
  check("the operator reads the panel", listed.status === 200 && Array.isArray(listed.body?.credentials));
  const crossSite = await send(credentialRoute.PUT as never, "/api/platform/credentials/tavily", { method: "PUT", headers: op, body: { apiKey: PLATFORM_TAVILY }, key: "tavily", origin: "https://evil.example" });
  check("a state-changing call from another origin is refused", crossSite.status === 403);
  const stored = await send(credentialRoute.PUT as never, "/api/platform/credentials/tavily", { method: "PUT", headers: op, body: { apiKey: PLATFORM_TAVILY }, key: "tavily" });
  check("the operator stores a default key, answered with a masked hint", stored.status === 200 && (stored.body as { hints?: Record<string, string> })?.hints?.apiKey === `…${PLATFORM_TAVILY.slice(-4)}`, stored.text.slice(0, 120));
  check("…the key never appears in the answer", !stored.text.includes(PLATFORM_TAVILY));
  const replaced = await send(credentialRoute.PUT as never, "/api/platform/credentials/tavily", { method: "PUT", headers: op, body: { apiKey: "" }, key: "tavily" });
  check("replacing with the secret left blank keeps the stored one", replaced.status === 200 && (await store.getPlatformCredential("tavily"))?.apiKey === PLATFORM_TAVILY);
  const listedAgain = await send(credentialsRoute.GET as never, "/api/platform/credentials", { headers: op });
  check("no operator response carries a stored secret", !listedAgain.text.includes(PLATFORM_TAVILY));
  const [row] = await db.select().from(platformCredentials).where(eq(platformCredentials.provider, "tavily"));
  check("it is stored encrypted, with a fingerprint, not the key", Boolean(row) && !row!.encryptedPayload.includes(PLATFORM_TAVILY) && !JSON.stringify(row!.config).includes(PLATFORM_TAVILY) && !row!.fingerprint.includes(PLATFORM_TAVILY));
  const noKey = await send(aiRoute.PUT as never, "/api/platform/ai", { method: "PUT", headers: op, body: { engine: "anthropic", defaultModel: { provider: "anthropic", modelId: "claude-haiku-5-5" } } });
  check("an Included AI engine whose key is not stored is refused", noKey.status === 400 && /Store the Anthropic/.test(String(noKey.body?.error)), noKey.text.slice(0, 120));
  const anthropic = await send(credentialRoute.PUT as never, "/api/platform/credentials/anthropic", { method: "PUT", headers: op, body: { apiKey: ANTHROPIC }, key: "anthropic" });
  const engine = await send(aiRoute.PUT as never, "/api/platform/ai", { method: "PUT", headers: op, body: { engine: "anthropic", defaultModel: { provider: "anthropic", modelId: "claude-haiku-5-5" } } });
  check("with the Anthropic key stored, Claude becomes the Included engine", anthropic.status === 200 && engine.status === 200 && (await store.getManagedAiSettings()).engine === "anthropic");
  const pilot = await send(aiRoute.PUT as never, "/api/platform/ai", { method: "PUT", headers: op, body: { engine: "claude_code", defaultModel: { provider: "claude_code", modelId: "sonnet" } } });
  check("the Claude Code subscription login cannot be chosen as the Included engine", pilot.status === 200 && (await store.getManagedAiSettings()).engine === null);
  const usage = await send(usageRoute.GET as never, "/api/platform/usage?month=2026-10", { headers: op });
  check("the operator reads use by workspace and the platform budgets", usage.status === 200 && Array.isArray(usage.body?.rows) && Array.isArray(usage.body?.budgets));

  // ------------------------------------------------------------ adopting one organization's own key
  await runInOrganization(org!.id, async () => {
    await setFeature("web_discovery", true, owner.id).catch(() => undefined);
    await saveTavilySettings({ key: OWN_TAVILY }, owner.id);
  });
  const [before] = await db.select().from(tavilySettings).where(eq(tavilySettings.organizationId, org!.id));
  const sources = await send(adoptRoute.GET as never, "/api/platform/adopt", { headers: op });
  const listedSource = (sources.body?.sources as { organizationId: string; available: string[] }[] | undefined)?.find((s) => s.organizationId === org!.id);
  check("the organizations to adopt from are listed with their providers, no secret", Boolean(listedSource?.available.includes("tavily")) && !sources.text.includes(OWN_TAVILY));
  const unknown = await send(adoptRoute.POST as never, "/api/platform/adopt", { method: "POST", headers: op, body: { organizationId: "00000000-0000-0000-0000-000000000000", keys: ["tavily"] } });
  check("adopting from an organization that does not exist is 404", unknown.status === 404);
  const adopted = await send(adoptRoute.POST as never, "/api/platform/adopt", { method: "POST", headers: op, body: { organizationId: org!.id, keys: ["tavily"] } });
  check("adopting copies that organization's own key into the defaults", adopted.status === 200 && (adopted.body?.adopted as string[] | undefined)?.includes("tavily") === true && (await store.getPlatformCredential("tavily"))?.apiKey === OWN_TAVILY, adopted.text.slice(0, 160));
  const [after] = await db.select().from(tavilySettings).where(eq(tavilySettings.organizationId, org!.id));
  const [mode] = await db.select().from(providerCredentialModes).where(and(eq(providerCredentialModes.organizationId, org!.id), eq(providerCredentialModes.service, "tavily")));
  check("…its own row and its choice stay exactly as they were", after?.encryptedKey === before?.encryptedKey && mode?.mode === "own");
  const status = (await store.listPlatformCredentialStatus()).find((s) => s.key === "tavily");
  check("…and the default records where it came from", status?.adoptedFrom?.organizationId === org!.id);

  // ------------------------------------------------------------ what a customer on the Included service reads
  await runInOrganization(fresh!.id, () => setFeature("web_discovery", true, owner.id).catch(() => undefined));
  const customer = await send(tavilySettingsRoute.GET as never, "/api/settings/tavily", { headers: await session(owner.email, fresh!.id) });
  check("an Included workspace's settings say Included and never carry the platform's key", customer.status === 200 && (customer.body?.settings as { included?: boolean })?.included === true && !customer.text.includes(OWN_TAVILY) && !customer.text.includes(OWN_TAVILY.slice(-4)));

  const removed = await send(credentialRoute.DELETE as never, "/api/platform/credentials/tavily", { method: "DELETE", headers: op, key: "tavily" });
  check("the operator removes a default key", removed.status === 200 && !(await store.getPlatformCredential("tavily")));
} finally {
  for (const key of ["tavily", "anthropic"] as const) await store.removePlatformCredential(key);
  await store.saveManagedAiSettings({ engine: null }, null);
  grant(["--email", operator.email, "--revoke"]);
}

console.log(failures ? `\n✗ ${failures} failure(s)` : "\n✓ all platform admin checks pass");
process.exit(failures ? 1 : 0);

/**
 * Unipile accounts on the Included service, end to end against the local
 * database: one platform Unipile shared by every Included workspace, each
 * workspace seeing and using only the accounts it owns.
 *
 * Unipile's API is a stand-in (global fetch intercepted for one fake host;
 * nothing leaves the machine). The routes run in-process through real Better
 * Auth sessions; Unipile's notify_url calls are made the way Unipile would.
 *
 * - A connection link is minted by the server for the signed-in workspace:
 *   its `name` is an opaque state id and its notify_url carries a secret
 *   token the browser never sees.
 * - A forged callback (wrong token, wrong name, wrong status), another
 *   workspace's state naming the account, an old unowned account, a wrong
 *   account type and an expired link claim nothing.
 * - Syncs keep only owned accounts; an unowned account is never adopted by
 *   whichever workspace syncs first, on the Included Unipile or on an own key
 *   that is the platform's.
 * - A call naming another workspace's account (send, read, delete, LinkedIn
 *   search) is refused before anything reaches Unipile.
 * - Reconnect and disconnect go by the workspace's own row ids; another
 *   workspace's are 404; a released account is never anyone else's.
 * - Webhooks on the platform's registration reach only the owning workspace.
 * - The connected-account allowance holds under truly parallel callbacks, in
 *   one workspace and across two (the platform budget).
 * - The migration's backfill is idempotent and reports conflicts.
 * - Routes as owner, admin, member and platform operator.
 *
 *   bun run --conditions=react-server scripts/e2e/unipile-ownership.ts
 *
 * Needs the managed-saas migration. Creates its own users and
 * organizations (left behind), restores the platform's Unipile credential as
 * it found it, and refuses a non-local DATABASE_URL.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq } from "drizzle-orm";
import type { NextRequest as NextRequestType } from "next/server";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}
process.env.BETTER_AUTH_SECRET ||= "unipile-ownership-test-secret-unipile-ownership";
// A public origin: on the Included Unipile a connection is confirmed by Unipile calling it.
process.env.BETTER_AUTH_URL = "https://app.unipile-ownership.test";
process.env.AUTH_SIGNUP = "open";
const ORIGIN = new URL(process.env.BETTER_AUTH_URL).origin;

// ------------------------------------------------------------ fake Unipile
const FAKE = "https://unipile-ownership.test";
const stamp = Date.now().toString(36);
const PLATFORM_KEY = `platform-key-${stamp}`;
const OWN_KEY_C = `own-key-c-${stamp}`;

type FakeAccount = Record<string, unknown> & { id: string; type: string };
type Recorded = { method: string; path: string; apiKey: string; json: Record<string, unknown> | null; form: Record<string, string>; query: Record<string, string> };
const requests: Recorded[] = [];
/** What the platform's key lists (every Included workspace's accounts, and strays). */
const platformAccounts: FakeAccount[] = [];
/** What an own key lists. */
const ownAccounts = new Map<string, FakeAccount[]>([[OWN_KEY_C, []]]);
const links: { apiKey: string; body: Record<string, unknown> }[] = [];
const webhooks: { id: string; apiKey: string; body: Record<string, unknown> }[] = [];

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const visible = (apiKey: string) => (apiKey === PLATFORM_KEY ? platformAccounts : ownAccounts.get(apiKey) ?? null);

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== FAKE) return realFetch(input, init);
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  const apiKey = headers.get("x-api-key") ?? "";
  let body: Record<string, unknown> | null = null;
  if (typeof init?.body === "string") {
    try { body = JSON.parse(init.body) as Record<string, unknown>; } catch { body = null; }
  }
  const form: Record<string, string> = {};
  if (init?.body instanceof FormData) for (const [key, value] of init.body.entries()) form[key] = String(value);
  const path = url.pathname.replace(/^\/api\/v1/, "");
  requests.push({ method, path, apiKey, json: body, form, query: Object.fromEntries(url.searchParams) });
  const list = visible(apiKey);
  if (!list) return json(401, { status: 401, type: "errors/invalid_credentials", title: "Invalid credentials" });

  if (method === "GET" && path === "/accounts") return json(200, { object: "AccountList", items: list, cursor: null });
  const one = path.match(/^\/accounts\/([^/]+)$/);
  if (one) {
    const account = list.find((candidate) => candidate.id === decodeURIComponent(one[1]!));
    if (!account) return json(404, { status: 404, type: "errors/resource_not_found", title: "Resource not found." });
    if (method === "GET") return json(200, account);
    if (method === "DELETE") {
      list.splice(list.indexOf(account), 1);
      return json(200, { object: "AccountDeleted" });
    }
  }
  if (method === "POST" && path === "/hosted/accounts/link") {
    links.push({ apiKey, body: body ?? {} });
    return json(201, { object: "HostedAuthURL", url: `https://account.unipile.test/link/${links.length}` });
  }
  if (path === "/webhooks" && method === "GET") {
    return json(200, { object: "WebhookList", items: webhooks.filter((hook) => hook.apiKey === apiKey).map((hook) => ({ id: hook.id, request_url: hook.body.request_url })), cursor: null });
  }
  if (path === "/webhooks" && method === "POST") {
    const id = `wh-${stamp}-${webhooks.length + 1}`;
    webhooks.push({ id, apiKey, body: body ?? {} });
    return json(201, { object: "WebhookCreated", webhook_id: id });
  }
  const hook = path.match(/^\/webhooks\/([^/]+)$/);
  if (hook && method === "DELETE") {
    const at = webhooks.findIndex((candidate) => candidate.id === decodeURIComponent(hook[1]!));
    if (at >= 0) webhooks.splice(at, 1);
    return json(200, { object: "WebhookDeleted" });
  }
  if (method === "POST" && path === "/chats") return json(201, { object: "ChatStarted", chat_id: `chat-${stamp}-${requests.length}`, message_id: `msg-${stamp}-${requests.length}` });
  if (method === "GET" && (path === "/chats" || path.startsWith("/chats/"))) return json(200, { object: "ChatList", items: [], cursor: null });
  if (method === "POST" && path === "/linkedin/search") return json(200, { object: "LinkedinSearch", items: [], cursor: null });
  return json(404, { status: 404, title: `No fake for ${method} ${path}` });
}) as typeof fetch;

const whatsapp = (id: string, phone: string, createdAt = new Date()): FakeAccount => ({
  object: "Account", type: "WHATSAPP", id, name: phone, created_at: createdAt.toISOString(),
  connection_params: { im: { id: phone.replace("+", ""), phone_number: phone } }, sources: [{ id: `s-${id}`, status: "OK" }],
});
const linkedin = (id: string, username: string, createdAt = new Date()): FakeAccount => ({
  object: "Account", type: "LINKEDIN", id, name: `Rep ${username}`, created_at: createdAt.toISOString(),
  connection_params: { im: { id: `li-${username}`, publicIdentifier: username, username } }, sources: [{ id: `s-${id}`, status: "OK" }],
});

// ------------------------------------------------------------ app modules
// What Next's server does at boot: its request stores, after() among them, are built on the global AsyncLocalStorage.
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;
const { NextRequest } = await import("next/server");
const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external");
const { db } = await import("@/lib/db");
const { auth } = await import("@/lib/auth/server");
const { members, organizations, users } = await import("@/lib/auth/schema");
const { gridProviderCredentials, gridProviders } = await import("@/lib/grid/schema");
const { encryptIntegrationCredentials } = await import("@/lib/integrations/credentials");
const { runInOrganization, currentOrganizationId } = await import("@/lib/tenancy/scope");
const { platformCredentials, platformOperators } = await import("@/lib/managed/schema");
const store = await import("@/lib/managed/store.server");
const { verifyPlatformCredential } = await import("@/lib/managed/verify.server");
const hooks = await import("@/lib/managed/hooks.server");
const { setAllowanceOverridesForTests, allowanceUsed } = await import("@/lib/managed/usage.server");
const { platformCredentialSource } = await import("@/lib/platform/credentials");
const { whatsappAccounts } = await import("@/lib/whatsapp/schema");
const { linkedInAccounts, webhookEvents } = await import("@/lib/linkedin/schema");
const { syncWhatsappAccounts } = await import("@/lib/whatsapp/accounts");
const { unipileAccountOwners, unipileConnectStates } = await import("@/lib/unipile/schema");
const ownership = await import("@/lib/unipile/ownership.server");
const { startConnection, UnipileConnectError } = await import("@/lib/unipile/connect.server");
const { unipileAccountIdForRow, disconnectUnipileAccount } = await import("@/lib/unipile/accounts.server");
const { getUnipileClient, searchLinkedIn } = await import("@/services/unipile.service");
const { startUnipileWhatsappChat } = await import("@/services/unipile.whatsapp");
const { unipileOrganizationIds, gateUnipileWebhook } = await import("@/lib/linkedin/organizations.server");
const { MANAGED_WEBHOOK_ORG } = await import("@/lib/platform/unipileWebhooks");
const connectRoute = await import("@/app/api/unipile/connect/route");
const disconnectRoute = await import("@/app/api/unipile/accounts/disconnect/route");
const linkedinHostedAuthRoute = await import("@/app/api/linkedin/accounts/hosted-auth/route");
const { POST: unipileAccountWebhook } = await import("@/app/api/webhooks/unipile-account/route");
const { POST: unipileMessageWebhook } = await import("@/app/api/webhooks/unipile-message/route");
const { POST: linkedinMessageWebhook } = await import("@/app/api/webhooks/message-received/route");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// ------------------------------------------------------------ sessions and routes
const cookie = (headers: Headers) => new Headers({ cookie: headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") });
async function person(label: string): Promise<{ email: string; id: string }> {
  const email = `${label}+${stamp}@unipile-ownership.test`;
  await auth.api.signUpEmail({ body: { name: label, email, password: "unipile-ownership-password-1" } }).catch(() => undefined);
  const [row] = await db.update(users).set({ emailVerified: true }).where(eq(users.email, email)).returning({ id: users.id });
  if (!row) throw new Error(`could not create ${label}`);
  return { email, id: row.id };
}
async function session(email: string, organizationId?: string): Promise<Headers> {
  const signed = await auth.api.signInEmail({ body: { email, password: "unipile-ownership-password-1" }, returnHeaders: true });
  const headers = cookie(signed.headers);
  if (!organizationId) return headers;
  const active = await auth.api.setActiveOrganization({ headers, body: { organizationId }, returnHeaders: true });
  const jar = new Map<string, string>();
  for (const part of [...(headers.get("cookie") ?? "").split("; "), ...active.headers.getSetCookie().map((c) => c.split(";")[0]!)]) {
    const at = part.indexOf("=");
    if (at > 0) jar.set(part.slice(0, at), part);
  }
  return new Headers({ cookie: [...jar.values()].join("; ") });
}

type Reply = { status: number; text: string; body: Record<string, unknown> | null };
async function send(handler: (request: never) => Promise<Response>, path: string, options: { method?: string; headers?: Headers; body?: unknown; origin?: string | null } = {}): Promise<Reply> {
  const headers = new Headers(options.headers ?? {});
  const method = options.method ?? "GET";
  if (method !== "GET") {
    if (options.origin !== null) headers.set("origin", options.origin ?? ORIGIN);
    headers.set("content-type", "application/json");
  }
  const request = new NextRequest(`${ORIGIN}${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const response = await handler(request as never);
  const text = await response.text();
  let body: Record<string, unknown> | null = null;
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = null; }
  return { status: response.status, text, body };
}

/** A route as Next calls it: inside a request store whose after() collects the callbacks, run once it answered. */
async function callRoute(handler: (request: NextRequestType) => Promise<Response>, request: NextRequestType): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const pending: (() => unknown)[] = [];
  const work = { afterContext: { after: (task: unknown) => { pending.push(typeof task === "function" ? (task as () => unknown) : () => task); } } };
  const response = await workAsyncStorage.run(work as never, () => handler(request));
  for (const task of pending) await task();
  const text = await response.text();
  let body: Record<string, unknown> | null = null;
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = null; }
  return { status: response.status, body };
}

/** Unipile calling a link's notify_url. */
function confirm(notifyUrl: string, body: Record<string, unknown>) {
  return callRoute(unipileAccountWebhook, new NextRequest(notifyUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
}
function messageHook(query: string, secret: string | null, payload: Record<string, unknown>, handler = unipileMessageWebhook, path = "/api/webhooks/unipile-message") {
  return callRoute(handler, new NextRequest(`${ORIGIN}${path}${query}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(secret ? { "x-unipile-secret": secret } : {}) },
    body: JSON.stringify(payload),
  }));
}

/** The link the last mint sent Unipile: its state id (name) and its notify_url. */
function lastLink(): { name: string; notifyUrl: string; token: string; body: Record<string, unknown> } {
  const link = links.at(-1)!;
  const notifyUrl = String(link.body.notify_url ?? "");
  return { name: String(link.body.name ?? ""), notifyUrl, token: notifyUrl ? new URL(notifyUrl).searchParams.get("token") ?? "" : "", body: link.body };
}

async function mintIn(organizationId: string, userId: string, channel: "whatsapp" | "linkedin" = "whatsapp", reconnectAccountId: string | null = null) {
  await runInOrganization(organizationId, () => startConnection({ channel, userId, reconnectAccountId }));
  return lastLink();
}

const created = (name: string, accountId: string, status = "CREATION_SUCCESS") => ({ status, account_id: accountId, name });
const ownerOf = async (accountId: string) => (await db.select().from(unipileAccountOwners).where(eq(unipileAccountOwners.accountId, accountId)))[0] ?? null;
const stateOf = async (id: string) => (await db.select().from(unipileConnectStates).where(eq(unipileConnectStates.id, id)))[0] ?? null;
const rowsIn = (organizationId: string) => db.select().from(whatsappAccounts).where(eq(whatsappAccounts.organizationId, organizationId));

async function ownUnipile(organizationId: string, apiKey: string, notifySecret: string) {
  await runInOrganization(organizationId, async () => {
    const [provider] = await db.insert(gridProviders).values({ organizationId: currentOrganizationId(), key: "platform-unipile", name: "Unipile (ownership check)", config: { platformKey: "unipile", values: { baseUrl: FAKE }, secretsSet: ["apiKey", "notifySecret"], verifiedAt: new Date().toISOString() } }).returning();
    await db.insert(gridProviderCredentials).values({ providerId: provider!.id, encryptedPayload: encryptIntegrationCredentials({ baseUrl: FAKE, apiKey, notifySecret }) });
  });
}

// ------------------------------------------------------------ fixtures
const [savedPlatformUnipile] = await db.select().from(platformCredentials).where(eq(platformCredentials.provider, "unipile"));
const ownerA = await person("owner-a");
const adminA = await person("admin-a");
const memberA = await person("member-a");
const ownerB = await person("owner-b");
const operator = await person("operator");
const orgA = await auth.api.createOrganization({ headers: await session(ownerA.email), body: { name: `Unipile ownership A ${stamp}`, slug: `unipile-ownership-a-${stamp}` } });
const orgB = await auth.api.createOrganization({ headers: await session(ownerB.email), body: { name: `Unipile ownership B ${stamp}`, slug: `unipile-ownership-b-${stamp}` } });
const orgOp = await auth.api.createOrganization({ headers: await session(operator.email), body: { name: `Unipile ownership operator ${stamp}`, slug: `unipile-ownership-op-${stamp}` } });
await db.insert(members).values([{ organizationId: orgA!.id, userId: adminA.id, role: "admin" }, { organizationId: orgA!.id, userId: memberA.id, role: "member" }]);
const [orgC] = await db.insert(organizations).values({ name: `Unipile ownership C (own key) ${stamp}`, slug: `unipile-ownership-c-${stamp}` }).returning();
const [orgD] = await db.insert(organizations).values({ name: `Unipile ownership D (platform's key as own) ${stamp}`, slug: `unipile-ownership-d-${stamp}` }).returning();
await db.insert(platformOperators).values({ userId: operator.id, grantedBy: "e2e:unipile-ownership", note: "test" }).onConflictDoNothing();
const A = orgA!.id;
const B = orgB!.id;
const C = orgC!.id;
const D = orgD!.id;
const ownerAHeaders = await session(ownerA.email, A);
const adminAHeaders = await session(adminA.email, A);
const memberAHeaders = await session(memberA.email, A);
const ownerBHeaders = await session(ownerB.email, B);
const operatorHeaders = await session(operator.email, orgOp!.id);

const WA_A1 = `wa-a1-${stamp}`;
const WA_A2 = `wa-a2-${stamp}`;
const WA_A3 = `wa-a3-${stamp}`;
const WA_B1 = `wa-b1-${stamp}`;
const WA_B2 = `wa-b2-${stamp}`;
const WA_B3 = `wa-b3-${stamp}`;
const WA_OLD = `wa-old-${stamp}`;
const WC_1 = `wc-1-${stamp}`;
const WA_LEGACY = `wa-legacy-${stamp}`;
const LI_B = `li-b-${stamp}`;
const phone = (n: number) => `+1555${String(Date.now()).slice(-6)}${n}`;

try {
  // ------------------------------------------------------------ the platform's Unipile
  const status = await store.storePlatformCredential("unipile", { baseUrl: FAKE, apiKey: PLATFORM_KEY }, { userId: operator.id, verify: verifyPlatformCredential });
  const registration = await hooks.onPlatformCredentialStored("unipile");
  const platformSecret = (await store.getPlatformCredential("unipile"))!.notifySecret!;
  check("storing the platform's Unipile verifies it and keeps only a masked hint", status.stored && !JSON.stringify(status).includes(PLATFORM_KEY) && !JSON.stringify(status).includes(platformSecret));
  check("…and registers the platform's own webhooks once, at org=managed, with its generated secret",
    registration?.status === "registered"
      && webhooks.length >= 3
      && webhooks.every((hook) => hook.apiKey === PLATFORM_KEY && String(hook.body.request_url).startsWith(ORIGIN) && new URL(String(hook.body.request_url)).searchParams.get("org") === MANAGED_WEBHOOK_ORG)
      && webhooks.every((hook) => JSON.stringify(hook.body.headers).includes(platformSecret)),
    JSON.stringify(webhooks.map((hook) => hook.body.request_url)));
  const listed = (await store.listPlatformCredentialStatus()).find((entry) => entry.key === "unipile");
  check("the panel shows the webhook registration, not the secret", listed?.webhooks?.status === "registered" && !JSON.stringify(listed).includes(platformSecret));

  await ownUnipile(C, OWN_KEY_C, `own-secret-c-${stamp}`);
  await ownUnipile(D, PLATFORM_KEY, `own-secret-d-${stamp}`);
  check("A and B (nothing saved) are on the Included Unipile; C and D on their own",
    (await runInOrganization(A, () => platformCredentialSource("unipile"))) === "managed"
      && (await runInOrganization(B, () => platformCredentialSource("unipile"))) === "managed"
      && (await runInOrganization(C, () => platformCredentialSource("unipile"))) === "own"
      && (await runInOrganization(D, () => platformCredentialSource("unipile"))) === "own");

  // ------------------------------------------------------------ minting a link
  const noSession = await send(connectRoute.POST as never, "/api/unipile/connect", { method: "POST", body: { channel: "whatsapp" } });
  check("connect without a session is 401", noSession.status === 401, String(noSession.status));
  const crossOrigin = await send(connectRoute.POST as never, "/api/unipile/connect", { method: "POST", headers: ownerAHeaders, body: { channel: "whatsapp" }, origin: "https://evil.example" });
  check("connect from another origin is 403", crossOrigin.status === 403, String(crossOrigin.status));
  const linksBefore = links.length;
  const memberInstagram = await send(connectRoute.POST as never, "/api/unipile/connect", { method: "POST", headers: memberAHeaders, body: { channel: "instagram" } });
  const memberEmail = await send(connectRoute.POST as never, "/api/unipile/connect", { method: "POST", headers: memberAHeaders, body: { channel: "email" } });
  check("a member cannot connect the workspace's Instagram or email (403), and no link is minted", memberInstagram.status === 403 && memberEmail.status === 403 && links.length === linksBefore, `${memberInstagram.status} ${memberEmail.status}`);
  const adminEmail = await send(connectRoute.POST as never, "/api/unipile/connect", { method: "POST", headers: adminAHeaders, body: { channel: "email" } });
  check("an admin can connect an email inbox", adminEmail.status === 200 && lastLink().body.providers === "*:MAILING", `${adminEmail.status} ${JSON.stringify(lastLink().body.providers)}`);
  const memberWa = await send(connectRoute.POST as never, "/api/unipile/connect", { method: "POST", headers: memberAHeaders, body: { channel: "whatsapp" } });
  check("a member can connect their own WhatsApp number", memberWa.status === 200 && typeof memberWa.body?.url === "string", String(memberWa.status));

  const started = await send(connectRoute.POST as never, "/api/unipile/connect", { method: "POST", headers: ownerAHeaders, body: { channel: "whatsapp" } });
  const linkA1 = lastLink();
  check("the owner gets Unipile's link and the connection id", started.status === 200 && started.body?.url === `https://account.unipile.test/link/${links.length}` && started.body?.connection === linkA1.name, started.text);
  check("the link's name is the opaque state id, and it was minted with the platform's key", links.at(-1)!.apiKey === PLATFORM_KEY && /^[0-9a-f-]{36}$/.test(linkA1.name) && !linkA1.name.includes(A));
  check("its notify_url is this app's public callback with the state and a secret token",
    linkA1.notifyUrl.startsWith(`${ORIGIN}/api/webhooks/unipile-account?state=${linkA1.name}&token=`) && linkA1.token.length >= 40);
  check("the browser's answer never carries the token", !started.text.includes(linkA1.token));
  check("the link opens on WhatsApp only, and returns to the WhatsApp page", JSON.stringify(linkA1.body.providers) === JSON.stringify(["WHATSAPP"]) && String(linkA1.body.success_redirect_url).startsWith(`${ORIGIN}/settings/whatsapp-accounts?unipile=success&connection=${linkA1.name}`));
  const stored = await stateOf(linkA1.name);
  check("the state stores only the token's hash", stored?.status === "pending" && stored.organizationId === A && stored.tokenHash !== linkA1.token && !JSON.stringify(stored).includes(linkA1.token));

  const managedClient = await runInOrganization(A, () => getUnipileClient());
  const directLink = await managedClient.account.createHostedAuthLink({ type: "create", providers: ["WHATSAPP"], api_url: FAKE, expiresOn: new Date(Date.now() + 60_000).toISOString() } as never).then(() => "sent", (error: unknown) => (error instanceof Error ? error.message : "refused"));
  check("on the Included Unipile, nothing mints a link outside the verified flow", directLink !== "sent", directLink);

  // ------------------------------------------------------------ forged callbacks
  platformAccounts.push(whatsapp(WA_A1, phone(1)));
  const tamperedToken = `${linkA1.token.slice(0, -2)}xx`;
  const forgedToken = await confirm(linkA1.notifyUrl.replace(linkA1.token, tamperedToken), created(linkA1.name, WA_A1));
  check("a callback with the wrong token is 401 and claims nothing", forgedToken.status === 401 && !(await ownerOf(WA_A1)), String(forgedToken.status));
  const noToken = await confirm(`${ORIGIN}/api/webhooks/unipile-account?state=${linkA1.name}`, created(linkA1.name, WA_A1));
  check("…without a token, 401", noToken.status === 401);
  const wrongName = await confirm(linkA1.notifyUrl, created("someone-else", WA_A1));
  check("…naming another connection in its body, 401", wrongName.status === 401);
  const failedStatus = await confirm(linkA1.notifyUrl, created(linkA1.name, WA_A1, "CREATION_FAILED"));
  check("…reporting a failed sign-in, 401", failedStatus.status === 401 && (await stateOf(linkA1.name))?.status === "pending");

  // ------------------------------------------------------------ the verified callback
  const confirmed = await confirm(linkA1.notifyUrl, created(linkA1.name, WA_A1));
  const ownerA1 = await ownerOf(WA_A1);
  check("Unipile's callback claims the new account for A", confirmed.status === 200 && confirmed.body?.claimed === true && ownerA1?.organizationId === A && ownerA1.credentialSource === "managed" && ownerA1.claimedVia === "hosted_auth" && ownerA1.claimedBy === ownerA.id, JSON.stringify(confirmed.body));
  const rowsA = await rowsIn(A);
  check("…and A's sync then shows the number", rowsA.length === 1 && rowsA[0]!.unipileAccountId === WA_A1, JSON.stringify(rowsA.map((row) => row.unipileAccountId)));
  const repeat = await confirm(linkA1.notifyUrl, created(linkA1.name, WA_A1));
  check("a repeated callback is answered the same and changes nothing", repeat.status === 200 && repeat.body?.claimed === true && (await db.select().from(unipileAccountOwners).where(eq(unipileAccountOwners.accountId, WA_A1))).length === 1);
  const statusA = await send(connectRoute.GET as never, `/api/unipile/connect?connection=${linkA1.name}`, { headers: memberAHeaders });
  check("A's members see how the connection ended", statusA.status === 200 && statusA.body?.status === "claimed", statusA.text);
  const statusB = await send(connectRoute.GET as never, `/api/unipile/connect?connection=${linkA1.name}`, { headers: ownerBHeaders });
  const statusOp = await send(connectRoute.GET as never, `/api/unipile/connect?connection=${linkA1.name}`, { headers: operatorHeaders });
  check("another workspace's owner, and a platform operator outside A, get 404 for it", statusB.status === 404 && statusOp.status === 404, `${statusB.status} ${statusOp.status}`);

  // ------------------------------------------------------------ syncs keep only owned accounts
  platformAccounts.push(whatsapp(WA_OLD, phone(9), new Date(Date.now() - 2 * 86_400_000)));
  await runInOrganization(B, () => syncWhatsappAccounts());
  await runInOrganization(A, () => syncWhatsappAccounts());
  await runInOrganization(D, () => syncWhatsappAccounts());
  check("B's sync on the same platform key lists A's number and an unowned one, and keeps neither", (await rowsIn(B)).length === 0);
  check("A's sync keeps its own number only", (await rowsIn(A)).map((row) => row.unipileAccountId).join() === WA_A1);
  check("D, whose own key is the platform's, adopts nothing", (await rowsIn(D)).length === 0 && !(await ownerOf(WA_OLD)));
  check("an unowned account is never adopted by whoever syncs first", !(await ownerOf(WA_OLD)));

  // ------------------------------------------------------------ claims that must fail
  const linkB1 = await mintIn(B, ownerB.id);
  const stolen = await confirm(linkB1.notifyUrl, created(linkB1.name, WA_A1));
  check("B's own valid link naming A's account is refused, and A keeps it", stolen.status === 200 && stolen.body?.claimed === false && (await ownerOf(WA_A1))?.organizationId === A && (await stateOf(linkB1.name))?.status === "rejected", JSON.stringify(stolen.body));
  const stolenAgain = await confirm(linkB1.notifyUrl, created(linkB1.name, WA_A2));
  check("…and a refused link cannot be used again for another account", stolenAgain.body?.claimed === false && !(await ownerOf(WA_A2)));
  const linkB2 = await mintIn(B, ownerB.id);
  const old = await confirm(linkB2.notifyUrl, created(linkB2.name, WA_OLD));
  check("an old unowned account is refused (not created by this connection)", old.body?.claimed === false && String(old.body?.reason).includes("not created by this connection") && !(await ownerOf(WA_OLD)), JSON.stringify(old.body));
  const linkB3 = await mintIn(B, ownerB.id);
  platformAccounts.push(linkedin(`li-new-${stamp}`, `rep-${stamp}`));
  const wrongType = await confirm(linkB3.notifyUrl, created(linkB3.name, `li-new-${stamp}`));
  check("an account of another channel is refused", wrongType.body?.claimed === false && String(wrongType.body?.reason).includes("LINKEDIN"), JSON.stringify(wrongType.body));
  const linkB4 = await mintIn(B, ownerB.id);
  const unknown = await confirm(linkB4.notifyUrl, created(linkB4.name, `wa-never-${stamp}`));
  check("an account Unipile does not know is refused", unknown.body?.claimed === false && String(unknown.body?.reason).includes("does not know"));
  const linkB5 = await mintIn(B, ownerB.id);
  await db.update(unipileConnectStates).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(unipileConnectStates.id, linkB5.name));
  platformAccounts.push(whatsapp(WA_B1, phone(2)));
  const expired = await confirm(linkB5.notifyUrl, created(linkB5.name, WA_B1));
  check("an expired link claims nothing", expired.body?.claimed === false && (await stateOf(linkB5.name))?.status === "expired" && !(await ownerOf(WA_B1)));
  const fromDifferentKey = links.filter((link) => link.apiKey !== PLATFORM_KEY && link.apiKey !== OWN_KEY_C);
  check("every link was minted with a known key", fromDifferentKey.length === 0);

  // ------------------------------------------------------------ calls naming another workspace's account
  const before = requests.length;
  const refusals = await runInOrganization(B, async () => {
    const client = await getUnipileClient();
    const outcomes: string[] = [];
    const attempt = async (label: string, run: () => Promise<unknown>) => {
      outcomes.push(await run().then(() => `${label}: sent`, (error: unknown) => (error instanceof ownership.UnipileAccountNotOwnedError ? `${label}: refused` : `${label}: ${error instanceof Error ? error.message : "error"}`)));
    };
    await attempt("start a chat", () => startUnipileWhatsappChat(WA_A1, "+15550001234", "hello"));
    await attempt("read the account", () => client.account.getOne(WA_A1));
    await attempt("delete the account", () => client.account.delete(WA_A1));
    await attempt("list its chats", () => client.messaging.getAllChats({ account_id: WA_A1, limit: 1 } as never));
    await attempt("reconnect it", () => client.account.reconnectWhatsapp(WA_A1));
    await attempt("read a profile through it", () => client.users.getProfile({ account_id: WA_A1, identifier: "someone" }));
    await attempt("search LinkedIn with it", () => searchLinkedIn(WA_A1, "https://www.linkedin.com/search/results/people/?keywords=x"));
    return outcomes;
  });
  check("B's calls naming A's account are all refused", refusals.every((outcome) => outcome.endsWith("refused")), refusals.join("; "));
  check("…before anything reached Unipile", requests.length === before, `${requests.length - before} request(s)`);
  const own = await runInOrganization(A, () => startUnipileWhatsappChat(WA_A1, "+15550001234", "hello"));
  check("A can send from its own number", Boolean(own.chatId) && requests.at(-1)?.path === "/chats");

  // ------------------------------------------------------------ the connected-account allowance
  setAllowanceOverridesForTests({ unipile_whatsapp: { workspace: 1 } });
  const linkA2 = await mintIn(A, ownerA.id);
  platformAccounts.push(whatsapp(WA_A2, phone(3)));
  const overA = await confirm(linkA2.notifyUrl, created(linkA2.name, WA_A2));
  check("A, at its allowance of one number, cannot connect a second", overA.body?.claimed === false && !(await ownerOf(WA_A2)) && String((await stateOf(linkA2.name))?.reason).includes("allowance for WhatsApp numbers is used up"), JSON.stringify(overA.body));
  const [linkP1, linkP2] = [await mintIn(B, ownerB.id), await mintIn(B, ownerB.id)];
  platformAccounts.push(whatsapp(WA_B2, phone(4)));
  const parallel = await Promise.all([confirm(linkP1.notifyUrl, created(linkP1.name, WA_B1)), confirm(linkP2.notifyUrl, created(linkP2.name, WA_B2))]);
  const bCount = await runInOrganization(B, () => allowanceUsed(db, "unipile_whatsapp", B));
  check("two of B's callbacks at once, allowance one: exactly one is claimed", parallel.filter((reply) => reply.body?.claimed === true).length === 1 && bCount === 1, `${JSON.stringify(parallel.map((reply) => reply.body?.claimed))} count ${bCount}`);
  const platformNow = await allowanceUsed(db, "unipile_whatsapp", null);
  setAllowanceOverridesForTests({ unipile_whatsapp: { workspace: 10, platform: platformNow + 1 } });
  const [linkQ1, linkQ2] = [await mintIn(A, ownerA.id), await mintIn(B, ownerB.id)];
  platformAccounts.push(whatsapp(WA_A3, phone(5)), whatsapp(WA_B3, phone(6)));
  const across = await Promise.all([confirm(linkQ1.notifyUrl, created(linkQ1.name, WA_A3)), confirm(linkQ2.notifyUrl, created(linkQ2.name, WA_B3))]);
  const refusedAcross = across.find((reply) => reply.body?.claimed === false);
  check("A and B at once with room for one more on the platform: exactly one is claimed", across.filter((reply) => reply.body?.claimed === true).length === 1 && (await allowanceUsed(db, "unipile_whatsapp", null)) === platformNow + 1, JSON.stringify(across.map((reply) => reply.body)));
  check("…and the refusal names no platform figure", Boolean(refusedAcross) && !/\d/.test(String(refusedAcross?.body?.reason ?? "")), String(refusedAcross?.body?.reason));
  setAllowanceOverridesForTests({});

  // ------------------------------------------------------------ reconnect
  const rowA1 = (await rowsIn(A)).find((row) => row.unipileAccountId === WA_A1)!;
  const reconnect = await send(connectRoute.POST as never, "/api/unipile/connect", { method: "POST", headers: ownerAHeaders, body: { channel: "whatsapp", accountId: rowA1.id } });
  const linkR = lastLink();
  check("A reconnects its number by its own row id", reconnect.status === 200 && linkR.body.type === "reconnect" && linkR.body.reconnect_account === WA_A1, reconnect.text);
  const wrongReconnect = await confirm(linkR.notifyUrl, created(linkR.name, WA_A3, "RECONNECTED"));
  check("a reconnect callback naming another account is refused", wrongReconnect.body?.claimed === false);
  const reconnectB = await send(connectRoute.POST as never, "/api/unipile/connect", { method: "POST", headers: ownerBHeaders, body: { channel: "whatsapp", accountId: rowA1.id } });
  check("B cannot reconnect A's number by A's row id (404)", reconnectB.status === 404, reconnectB.text);
  const reconnectBDirect = await runInOrganization(B, () => startConnection({ channel: "whatsapp", userId: ownerB.id, reconnectAccountId: WA_A1 })).then(() => 0, (error: unknown) => (error instanceof UnipileConnectError ? error.status : -1));
  check("…nor by naming A's Unipile account id", reconnectBDirect === 404);
  const linkR2 = (await send(connectRoute.POST as never, "/api/unipile/connect", { method: "POST", headers: ownerAHeaders, body: { channel: "whatsapp", accountId: rowA1.id } }), lastLink());
  const reconnected = await confirm(linkR2.notifyUrl, created(linkR2.name, WA_A1, "RECONNECTED"));
  check("Unipile's reconnect callback for the same account is accepted", reconnected.body?.claimed === true && (await ownerOf(WA_A1))?.organizationId === A);

  // ------------------------------------------------------------ LinkedIn's hosted sign-in uses the same flow
  const liStart = await send(linkedinHostedAuthRoute.POST as never, "/api/linkedin/accounts/hosted-auth", { method: "POST", headers: memberAHeaders, body: {} });
  const liLink = lastLink();
  check("LinkedIn's sign-in link is a verified connection too", liStart.status === 200 && JSON.stringify(liLink.body.providers) === JSON.stringify(["LINKEDIN"]) && (await stateOf(liLink.name))?.channel === "linkedin" && !liStart.text.includes(liLink.token), liStart.text);

  // ------------------------------------------------------------ webhooks reach only the owner
  const message = (accountId: string, n: number) => ({
    event: "message_received", account_type: "WHATSAPP", account_id: accountId, chat_id: `chat-hook-${stamp}-${n}`, message_id: `msg-hook-${stamp}-${n}`,
    message: "Hi there", timestamp: new Date().toISOString(), sender: { attendee_provider_id: "15550009999@s.whatsapp.net", attendee_name: "Lead" },
  });
  const ledger = async (accountId: string) => db.select({ organizationId: webhookEvents.organizationId }).from(webhookEvents).where(eq(webhookEvents.accountId, accountId));
  const toOwner = await messageHook(`?org=${MANAGED_WEBHOOK_ORG}`, platformSecret, message(WA_A1, 1));
  const ledgerA1 = await ledger(WA_A1);
  check("a message for A's number on the platform's webhook is accepted for A only", toOwner.status === 200 && ledgerA1.length === 1 && ledgerA1[0]!.organizationId === A, `${toOwner.status} ${JSON.stringify(ledgerA1)}`);
  const wrongSecret = await messageHook(`?org=${MANAGED_WEBHOOK_ORG}`, "not-the-secret", message(WA_A1, 2));
  check("…with a wrong secret it is 401", wrongSecret.status === 401);
  const stray = await messageHook(`?org=${MANAGED_WEBHOOK_ORG}`, platformSecret, message(WA_OLD, 3));
  check("a message for an unowned account is acknowledged and dropped", stray.status === 200 && (await ledger(WA_OLD)).length === 0);
  const viaC = await messageHook(`?org=${C}`, `own-secret-c-${stamp}`, message(WA_A1, 4));
  check("C's own registration naming A's number is dropped", viaC.status === 200 && (await ledger(WA_A1)).length === 1, JSON.stringify(viaC.body));
  const viaB = await messageHook(`?org=${B}`, platformSecret, message(WA_A1, 5));
  check("…and so is B's URL with the platform's secret", viaB.status === 200 && (await ledger(WA_A1)).length === 1);

  check("the Unipile workers visit A and B, which have no Unipile row of their own", (await unipileOrganizationIds()).includes(A) && (await unipileOrganizationIds()).includes(B));

  // A LinkedIn row another workspace holds for an account A owns (a pre-existing conflict): a hand-registered URL is dropped too.
  await runInOrganization(B, () => db.insert(linkedInAccounts).values({ organizationId: B, linkedinId: WA_A1, name: "Conflict", username: `conflict-${stamp}`, status: "CONNECTED", updatedAt: new Date() }));
  const legacy = await messageHook(`?secret=${platformSecret}`, null, { event: "message_received", account_type: "LINKEDIN", account_id: WA_A1, chat_id: `li-chat-${stamp}`, message_id: `li-msg-${stamp}`, message: "hi", sender: { attendee_provider_id: "x" } }, linkedinMessageWebhook as never, "/api/webhooks/message-received");
  check("a hand-registered URL for an account owned elsewhere is dropped", legacy.status === 200 && (await ledger(WA_A1)).length === 1, JSON.stringify(legacy.body));

  // ------------------------------------------------------------ disconnect
  const disconnectB = await send(disconnectRoute.POST as never, "/api/unipile/accounts/disconnect", { method: "POST", headers: ownerBHeaders, body: { channel: "whatsapp", id: rowA1.id } });
  const disconnectOp = await send(disconnectRoute.POST as never, "/api/unipile/accounts/disconnect", { method: "POST", headers: operatorHeaders, body: { channel: "whatsapp", id: rowA1.id } });
  const disconnectMember = await send(disconnectRoute.POST as never, "/api/unipile/accounts/disconnect", { method: "POST", headers: memberAHeaders, body: { channel: "whatsapp", id: rowA1.id } });
  const unresolved = await runInOrganization(B, () => unipileAccountIdForRow("whatsapp", rowA1.id));
  const notDisconnected = await runInOrganization(B, () => disconnectUnipileAccount("whatsapp", rowA1.id));
  check("B and the operator get 404 for A's row; A's member 403", disconnectB.status === 404 && disconnectOp.status === 404 && disconnectMember.status === 403 && unresolved === null && notDisconnected === null, `${disconnectB.status} ${disconnectOp.status} ${disconnectMember.status}`);
  check("…and nothing was deleted at Unipile", !requests.some((request) => request.method === "DELETE" && request.path === `/accounts/${WA_A1}`) && platformAccounts.some((account) => account.id === WA_A1));
  const disconnectA = await send(disconnectRoute.POST as never, "/api/unipile/accounts/disconnect", { method: "POST", headers: adminAHeaders, body: { channel: "whatsapp", id: rowA1.id } });
  const releasedA1 = await ownerOf(WA_A1);
  const [rowAfter] = await db.select().from(whatsappAccounts).where(eq(whatsappAccounts.id, rowA1.id));
  check("A's admin disconnects it: removed from Unipile, row disconnected, ownership released (still A's)", disconnectA.status === 200 && requests.some((request) => request.method === "DELETE" && request.path === `/accounts/${WA_A1}`) && rowAfter?.status === "disconnected" && releasedA1?.status === "released" && releasedA1.organizationId === A, disconnectA.text);
  platformAccounts.push(whatsapp(WA_A1, phone(1), new Date(Date.now() - 86_400_000)));
  const linkB6 = await mintIn(B, ownerB.id);
  const afterRelease = await confirm(linkB6.notifyUrl, created(linkB6.name, WA_A1));
  check("a released account is never given to another workspace", afterRelease.body?.claimed === false && (await ownerOf(WA_A1))?.organizationId === A);
  const linkA4 = await mintIn(A, ownerA.id);
  const again = await confirm(linkA4.notifyUrl, created(linkA4.name, WA_A1));
  check("A connecting it again makes it active again", again.body?.claimed === true && (await ownerOf(WA_A1))?.status === "active", JSON.stringify(again.body));

  // ------------------------------------------------------------ own keys
  ownAccounts.get(OWN_KEY_C)!.push(whatsapp(WC_1, phone(7), new Date(Date.now() - 86_400_000)), whatsapp(WA_A1, phone(1)));
  await runInOrganization(C, () => syncWhatsappAccounts());
  const rowsC = (await rowsIn(C)).map((row) => row.unipileAccountId);
  const ownerC = await ownerOf(WC_1);
  check("C's own key adopts an unowned account its Unipile lists, as a sync always did", rowsC.includes(WC_1) && ownerC?.organizationId === C && ownerC.credentialSource === "own" && ownerC.claimedVia === "own_sync", JSON.stringify(rowsC));
  check("…but never an account another workspace owns", !rowsC.includes(WA_A1) && (await ownerOf(WA_A1))?.organizationId === A);
  const gateC = await gateUnipileWebhook({ nextUrl: { searchParams: new URLSearchParams(`org=${MANAGED_WEBHOOK_ORG}`) }, headers: new Headers({ "x-unipile-secret": platformSecret }) }, C, WC_1);
  check("the platform's webhook ignores accounts of workspaces on their own Unipile", gateC.verdict === "ignore" && gateC.reason.includes("its own Unipile"), JSON.stringify(gateC));
  const linkC = await mintIn(C, ownerA.id);
  check("C's links are minted with its own key", links.at(-1)!.apiKey === OWN_KEY_C && linkC.name.length === 36);

  // ------------------------------------------------------------ the migration's backfill
  await runInOrganization(C, () => db.insert(whatsappAccounts).values({ organizationId: C, unipileAccountId: WA_LEGACY, phone: phone(8), status: "connected" }));
  await runInOrganization(B, () => db.insert(linkedInAccounts).values({ organizationId: B, linkedinId: LI_B, name: "Legacy", username: `legacy-${stamp}`, status: "CONNECTED", updatedAt: new Date() }));
  const migrate = () => Bun.spawnSync(["bun", "scripts/add-managed-saas.ts"], { env: process.env, stdout: "pipe", stderr: "pipe" });
  const first = migrate();
  const second = migrate();
  const out1 = first.stdout.toString();
  const out2 = second.stdout.toString();
  const legacyOwner = await ownerOf(WA_LEGACY);
  const liOwner = await ownerOf(LI_B);
  check("the migration gives every account an organization already holds its ownership row", first.exitCode === 0 && legacyOwner?.organizationId === C && legacyOwner.claimedVia === "existing" && liOwner?.organizationId === B, first.stderr.toString().slice(0, 300));
  check("…reports a conflict and leaves it", out1.includes(`linkedin account ${WA_A1}: held by organization ${B}, owned by ${A}`) && (await ownerOf(WA_A1))?.organizationId === A, out1.split("\n").filter((line) => line.includes(WA_A1)).join(" | ") || out1.slice(0, 300));
  const count = (out: string) => out.match(/unipile_account_owners \((\d+) accounts\)/)?.[1];
  check("…and running it again changes nothing", second.exitCode === 0 && count(out1) === count(out2) && out2.includes(`linkedin account ${WA_A1}`), `${count(out1)} / ${count(out2)}`);
  await db.delete(linkedInAccounts).where(and(eq(linkedInAccounts.organizationId, B), eq(linkedInAccounts.linkedinId, WA_A1)));

  // ------------------------------------------------------------ the ownership table is scoped
  const seenByB = await runInOrganization(B, () => ownership.ownedAccountIds("whatsapp"));
  check("B's view of the ownership table holds only B's accounts", [...seenByB].every((id) => !id.startsWith("wa-a") && !id.startsWith("wc-")), JSON.stringify([...seenByB]));
} finally {
  setAllowanceOverridesForTests({});
  await db.delete(platformOperators).where(eq(platformOperators.userId, operator.id));
  await db.delete(platformCredentials).where(eq(platformCredentials.provider, "unipile"));
  if (savedPlatformUnipile) await db.insert(platformCredentials).values(savedPlatformUnipile);
  store.clearPlatformCredentialCache();
  globalThis.fetch = realFetch;
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll Unipile ownership checks passed.");
process.exit(failures ? 1 : 0);

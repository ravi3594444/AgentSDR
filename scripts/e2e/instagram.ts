/**
 * Instagram through Unipile (API v1), end to end against the database, with
 * Unipile's API replaced by a recording stand-in (global fetch is
 * intercepted for one fake host; nothing leaves the machine). It runs the
 * real code: the feature switch, the account sync, the hosted sign-in link,
 * the account-status webhook, the messaging webhook through the real
 * /api/webhooks/unipile-message route (gate, secret, ledger, and the
 * after() processing, driven by a minimal request store), echoes, history,
 * the history import, a CRM draft sent through the real sendDraft →
 * sendThroughCrmProvider → Unipile, Do Not Contact, and organization
 * isolation.
 *
 *   bun run --conditions=react-server scripts/e2e/instagram.ts
 *
 * What it cannot prove: that the real Unipile sends these exact payloads and
 * accepts these exact requests. Both follow Unipile's v1 API reference and
 * unipile-node-sdk 1.9.3 (docs/product/INSTAGRAM_INTAKE_DISCOVERY.md).
 *
 * It creates its own two organizations ("Instagram check A/B …") and leaves
 * them behind with their features off and their fake Unipile connections
 * removed. Refuses a non-local DATABASE_URL.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import type { NextRequest as NextRequestType } from "next/server";
import type { WebhookLog } from "@/lib/instagram/messages";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}

// ------------------------------------------------------------ fake Unipile
const FAKE = "https://unipile-instagram-check.invalid";
const stamp = Date.now().toString(36);
const KEY_A = `ig-check-a-${stamp}`;
const KEY_B = `ig-check-b-${stamp}`;
const SECRET_A = `ig-secret-a-${stamp}`;
const SECRET_B = `ig-secret-b-${stamp}`;

type Recorded = { method: string; path: string; query: Record<string, string>; form: Record<string, string>; json: Record<string, unknown> | null; apiKey: string };
const requests: Recorded[] = [];
const workspaces = new Map<string, Record<string, unknown>[]>();
const chatsByAccount = new Map<string, Record<string, unknown>[]>();
const messagesByChat = new Map<string, Record<string, unknown>[]>();
/** Runs while a send is "in flight" at Unipile, before it answers — how an early echo is simulated. */
const beforeSendAnswer = new Map<string, (messageId: string, text: string) => Promise<void>>();
let sendCount = 0;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== FAKE) return realFetch(input, init);
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  const form: Record<string, string> = {};
  if (init?.body instanceof FormData) for (const [key, value] of init.body.entries()) form[key] = String(value);
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
  const apiKey = headers.get("x-api-key") ?? "";
  requests.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), form, json: body, apiKey });
  const path = url.pathname.replace(/^\/api\/v1/, "");

  if (method === "GET" && path === "/accounts") return json(200, { object: "AccountList", items: workspaces.get(apiKey) ?? [], cursor: null });
  if (method === "GET" && path === "/chats") {
    if (url.searchParams.get("account_type") !== "INSTAGRAM") return json(400, { status: 400, title: "Expected account_type INSTAGRAM" });
    return json(200, { object: "ChatList", items: chatsByAccount.get(url.searchParams.get("account_id") ?? "") ?? [], cursor: null });
  }
  const messagesMatch = path.match(/^\/chats\/([^/]+)\/messages$/);
  if (method === "GET" && messagesMatch) {
    return json(200, { object: "MessageList", items: messagesByChat.get(decodeURIComponent(messagesMatch[1]!)) ?? [], cursor: null });
  }
  if (method === "POST" && messagesMatch) {
    const chatId = decodeURIComponent(messagesMatch[1]!);
    if (chatId.startsWith("ig-chat-refuse")) {
      return json(422, { status: 422, type: "errors/cannot_resend_yet", title: "Recipient cannot be reached", detail: "The user does not accept messages." });
    }
    sendCount += 1;
    const messageId = `ig-sent-${stamp}-${sendCount}`;
    await beforeSendAnswer.get(chatId)?.(messageId, form.text ?? "");
    return json(201, { object: "MessageSent", message_id: messageId });
  }
  if (method === "POST" && path === "/chats") return json(500, { status: 500, title: "This check never starts a chat" });
  if (method === "POST" && path === "/hosted/accounts/link") return json(201, { object: "HostedAuthURL", url: `https://account.unipile.example/${stamp}` });
  return json(404, { title: `No fake for ${method} ${path}`, status: 404 });
}) as typeof fetch;

// ------------------------------------------------------------ app modules
// What Next's server does at boot (node-environment-baseline): its request
// stores, after() among them, are built on the global AsyncLocalStorage.
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;
const { NextRequest } = await import("next/server");
const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external");
const { db } = await import("@/lib/db");
const { organizations, users, members } = await import("@/lib/auth/schema");
const { people } = await import("@/lib/leads/schema");
const { gridProviderCredentials, gridProviders } = await import("@/lib/grid/schema");
const { encryptIntegrationCredentials } = await import("@/lib/integrations/credentials");
const { inquiries } = await import("@/lib/intake/schema");
const { runInOrganization, currentOrganizationId } = await import("@/lib/tenancy/scope");
const { setFeature } = await import("@/lib/features/flags.server");
const { instagramAccounts, instagramChats, instagramMessages } = await import("@/lib/instagram/schema");
const accountsLib = await import("@/lib/instagram/accounts");
const messagesLib = await import("@/lib/instagram/messages");
const { performInstagramReply } = await import("@/lib/instagram/send.server");
const { InstagramSendRefusedError } = await import("@/lib/instagram/delivery");
const { InstagramApiError } = await import("@/lib/instagram/errors");
const { createInstagramHostedAuthLink, instagramHostedAuthName } = await import("@/services/unipile.instagram");
const { instagramHostedAuthCallbackUrls } = await import("@/lib/instagram/hostedAuth");
const { sendDraft, sendThroughCrmProvider, DefiniteCrmSendError } = await import("@/lib/crm/send");
const { setPersonDoNotContact } = await import("@/lib/crm/policies");
const { crmConversationMessages, crmConversations, crmDrafts, crmJobs, crmRecords, crmSendAttempts } = await import("@/lib/crm/schema");
const { webhookEvents } = await import("@/lib/linkedin/schema");
const { replayableWebhookEvents } = await import("@/lib/linkedin/webhooks/inbox");
const { POST: unipileMessageWebhook } = await import("@/app/api/webhooks/unipile-message/route");
const { POST: unipileAccountWebhook } = await import("@/app/api/webhooks/unipile-account/route");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/**
 * Calls a route handler the way Next does for these webhooks: inside a
 * request store whose `after()` collects the callbacks, then runs them once
 * the response exists — the response is returned before processing, as in
 * production.
 */
async function callRoute(handler: (request: NextRequestType) => Promise<Response>, request: NextRequestType): Promise<Response> {
  const pending: (() => unknown)[] = [];
  const store = { afterContext: { after: (task: unknown) => { pending.push(typeof task === "function" ? (task as () => unknown) : () => task); } } };
  const response = await workAsyncStorage.run(store as never, () => handler(request));
  for (const task of pending) await task();
  return response;
}

function messageHook(orgId: string, secret: string | null, payload: Record<string, unknown>) {
  return callRoute(unipileMessageWebhook, new NextRequest(`http://localhost/api/webhooks/unipile-message?org=${orgId}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(secret ? { "x-unipile-secret": secret } : {}) },
    body: JSON.stringify(payload),
  }));
}

function accountHook(orgId: string, secret: string, payload: Record<string, unknown>) {
  return callRoute(unipileAccountWebhook, new NextRequest(`http://localhost/api/webhooks/unipile-account?org=${orgId}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-unipile-secret": secret },
    body: JSON.stringify(payload),
  }));
}

// ------------------------------------------------------------ fixtures
const OWNER_A1 = `178414${stamp}01`;
const LEAD1 = `178414${stamp}11`;
const LEAD3 = `178414${stamp}13`;
const LEAD4 = `178414${stamp}14`;
const LEAD5 = `178414${stamp}15`;
const LEAD6 = `178414${stamp}16`;
const A1 = `ig-a1-${stamp}`;
const A2 = `ig-a2-${stamp}`;
const A3 = `ig-a3-${stamp}`;
const B1 = `ig-b1-${stamp}`;
const CHAT1 = `ig-chat-1-${stamp}`;
const CHAT_IMP = `ig-chat-imp-${stamp}`;
const CHAT_U = `ig-chat-u-${stamp}`;
const CHAT_V = `ig-chat-v-${stamp}`;
const CHAT_DNC = `ig-chat-dnc-${stamp}`;
const CHAT_REFUSE = `ig-chat-refuse-${stamp}`;

const igAccount = (id: string, status: string, im: Record<string, unknown> = {}, name: string | null = null) =>
  ({ object: "Account", type: "INSTAGRAM", id, name, connection_params: { im }, sources: [{ id: `${id}-src`, status }] });
const accountA1 = igAccount(A1, "OK", { id: OWNER_A1, username: "banerbakery" }, "Baner Bakery");
const accountA2 = igAccount(A2, "CREDENTIALS", { username: "banerbakery.events" });
const accountA3 = igAccount(A3, "OK", { username: "banerbakery.cakes" }, "Baner Cakes");
const linkedinA = { object: "Account", type: "LINKEDIN", id: `li-${stamp}`, name: "Someone", connection_params: { im: { username: "someone" } }, sources: [{ status: "OK" }] };
const whatsappA = { object: "Account", type: "WHATSAPP", id: `wa-${stamp}`, name: "+919800000001", connection_params: { im: { phone_number: "919800000001" } }, sources: [{ status: "OK" }] };
workspaces.set(KEY_A, [accountA1, accountA2, linkedinA, whatsappA]);
// Organization B's workspace also lists A1, as a shared Unipile workspace would.
workspaces.set(KEY_B, [igAccount(B1, "OK", { username: "otherbrand" }, "Other Brand"), accountA1]);

/** A message_received delivery as Unipile v1 posts it for an Instagram account. */
function delivery(input: {
  accountId?: string;
  chatId: string;
  messageId: string;
  text: string;
  lead: string;
  leadName?: string;
  leadUsername?: string;
  echo?: boolean;
  timestamp?: string;
  accountType?: string;
}): Record<string, unknown> {
  const owner = { attendee_id: "att-owner", attendee_provider_id: OWNER_A1, attendee_name: "Baner Bakery" };
  const lead = { attendee_id: `att-${input.lead}`, attendee_provider_id: input.lead, attendee_name: input.leadName ?? "Asha Rao", attendee_profile_url: `https://www.instagram.com/${input.leadUsername ?? "asha.rao"}/` };
  return {
    event: "message_received",
    account_type: input.accountType ?? "INSTAGRAM",
    account_id: input.accountId ?? A1,
    account_info: { type: "INSTAGRAM", user_id: OWNER_A1 },
    webhook_name: "AgentSDR messages",
    chat_id: input.chatId,
    message_id: input.messageId,
    message: input.text,
    timestamp: input.timestamp ?? new Date().toISOString(),
    is_sender: input.echo ?? false,
    is_group: false,
    sender: input.echo ? owner : lead,
    attendees: [lead, owner],
    attachments: [],
  };
}

const posts = (chatId?: string) => requests.filter((r) => r.method === "POST" && /^\/api\/v1\/chats\/[^/]+\/messages$/.test(r.path) && (!chatId || r.path === `/api/v1/chats/${chatId}/messages`));

// ------------------------------------------------------------ organizations
const [orgA] = await db.insert(organizations).values({ name: `Instagram check A ${stamp}`, slug: `instagram-check-a-${stamp}` }).returning();
const [orgB] = await db.insert(organizations).values({ name: `Instagram check B ${stamp}`, slug: `instagram-check-b-${stamp}` }).returning();
const A = orgA!.id;
const B = orgB!.id;
const [userA] = await db.insert(users).values({ name: "Ravi (check)", email: `ig-owner-a-${stamp}@example.test`, emailVerified: true }).returning();
const [userB] = await db.insert(users).values({ name: "Other (check)", email: `ig-owner-b-${stamp}@example.test`, emailVerified: true }).returning();
await db.insert(members).values([{ organizationId: A, userId: userA!.id, role: "owner" }, { organizationId: B, userId: userB!.id, role: "owner" }]);
console.log(`Organizations ${A} (A) and ${B} (B)`);

const providerIds: string[] = [];
for (const [orgId, apiKey, secret] of [[A, KEY_A, SECRET_A], [B, KEY_B, SECRET_B]] as const) {
  await runInOrganization(orgId, async () => {
    const [provider] = await db.insert(gridProviders).values({ organizationId: currentOrganizationId(), key: "platform-unipile", name: "Unipile (Instagram check)" }).returning();
    await db.insert(gridProviderCredentials).values({ providerId: provider!.id, encryptedPayload: encryptIntegrationCredentials({ baseUrl: FAKE, apiKey, notifySecret: secret }) });
    providerIds.push(provider!.id);
  });
}

const inA = <T,>(fn: () => Promise<T>) => runInOrganization(A, fn);
const inB = <T,>(fn: () => Promise<T>) => runInOrganization(B, fn);

/** Instagram rows of organization A, counted through their account. */
async function countA() {
  return inA(async () => {
    const [chats] = await db.select({ n: count() }).from(instagramChats).where(messagesLib.chatInOrg());
    const [messages] = await db.select({ n: count() }).from(instagramMessages).where(messagesLib.messageInOrg());
    const [crm] = await db.select({ n: count() }).from(crmConversationMessages)
      .innerJoin(crmConversations, eq(crmConversations.id, crmConversationMessages.conversationId))
      .where(and(eq(crmConversations.organizationId, A), eq(crmConversations.channel, "instagram")));
    const [jobs] = await db.select({ n: count() }).from(crmJobs).where(and(eq(crmJobs.organizationId, A), eq(crmJobs.kind, "classification")));
    const [unread] = await db.select({ n: sql<number>`coalesce(sum(${instagramChats.unreadCount}), 0)::int` }).from(instagramChats).where(messagesLib.chatInOrg());
    return { chats: chats!.n, messages: messages!.n, crm: crm!.n, jobs: jobs!.n, unread: Number(unread!.n) };
  });
}

async function messageRows(unipileMessageId: string) {
  return inA(() => db.select().from(instagramMessages).where(and(messagesLib.messageInOrg(), eq(instagramMessages.unipileMessageId, unipileMessageId))));
}

async function ledgerRow(key: string) {
  const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.providerEventKey, key)).limit(1);
  return row ?? null;
}

const crmRequest = (overrides: Partial<Parameters<typeof sendThroughCrmProvider>[0]> = {}) => ({
  channel: "instagram" as const,
  accountRef: A1,
  providerThreadId: CHAT1,
  providerContactId: LEAD1,
  recipientEmail: null,
  recipientPhone: null,
  personId: null as string | null,
  subject: null,
  bodyText: "Thanks! We deliver on Saturdays.",
  bodyHtml: null,
  inReplyTo: null,
  ...overrides,
});

try {
  // ============================================================ feature off
  await inA(async () => {
    const refused = await sendThroughCrmProvider(crmRequest()).then(() => null, (error: unknown) => error);
    check("feature off: a CRM reply over Instagram is refused definitely", refused instanceof DefiniteCrmSendError && /off/i.test((refused as Error).message), String(refused));
    const direct = await performInstagramReply({ unipileAccountId: A1, unipileChatId: CHAT1, text: "hi", personId: null }).then(() => null, (error: unknown) => error);
    check("feature off: the sender's refusal says feature_off", direct instanceof InstagramSendRefusedError && direct.reason === "feature_off");
    const log: WebhookLog = [];
    const outcome = await messagesLib.ingestInstagramWebhook(delivery({ chatId: CHAT1, messageId: `ig-off-${stamp}`, text: "Hello?", lead: LEAD1 }), log);
    check("feature off: a webhook delivery is skipped and logged", outcome === "skipped" && log.some((entry) => /off/.test(entry.message)), JSON.stringify(log));
  });
  const offHook = await messageHook(A, SECRET_A, delivery({ chatId: CHAT1, messageId: `ig-off2-${stamp}`, text: "Hello?", lead: LEAD1 }));
  const afterOff = await countA();
  check(
    "feature off: nothing is stored and nothing reaches Unipile",
    offHook.status === 200 && afterOff.chats === 0 && afterOff.messages === 0 && posts().length === 0 && !requests.some((r) => r.path === "/api/v1/accounts"),
    JSON.stringify({ status: offHook.status, ...afterOff, requests: requests.length }),
  );

  // ============================================================ accounts
  await inA(() => setFeature("instagram", true, userA!.id));
  await inB(() => setFeature("instagram", true, userB!.id));

  const firstSync = await inA(() => accountsLib.syncInstagramAccounts());
  check(
    "sync takes only Instagram accounts (not LinkedIn or WhatsApp)",
    firstSync.length === 2 && firstSync.every((account) => [A1, A2].includes(account.unipileAccountId)),
    JSON.stringify(firstSync.map((account) => account.unipileAccountId)),
  );
  const a1 = firstSync.find((account) => account.unipileAccountId === A1)!;
  const a2 = firstSync.find((account) => account.unipileAccountId === A2)!;
  check("a connected account gets connected_at and a history cutoff", a1.status === "connected" && Boolean(a1.connectedAt) && Boolean(a1.historyCutoffAt) && a1.username === "banerbakery");
  check("an account needing credentials gets neither", a2.status === "credentials" && a2.historyCutoffAt === null && a2.connectedAt === null);
  const a1Row = (await inA(() => accountsLib.findInstagramAccountByUnipileId(A1)))!;
  check("the account's own Instagram id is kept for echo detection", a1Row.providerUserId === OWNER_A1);
  const secondSync = await inA(() => accountsLib.syncInstagramAccounts());
  check("syncing again keeps the first cutoff", secondSync.find((account) => account.unipileAccountId === A1)?.historyCutoffAt === a1.historyCutoffAt);

  const bSync = await inB(() => accountsLib.syncInstagramAccounts());
  const [a1Owner] = await db.select({ organizationId: instagramAccounts.organizationId }).from(instagramAccounts).where(eq(instagramAccounts.unipileAccountId, A1));
  check(
    "another organization listing the same Unipile account never takes it",
    bSync.length === 1 && bSync[0]!.unipileAccountId === B1 && a1Owner?.organizationId === A,
    JSON.stringify(bSync.map((account) => account.unipileAccountId)),
  );

  // The account-status webhook (hosted sign-in's notify_url).
  workspaces.set(KEY_A, [accountA1, accountA2, whatsappA, accountA3]);
  await inA(() => setFeature("instagram", false, userA!.id));
  const offAccountHook = await accountHook(A, SECRET_A, { status: "CREATION_SUCCESS", account_id: A3, name: instagramHostedAuthName(A, userA!.id) });
  const a3WhileOff = await inA(() => accountsLib.findInstagramAccountByUnipileId(A3));
  check("account webhook with the feature off: no Instagram sync", offAccountHook.status === 200 && a3WhileOff === null, String(offAccountHook.status));
  await inA(() => setFeature("instagram", true, userA!.id));
  const onAccountHook = await accountHook(A, SECRET_A, { status: "CREATION_SUCCESS", account_id: A3, name: instagramHostedAuthName(A, userA!.id) });
  const a3 = await inA(() => accountsLib.findInstagramAccountByUnipileId(A3));
  check("account webhook with the feature on: the new account is synced and owned by the member who linked it", onAccountHook.status === 200 && a3?.connectedBy === userA!.id, `${onAccountHook.status} ${a3?.connectedBy}`);
  await accountHook(A, SECRET_A, { status: "RECONNECTED", account_id: A3, name: instagramHostedAuthName(A, userB!.id) });
  const a3After = await inA(() => accountsLib.findInstagramAccountByUnipileId(A3));
  check("a sign-in name naming someone outside the organization changes no owner", a3After?.connectedBy === userA!.id);
  const listed = await inA(() => accountsLib.listInstagramAccounts());
  check("the account list names who linked it", listed.find((account) => account.unipileAccountId === A3)?.connectedBy?.name === "Ravi (check)");

  // Hosted sign-in link: Instagram only, owner in `name`, notify_url = the account webhook.
  const publicUrl = process.env.BETTER_AUTH_URL;
  process.env.BETTER_AUTH_URL = "https://agentsdr-check.example.test";
  try {
    const linkUrl = await inA(async () => createInstagramHostedAuthLink({
      name: instagramHostedAuthName(A, userA!.id),
      ...instagramHostedAuthCallbackUrls(null, SECRET_A, A),
    }));
    const linkRequest = requests.filter((r) => r.path === "/api/v1/hosted/accounts/link").at(-1);
    const notify = typeof linkRequest?.json?.notify_url === "string" ? new URL(linkRequest.json.notify_url) : null;
    check(
      "the hosted sign-in link is Instagram-only, names its owner, notifies this organization's account webhook and returns to the Instagram page",
      Boolean(linkUrl) && linkRequest?.json?.type === "create" && JSON.stringify(linkRequest.json.providers) === '["INSTAGRAM"]'
        && linkRequest.json.name === `${A}:${userA!.id}` && notify?.pathname === "/api/webhooks/unipile-account" && notify.searchParams.get("org") === A
        && String(linkRequest.json.success_redirect_url).startsWith("https://agentsdr-check.example.test/settings/instagram-accounts?unipile=success"),
      JSON.stringify(linkRequest?.json),
    );
  } finally {
    process.env.BETTER_AUTH_URL = publicUrl;
  }

  workspaces.set(KEY_A, [accountA1, accountA3, whatsappA]);
  const afterUnlink = await inA(() => accountsLib.syncInstagramAccounts());
  check("an account Unipile no longer lists becomes disconnected, not deleted", afterUnlink.find((account) => account.unipileAccountId === A2)?.status === "disconnected" && afterUnlink.length === 3);

  // ============================================================ seed: a person known by an existing chat
  const a2Row = (await inA(() => accountsLib.findInstagramAccountByUnipileId(A2)))!;
  const [asha] = await inA(() => db.insert(people).values({ organizationId: A, fullName: "Asha Rao", firstName: "Asha", source: "instagram-check" }).returning());
  const [vikram] = await inA(() => db.insert(people).values({ organizationId: A, fullName: "Vikram Shah", firstName: "Vikram", source: "instagram-check" }).returning());
  await db.insert(instagramChats).values({ accountId: a2Row.id, unipileChatId: `ig-chat-old-${stamp}`, providerId: LEAD1, username: "asha.rao", personId: asha!.id });
  await db.insert(instagramChats).values({ accountId: a1Row.id, unipileChatId: CHAT_DNC, providerId: LEAD6, personId: vikram!.id });
  await db.insert(instagramChats).values({ accountId: a1Row.id, unipileChatId: CHAT_REFUSE, providerId: LEAD6 });

  // ============================================================ webhook gate
  const wrongSecret = await messageHook(A, "not-the-secret", delivery({ chatId: CHAT1, messageId: `ig-x-${stamp}`, text: "x", lead: LEAD1 }));
  check("the messaging webhook refuses a wrong secret", wrongSecret.status === 401);
  const strangerHook = await messageHook(A, SECRET_A, delivery({ accountId: B1, chatId: CHAT1, messageId: `ig-y-${stamp}`, text: "y", lead: LEAD1 }));
  const strangerBody = await strangerHook.json() as { skipped?: boolean };
  check("an event for another organization's account is acknowledged and dropped", strangerHook.status === 200 && strangerBody.skipped === true && (await ledgerRow(`instagram:message_received:v1:${B1}:ig-y-${stamp}`)) === null);

  // ============================================================ inbound from a known person
  const before = await countA();
  const m1 = `ig-m1-${stamp}`;
  const m1Payload = delivery({ chatId: CHAT1, messageId: m1, text: "Do you deliver to Baner on Saturday?", lead: LEAD1 });
  const first = await messageHook(A, SECRET_A, m1Payload);
  const afterM1 = await countA();
  const [m1Row] = await messageRows(m1);
  const chat1 = (await inA(() => db.select().from(instagramChats).where(and(messagesLib.chatInOrg(), eq(instagramChats.unipileChatId, CHAT1)))))[0];
  const [conversation] = await inA(() => db.select().from(crmConversations).where(and(eq(crmConversations.organizationId, A), eq(crmConversations.channel, "instagram"), eq(crmConversations.providerThreadId, CHAT1))));
  check("the delivery is answered 200 and processed after the response", first.status === 200 && Boolean(m1Row), String(first.status));
  check("the chat is linked to the person already known by another chat with the same Instagram id", chat1?.personId === asha!.id && chat1.username === "asha.rao" && chat1.unreadCount === 1);
  check(
    "the message reaches the CRM on an instagram conversation, and a classification job is queued",
    m1Row?.origin === "lead" && !m1Row.historical && Boolean(m1Row.crmConversationMessageId)
      && conversation?.personId === asha!.id && conversation.accountRef === A1 && conversation.providerContactId === LEAD1
      && afterM1.crm === before.crm + 1 && afterM1.jobs === before.jobs + 1,
    JSON.stringify({ before, afterM1 }),
  );
  const m1Ledger = await ledgerRow(`instagram:message_received:v1:${A1}:${m1}`);
  check("the ledger has the delivery as INSTAGRAM, processed ok", m1Ledger?.accountType === "INSTAGRAM" && m1Ledger.processingStatus === "ok" && m1Ledger.organizationId === A, JSON.stringify(m1Ledger?.processingLog));

  const again = await messageHook(A, SECRET_A, m1Payload);
  const againBody = await again.json() as { duplicate?: boolean };
  const afterAgain = await countA();
  check(
    "the same delivery twice: one message, one CRM message, no second job",
    again.status === 200 && againBody.duplicate === true && (await messageRows(m1)).length === 1 && afterAgain.crm === afterM1.crm && afterAgain.jobs === afterM1.jobs,
    JSON.stringify(afterAgain),
  );

  // ============================================================ an errored delivery is processed again on retry
  const m2 = `ig-m2-${stamp}`;
  // A timestamp Postgres cannot store makes the first attempt fail inside processing.
  console.log("      (the processing error printed next is expected)");
  const broken = await messageHook(A, SECRET_A, delivery({ chatId: CHAT1, messageId: m2, text: "Also, do you have eggless cakes?", lead: LEAD1, timestamp: "-271821-04-20T00:00:00.000Z" }));
  const m2Key = `instagram:message_received:v1:${A1}:${m2}`;
  const brokenLedger = await ledgerRow(m2Key);
  check("a delivery whose processing fails is answered 200 and marked errored", broken.status === 200 && brokenLedger?.processingStatus === "error" && (await messageRows(m2)).length === 0, brokenLedger?.processingStatus ?? "no row");
  const replayable = await replayableWebhookEvents(500, new Date(Date.now() + 60 * 60_000), A);
  check("the LinkedIn replay job never picks an Instagram delivery", !replayable.some((row) => row.id === brokenLedger?.id));
  await new Promise((resolve) => setTimeout(resolve, 5_300)); // the ledger's first retry delay
  const retried = await messageHook(A, SECRET_A, delivery({ chatId: CHAT1, messageId: m2, text: "Also, do you have eggless cakes?", lead: LEAD1 }));
  const retriedBody = await retried.json() as { duplicate?: boolean };
  const retriedLedger = await ledgerRow(m2Key);
  const [m2Row] = await messageRows(m2);
  check(
    "Unipile's retry of the errored delivery is processed again: stored and on the CRM",
    retried.status === 200 && retriedBody.duplicate !== true && retriedLedger?.processingStatus === "ok" && retriedLedger.processingAttempt === 2 && Boolean(m2Row?.crmConversationMessageId),
    JSON.stringify({ status: retriedLedger?.processingStatus, attempt: retriedLedger?.processingAttempt }),
  );

  // ============================================================ history
  const beforeHistory = await countA();
  const h1 = `ig-h1-${stamp}`;
  const h2 = `ig-h2-${stamp}`;
  await inA(async () => {
    const log1: WebhookLog = [];
    await messagesLib.ingestInstagramWebhook(delivery({ chatId: CHAT1, messageId: h1, text: "Old question from last week", lead: LEAD1, timestamp: new Date(Date.now() - 7 * 24 * 3600_000).toISOString() }), log1);
    const log2: WebhookLog = [];
    const cutoff = new Date(a1.historyCutoffAt!);
    await messagesLib.ingestInstagramWebhook(delivery({ chatId: CHAT1, messageId: h2, text: "Sent just before the account was linked", lead: LEAD1, timestamp: new Date(cutoff.getTime() - 60_000).toISOString() }), log2);
  });
  const afterHistory = await countA();
  const [h1Row] = await messageRows(h1);
  const [h2Row] = await messageRows(h2);
  check(
    "a message older than the fresh window and one sent before the cutoff are stored as history",
    h1Row?.historical === true && h2Row?.historical === true && !h1Row.crmConversationMessageId && !h2Row.crmConversationMessageId,
  );
  check("history reaches no CRM, queues no job and counts no unread", afterHistory.crm === beforeHistory.crm && afterHistory.jobs === beforeHistory.jobs && afterHistory.unread === beforeHistory.unread, JSON.stringify({ beforeHistory, afterHistory }));

  // ============================================================ unknown senders
  const beforeUnknown = await countA();
  const unknownLog: WebhookLog = [];
  await inA(() => messagesLib.ingestInstagramWebhook(delivery({ chatId: CHAT_U, messageId: `ig-u1-${stamp}`, text: "Hi, how much is a cake?", lead: LEAD4, leadName: "Unknown One", leadUsername: "unknown.one" }), unknownLog));
  const afterUnknown = await countA();
  const chatU = (await inA(() => db.select().from(instagramChats).where(and(messagesLib.chatInOrg(), eq(instagramChats.unipileChatId, CHAT_U)))))[0];
  check(
    "an unknown sender with inquiry intake off: stored and visible in the inbox, nothing else",
    afterUnknown.messages === beforeUnknown.messages + 1 && chatU?.personId === null && chatU.unreadCount === 1 && afterUnknown.crm === beforeUnknown.crm && afterUnknown.jobs === beforeUnknown.jobs,
    unknownLog.map((entry) => entry.message).join(" | "),
  );
  await inA(async () => {
    await setFeature("inquiry_intake", true, userA!.id);
    await accountsLib.setInstagramInquiryIntake(a1Row.id, true);
    const log1: WebhookLog = [];
    await messagesLib.ingestInstagramWebhook(delivery({ chatId: CHAT_V, messageId: `ig-v1-${stamp}`, text: "Hello! Do you cater weddings?", lead: LEAD5, leadName: "New Person", leadUsername: "new.person" }), log1);
    const chatV = (await db.select().from(instagramChats).where(and(messagesLib.chatInOrg(), eq(instagramChats.unipileChatId, CHAT_V))))[0];
    const inquiriesV = chatV ? await db.select().from(inquiries).where(eq(inquiries.instagramChatId, chatV.id)) : [];
    check(
      "with inquiry intake on, the first message of a new chat becomes an inquiry: a person is linked and the message reaches the CRM",
      log1.some((entry) => /New inquiry/.test(entry.message)) && Boolean(chatV?.personId) && inquiriesV.length === 1 && inquiriesV[0]!.message === "Hello! Do you cater weddings?" && inquiriesV[0]!.historical === false && log1.some((entry) => /Recorded on the CRM/.test(entry.message)),
      log1.map((entry) => entry.message).join(" | "),
    );
    const log2: WebhookLog = [];
    await messagesLib.ingestInstagramWebhook(delivery({ chatId: CHAT_V, messageId: `ig-v2-${stamp}`, text: "For 200 people", lead: LEAD5, leadName: "New Person", leadUsername: "new.person" }), log2);
    const inquiriesV2 = chatV ? await db.select().from(inquiries).where(eq(inquiries.instagramChatId, chatV.id)) : [];
    check(
      "a later message in that chat is an ordinary reply from the same person, not a second inquiry",
      inquiriesV2.length === 1 && !log2.some((entry) => /New inquiry/.test(entry.message)) && log2.some((entry) => /Recorded on the CRM/.test(entry.message)),
      log2.map((entry) => entry.message).join(" | "),
    );
    await accountsLib.setInstagramInquiryIntake(a1Row.id, false);
    await setFeature("inquiry_intake", false, userA!.id);
  });

  // ============================================================ history import
  chatsByAccount.set(A1, [
    { object: "Chat", id: CHAT1, account_id: A1, account_type: "INSTAGRAM", type: 0, name: "Asha Rao", attendee_provider_id: LEAD1, timestamp: new Date().toISOString(), unread_count: 4 },
    { object: "Chat", id: CHAT_IMP, account_id: A1, account_type: "INSTAGRAM", type: 0, name: "Ravi K", attendee_provider_id: LEAD3, attendee_public_identifier: "ravi.k", timestamp: new Date(Date.now() - 86400_000).toISOString(), unread_count: 2 },
    { object: "Chat", id: `ig-group-${stamp}`, account_id: A1, account_type: "INSTAGRAM", type: 1, name: "Bakery fans", timestamp: new Date().toISOString() },
  ]);
  messagesByChat.set(CHAT1, [
    { object: "Message", id: m1, chat_id: CHAT1, text: "Do you deliver to Baner on Saturday?", timestamp: m1Row!.sentAt.toISOString(), is_sender: 0, attachments: [] },
    { object: "Message", id: `ig-old1-${stamp}`, chat_id: CHAT1, text: "Loved the croissants!", timestamp: new Date(Date.now() - 3 * 86400_000).toISOString(), is_sender: 0, attachments: [] },
  ]);
  messagesByChat.set(CHAT_IMP, [
    { object: "Message", id: `ig-i1-${stamp}`, chat_id: CHAT_IMP, text: "Are you open on Sunday?", timestamp: new Date(Date.now() - 2 * 86400_000).toISOString(), is_sender: 0, attachments: [] },
    { object: "Message", id: `ig-i2-${stamp}`, chat_id: CHAT_IMP, text: "Yes, 9 to 5!", timestamp: new Date(Date.now() - 2 * 86400_000 + 60_000).toISOString(), is_sender: 1, attachments: [] },
    { object: "Message", id: `ig-i3-${stamp}`, chat_id: CHAT_IMP, text: "", timestamp: new Date().toISOString(), is_event: 1 },
  ]);
  const beforeImport = await countA();
  const imported = await inA(() => messagesLib.importInstagramHistory(a1Row.id));
  const afterImport = await countA();
  const importedIds = [`ig-old1-${stamp}`, `ig-i1-${stamp}`, `ig-i2-${stamp}`];
  const importedRows = await inA(() => db.select().from(instagramMessages).where(and(messagesLib.messageInOrg(), inArray(instagramMessages.unipileMessageId, importedIds))));
  const chatImp = (await inA(() => db.select().from(instagramChats).where(and(messagesLib.chatInOrg(), eq(instagramChats.unipileChatId, CHAT_IMP)))))[0];
  check(
    "import brings in chats and their latest messages, skipping groups and chat events",
    imported.importedChats === 2 && imported.importedMessages === 3 && imported.skippedGroups === 1 && importedRows.length === 3,
    JSON.stringify(imported),
  );
  check(
    "every imported message is history; a message already received keeps what it was",
    importedRows.every((row) => row.historical) && (await messageRows(m1))[0]?.historical === false
      && importedRows.find((row) => row.unipileMessageId === `ig-i2-${stamp}`)?.origin === "phone",
  );
  check("an imported chat is marked as first seen by import, with no unread", chatImp?.firstSeenVia === "import" && chatImp.unreadCount === 0 && chatImp.username === "ravi.k");
  check("import reaches no CRM, queues no job, counts no unread", afterImport.crm === beforeImport.crm && afterImport.jobs === beforeImport.jobs && afterImport.unread === beforeImport.unread, JSON.stringify({ beforeImport, afterImport }));
  const reImport = await inA(() => messagesLib.importInstagramHistory(a1Row.id));
  const afterReImport = await countA();
  check("importing again imports nothing new", reImport.importedChats === 0 && reImport.importedMessages === 0 && afterReImport.messages === afterImport.messages, JSON.stringify(reImport));
  check("the account remembers when history was imported", Boolean((await inA(() => accountsLib.findInstagramAccountByUnipileId(A1)))?.lastImportedAt));

  // ============================================================ a CRM reply, sent through the real dispatcher
  const [record] = await inA(() => db.select().from(crmRecords).where(and(eq(crmRecords.organizationId, A), eq(crmRecords.id, conversation!.crmRecordId))));
  const replyText = "Yes! We deliver to Baner every Saturday morning.";
  const [draft] = await inA(() => db.insert(crmDrafts).values({
    crmRecordId: record!.id,
    conversationId: conversation!.id,
    expectedContextVersion: record!.contextVersion,
    channel: "instagram",
    editedBodyText: replyText,
    status: "awaiting_review",
  }).returning());
  const echoLog: WebhookLog = [];
  // Unipile's echo of the send arrives before its own answer to the send.
  beforeSendAnswer.set(CHAT1, async (messageId, text) => {
    await messagesLib.ingestInstagramWebhook(delivery({ chatId: CHAT1, messageId, text, lead: LEAD1, echo: true }), echoLog);
  });
  const postsBefore = posts().length;
  const attempt = await inA(() => sendDraft({ draftId: draft!.id, revision: 1, idempotencyKey: `ig-check-${stamp}-send-1`, requestId: `ig-check-${stamp}` }));
  beforeSendAnswer.delete(CHAT1);
  const sendPosts = posts().slice(postsBefore);
  const sentId = `ig-sent-${stamp}-${sendCount}`;
  const sentRows = await messageRows(sentId);
  check(
    "a reviewed CRM draft goes out as exactly one POST /chats/{id}/messages, with the text",
    attempt.status === "sent" && sendPosts.length === 1 && sendPosts[0]!.path === `/api/v1/chats/${CHAT1}/messages` && sendPosts[0]!.form.text === replyText,
    JSON.stringify({ status: attempt.status, posts: sendPosts.map((p) => p.path) }),
  );
  check(
    "the early echo attached to the stored send instead of duplicating it, and the message is linked to its CRM twin",
    sentRows.length === 1 && sentRows[0]!.origin === "agentsdr" && Boolean(sentRows[0]!.crmConversationMessageId) && echoLog.some((entry) => /id attached/.test(entry.message)),
    echoLog.map((entry) => entry.message).join(" | "),
  );
  const lateEcho = await messageHook(A, SECRET_A, delivery({ chatId: CHAT1, messageId: sentId, text: replyText, lead: LEAD1, echo: true }));
  check("a late echo of the same send changes nothing", lateEcho.status === 200 && (await messageRows(sentId)).length === 1);
  const [sendAttempt] = await db.select().from(crmSendAttempts).where(eq(crmSendAttempts.draftId, draft!.id));
  check("the CRM send attempt records Unipile's message id", sendAttempt?.status === "sent" && (sendAttempt.response as { messageId?: string } | null)?.messageId === sentId);

  // An echo typed in the Instagram app, on a chat with a person, is recorded as outbound on the CRM.
  const phoneId = `ig-phone-${stamp}`;
  const beforePhone = await countA();
  await inA(() => messagesLib.ingestInstagramWebhook(delivery({ chatId: CHAT1, messageId: phoneId, text: "See you Saturday!", lead: LEAD1, echo: true }), []));
  const [phoneRow] = await messageRows(phoneId);
  const afterPhone = await countA();
  check("a message typed in the Instagram app is stored as phone and recorded on the CRM as outbound", phoneRow?.origin === "phone" && Boolean(phoneRow.crmConversationMessageId) && afterPhone.crm === beforePhone.crm + 1 && afterPhone.jobs === beforePhone.jobs);

  // ============================================================ refusals
  await inA(() => setPersonDoNotContact({ personId: vikram!.id, reason: "Asked not to be contacted (check)", source: "human", actorType: "human" }));
  const postsBeforeRefusals = posts().length;
  await inA(async () => {
    const dnc = await sendThroughCrmProvider(crmRequest({ providerThreadId: CHAT_DNC, providerContactId: LEAD6, personId: vikram!.id })).then(() => null, (error: unknown) => error);
    check("Do Not Contact: refused definitely", dnc instanceof DefiniteCrmSendError && /Do Not Contact/.test((dnc as Error).message), String(dnc));
    const tooLong = await performInstagramReply({ unipileAccountId: A1, unipileChatId: CHAT1, text: "x".repeat(1001), personId: asha!.id }).then(() => null, (error: unknown) => error);
    check("longer than Instagram allows: refused, never cut", tooLong instanceof InstagramSendRefusedError && tooLong.reason === "too_long");
    const noChat = await performInstagramReply({ unipileAccountId: A1, unipileChatId: `ig-chat-nowhere-${stamp}`, text: "hi", personId: null }).then(() => null, (error: unknown) => error);
    check("a chat that is not this account's: refused", noChat instanceof InstagramSendRefusedError && noChat.reason === "no_chat");
    const notConnected = await performInstagramReply({ unipileAccountId: A2, unipileChatId: `ig-chat-old-${stamp}`, text: "hi", personId: null }).then(() => null, (error: unknown) => error);
    check("an account that is not connected: refused", notConnected instanceof InstagramSendRefusedError && notConnected.reason === "not_connected");
  });
  check("no refusal reached Unipile", posts().length === postsBeforeRefusals, `${posts().length - postsBeforeRefusals} posts`);
  const rejected = await inA(() => sendThroughCrmProvider(crmRequest({ providerThreadId: CHAT_REFUSE, providerContactId: LEAD6 })).then(() => null, (error: unknown) => error as Error & { status?: number }));
  const refuseRows = await inA(async () => {
    const [chat] = await db.select({ id: instagramChats.id }).from(instagramChats).where(and(messagesLib.chatInOrg(), eq(instagramChats.unipileChatId, CHAT_REFUSE)));
    return db.select().from(instagramMessages).where(and(messagesLib.messageInOrg(), eq(instagramMessages.chatId, chat!.id)));
  });
  check("a send Unipile refuses (422) fails with its status and leaves no stored message", rejected?.status === 422 && refuseRows.length === 0, `${rejected?.status} ${rejected?.message}`);
  check("no new chat is ever started", !requests.some((r) => r.method === "POST" && r.path === "/api/v1/chats"));

  // ============================================================ organization B sees none of A
  const aChatId = chat1!.id;
  await inB(async () => {
    const accounts = await accountsLib.listInstagramAccounts();
    check("B lists only its own Instagram account", accounts.length === 1 && accounts[0]!.unipileAccountId === B1, JSON.stringify(accounts.map((account) => account.unipileAccountId)));
    const chats = await messagesLib.listInstagramChats({});
    check("B lists none of A's chats", chats.chats.length === 0, `${chats.chats.length}`);
    const filtered = await messagesLib.listInstagramChats({ accountId: a1Row.id });
    check("B filtering by A's account id still sees nothing", filtered.chats.length === 0);
    const notFound = async (label: string, run: () => Promise<unknown>) => {
      const error = await run().then(() => null, (cause: unknown) => cause);
      check(`B cannot ${label} (404)`, error instanceof InstagramApiError && error.status === 404, String(error));
    };
    await notFound("read A's thread", () => messagesLib.getInstagramThread(aChatId));
    await notFound("mark A's chat read", () => messagesLib.markInstagramChatRead(aChatId));
    await notFound("import A's history", () => messagesLib.importInstagramHistory(a1Row.id));
    await notFound("change A's inquiry switch", () => accountsLib.setInstagramInquiryIntake(a1Row.id, true));
    check("B cannot find A's account by its Unipile id", (await accountsLib.findInstagramAccountByUnipileId(A1)) === null);
    const postsBeforeB = posts().length;
    const refused = await performInstagramReply({ unipileAccountId: A1, unipileChatId: CHAT1, text: "hi from B", personId: null }).then(() => null, (error: unknown) => error);
    check("B cannot send from A's account", refused instanceof InstagramSendRefusedError && refused.reason === "account_unknown" && posts().length === postsBeforeB);
    const log: WebhookLog = [];
    const outcome = await messagesLib.ingestInstagramWebhook(delivery({ chatId: CHAT1, messageId: `ig-b-${stamp}`, text: "x", lead: LEAD1 }), log);
    const [bChats] = await db.select({ n: count() }).from(instagramChats).where(messagesLib.chatInOrg());
    check("a delivery for A's account processed as B is skipped and stores nothing for B", outcome === "skipped" && bChats!.n === 0, log.map((entry) => entry.message).join(" | "));
  });
  const [a1Still] = await db.select({ organizationId: instagramAccounts.organizationId, inquiryIntake: instagramAccounts.inquiryIntake }).from(instagramAccounts).where(eq(instagramAccounts.unipileAccountId, A1));
  const [chat1Still] = await db.select({ unreadCount: instagramChats.unreadCount }).from(instagramChats).where(eq(instagramChats.id, aChatId));
  check("A's account and chat are untouched by B", a1Still?.organizationId === A && a1Still.inquiryIntake === false && (chat1Still?.unreadCount ?? 0) > 0);
} finally {
  await inA(() => setFeature("instagram", false, null)).catch(() => {});
  await inB(() => setFeature("instagram", false, null)).catch(() => {});
  if (providerIds.length) await db.delete(gridProviders).where(inArray(gridProviders.id, providerIds));
}

globalThis.fetch = realFetch;
console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);

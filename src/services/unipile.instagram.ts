import { getUnipileClient } from "@/services/unipile.service";
import { isPlatformNotConnectedError, requirePlatformCredentials } from "@/lib/platform/credentials";
import type { InstagramAccountStatus } from "@/lib/instagram/contract";

/**
 * Unipile's Instagram side (API v1 only, through unipile-node-sdk 1.9.3 like
 * every other channel here): the linked accounts, their chats and messages,
 * replying in an existing chat, and the hosted sign-in link. Kept apart from
 * unipile.service.ts (type LINKEDIN) and unipile.whatsapp.ts (type
 * WHATSAPP), so each provider syncs on its own.
 *
 * There is deliberately no "start a new chat" here: AgentSDR only answers
 * people who wrote first (no cold Instagram outreach in this release).
 *
 * Every call runs with the organization's own Unipile credentials
 * (getUnipileClient throws PlatformNotConnectedError when it has none). A
 * failed call throws UnipileInstagramError carrying the HTTP status Unipile
 * answered with, when it said one, so callers can tell a refusal (4xx) from a
 * failure.
 */

export type UnipileInstagramAccount = {
  unipileAccountId: string;
  name: string | null;
  username: string | null;
  /** The account's own Instagram user id, when Unipile reports it. */
  providerUserId: string | null;
  status: InstagramAccountStatus;
};

/**
 * A Unipile call that failed; `status` is the HTTP status Unipile reported
 * (null when it never answered), `type` its problem type
 * ("errors/disconnected_account"…) when it said one.
 */
export class UnipileInstagramError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
    readonly type: string | null = null,
  ) {
    super(message);
    this.name = "UnipileInstagramError";
  }
}

/** The HTTP status a Unipile SDK error carries (its problem body's `status`), when it does. */
export function instagramUnipileErrorStatus(error: unknown): number | null {
  if (error instanceof UnipileInstagramError) return error.status;
  const value = error as { status?: unknown; body?: { status?: unknown }; response?: { status?: unknown } } | null;
  const status = Number(value?.body?.status ?? value?.status ?? value?.response?.status);
  return Number.isInteger(status) && status > 0 ? status : null;
}

/** Unipile's problem type ("errors/…") from our error or an SDK problem body, when it says one. */
export function instagramUnipileErrorType(error: unknown): string | null {
  if (error instanceof UnipileInstagramError) return error.type;
  const type = (error as { body?: { type?: unknown } } | null)?.body?.type;
  return typeof type === "string" && type.trim() ? type.trim() : null;
}

/**
 * What a failed call says about the account itself, from Unipile's problem
 * type: only the two that unambiguously mean the account (not the API key,
 * the chat or the recipient) can no longer send — "disconnected_account"
 * and "expired_credentials". Null for anything else. Exported for tests.
 */
export function instagramAccountStatusFromError(error: unknown): Extract<InstagramAccountStatus, "disconnected" | "credentials"> | null {
  switch (instagramUnipileErrorType(error)) {
    case "errors/disconnected_account":
      return "disconnected";
    case "errors/expired_credentials":
      return "credentials";
    default:
      return null;
  }
}

/** Unipile's reason for a refusal ("title: detail"), when its problem body says one. */
function unipileReason(error: unknown): string | null {
  const body = (error as { body?: { title?: unknown; detail?: unknown } } | null)?.body;
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const detail = typeof body?.detail === "string" ? body.detail.trim() : "";
  return [title, detail].filter(Boolean).join(": ") || null;
}

/** Runs one Unipile call; anything it throws becomes an UnipileInstagramError (PlatformNotConnectedError passes through). */
async function call<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isPlatformNotConnectedError(error)) throw error;
    const status = instagramUnipileErrorStatus(error);
    const reason = unipileReason(error) ?? (error instanceof Error && error.message ? error.message : null);
    throw new UnipileInstagramError(status, `Unipile could not ${what}${status ? ` (HTTP ${status})` : ""}${reason ? `: ${reason}` : ""}`, instagramUnipileErrorType(error));
  }
}

/** Unipile's account source status → ours. Exported for tests. */
export function instagramAccountStatus(sourceStatus: unknown): InstagramAccountStatus {
  switch (String(sourceStatus ?? "").toUpperCase()) {
    case "OK":
    case "RUNNING":
    case "CONNECTING":
      return "connected";
    case "CREDENTIALS":
      return "credentials";
    case "STOPPED":
    case "DISCONNECTED":
      return "disconnected";
    default:
      return "error";
  }
}

function text(value: unknown): string | null {
  if (typeof value === "string") return value.trim() ? value.trim() : null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** An Account object (GET /accounts) of type INSTAGRAM → ours; null for any other type. Exported for tests. */
export function mapUnipileInstagramAccount(account: Record<string, unknown>): UnipileInstagramAccount | null {
  if (account.type !== "INSTAGRAM") return null;
  const unipileAccountId = text(account.id);
  if (!unipileAccountId) return null;
  const im = ((account.connection_params as Record<string, unknown> | undefined)?.im ?? {}) as Record<string, unknown>;
  const username = text(im.username) ?? text(im.publicIdentifier) ?? text(im.public_identifier);
  return {
    unipileAccountId,
    name: text(account.name),
    username: username ? username.replace(/^@/, "") : null,
    providerUserId: text(im.id) ?? text(im.provider_id) ?? text(im.user_id),
    status: instagramAccountStatus((account.sources as Array<{ status?: unknown }> | undefined)?.[0]?.status),
  };
}

const ACCOUNT_PAGE_SIZE = 250;
const ACCOUNT_PAGES = 20;

/** Every Instagram account linked to this organization's Unipile workspace (type INSTAGRAM only). */
export async function listUnipileInstagramAccounts(): Promise<UnipileInstagramAccount[]> {
  const client = await getUnipileClient();
  const accounts: UnipileInstagramAccount[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < ACCOUNT_PAGES; page += 1) {
    const response = (await call("list the linked accounts", () => client.account.getAll({
      limit: ACCOUNT_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    }))) as { items?: Record<string, unknown>[]; cursor?: string | null };
    for (const item of response.items ?? []) {
      const account = mapUnipileInstagramAccount(item);
      if (account) accounts.push(account);
    }
    if (!response.cursor) break;
    cursor = response.cursor;
  }
  return accounts;
}

/** A page of an account's Instagram chats, newest first (GET /chats?account_type=INSTAGRAM&account_id=). */
export async function listUnipileInstagramChats(
  unipileAccountId: string,
  cursor?: string | null,
  limit = 50,
): Promise<{ items: Record<string, unknown>[]; cursor: string | null }> {
  const client = await getUnipileClient();
  const response = (await call("list the Instagram chats", () => client.messaging.getAllChats({
    account_type: "INSTAGRAM",
    account_id: unipileAccountId,
    limit,
    ...(cursor ? { cursor } : {}),
  }))) as { items?: Record<string, unknown>[]; cursor?: string | null };
  return { items: response.items ?? [], cursor: response.cursor ?? null };
}

/** A page of a chat's messages, newest first (GET /chats/{chat_id}/messages). */
export async function listUnipileInstagramMessages(
  unipileChatId: string,
  cursor?: string | null,
  limit = 30,
): Promise<{ items: Record<string, unknown>[]; cursor: string | null }> {
  const client = await getUnipileClient();
  const response = (await call("read the Instagram chat", () => client.messaging.getAllMessagesFromChat({
    chat_id: unipileChatId,
    limit,
    ...(cursor ? { cursor } : {}),
  }))) as { items?: Record<string, unknown>[]; cursor?: string | null };
  return { items: response.items ?? [], cursor: response.cursor ?? null };
}

/**
 * Sends a reply into an existing chat (POST /chats/{chat_id}/messages).
 * Unipile answers with the new message's id, or null when it cannot name it
 * yet (the webhook's echo carries it then).
 */
export async function sendUnipileInstagramMessage(unipileChatId: string, body: string): Promise<{ messageId: string | null }> {
  const client = await getUnipileClient();
  const response = (await call("send the Instagram message", () => client.messaging.sendMessage({
    chat_id: unipileChatId,
    text: body,
  }))) as { message_id?: unknown; id?: unknown };
  return { messageId: text(response.message_id) ?? text(response.id) };
}

// --- hosted sign-in ---------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The hosted-auth `name` for an Instagram link: "<organizationId>:<userId>".
 * Unipile echoes it on notify_url, which is how the account-status webhook
 * knows which member linked the account. LinkedIn's links use other names
 * (an account id or "agentsdr"), never two UUIDs.
 */
export function instagramHostedAuthName(organizationId: string, userId: string): string {
  return `${organizationId}:${userId}`;
}

/** The organization and member a hosted-auth `name` carries, or null when it is not an Instagram link's. */
export function parseInstagramHostedAuthName(name: unknown): { organizationId: string; userId: string } | null {
  if (typeof name !== "string") return null;
  const [organizationId, userId, ...rest] = name.trim().split(":");
  if (rest.length || !organizationId || !userId || !UUID.test(organizationId) || !UUID.test(userId)) return null;
  return { organizationId: organizationId.toLowerCase(), userId: userId.toLowerCase() };
}

export type InstagramHostedAuthInput = {
  /** instagramHostedAuthName(organization, member). */
  name: string;
  successRedirectUrl: string;
  failureRedirectUrl: string;
  /** The account-status webhook (hostedAuthCallbackUrls); omitted where Unipile cannot reach it. */
  notifyUrl?: string;
  expiresInMinutes?: number;
};

/**
 * A single-use Unipile hosted sign-in URL locked to Instagram
 * (`providers: ["INSTAGRAM"]`), so the wizard opens straight on Instagram
 * and AgentSDR never sees the password. Navigate to it; Unipile advises
 * against framing the wizard.
 */
export async function createInstagramHostedAuthLink({
  name,
  successRedirectUrl,
  failureRedirectUrl,
  notifyUrl,
  expiresInMinutes = 15,
}: InstagramHostedAuthInput): Promise<string> {
  const { baseUrl } = await requirePlatformCredentials("unipile");
  const client = await getUnipileClient();
  const response = await call("create the Instagram sign-in link", () => client.account.createHostedAuthLink({
    type: "create",
    providers: ["INSTAGRAM"],
    // Unipile expires links on its daily restart anyway; this one is used at once.
    expiresOn: new Date(Date.now() + expiresInMinutes * 60_000).toISOString(),
    api_url: baseUrl,
    name,
    success_redirect_url: successRedirectUrl,
    failure_redirect_url: failureRedirectUrl,
    ...(notifyUrl ? { notify_url: notifyUrl } : {}),
  }));
  const url = text((response as { url?: unknown }).url);
  if (!url) throw new UnipileInstagramError(null, "Unipile returned no sign-in link");
  return url;
}

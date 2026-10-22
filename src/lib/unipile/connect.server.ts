import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { publicAppUrl } from "@/lib/http/publicAppUrl";
import { UNIPILE_ACCOUNT_ALLOWANCE } from "@/lib/managed/allowances";
import { checkManagedAllowance } from "@/lib/managed/usage.server";
import { UNIPILE_EMAIL_ACCOUNT_TYPES } from "@/lib/outreach/unipileMail";
import { platformCredentialSource, requirePlatformCredentials } from "@/lib/platform/credentials";
import { currentOrganizationId, inOrg, runInOrganization } from "@/lib/tenancy/scope";
import { unipileClientFor } from "@/services/unipile.service";
import { accountOwner, claimAccount, ownsAccount } from "./ownership.server";
import { unipileConnectStates, type UnipileChannel } from "./schema";

/**
 * Connecting a Unipile account to a workspace (hosted auth, v1 API).
 *
 * 1. `startConnection`, for a signed-in workspace: the server records a
 *    connect state (its id, the workspace, the person, the channel, a
 *    reconnect's account, and the sha256 of a fresh secret token), then mints
 *    the hosted-auth link with the state id as `name` and the token in
 *    `notify_url`. The browser receives only Unipile's link; it never names
 *    the organization, and nothing it sends later is proof of ownership.
 * 2. `completeConnection`, from Unipile's `notify_url` call (unsigned, so a
 *    nudge only): the state must exist, be pending and unexpired, and its
 *    token must match; the body must name the state and an account. The
 *    account is then re-read from Unipile with the key that minted the link,
 *    and must be of the channel's type and either created after the link was
 *    minted (a new account) or the very account the state named (a
 *    reconnect). Only then is it claimed for the state's workspace, under the
 *    workspace's lock and, on the Included Unipile, within its connected-
 *    account allowance and the platform's. An account another workspace owns
 *    is refused and reported; nothing is reassigned. The outcome is recorded
 *    on the state.
 *
 * Unipile v1 links expire on its daily restart whatever expiresOn says; the
 * state expires after STATE_TTL_MINUTES either way.
 */

export const STATE_TTL_MINUTES = 15;
/** A new account's created_at may trail the link by a little clock difference. */
const CREATED_SKEW_MS = 5 * 60_000;
const MAX_LINKS_PER_HOUR = 20;
export const HOSTED_AUTH_CALLBACK_PATH = "/api/webhooks/unipile-account";

export const CHANNEL_RETURN_PATH: Record<UnipileChannel, string> = {
  linkedin: "/settings/linkedin-accounts",
  whatsapp: "/settings/whatsapp-accounts",
  instagram: "/settings/instagram-accounts",
  email: "/settings/email-accounts",
};

const CHANNEL_TYPES: Record<UnipileChannel, readonly string[]> = {
  linkedin: ["LINKEDIN"],
  whatsapp: ["WHATSAPP"],
  instagram: ["INSTAGRAM"],
  email: UNIPILE_EMAIL_ACCOUNT_TYPES,
};

const CHANNEL_PROVIDERS = {
  linkedin: ["LINKEDIN"],
  whatsapp: ["WHATSAPP"],
  instagram: ["INSTAGRAM"],
  email: "*:MAILING",
} as const;

export class UnipileConnectError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 429 = 400) {
    super(message);
    this.name = "UnipileConnectError";
  }
}

export function isUnipileChannel(value: unknown): value is UnipileChannel {
  return value === "linkedin" || value === "whatsapp" || value === "instagram" || value === "email";
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const LOCAL_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?$/;

/** Where the wizard returns the browser: its own localhost origin in development, else the public one. */
function returnOrigin(requestOrigin: string | null): string {
  const configured = publicAppUrl();
  const local = requestOrigin && LOCAL_ORIGIN.test(requestOrigin) ? requestOrigin : null;
  const origin = local ?? configured;
  if (!origin) throw new UnipileConnectError("BETTER_AUTH_URL is not set: Unipile's sign-in needs absolute return addresses", 409);
  return origin;
}

/** The public origin Unipile's servers can call, or null on a local address. */
function notifyOrigin(): string | null {
  const configured = publicAppUrl();
  return configured && !LOCAL_ORIGIN.test(configured) ? configured : null;
}

export type StartedConnection = { url: string; stateId: string };

export type HostedAuthMinter = (input: {
  channel: UnipileChannel;
  name: string;
  successRedirectUrl: string;
  failureRedirectUrl: string;
  notifyUrl?: string;
  reconnectAccountId: string | null;
  expiresOn: string;
}) => Promise<string>;

/** Mints the link through the workspace's Unipile (the platform's on the Included service). */
const mintWithUnipile: HostedAuthMinter = async (input) => {
  const credentials = await requirePlatformCredentials("unipile");
  const client = unipileClientFor(credentials);
  const shared = {
    expiresOn: input.expiresOn,
    api_url: credentials.baseUrl,
    name: input.name,
    success_redirect_url: input.successRedirectUrl,
    failure_redirect_url: input.failureRedirectUrl,
    ...(input.notifyUrl ? { notify_url: input.notifyUrl } : {}),
  };
  const response = await client.account.createHostedAuthLink(
    input.reconnectAccountId
      ? { type: "reconnect", reconnect_account: input.reconnectAccountId, ...shared }
      : { type: "create", providers: CHANNEL_PROVIDERS[input.channel] as never, ...shared },
  );
  const url = (response as { url?: unknown }).url;
  if (typeof url !== "string" || !url) throw new UnipileConnectError("Unipile returned no sign-in link", 409);
  return url;
};

/**
 * A hosted-auth link for the organization in scope. `reconnectAccountId` is
 * a Unipile account the caller already resolved from this organization's own
 * row; it must also be owned by this organization.
 */
export async function startConnection(input: {
  channel: UnipileChannel;
  userId: string;
  reconnectAccountId?: string | null;
  requestOrigin?: string | null;
  mint?: HostedAuthMinter;
}): Promise<StartedConnection> {
  const organizationId = currentOrganizationId();
  const source = await platformCredentialSource("unipile");
  // Not connected (own Unipile not saved, or the platform has none): PlatformNotConnectedError.
  await requirePlatformCredentials("unipile");
  const reconnect = input.reconnectAccountId ?? null;
  if (reconnect && !(await ownsAccount(reconnect))) throw new UnipileConnectError("Account not found", 404);

  const notify = notifyOrigin();
  // On the Included Unipile a connection is claimed only by the callback, which needs a public address.
  if (source === "managed" && !notify) {
    throw new UnipileConnectError("Connecting an account needs this app's public address (BETTER_AUTH_URL): Unipile confirms each connection by calling it.", 409);
  }
  const [{ recent }] = await db.select({ recent: sql<number>`count(*)::int` }).from(unipileConnectStates)
    .where(and(inOrg(unipileConnectStates), gte(unipileConnectStates.createdAt, new Date(Date.now() - 3_600_000))));
  if (Number(recent) >= MAX_LINKS_PER_HOUR) throw new UnipileConnectError("Too many connection links in the last hour; try again later.", 429);

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + STATE_TTL_MINUTES * 60_000);
  const [state] = await db.insert(unipileConnectStates).values({
    organizationId,
    userId: input.userId,
    channel: input.channel,
    kind: reconnect ? "reconnect" : "create",
    reconnectAccountId: reconnect,
    credentialSource: source,
    tokenHash: hashToken(token),
    expiresAt,
  }).returning({ id: unipileConnectStates.id });
  const origin = returnOrigin(input.requestOrigin ?? null);
  const back = (outcome: "success" | "failure") => `${origin}${CHANNEL_RETURN_PATH[input.channel]}?unipile=${outcome}&connection=${state!.id}`;
  const url = await (input.mint ?? mintWithUnipile)({
    channel: input.channel,
    name: state!.id,
    successRedirectUrl: back("success"),
    failureRedirectUrl: back("failure"),
    ...(notify ? { notifyUrl: `${notify}${HOSTED_AUTH_CALLBACK_PATH}?state=${state!.id}&token=${token}` } : {}),
    reconnectAccountId: reconnect,
    expiresOn: expiresAt.toISOString(),
  });
  return { url, stateId: state!.id };
}

export type ConnectionOutcome =
  | { ok: true; status: "claimed"; organizationId: string; accountId: string; channel: UnipileChannel; userId: string }
  | { ok: false; status: "rejected" | "expired" | "invalid"; reason: string };

type StateRow = typeof unipileConnectStates.$inferSelect;

async function finish(state: StateRow, status: "claimed" | "rejected" | "expired", accountId: string | null, reason: string | null): Promise<void> {
  await db.update(unipileConnectStates)
    .set({ status, accountId, reason: reason?.slice(0, 300) ?? null, completedAt: new Date() })
    .where(and(eq(unipileConnectStates.id, state.id), eq(unipileConnectStates.status, "pending")));
}

/** Reads the account back from Unipile with the key that minted the link. Injectable for tests. */
export type AccountReader = (accountId: string) => Promise<{ type: string | null; createdAt: Date | null } | null>;

const readWithUnipile: AccountReader = async (accountId) => {
  const credentials = await requirePlatformCredentials("unipile");
  try {
    const account = (await unipileClientFor(credentials).account.getOne(accountId)) as unknown as { type?: unknown; created_at?: unknown };
    const created = typeof account.created_at === "string" ? new Date(account.created_at) : null;
    return { type: typeof account.type === "string" ? account.type : null, createdAt: created && Number.isFinite(created.getTime()) ? created : null };
  } catch (error) {
    const status = Number((error as { body?: { status?: unknown }; status?: unknown })?.body?.status ?? (error as { status?: unknown })?.status);
    if (status === 404) return null;
    throw error;
  }
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Unipile's notify_url call. `invalid`: an unknown state, a wrong token or a
 * malformed body (the route answers 401 and nothing is recorded). Every other
 * outcome is recorded on the state and answered 200, so Unipile does not
 * retry a refusal.
 */
export async function completeConnection(input: {
  stateId: string | null;
  token: string | null;
  body: unknown;
  read?: AccountReader;
}): Promise<ConnectionOutcome> {
  const invalid = (reason: string): ConnectionOutcome => ({ ok: false, status: "invalid", reason });
  if (!input.stateId || !UUID.test(input.stateId) || !input.token) return invalid("missing state or token");
  const [state] = await db.select().from(unipileConnectStates).where(eq(unipileConnectStates.id, input.stateId)).limit(1);
  if (!state) return invalid("unknown state");
  const given = Buffer.from(hashToken(input.token));
  const expected = Buffer.from(state.tokenHash);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return invalid("wrong token");

  const body = (input.body && typeof input.body === "object" ? input.body : {}) as { status?: unknown; account_id?: unknown; name?: unknown };
  const accountId = typeof body.account_id === "string" && body.account_id.trim() ? body.account_id.trim() : null;
  if (body.name !== state.id || !accountId) return invalid("the body does not name this connection and an account");
  const wanted = state.kind === "reconnect" ? "RECONNECTED" : "CREATION_SUCCESS";
  if (body.status !== wanted) return invalid(`status ${String(body.status)} is not ${wanted}`);

  if (state.status !== "pending") {
    // A repeat of a callback already handled: the same account again is answered the same way.
    if (state.status === "claimed" && state.accountId === accountId) {
      return { ok: true, status: "claimed", organizationId: state.organizationId, accountId, channel: state.channel, userId: state.userId };
    }
    return { ok: false, status: state.status === "expired" ? "expired" : "rejected", reason: state.reason ?? `this connection was already ${state.status}` };
  }
  if (state.expiresAt.getTime() < Date.now()) {
    await finish(state, "expired", accountId, "the connection link expired before Unipile confirmed it");
    return { ok: false, status: "expired", reason: "the connection link expired before Unipile confirmed it" };
  }

  return runInOrganization(state.organizationId, async (): Promise<ConnectionOutcome> => {
    const reject = async (reason: string): Promise<ConnectionOutcome> => {
      await finish(state, "rejected", accountId, reason);
      console.warn(`[unipile/connect] connection ${state.id} for organization ${state.organizationId} refused: ${reason}`);
      return { ok: false, status: "rejected", reason };
    };
    // The key that minted the link reads the account back; a workspace that switched Unipile meanwhile cannot claim through the old link.
    if ((await platformCredentialSource("unipile")) !== state.credentialSource) return reject("the workspace switched its Unipile since the link was made");
    if (state.kind === "reconnect" && accountId !== state.reconnectAccountId) return reject("Unipile reported a different account than the one being reconnected");
    const account = await (input.read ?? readWithUnipile)(accountId);
    if (!account) return reject("Unipile does not know that account");
    if (!account.type || !CHANNEL_TYPES[state.channel].includes(account.type)) return reject(`that account is ${account.type ?? "of no known type"}, not ${state.channel}`);
    const owner = await accountOwner(accountId);
    if (owner && owner.organizationId !== state.organizationId) return reject("that account is connected to another workspace");
    if (!owner && state.kind === "create" && (!account.createdAt || account.createdAt.getTime() < state.createdAt.getTime() - CREATED_SKEW_MS)) {
      return reject("that account was not created by this connection");
    }
    const claimed = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`unipile-claim:${state.organizationId}`}, 0))`);
      // A new account, or its own released one becoming active again, counts against the allowance.
      if (state.credentialSource === "managed" && (!owner || owner.status !== "active")) {
        const over = await checkManagedAllowance(tx, UNIPILE_ACCOUNT_ALLOWANCE[state.channel], 1);
        if (over) return { refused: over.message } as const;
      }
      return { result: await claimAccount(tx, { accountId, channel: state.channel, source: state.credentialSource, via: "hosted_auth", userId: state.userId }) } as const;
    });
    if ("refused" in claimed) return reject(claimed.refused ?? "the connected-account allowance is used up");
    if (claimed.result === "elsewhere") return reject("that account is connected to another workspace");
    await finish(state, "claimed", accountId, null);
    return { ok: true, status: "claimed", organizationId: state.organizationId, accountId, channel: state.channel, userId: state.userId };
  });
}

/** The outcome of one of this organization's connection links, for the page the wizard returns to. */
export async function connectionStatus(stateId: string): Promise<{ status: StateRow["status"]; channel: UnipileChannel; reason: string | null; expired: boolean } | null> {
  if (!UUID.test(stateId)) return null;
  const [state] = await db.select().from(unipileConnectStates).where(and(inOrg(unipileConnectStates), eq(unipileConnectStates.id, stateId))).limit(1);
  if (!state) return null;
  return { status: state.status, channel: state.channel, reason: state.reason, expired: state.status === "pending" && state.expiresAt.getTime() < Date.now() };
}

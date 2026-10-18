/**
 * Read one initial DM back from Unipile, without sending or changing records.
 * Uses Bun's SQL client and the existing credential decryptor; no packages.
 * From source: bun scripts/diagnose-instagram-delivery.ts --message-id <id>
 * Container (from the checkout; no rebuild):
 *   tar -cf - scripts/diagnose-instagram-delivery.ts src/lib/integrations/credential-crypto.ts \
 *     | docker exec -i agentsdr-app-1 tar -xf - -C /tmp
 *   docker exec agentsdr-app-1 agentsdr-entrypoint bun \
 *     /tmp/scripts/diagnose-instagram-delivery.ts --message-id <id>
 */
import { SQL } from "bun";
import { decryptCredentialText } from "../src/lib/integrations/credential-crypto";

type Body = Record<string, unknown>;
export type StoredDelivery = {
  organizationId: string;
  sender: string;
  recipient: string;
  accountId: string;
  messagingId: string | null;
  chatId: string | null;
  messageId: string;
  body: string;
  status: string;
};
type Credentials = { baseUrl: string; apiKey: string; notifySecret?: string };
type Lookup = { httpStatus: number | null; body: Body | null; problem: string | null };

const object = (v: unknown): Body | null => v && typeof v === "object" && !Array.isArray(v) ? v as Body : null;
const text = (v: unknown): string | null => typeof v === "string" && v.trim() ? v : null;
const identifier = (v: unknown): string | null => text(v) ?? (typeof v === "number" && Number.isSafeInteger(v) ? String(v) : null);
const flag = (v: unknown): boolean | null => v === true || v === 1 ? true : v === false || v === 0 ? false : null;
const matches = (actual: unknown, expected: string | null) => identifier(actual) && expected ? identifier(actual) === expected : null;
const handle = (v: unknown) => text(v)?.replace(/^@/, "").toLowerCase() ?? null;
const sameHandle = (actual: unknown, expected: string) => handle(actual) ? handle(actual) === handle(expected) : null;
const normalizeText = (v: string) => v.replace(/\r\n/g, "\n");

/** Only selected metadata leaves the process; never print raw provider payloads. */
export function redactDeliveryReport(report: unknown, secrets: (string | undefined)[]): string {
  let out = JSON.stringify(report, null, 2);
  for (const secret of secrets.filter((v): v is string => Boolean(v)).sort((a, b) => b.length - a.length)) {
    for (const encoded of [JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)]) {
      if (encoded) out = out.split(encoded).join("[REDACTED]");
    }
  }
  return out;
}

export async function inspectInstagramProvider(
  stored: StoredDelivery,
  credentials: Credentials,
  fetcher: typeof fetch = fetch,
) {
  const root = credentials.baseUrl.trim().replace(/\/+$/, "").replace(/\/api\/v1$/, "");
  if (!/^https:\/\/[^\s/?#]+$/.test(root) || new URL(root).username || new URL(root).password) {
    throw new Error("The saved Unipile DSN is invalid");
  }
  if (!credentials.apiKey || !stored.chatId || !stored.messageId || !stored.accountId) {
    throw new Error("A saved Unipile connection and returned account/chat/message IDs are required");
  }
  const get = async (path: string): Promise<Lookup> => {
    try {
      const response = await fetcher(`${root}/api/v1${path}`, {
        method: "GET", redirect: "error",
        headers: { "X-API-KEY": credentials.apiKey, accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      const body = object(await response.json().catch(() => null));
      return {
        httpStatus: response.status, body: response.ok ? body : null,
        problem: response.ok ? (body ? null : "Non-object JSON response") : text(body?.type) ?? text(body?.title) ?? "Provider refused the read",
      };
    } catch {
      return { httpStatus: null, body: null, problem: "Provider read failed, timed out or redirected; nothing was retried" };
    }
  };
  const accountPath = encodeURIComponent(stored.accountId);
  const chatPath = encodeURIComponent(stored.chatId);
  const [account, profile, chat, message, attendees] = await Promise.all([
    get(`/accounts/${accountPath}`),
    get(`/users/${encodeURIComponent(stored.recipient)}?account_id=${accountPath}`),
    get(`/chats/${chatPath}`),
    get(`/messages/${encodeURIComponent(stored.messageId)}`),
    get(`/chats/${chatPath}/attendees`),
  ]);
  const im = object(object(account.body?.connection_params)?.im);
  const remoteSender = im?.username ?? im?.publicIdentifier ?? im?.public_identifier;
  const remoteRecipient = profile.body?.username ?? profile.body?.public_identifier;
  const status = (read: Lookup) => ({ httpStatus: read.httpStatus, problem: read.problem });
  return {
    stored: { sender: stored.sender, recipient: stored.recipient, status: stored.status, chatId: stored.chatId, messageId: stored.messageId },
    account: { ...status(account), provider: text(account.body?.type), username: text(remoteSender), matchesStoredSender: sameHandle(remoteSender, stored.sender) },
    recipient: { ...status(profile), provider: text(profile.body?.provider), username: text(remoteRecipient), matchesRequestedHandle: sameHandle(remoteRecipient, stored.recipient), messagingId: identifier(profile.body?.provider_messaging_id), matchesStoredMessagingId: matches(profile.body?.provider_messaging_id, stored.messagingId) },
    chat: { ...status(chat), id: text(chat.body?.id), provider: text(chat.body?.account_type), providerId: identifier(chat.body?.provider_id), matchesStoredChat: matches(chat.body?.id, stored.chatId), matchesStoredAccount: matches(chat.body?.account_id, stored.accountId), attendeeProviderId: identifier(chat.body?.attendee_provider_id) },
    message: {
      ...status(message), id: text(message.body?.id), providerId: identifier(message.body?.provider_id),
      matchesStoredMessage: matches(message.body?.id, stored.messageId),
      matchesStoredAccount: matches(message.body?.account_id, stored.accountId),
      matchesStoredChat: matches(message.body?.chat_id, stored.chatId),
      isFromConnectedSender: flag(message.body?.is_sender),
      textMatchesApproved: typeof message.body?.text === "string" ? normalizeText(message.body.text) === normalizeText(stored.body) : null,
      timestamp: text(message.body?.timestamp),
      deliveredFlag: flag(message.body?.delivered), seenFlag: flag(message.body?.seen),
      deletedFlag: flag(message.body?.deleted), hiddenFlag: flag(message.body?.hidden),
    },
    attendees: { ...status(attendees), items: Array.isArray(attendees.body?.items) ? attendees.body.items.slice(0, 10).map((item: unknown) => {
      const row = object(item);
      return { providerId: identifier(row?.provider_id), isSelf: flag(row?.is_self), profileUrl: text(row?.profile_url) };
    }) : null },
    note: "Read-only provider snapshot. Null means not reported. Delivery flags depend on provider support and do not independently prove recipient-inbox visibility. No send, retry, sync or record update was performed.",
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--message-id" || !/^[a-zA-Z0-9_-]{1,200}$/.test(args[1]!)) {
    throw new Error("Usage: bun scripts/diagnose-instagram-delivery.ts --message-id <returned-message-id>");
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set; run this through agentsdr-entrypoint inside Docker");
  const sql = new SQL(url, { max: 1, tls: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false } });
  let stored: StoredDelivery;
  let credentials: Credentials;
  try {
    ({ stored, credentials } = await sql.begin(async (tx) => {
      await tx`SET TRANSACTION READ ONLY`;
      // Resolve exactly one target first, then read only that organization's connection.
      const rows = await tx<StoredDelivery[]>`
        select q.organization_id as "organizationId", a.username as sender,
          q.username as recipient, a.unipile_account_id as "accountId",
          q.messaging_id as "messagingId", q.chat_id as "chatId", q.message_id as "messageId",
          q.body, q.status
        from instagram_outreach_queue q join instagram_accounts a
          on a.id=q.account_id and a.organization_id=q.organization_id
        where q.message_id=${args[1]!} limit 2`;
      if (rows.length !== 1) throw new Error("Expected exactly one stored Instagram send with this message ID");
      const stored = rows[0]!;
      const [connection] = await tx<{ encrypted_payload: string }[]>`
        select c.encrypted_payload from grid_providers p
        join grid_provider_credentials c on c.provider_id=p.id
        where p.organization_id=${stored.organizationId} and p.key='platform-unipile' and p.enabled=true limit 1`;
      if (!connection) throw new Error("This send's organization has no saved Unipile connection");
      const raw = object(JSON.parse(decryptCredentialText(connection.encrypted_payload)));
      if (!text(raw?.baseUrl) || !text(raw?.apiKey)) throw new Error("The saved Unipile connection is incomplete");
      return { stored, credentials: { baseUrl: String(raw!.baseUrl), apiKey: String(raw!.apiKey), notifySecret: text(raw!.notifySecret) ?? undefined } };
    }));
  } finally {
    await sql.close();
  }
  const report = await inspectInstagramProvider(stored, credentials);
  console.log(redactDeliveryReport(report, [credentials.apiKey, credentials.notifySecret, process.env.INTEGRATION_CREDENTIALS_KEY, process.env.POSTGRES_PASSWORD, process.env.DATABASE_URL]));
}

if (import.meta.main) {
  main().catch(() => {
    // Errors from a driver or credential decoder may contain connection details.
    console.error("The read-only diagnostic could not complete. Check the message ID, saved Unipile connection and container environment. No send or retry was performed.");
    process.exitCode = 1;
  });
}

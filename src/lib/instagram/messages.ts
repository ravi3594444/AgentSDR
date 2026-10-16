import "server-only";

import { and, desc, eq, gt, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { crmPipelines, crmRecords } from "@/lib/crm/schema";
import type { CrmExecutor } from "@/lib/crm/repository";
import { people } from "@/lib/leads/schema";
import { pickRepresentativeRecord } from "@/lib/calls/leadStageRules";
import { featureEnabled } from "@/lib/features/flags.server";
import { recordInstagramInquiry } from "@/lib/intake/instagram.server";
import { attachInquiryToRun } from "@/lib/assistant/inquiryRuns.server";
import { isPlatformNotConnectedError } from "@/lib/platform/credentials";
import { inOrg } from "@/lib/tenancy/scope";
import { listUnipileInstagramChats, listUnipileInstagramMessages } from "@/services/unipile.instagram";
import type {
  ImportInstagramHistoryResponse,
  InstagramAttachment,
  InstagramChatSource,
  InstagramChatSummary,
  InstagramDirection,
  InstagramMessage,
  InstagramMessageOrigin,
  InstagramPersonRef,
  InstagramThreadResponse,
  ListInstagramChatsResponse,
} from "./contract";
import {
  findInstagramAccountByUnipileId,
  getInstagramAccountRow,
  syncInstagramAccounts,
  type InstagramAccountRow,
} from "./accounts";
import { forwardInstagramInboundToCrm, recordInstagramOutboundInCrm } from "./crmBridge";
import { InstagramApiError } from "./errors";
import {
  decideIngest,
  ECHO_MATCH_WINDOW_MS,
  isHistoricalMessage,
  mapUnipileInstagramChat,
  mapUnipileInstagramMessage,
  messagePreview,
  parseInstagramWebhook,
  pickPendingSend,
  type ParsedInstagramMessageEvent,
  type UnipileInstagramChatRecord,
} from "./parse";
import { instagramAccounts, instagramChats, instagramMessages, type InstagramChatRow, type InstagramMessageRow } from "./schema";

/**
 * Instagram chats and messages: what Unipile's webhook delivers, what the
 * history import brings in, and what the Instagram inbox reads. Replies are
 * sent in send.server.ts, which stores through the helpers here.
 *
 * A message is stored once, keyed by its Unipile id. Its origin says who
 * wrote it: the other person ("lead", inbound), AgentSDR ("agentsdr", sent
 * through Unipile) or the owner in the Instagram app ("phone" — an echo
 * AgentSDR did not send). An AgentSDR send is stored before Unipile answers,
 * without an id; its echo, which can arrive before that answer, attaches it.
 *
 * History — imported, or sent before the account's history cutoff, or older
 * than INSTAGRAM_FRESH_MESSAGE_WINDOW_MS when it arrived — is stored with
 * historical = true and is never counted unread, forwarded to the CRM or
 * made an inquiry. Only a fresh message reaches the CRM: a reply from a
 * person the chat is linked to, or — with inquiry intake on for the account
 * and the organization — the first message of a new chat from someone
 * AgentSDR does not know, which becomes an inquiry first.
 *
 * Nothing here runs while the organization's Instagram feature is off.
 */

export type { InstagramChatRow, InstagramMessageRow };

/**
 * instagram_chats and instagram_messages have no organization column of
 * their own: they belong to the organization of their account. These are the
 * filters that say so.
 */
export function chatInOrg(): SQL {
  return inArray(instagramChats.accountId, db.select({ id: instagramAccounts.id }).from(instagramAccounts).where(inOrg(instagramAccounts)));
}

export function messageInOrg(): SQL {
  return inArray(instagramMessages.chatId, db.select({ id: instagramChats.id }).from(instagramChats).where(chatInOrg()));
}

export function isUniqueViolation(error: unknown): boolean {
  const value = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return value?.code === "23505" || value?.cause?.code === "23505";
}

// --- people --------------------------------------------------------------------------

/** The person already linked to another chat with this Instagram id in this organization (the latest one). */
async function personForProviderId(providerId: string | null, executor: CrmExecutor = db): Promise<string | null> {
  if (!providerId) return null;
  const [row] = await executor
    .select({ personId: instagramChats.personId })
    .from(instagramChats)
    .where(and(chatInOrg(), eq(instagramChats.providerId, providerId), isNotNull(instagramChats.personId)))
    .orderBy(desc(instagramChats.updatedAt), desc(instagramChats.id))
    .limit(1);
  return row?.personId ?? null;
}

async function loadPersonRefs(personIds: string[]): Promise<Map<string, InstagramPersonRef>> {
  const ids = [...new Set(personIds)];
  const refs = new Map<string, InstagramPersonRef>();
  if (!ids.length) return refs;
  const [rows, records] = await Promise.all([
    db
      .select({ id: people.id, fullName: people.fullName, firstName: people.firstName, lastName: people.lastName })
      .from(people)
      .where(and(inOrg(people), inArray(people.id, ids))),
    db
      .select({
        id: crmRecords.id,
        personId: crmRecords.personId,
        updatedAt: crmRecords.updatedAt,
        isDefaultPipeline: crmPipelines.isDefault,
      })
      .from(crmRecords)
      .innerJoin(crmPipelines, eq(crmPipelines.id, crmRecords.pipelineId))
      .where(and(inOrg(crmRecords), inArray(crmRecords.personId, ids))),
  ]);
  const recordsByPerson = new Map<string, (typeof records)[number][]>();
  for (const record of records) recordsByPerson.set(record.personId, [...(recordsByPerson.get(record.personId) ?? []), record]);
  for (const row of rows) {
    refs.set(row.id, {
      id: row.id,
      fullName: row.fullName?.trim() || [row.firstName, row.lastName].filter(Boolean).join(" ").trim() || null,
      crmRecordId: pickRepresentativeRecord(recordsByPerson.get(row.id) ?? [])?.id ?? null,
    });
  }
  return refs;
}

// --- mapping --------------------------------------------------------------------------

export function toInstagramMessage(row: InstagramMessageRow): InstagramMessage {
  return {
    id: row.id,
    chatId: row.chatId,
    direction: row.direction,
    origin: row.origin,
    body: row.body,
    attachments: row.attachments ?? [],
    sentAt: row.sentAt.toISOString(),
    historical: row.historical,
  };
}

function toChatSummary(row: InstagramChatRow, person: InstagramPersonRef | null): InstagramChatSummary {
  return {
    id: row.id,
    accountId: row.accountId,
    username: row.username,
    name: row.name,
    person,
    firstSeenVia: row.firstSeenVia,
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    lastMessagePreview: row.lastMessagePreview,
    lastDirection: row.lastDirection,
    unreadCount: row.unreadCount,
  };
}

export async function toInstagramChatSummary(row: InstagramChatRow): Promise<InstagramChatSummary> {
  const refs = await loadPersonRefs(row.personId ? [row.personId] : []);
  return toChatSummary(row, row.personId ? refs.get(row.personId) ?? null : null);
}

// --- storage ---------------------------------------------------------------------------

export type InstagramChatUpsert = {
  accountId: string;
  unipileChatId: string;
  providerId: string | null;
  username: string | null;
  name: string | null;
  /** Applied only when the chat is created. */
  firstSeenVia: InstagramChatSource;
};

/**
 * The chat row for a Unipile chat — created, or refreshed with what is now
 * known (id, username, name). Its person: the one it already has, else the
 * person already linked to another chat with the same Instagram id in this
 * organization.
 */
export async function upsertInstagramChat(input: InstagramChatUpsert, executor: CrmExecutor = db): Promise<InstagramChatRow> {
  const [existing] = await executor
    .select()
    .from(instagramChats)
    .where(and(chatInOrg(), eq(instagramChats.accountId, input.accountId), eq(instagramChats.unipileChatId, input.unipileChatId)))
    .limit(1);

  let row: InstagramChatRow | undefined = existing;
  const now = new Date();
  if (!row) {
    const [inserted] = await executor
      .insert(instagramChats)
      .values({
        accountId: input.accountId,
        unipileChatId: input.unipileChatId,
        providerId: input.providerId,
        username: input.username,
        name: input.name,
        firstSeenVia: input.firstSeenVia,
      })
      .onConflictDoUpdate({
        target: [instagramChats.accountId, instagramChats.unipileChatId],
        set: { updatedAt: now },
      })
      .returning();
    row = inserted;
  }
  if (!row) throw new Error("instagram_chats upsert returned no row");

  const patch: Partial<typeof instagramChats.$inferInsert> = {};
  if (input.providerId && row.providerId !== input.providerId) patch.providerId = input.providerId;
  if (input.username && row.username !== input.username) patch.username = input.username;
  if (input.name && row.name !== input.name) patch.name = input.name;
  const providerId = patch.providerId ?? row.providerId;
  if (!row.personId && providerId) {
    const personId = await personForProviderId(providerId, executor);
    if (personId) patch.personId = personId;
  }
  if (Object.keys(patch).length === 0) return row;
  const [updated] = await executor
    .update(instagramChats)
    .set({ ...patch, updatedAt: now })
    .where(and(chatInOrg(), eq(instagramChats.id, row.id)))
    .returning();
  return updated ?? row;
}

export type InstagramMessageInsert = {
  chatId: string;
  unipileMessageId: string | null;
  direction: InstagramDirection;
  origin: InstagramMessageOrigin;
  body: string;
  attachments: InstagramAttachment[];
  sentAt: Date;
  historical: boolean;
  raw?: Record<string, unknown> | null;
};

/** Inserts a message; null when its Unipile id is already stored. */
export async function insertInstagramMessage(input: InstagramMessageInsert, executor: CrmExecutor = db): Promise<InstagramMessageRow | null> {
  const [row] = await executor
    .insert(instagramMessages)
    .values({
      chatId: input.chatId,
      unipileMessageId: input.unipileMessageId,
      direction: input.direction,
      origin: input.origin,
      body: input.body,
      attachments: input.attachments,
      sentAt: input.sentAt,
      historical: input.historical,
      raw: input.raw ?? null,
    })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

/** Moves the chat's "last message" forward (never back), and counts a fresh inbound message as unread. */
export async function applyMessageToChat(
  chatId: string,
  message: { sentAt: Date; body: string; attachments: InstagramAttachment[]; direction: InstagramDirection; countUnread: boolean },
  executor: CrmExecutor = db,
): Promise<void> {
  const newer = sql`(${instagramChats.lastMessageAt} is null or ${instagramChats.lastMessageAt} <= ${message.sentAt.toISOString()}::timestamptz)`;
  await executor
    .update(instagramChats)
    .set({
      lastMessageAt: sql`case when ${newer} then ${message.sentAt.toISOString()}::timestamptz else ${instagramChats.lastMessageAt} end`,
      lastMessagePreview: sql`case when ${newer} then ${messagePreview(message.body, message.attachments)}::text else ${instagramChats.lastMessagePreview} end`,
      lastDirection: sql`case when ${newer} then ${message.direction}::text else ${instagramChats.lastDirection} end`,
      unreadCount: message.countUnread ? sql`${instagramChats.unreadCount} + 1` : sql`${instagramChats.unreadCount}`,
      updatedAt: new Date(),
    })
    .where(and(chatInOrg(), eq(instagramChats.id, chatId)));
}

export async function findInstagramMessageByUnipileId(unipileMessageId: string): Promise<InstagramMessageRow | null> {
  const [row] = await db
    .select()
    .from(instagramMessages)
    .where(and(messageInOrg(), eq(instagramMessages.unipileMessageId, unipileMessageId)))
    .limit(1);
  return row ?? null;
}

/** Whether the chat holds any message yet — if not, the message arriving opens a new conversation. */
async function chatHasMessages(chatId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: instagramMessages.id })
    .from(instagramMessages)
    .where(and(messageInOrg(), eq(instagramMessages.chatId, chatId)))
    .limit(1);
  return Boolean(row);
}

// --- webhook ------------------------------------------------------------------------------

export type WebhookLog = { level: "info" | "warn" | "error"; message: string; time: string }[];
/**
 * "error" means the delivery is worth processing again (the CRM could not
 * record a stored message): the ledger row is marked errored and the replay
 * job (src/jobs/replayInstagramWebhooks.ts) runs it again.
 */
export type WebhookOutcome = "ok" | "skipped" | "error";

function logger(entries: WebhookLog) {
  const add = (level: WebhookLog[number]["level"]) => (message: string) => {
    entries.push({ level, message, time: new Date().toISOString() });
  };
  return { info: add("info"), warn: add("warn"), error: add("error") };
}

/**
 * One delivery of /api/webhooks/instagram-message, in the organization's
 * scope. `receivedAt` is when the delivery reached AgentSDR (its ledger
 * row's creation, also on a replay): what is history is judged from it.
 * Throws only on a database failure; that and an "error" outcome (the CRM
 * could not record the message) leave the delivery errored for the replay.
 * Everything it cannot or must not use is a logged "skipped". Safe to run
 * again for the same delivery: a message already stored is not stored
 * twice, and a fresh one the CRM has not recorded yet is forwarded again.
 */
export async function ingestInstagramWebhook(payload: unknown, entries: WebhookLog, receivedAt = new Date()): Promise<WebhookOutcome> {
  const log = logger(entries);
  if (!(await featureEnabled("instagram"))) {
    log.info("Skipped: Instagram messages are off for this organization — nothing stored");
    return "skipped";
  }

  const parsed = parseInstagramWebhook(payload, receivedAt);
  if (parsed.kind === "ignore") {
    log.info(`Ignored: ${parsed.reason}`);
    return "skipped";
  }

  if (parsed.kind === "status") {
    // Instagram receipts are not kept (instagram_messages has no read or
    // delivered columns); the ledger row is the record that one arrived.
    const stored = await findInstagramMessageByUnipileId(parsed.unipileMessageId);
    log.info(stored ? `Instagram ${parsed.status} receipt for message ${parsed.unipileMessageId} — not stored` : `No stored message ${parsed.unipileMessageId} for this ${parsed.status} receipt`);
    return "skipped";
  }

  let account = await findInstagramAccountByUnipileId(parsed.unipileAccountId);
  if (!account) {
    log.info(`Unknown account ${parsed.unipileAccountId} — syncing Instagram accounts once`);
    try {
      await syncInstagramAccounts();
    } catch (error) {
      if (!isPlatformNotConnectedError(error)) throw error;
      log.warn("Unipile is not connected for this organization — skipped");
      return "skipped";
    }
    account = await findInstagramAccountByUnipileId(parsed.unipileAccountId);
  }
  if (!account) {
    log.warn(`Account ${parsed.unipileAccountId} is not a linked Instagram account — skipped`);
    return "skipped";
  }

  // The account's own id tells an echo apart even when the payload omits is_sender and account_info.
  const event = account.providerUserId ? parseInstagramWebhook(payload, receivedAt, account.providerUserId) : parsed;
  if (event.kind !== "message") {
    log.info(`Ignored: ${event.kind === "ignore" ? event.reason : "not a message"}`);
    return "skipped";
  }
  return ingestMessageEvent(account, event, payload as Record<string, unknown>, receivedAt, log);
}

async function ingestMessageEvent(
  account: InstagramAccountRow,
  event: ParsedInstagramMessageEvent,
  raw: Record<string, unknown>,
  receivedAt: Date,
  log: ReturnType<typeof logger>,
): Promise<WebhookOutcome> {
  const stored = await findInstagramMessageByUnipileId(event.unipileMessageId);
  if (stored) return resumeStoredMessage(account, stored, event, raw, log);

  const chat = await upsertInstagramChat({
    accountId: account.id,
    unipileChatId: event.unipileChatId,
    providerId: event.counterpartyProviderId,
    username: event.counterpartyUsername,
    name: event.counterpartyName,
    firstSeenVia: "webhook",
  });
  log.info(`Chat ${chat.id} (${chat.username ? `@${chat.username}` : event.counterpartyProviderId})${chat.personId ? ` → person ${chat.personId}` : " — no person linked"}`);

  const pendingMatch = event.isSender ? pickPendingSend(await pendingSends(chat.id), event, receivedAt) : null;
  const decision = decideIngest({ isSender: event.isSender, alreadyStored: false, pendingMatch });

  if (decision.action === "attach") {
    try {
      const [attached] = await db
        .update(instagramMessages)
        .set({ unipileMessageId: event.unipileMessageId, raw })
        .where(and(messageInOrg(), eq(instagramMessages.id, decision.pendingId), isNull(instagramMessages.unipileMessageId)))
        .returning({ id: instagramMessages.id });
      log.info(attached ? `Echo of AgentSDR send ${decision.pendingId} — id attached` : `Echo of AgentSDR send ${decision.pendingId} — already had its id`);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      log.info(`Echo ${event.unipileMessageId} already stored by the send itself — no-op`);
    }
    return "ok";
  }
  if (decision.action === "duplicate") return "skipped";

  const origin = decision.origin;
  const historical = isHistoricalMessage({ sentAt: event.sentAt, receivedAt, historyCutoffAt: account.historyCutoffAt });
  let personId = chat.personId;
  // A fresh message from someone not linked yet may be an inquiry. That is
  // settled before the message is stored, so a failure there leaves nothing
  // behind and the replay runs it again (inquiry intake de-duplicates).
  if (origin === "lead" && !historical && !personId) personId = await inquiryPerson(account, chat, event, log);

  // The message and the chat's last message / unread count move together,
  // so a failure leaves neither and the replay stores both.
  const message = await db.transaction(async (tx) => {
    const inserted = await insertInstagramMessage({
      chatId: chat.id,
      unipileMessageId: event.unipileMessageId,
      direction: origin === "lead" ? "inbound" : "outbound",
      origin,
      body: event.body,
      attachments: event.attachments,
      sentAt: event.sentAt,
      historical,
      raw,
    }, tx);
    if (!inserted) return null;
    await applyMessageToChat(chat.id, {
      sentAt: inserted.sentAt,
      body: inserted.body,
      attachments: inserted.attachments,
      direction: inserted.direction,
      countUnread: origin === "lead" && !historical,
    }, tx);
    return inserted;
  });
  if (!message) {
    log.info(`Message ${event.unipileMessageId} stored concurrently — no-op`);
    return "skipped";
  }
  const who = origin === "lead" ? "inbound message" : "message the owner sent from the Instagram app";
  if (historical) {
    log.info(`Stored ${who} as history (sent ${message.sentAt.toISOString()}, before the account's cutoff or long before it arrived) — not forwarded, never answered (${message.id})`);
    return "ok";
  }
  log.info(`Stored ${who} (${message.id})`);
  if (!personId) return "ok";
  return recordOnCrm(account, chat, message, personId, event.counterpartyProviderId, raw, log);
}

/**
 * A delivery of a message already stored: a retry of a delivery that failed
 * part-way, the replay, or the echo of an AgentSDR send. A fresh message
 * from the person (or typed in the Instagram app) in a chat with a person,
 * that the CRM has not recorded yet, is forwarded again — the CRM's
 * idempotency key (`instagram:<id>`) makes a second forward a no-op if the
 * first one did land. History and AgentSDR's own sends never are.
 */
async function resumeStoredMessage(
  account: InstagramAccountRow,
  stored: InstagramMessageRow,
  event: ParsedInstagramMessageEvent,
  raw: Record<string, unknown>,
  log: ReturnType<typeof logger>,
): Promise<WebhookOutcome> {
  const noOp = () => {
    log.info(`Message ${event.unipileMessageId} already stored (${stored.origin}) — ${event.isSender ? "echo of a stored send" : "retried delivery"}, no-op`);
    return "skipped" as const;
  };
  if (stored.historical || stored.origin === "agentsdr" || stored.crmConversationMessageId) return noOp();
  const [chat] = await db
    .select()
    .from(instagramChats)
    .where(and(chatInOrg(), eq(instagramChats.id, stored.chatId), eq(instagramChats.accountId, account.id)))
    .limit(1);
  if (!chat?.personId) return noOp();
  log.info(`Message ${event.unipileMessageId} already stored (${stored.id}) but not on the CRM yet — recording it now`);
  return recordOnCrm(account, chat, stored, chat.personId, event.counterpartyProviderId, raw, log);
}

/** A fresh stored message → the CRM (inbound from the person, or outbound typed in the app), linked to its CRM twin. */
async function recordOnCrm(
  account: InstagramAccountRow,
  chat: InstagramChatRow,
  message: InstagramMessageRow,
  personId: string,
  counterpartyProviderId: string,
  raw: Record<string, unknown>,
  log: ReturnType<typeof logger>,
): Promise<WebhookOutcome> {
  const crmInput = {
    personId,
    unipileAccountId: account.unipileAccountId,
    unipileChatId: chat.unipileChatId,
    providerContactId: chat.providerId ?? counterpartyProviderId,
    unipileMessageId: message.unipileMessageId!,
    body: message.body,
    sentAt: message.sentAt,
    raw,
  };
  const result = message.origin === "lead"
    ? await forwardInstagramInboundToCrm(crmInput)
    : await recordInstagramOutboundInCrm({ ...crmInput, origin: "phone" });
  if (result.error) {
    log.error(`Not recorded on the CRM: ${result.error} — the message is kept and the delivery will be processed again`);
    return "error";
  }
  if (!result.crmConversationMessageId) {
    log.info("Not recorded on the CRM (the bridge returned no message)");
    return "ok";
  }
  await db
    .update(instagramMessages)
    .set({ crmConversationMessageId: result.crmConversationMessageId })
    .where(and(messageInOrg(), eq(instagramMessages.id, message.id)));
  log.info(`Recorded on the CRM (${result.crmConversationMessageId})`);
  return "ok";
}

/**
 * A fresh message from someone AgentSDR does not know: an inquiry when the
 * organization has Inquiry intake on, the account takes inquiries, and this
 * is the first message of the chat. Returns the person the chat now belongs
 * to, or null to just keep the message in the inbox.
 */
async function inquiryPerson(
  account: InstagramAccountRow,
  chat: InstagramChatRow,
  event: ParsedInstagramMessageEvent,
  log: ReturnType<typeof logger>,
): Promise<string | null> {
  if (!account.inquiryIntake) {
    log.info("No person for this chat, and the account does not take inquiries — kept in the Instagram inbox only");
    return null;
  }
  if (!(await featureEnabled("inquiry_intake"))) {
    log.info("No person for this chat, and Inquiry intake is off for this organization — kept in the Instagram inbox only");
    return null;
  }
  if (await chatHasMessages(chat.id)) {
    log.info("No person for this chat, but it is not a new conversation — kept in the Instagram inbox only");
    return null;
  }
  const inquiry = await recordInstagramInquiry({
    chatId: chat.id,
    unipileAccountId: account.unipileAccountId,
    providerId: chat.providerId ?? event.counterpartyProviderId,
    username: chat.username,
    name: chat.name,
    messageText: event.body,
    unipileMessageId: event.unipileMessageId,
    sentAt: event.sentAt,
  });
  if (!inquiry.personId) {
    log.info("Inquiry intake recorded no inquiry — kept in the Instagram inbox only");
    return null;
  }
  const [linked] = await db
    .update(instagramChats)
    .set({ personId: inquiry.personId, updatedAt: new Date() })
    .where(and(chatInOrg(), eq(instagramChats.id, chat.id), isNull(instagramChats.personId)))
    .returning({ personId: instagramChats.personId });
  const personId = linked?.personId ?? (await db.select({ personId: instagramChats.personId }).from(instagramChats).where(and(chatInOrg(), eq(instagramChats.id, chat.id))).limit(1))[0]?.personId ?? null;
  log.info(`${inquiry.duplicate ? "Existing inquiry" : "New inquiry"}${inquiry.inquiryId ? ` ${inquiry.inquiryId}` : ""} — chat linked to person ${personId}`);
  // A fresh inquiry joins the owner's running inquiry run, if there is one,
  // before its message reaches the CRM: the draft written for it is then
  // looked at under that run's Automatic/Review mode. Without one it waits
  // for review like any reply.
  if (personId && !inquiry.duplicate) {
    const runId = await attachInquiryToRun(personId, "instagram", account.unipileAccountId);
    log.info(runId ? `Covered by the inquiry run ${runId}` : "No inquiry run is answering new inquiries — the reply waits for review");
  }
  return personId;
}

/** AgentSDR sends in this chat still waiting for their Unipile id. */
async function pendingSends(chatId: string) {
  return db
    .select({ id: instagramMessages.id, body: instagramMessages.body, sentAt: instagramMessages.sentAt })
    .from(instagramMessages)
    .where(and(
      messageInOrg(),
      eq(instagramMessages.chatId, chatId),
      eq(instagramMessages.origin, "agentsdr"),
      isNull(instagramMessages.unipileMessageId),
      gt(instagramMessages.sentAt, new Date(Date.now() - ECHO_MATCH_WINDOW_MS)),
    ));
}

// --- read side -----------------------------------------------------------------------------

const CHAT_PAGE_SIZE = 50;
const THREAD_MESSAGE_LIMIT = 500;

/**
 * Keyset cursor: the last chat's activity exactly as Postgres printed it (a
 * JS Date would drop the microseconds and skip or repeat rows) and its id.
 */
type ChatCursor = { at: string; id: string };
const PG_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeCursor(cursor: ChatCursor): string {
  return Buffer.from(JSON.stringify([cursor.at, cursor.id]), "utf8").toString("base64url");
}

function decodeCursor(value: string): ChatCursor {
  try {
    const [at, id] = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown[];
    if (typeof at === "string" && typeof id === "string" && PG_TIMESTAMP.test(at) && UUID.test(id)) {
      return { at, id };
    }
  } catch {
    // fall through
  }
  throw new InstagramApiError(400, "cursor is not valid");
}

/** A chat's place in the list: its last message, else when it was created. */
const chatActivity = sql<string>`coalesce(${instagramChats.lastMessageAt}, ${instagramChats.createdAt})`;

export type ListInstagramChatsInput = {
  accountId?: string | null;
  cursor?: string | null;
};

export async function listInstagramChats(input: ListInstagramChatsInput = {}): Promise<ListInstagramChatsResponse> {
  const conditions: SQL[] = [chatInOrg()];
  if (input.accountId) conditions.push(eq(instagramChats.accountId, input.accountId));
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor);
    conditions.push(sql`(${chatActivity}, ${instagramChats.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`);
  }

  const rows = await db
    .select({ chat: instagramChats, activity: chatActivity })
    .from(instagramChats)
    .where(and(...conditions))
    .orderBy(desc(chatActivity), desc(instagramChats.id))
    .limit(CHAT_PAGE_SIZE + 1);

  const page = rows.slice(0, CHAT_PAGE_SIZE);
  const refs = await loadPersonRefs(page.flatMap(({ chat }) => (chat.personId ? [chat.personId] : [])));
  const last = page.at(-1);
  return {
    chats: page.map(({ chat }) => toChatSummary(chat, chat.personId ? refs.get(chat.personId) ?? null : null)),
    nextCursor: rows.length > CHAT_PAGE_SIZE && last
      ? encodeCursor({ at: String(last.activity), id: last.chat.id })
      : null,
  };
}

async function threadMessages(chatId: string): Promise<InstagramMessage[]> {
  const rows = await db
    .select()
    .from(instagramMessages)
    .where(and(messageInOrg(), eq(instagramMessages.chatId, chatId)))
    .orderBy(desc(instagramMessages.sentAt), desc(instagramMessages.createdAt))
    .limit(THREAD_MESSAGE_LIMIT);
  return rows.reverse().map(toInstagramMessage);
}

async function getChatRow(chatId: string): Promise<InstagramChatRow> {
  const [row] = await db.select().from(instagramChats).where(and(chatInOrg(), eq(instagramChats.id, chatId))).limit(1);
  if (!row) throw new InstagramApiError(404, "Instagram chat not found");
  return row;
}

/** A chat and its messages, oldest first (the latest THREAD_MESSAGE_LIMIT). */
export async function getInstagramThread(chatId: string): Promise<InstagramThreadResponse> {
  const chat = await getChatRow(chatId);
  const [summary, messages] = await Promise.all([toInstagramChatSummary(chat), threadMessages(chat.id)]);
  return { chat: summary, messages };
}

/** Clears the chat's unread count in AgentSDR (Instagram itself is not told). */
export async function markInstagramChatRead(chatId: string): Promise<{ ok: true }> {
  const [row] = await db
    .update(instagramChats)
    .set({ unreadCount: 0, updatedAt: new Date() })
    .where(and(chatInOrg(), eq(instagramChats.id, chatId)))
    .returning({ id: instagramChats.id });
  if (!row) throw new InstagramApiError(404, "Instagram chat not found");
  return { ok: true };
}

// --- history import ---------------------------------------------------------------------------

const IMPORT_CHAT_PAGES = 2;
const IMPORT_MESSAGES_PER_CHAT = 30;
const IMPORT_CONCURRENCY = 4;

/**
 * Imports an account's recent chats and their latest messages from Unipile
 * as history: every message historical, no unread counts, nothing forwarded
 * to the CRM, no inquiries. Safe to re-run: messages dedupe on their Unipile
 * id, and a message already stored (from the webhook) keeps what it was. A
 * sent message in history is taken as typed in the Instagram app;
 * AgentSDR's own sends are already stored with their ids.
 */
export async function importInstagramHistory(accountId: string): Promise<ImportInstagramHistoryResponse> {
  const account = await getInstagramAccountRow(accountId);
  if (!account) throw new InstagramApiError(404, "Instagram account not found");
  if (account.status !== "connected") throw new InstagramApiError(409, "This Instagram account is not connected — reconnect it, then sync");

  const chats: UnipileInstagramChatRecord[] = [];
  let cursor: string | null = null;
  let skippedGroups = 0;
  for (let page = 0; page < IMPORT_CHAT_PAGES; page += 1) {
    const response = await listUnipileInstagramChats(account.unipileAccountId, cursor);
    for (const item of response.items) {
      const chat = mapUnipileInstagramChat(item);
      if (!chat) continue;
      if (chat.isGroup) skippedGroups += 1;
      else chats.push(chat);
    }
    if (!response.cursor) break;
    cursor = response.cursor;
  }

  let importedChats = 0;
  let importedMessages = 0;
  const queue = [...chats];
  const worker = async () => {
    for (let chat = queue.shift(); chat; chat = queue.shift()) {
      const imported = await importChat(account, chat);
      importedMessages += imported.messages;
      if (imported.created || imported.messages > 0) importedChats += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(IMPORT_CONCURRENCY, queue.length) }, worker));

  await db
    .update(instagramAccounts)
    .set({ lastImportedAt: new Date(), updatedAt: new Date() })
    .where(and(inOrg(instagramAccounts), eq(instagramAccounts.id, account.id)));
  return { importedChats, importedMessages, skippedGroups };
}

async function importChat(account: InstagramAccountRow, chat: UnipileInstagramChatRecord): Promise<{ created: boolean; messages: number }> {
  const [before] = await db
    .select({ id: instagramChats.id })
    .from(instagramChats)
    .where(and(chatInOrg(), eq(instagramChats.accountId, account.id), eq(instagramChats.unipileChatId, chat.unipileChatId)))
    .limit(1);
  const response = await listUnipileInstagramMessages(chat.unipileChatId, null, IMPORT_MESSAGES_PER_CHAT);
  const messages = response.items
    .map(mapUnipileInstagramMessage)
    .filter((message): message is NonNullable<typeof message> => Boolean(message))
    .sort((left, right) => left.sentAt.getTime() - right.sentAt.getTime());

  const row = await upsertInstagramChat({
    accountId: account.id,
    unipileChatId: chat.unipileChatId,
    providerId: chat.providerId,
    username: chat.username,
    name: chat.name,
    firstSeenVia: "import",
  });

  let imported = 0;
  for (const message of messages) {
    const inserted = await insertInstagramMessage({
      chatId: row.id,
      unipileMessageId: message.unipileMessageId,
      direction: message.isSender ? "outbound" : "inbound",
      origin: message.isSender ? "phone" : "lead",
      body: message.body,
      attachments: message.attachments,
      sentAt: message.sentAt,
      historical: true,
    });
    if (inserted) imported += 1;
  }
  const newest = messages.at(-1);
  if (newest) {
    await applyMessageToChat(row.id, {
      sentAt: newest.sentAt,
      body: newest.body,
      attachments: newest.attachments,
      direction: newest.isSender ? "outbound" : "inbound",
      countUnread: false,
    });
  }
  return { created: !before, messages: imported };
}

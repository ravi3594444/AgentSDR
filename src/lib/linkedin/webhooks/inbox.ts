import { createHash } from "crypto";
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { webhookEvents, type WebhookEvent } from "@/lib/linkedin/schema";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";

export const WEBHOOK_PROCESSING_LEASE_MS = 5 * 60 * 1000;
export const WEBHOOK_MAX_ATTEMPTS = 8;

type WebhookBody = Record<string, unknown>;

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Stable JSON is used only as a conservative fallback when Unipile supplies no event identifier. */
export function stableWebhookJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableWebhookJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableWebhookJson(item)}`)
    .join(",")}}`;
}

/**
 * Derive a delivery identity only from fields evidenced by our stored payload contract.
 * message_id is authoritative for message_received. new_relation has no documented
 * event id in this repository, so timestamp is used when present and an exact payload
 * fingerprint otherwise. The digest fallback avoids guessing that a relationship can
 * happen only once for an account/person pair.
 */
export function linkedinWebhookEventKey(body: WebhookBody): string {
  const event = nonEmptyString(body.event) ?? "unknown";
  const accountType = nonEmptyString(body.account_type) ?? "unknown";
  const accountId = nonEmptyString(body.account_id) ?? "unknown";
  const messageId = nonEmptyString(body.message_id);
  if (event === "message_received" && messageId) {
    return `linkedin:${accountType}:message_received:v1:${accountId}:${messageId}`;
  }

  const timestamp = nonEmptyString(body.timestamp);
  const providerId = nonEmptyString(body.user_provider_id);
  if (event === "new_relation" && timestamp && providerId) {
    return `linkedin:${accountType}:new_relation:v1:${accountId}:${providerId}:${timestamp}`;
  }

  const digest = createHash("sha256").update(stableWebhookJson(body)).digest("hex");
  return `linkedin:${event}:payload-sha256:${digest}`;
}

export type WebhookEventInsert = Pick<
  typeof webhookEvents.$inferInsert,
  "event" | "accountType" | "accountId" | "senderId" | "chatId" | "messageText" | "rawBody"
>;

/**
 * Records a delivery and claims it for processing; `claimed` is false for a
 * retry of a delivery already recorded. `providerEventKey` overrides the
 * LinkedIn key derivation — the WhatsApp webhook uses its own "whatsapp:"
 * keys so the same Unipile message reaching both routes never collides.
 */
export async function beginWebhookDelivery(
  body: WebhookBody,
  values: WebhookEventInsert,
  options: { providerEventKey?: string } = {},
): Promise<{ event: WebhookEvent; claimed: boolean }> {
  const providerEventKey = options.providerEventKey ?? linkedinWebhookEventKey(body);
  const now = new Date();
  const [inserted] = await db
    .insert(webhookEvents)
    .values({
      organizationId: currentOrganizationId(),
      ...values,
      providerEventKey,
      processingStatus: "processing",
      processingAttempt: 1,
      processingStartedAt: now,
      nextAttemptAt: null,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { event: inserted, claimed: true };

  const [existing] = await db
    .select()
    .from(webhookEvents)
    .where(and(inOrg(webhookEvents), eq(webhookEvents.providerEventKey, providerEventKey)))
    .limit(1);
  if (!existing) throw new Error(`Webhook event conflict without matching key: ${providerEventKey}`);
  return { event: existing, claimed: false };
}

export function webhookRetryDelayMs(attempt: number): number {
  return Math.min(15 * 60_000, 5_000 * 2 ** Math.max(0, attempt - 1));
}

export async function finishWebhookEvent(
  eventId: string,
  status: string,
  processingLog: unknown,
): Promise<void> {
  if (status === "error") {
    await failWebhookEvent(eventId, processingLog);
    return;
  }
  const now = new Date();
  await db
    .update(webhookEvents)
    .set({
      processingLog,
      processingStatus: status,
      processingStartedAt: null,
      nextAttemptAt: null,
      processedAt: status === "ok" || status === "skipped" ? now : null,
    })
    .where(and(inOrg(webhookEvents), eq(webhookEvents.id, eventId)));
}

export async function failWebhookEvent(
  eventId: string,
  processingLog: unknown,
): Promise<void> {
  const [event] = await db
    .select({ attempt: webhookEvents.processingAttempt })
    .from(webhookEvents)
    .where(and(inOrg(webhookEvents), eq(webhookEvents.id, eventId)))
    .limit(1);
  if (!event) return;

  const exhausted = event.attempt >= WEBHOOK_MAX_ATTEMPTS;
  await db
    .update(webhookEvents)
    .set({
      processingLog,
      processingStatus: exhausted ? "dead" : "error",
      processingStartedAt: null,
      nextAttemptAt: exhausted ? null : new Date(Date.now() + webhookRetryDelayMs(event.attempt)),
    })
    .where(and(inOrg(webhookEvents), eq(webhookEvents.id, eventId)));
}

/** Atomically owns an errored or abandoned delivery. Only one process receives a row. */
export async function claimWebhookEvent(
  eventId: string,
  now = new Date(),
): Promise<WebhookEvent | null> {
  const staleBefore = new Date(now.getTime() - WEBHOOK_PROCESSING_LEASE_MS);
  const [claimed] = await db
    .update(webhookEvents)
    .set({
      processingStatus: "processing",
      processingAttempt: sql`${webhookEvents.processingAttempt} + 1`,
      processingStartedAt: now,
      nextAttemptAt: null,
    })
    .where(and(
      inOrg(webhookEvents),
      eq(webhookEvents.id, eventId),
      lt(webhookEvents.processingAttempt, WEBHOOK_MAX_ATTEMPTS),
      or(
        and(
          eq(webhookEvents.processingStatus, "error"),
          or(isNull(webhookEvents.nextAttemptAt), lte(webhookEvents.nextAttemptAt, now)),
        ),
        and(
          eq(webhookEvents.processingStatus, "processing"),
          or(isNull(webhookEvents.processingStartedAt), lte(webhookEvents.processingStartedAt, staleBefore)),
        ),
      ),
    ))
    .returning();
  return claimed ?? null;
}

/**
 * Which ledger rows a replay job takes: one account type, and only these
 * events (every event when omitted).
 */
export type WebhookReplayScope = { accountType: string; events?: readonly string[] };

/** The LinkedIn replay job's rows (src/jobs/replayLinkedinWebhooks.ts) — the default. */
export const LINKEDIN_WEBHOOK_REPLAY_SCOPE: WebhookReplayScope = { accountType: "LINKEDIN", events: ["new_relation", "message_received"] };

/**
 * Deliveries due for replay across every organization — the one global read in
 * this file, for the replay jobs, which then run each event inside its own
 * organization's scope.
 */
export async function replayableWebhookEvents(
  limit = 100,
  now = new Date(),
  organizationId?: string,
  scope: WebhookReplayScope = LINKEDIN_WEBHOOK_REPLAY_SCOPE,
): Promise<{ id: string; organizationId: string }[]> {
  const staleBefore = new Date(now.getTime() - WEBHOOK_PROCESSING_LEASE_MS);
  const rows = await db
    .select({ id: webhookEvents.id, organizationId: webhookEvents.organizationId })
    .from(webhookEvents)
    .where(and(
      ...(organizationId ? [eq(webhookEvents.organizationId, organizationId)] : []),
      ...(scope.events ? [inArray(webhookEvents.event, [...scope.events])] : []),
      eq(webhookEvents.accountType, scope.accountType),
      lt(webhookEvents.processingAttempt, WEBHOOK_MAX_ATTEMPTS),
      or(
        and(
          eq(webhookEvents.processingStatus, "error"),
          or(isNull(webhookEvents.nextAttemptAt), lte(webhookEvents.nextAttemptAt, now)),
        ),
        and(
          eq(webhookEvents.processingStatus, "processing"),
          or(isNull(webhookEvents.processingStartedAt), lte(webhookEvents.processingStartedAt, staleBefore)),
        ),
      ),
    ))
    .orderBy(asc(webhookEvents.createdAt))
    .limit(limit);
  return rows;
}

/** Ids only, across every organization — kept for scripts; the job uses replayableWebhookEvents. */
export async function replayableWebhookEventIds(limit = 100, now = new Date()): Promise<string[]> {
  return (await replayableWebhookEvents(limit, now)).map((row) => row.id);
}

const internalReplayIds = new WeakMap<object, string>();

/** Marks an in-process synthetic request; external HTTP callers cannot set this marker. */
export function markInternalWebhookReplay(request: object, eventId: string): void {
  internalReplayIds.set(request, eventId);
}

export function internalWebhookReplayId(request: object): string | null {
  return internalReplayIds.get(request) ?? null;
}

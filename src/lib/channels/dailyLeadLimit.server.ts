import "server-only";

/**
 * The daily lead limit: at most `general.newLeadsPerDay` people contacted
 * for the first time per workspace day, across email, LinkedIn, WhatsApp
 * and Instagram together.
 *
 * No counter is kept. Each engine already writes a durable claim row before
 * it calls the provider, and removes or fails that row itself when the send
 * definitely did not happen; the count is derived from those rows:
 *
 *   email      outreach_emails, every status except a step Do Not Contact
 *              stopped before the provider (EMAIL_DNC_BLOCKED_ERROR)
 *   LinkedIn   "Message" rows of type INVITATION (deleted on a block or an
 *              account-limit revert, kept when the outcome is uncertain)
 *   WhatsApp   whatsapp_campaign_sends in sending or sent (a definite
 *              failure is deleted or marked failed)
 *   Instagram  instagram_outreach_queue in sending, sent or uncertain
 *
 * A person is new on the day of their earliest claim and is counted once,
 * whichever channel reached them first; follow-ups, replies and messages a
 * person sends by hand write none of these rows for someone not already in
 * them. So usage survives restarts, an uncertain claim keeps its place, and
 * a definite failure frees it again through the engine's existing code.
 *
 * newLeadAllowance runs inside an engine's own first-touch claim
 * transaction, after that engine's own lock, and takes the organization's
 * `new-leads:<org>` advisory lock last (lock order is acyclic: no holder of
 * this lock waits for another engine lock). The claim row the engine then
 * writes in the same transaction is the reservation.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { EMAIL_DNC_BLOCKED_ERROR } from "@/lib/outreach/sendRules";
import { currentOrganizationId } from "@/lib/tenancy/scope";
import { dailyLeadLimitReason, leadDayWindow } from "./dailyLeadLimit";
import { channelRules } from "./rules.server";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = Pick<Tx, "execute">;

export type LeadDay = {
  /** general.newLeadsPerDay */
  limit: number;
  /** When the workspace's current day began. */
  start: Date;
  /** When the next one begins: the limit resets then. */
  resetsAt: Date;
  timeZone: string;
  dayStartsAt: string;
};

export type NewLeadAllowance =
  /** `counted`: this person is new and takes one of today's places; false when already contacted on some channel. */
  | { ok: true; counted: boolean; used: number; limit: number }
  /** Today's places are used: write no claim, leave the lead waiting. `reason` starts with DAILY_LEAD_LIMIT_GATE. */
  | { ok: false; used: number; limit: number; resetsAt: Date; timeZone: string; reason: string };

/** The workspace's current lead day and limit, for the organization in scope. */
export async function leadDay(now: Date = new Date()): Promise<LeadDay> {
  const general = await channelRules("general");
  return {
    limit: general.newLeadsPerDay,
    timeZone: general.timeZone,
    dayStartsAt: general.dayStartsAt,
    ...leadDayWindow(general.timeZone, general.dayStartsAt, now),
  };
}

/**
 * The Instagram outreach table is optional (instagramOutreachReady): an
 * install without it has no Instagram claims to count. Once present it is
 * not looked up again; while absent, again after a minute.
 */
let instagramQueue: { exists: boolean; checkedAt: number } | null = null;
async function instagramQueueExists(): Promise<boolean> {
  if (instagramQueue && (instagramQueue.exists || Date.now() - instagramQueue.checkedAt < 60_000)) return instagramQueue.exists;
  const [row] = await db.execute<{ ready: boolean }>(sql`select to_regclass('public.instagram_outreach_queue') is not null as ready`);
  instagramQueue = { exists: Boolean(row?.ready), checkedAt: Date.now() };
  return instagramQueue.exists;
}

/**
 * Every automated outreach claim of the organization, (person_id, at): the
 * instant the claim was written. LinkedIn stores UTC in `timestamp without
 * time zone` (src/lib/linkedin/schema.ts), read here as that instant.
 */
function touches(org: string, instagram: boolean): SQL {
  return sql`
    SELECT l.person_id, coalesce(e.created_at, e.sent_at) AS at
      FROM outreach_emails e
      JOIN outreach_leads l ON l.id = e.lead_id
      JOIN outreach_campaigns c ON c.id = l.campaign_id
     WHERE c.organization_id = ${org}
       AND NOT (e.status = 'failed' AND e.error IS NOT DISTINCT FROM ${EMAIL_DNC_BLOCKED_ERROR})
    UNION ALL
    SELECT ld."personId", (m."createdAt" AT TIME ZONE 'UTC')
      FROM "Message" m
      JOIN "Lead" ld ON ld.id = m."leadId"
     WHERE m."organizationId" = ${org} AND ld."organizationId" = ${org}
       AND m.type = 'INVITATION' AND m."duplicateOfMessageId" IS NULL
    UNION ALL
    SELECT wl.person_id, s.created_at
      FROM whatsapp_campaign_sends s
      JOIN whatsapp_campaign_leads wl ON wl.id = s.lead_id
      JOIN whatsapp_campaigns wc ON wc.id = wl.campaign_id
     WHERE wc.organization_id = ${org} AND s.status IN ('sending', 'sent')${instagram ? sql`
    UNION ALL
    SELECT ig.person_id, ig.attempted_at
      FROM instagram_outreach_queue ig
     WHERE ig.organization_id = ${org} AND ig.status IN ('sending', 'sent', 'uncertain') AND ig.attempted_at IS NOT NULL` : sql``}`;
}

/**
 * A condition on a person id column: true when automated outreach already
 * reached (or may have reached) that person on any channel, so contacting
 * them again takes no place under the limit. For an engine's pick query
 * while the limit is used, so people already contacted are not stuck
 * behind new ones; the claim's newLeadAllowance still decides.
 */
export async function contactedByAutomation(person: SQL): Promise<SQL> {
  return sql`EXISTS (SELECT 1 FROM (${touches(currentOrganizationId(), await instagramQueueExists())}) touched WHERE touched.person_id = ${person})`;
}

async function usage(executor: Executor, org: string, start: Date, personId: string | null): Promise<{ used: number; touched: boolean }> {
  const instagram = await instagramQueueExists();
  const [row] = await executor.execute<{ used: number; touched: boolean }>(sql`
    WITH t AS (${touches(org, instagram)}),
    firsts AS (SELECT person_id, min(at) AS first_at FROM t WHERE person_id IS NOT NULL GROUP BY person_id)
    SELECT (SELECT count(*)::int FROM firsts WHERE first_at >= ${start.toISOString()}::timestamptz) AS used,
           ${personId ? sql`EXISTS (SELECT 1 FROM firsts WHERE person_id = ${personId}::uuid)` : sql`false`} AS touched`);
  return { used: Number(row?.used ?? 0), touched: Boolean(row?.touched) };
}

/** The organization's lock for first-touch claims, taken last in each engine's claim transaction. */
export function newLeadLockKey(organizationId: string): string {
  return `new-leads:${organizationId}`;
}

/**
 * Whether the engine may claim a first automated message to `personId` now.
 * Call it inside the engine's claim transaction, after the engine's own
 * lock and before it writes the claim row; on `ok: false` write nothing.
 */
export async function newLeadAllowance(tx: Tx, input: { personId: string; now?: Date }): Promise<NewLeadAllowance> {
  const org = currentOrganizationId();
  const day = await leadDay(input.now ?? new Date());
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${newLeadLockKey(org)}, 0))`);
  const { used, touched } = await usage(tx, org, day.start, input.personId);
  if (touched) return { ok: true, counted: false, used, limit: day.limit };
  if (used < day.limit) return { ok: true, counted: true, used: used + 1, limit: day.limit };
  return { ok: false, used, limit: day.limit, resetsAt: day.resetsAt, timeZone: day.timeZone, reason: dailyLeadLimitReason(used, day.limit, day.resetsAt, day.timeZone) };
}

/** Today's count against the limit, without the lock: the settings page and the status screens. */
export async function newLeadsToday(now: Date = new Date()): Promise<LeadDay & { used: number }> {
  const day = await leadDay(now);
  const { used } = await usage(db, currentOrganizationId(), day.start, null);
  return { ...day, used };
}

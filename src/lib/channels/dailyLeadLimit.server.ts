import "server-only";

/**
 * The daily lead limit: at most `general.newLeadsPerDay` people contacted
 * for the first time per workspace day, across email, LinkedIn, WhatsApp
 * and Instagram together.
 *
 * The count is a ledger, lead_first_contacts: one row per person, written
 * by recordNewLead in the same transaction as the engine's first-touch claim
 * row (the claim is the reservation; the ledger row is the place). A person
 * is new on the day of that row and is counted once, whichever channel
 * reached them first. The row outlives the campaign, lead and claim rows, so
 * deleting a campaign or a lead, or an engine dropping a claim whose send
 * may have gone out (a timeout), gives no place back. Only a definite
 * failure — the engine knows nothing was sent — releases it
 * (releaseNewLead), and only when no other counted claim reached the person:
 *
 *   email      a step Do Not Contact stopped before the provider
 *              (EMAIL_DNC_BLOCKED_ERROR)
 *   LinkedIn   a claim removed on a block or an account-limit revert
 *   WhatsApp   a claim deleted or failed for a refusal, a ban or a held number
 *   Instagram  a claim marked failed (not uncertain)
 *
 * newLeadAllowance runs inside an engine's own first-touch claim
 * transaction, after that engine's own lock, and takes the organization's
 * `new-leads:<org>` advisory lock last (lock order is acyclic: no holder of
 * this lock waits for another engine lock).
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { leadFirstContacts } from "./schema";
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
 * Every counted automated outreach claim of the organization, (person_id,
 * at): the instant the claim was written. LinkedIn stores UTC in `timestamp
 * without time zone` (src/lib/linkedin/schema.ts), read here as that
 * instant. The ledger was filled from these once (the always-on-sending
 * migration); releaseNewLead reads them to keep a place another claim holds.
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
  return sql`EXISTS (SELECT 1 FROM lead_first_contacts f WHERE f.organization_id = ${currentOrganizationId()} AND f.person_id = ${person})`;
}

async function usage(executor: Executor, org: string, start: Date, personId: string | null): Promise<{ used: number; touched: boolean }> {
  const [row] = await executor.execute<{ used: number; touched: boolean }>(sql`
    SELECT (SELECT count(*)::int FROM lead_first_contacts WHERE organization_id = ${org} AND first_at >= ${start.toISOString()}::timestamptz) AS used,
           ${personId ? sql`EXISTS (SELECT 1 FROM lead_first_contacts WHERE organization_id = ${org} AND person_id = ${personId}::uuid)` : sql`false`} AS touched`);
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

/**
 * Takes today's place for a new person: call it in the claim transaction,
 * right after the engine's claim row is written, when newLeadAllowance said
 * `counted`. `at` is the claim's time (releaseNewLead matches it).
 */
export async function recordNewLead(tx: Tx, input: { personId: string; channel: "email" | "linkedin" | "whatsapp" | "instagram"; at: Date }): Promise<void> {
  await tx.insert(leadFirstContacts).values({ organizationId: currentOrganizationId(), personId: input.personId, firstAt: input.at, channel: input.channel }).onConflictDoNothing();
}

/**
 * Gives a place back after a definite failure (nothing was sent): the
 * person's ledger row, if this claim wrote it (at or after `since`) and no
 * other counted claim reaches them. Call it after the engine has removed or
 * failed its own claim. A claim whose send may have gone out never calls it.
 */
export async function releaseNewLead(executor: Executor, input: { personId: string; since: Date }): Promise<void> {
  const org = currentOrganizationId();
  await executor.execute(sql`
    DELETE FROM lead_first_contacts
     WHERE organization_id = ${org} AND person_id = ${input.personId}::uuid AND first_at >= ${input.since.toISOString()}::timestamptz
       AND NOT EXISTS (SELECT 1 FROM (${touches(org, await instagramQueueExists())}) t WHERE t.person_id = ${input.personId}::uuid)`);
}

/** Today's count against the limit, without the lock: the settings page and the status screens. */
export async function newLeadsToday(now: Date = new Date()): Promise<LeadDay & { used: number }> {
  const day = await leadDay(now);
  const { used } = await usage(db, currentOrganizationId(), day.start, null);
  return { ...day, used };
}

import "server-only";

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { currentOrganizationId } from "@/lib/tenancy/scope";
import { MAX_LEAD_RETRIES } from "@/lib/linkedin/inviteRetry";
import type { PeriodMetrics } from "@/lib/reporting/metrics";
import { LINKEDIN_OUTREACH_TYPES, periodMetrics, reportFilter } from "@/lib/reporting/metrics.server";
import {
  bucketFor,
  bucketStarts,
  ratio,
  toSeries,
  type AnalyticsRange,
  type LinkedinAnalytics,
} from "./contract";
import { inCurrentOrPreviousRange, inPreviousRange, inRange, localDay, num, previousWindow, rangeWindow, runLimited } from "./server";

const CAMPAIGN_ROW_CAP = 25;

// Mirrors MAX_REQUESTS_PER_DAY_PREMIUM / _FREE in src/functions/sendInvitations.ts,
// which are module-private there.
const DAILY_INVITES_PREMIUM = 30;
const DAILY_INVITES_FREE = 5;

/**
 * The LinkedIn tables (Prisma-era) store `timestamp without time zone` holding
 * UTC. The shared range helpers expect a timestamptz, and applying
 * `AT TIME ZONE <viewer tz>` to a naive value would read it as viewer-local
 * time, so every LinkedIn timestamp goes through this first.
 */
const utc = (column: ReturnType<typeof sql>) => sql`(${column} AT TIME ZONE 'UTC')`;

type MessageRow = {
  d: string | null;
  total: boolean;
  invites: unknown;
  messaged: unknown;
};

type ReplyRow = { d: string; replied: unknown };

type AcceptedRow = { d: string | null; total: boolean; accepted: unknown; accepted_prev: unknown };

type AccountRow = {
  id: string;
  name: string | null;
  username: string;
  status: string;
  is_premium: boolean;
  sent_today: unknown;
  pending: unknown;
};

type CampaignRow = {
  id: string;
  name: string;
  status: string;
  leads: unknown;
  invited: unknown;
  accepted: unknown;
  replied: unknown;
};

type CampaignInviteRow = { campaign_id: string; d: string; invites: unknown };

/**
 * LinkedIn view. Eight statements, at most three in flight (runLimited):
 *  1. "Message" (canonical rows LinkedIn accepted only, as the shared send definition
 *     counts them): invites and distinct messaged leads, per day and in total (the
 *     GROUPING SETS total row has `total = true`).
 *  2. Accepted connections, same shape. An acceptance is timestamped
 *     COALESCE(Lead.acceptMessageSentAt, Connection.connectedAt): acceptMessageSentAt is
 *     set on every processed acceptance, with or without acceptance text
 *     (acceptanceMessage.ts), but only when the worker gets to the lead, so a
 *     connection the worker has not reached yet still counts via connectedAt (set by the
 *     connection-accepted webhook). One timestamp per lead, so a lead counts once.
 *  3. Accounts now.
 *  4. Campaigns with lead counts (all time).
 *  5. Invites per campaign per day (Lead.requestSentAt) for sentInRange ordering and trend.
 *  6. Inbound LinkedIn messages per day (the shared reply ledger), for the chart.
 *  7–8. The shared figures (src/lib/reporting/metrics.server.ts) for the range and the one
 *     before: invitations and messages sent, people contacted, contacted who replied,
 *     reply rate — the same numbers Overview shows for LinkedIn.
 *
 * The chart's replies are messages; the KPI and the funnel use the shared distinct count
 * of contacted people who replied.
 *
 * Indexes that would help at scale: "Message" (type, createdAt), "Lead" (requestSentAt).
 */
export async function getLinkedinAnalytics(range: AnalyticsRange): Promise<LinkedinAnalytics> {
  const org = currentOrganizationId();
  const filter = await reportFilter();
  const msgTs = utc(sql`m."createdAt"`);
  const acceptTs = utc(sql`COALESCE(l."acceptMessageSentAt", c."connectedAt")`);
  const inviteTs = utc(sql`l."requestSentAt"`);
  // Start of today in the viewer's zone, back as a naive UTC timestamp like the columns.
  const todayStart = sql`(((date_trunc('day', now() AT TIME ZONE ${range.tz})) AT TIME ZONE ${range.tz}) AT TIME ZONE 'UTC')`;

  const results = await runLimited<unknown>(
    [
      () =>
        db.execute<MessageRow>(sql`
          SELECT d, GROUPING(d) = 1 AS total,
            count(*) FILTER (WHERE type = 'INVITATION')::int AS invites,
            count(DISTINCT lead_id) FILTER (WHERE type <> 'INVITATION')::int AS messaged
          FROM (
            SELECT m.type, m."leadId" AS lead_id, ${localDay(msgTs, range)} AS d
            FROM "Message" m
            WHERE m."organizationId" = ${org} AND m."duplicateOfMessageId" IS NULL
              AND m.type IN ${LINKEDIN_OUTREACH_TYPES} AND m."linkedinMessageId" IS NOT NULL
              AND ${inRange(msgTs, range)}
          ) t
          GROUP BY GROUPING SETS ((), (d))
        `),
      () =>
        db.execute<AcceptedRow>(sql`
          SELECT d, GROUPING(d) = 1 AS total,
            count(*) FILTER (WHERE ${inRange(sql`ts`, range)})::int AS accepted,
            count(*) FILTER (WHERE ${inPreviousRange(sql`ts`, range)})::int AS accepted_prev
          FROM (
            SELECT ${acceptTs} AS ts, ${localDay(acceptTs, range)} AS d
            FROM "Lead" l
            LEFT JOIN "Connection" c ON c."leadId" = l.id AND c."organizationId" = ${org}
            WHERE l."organizationId" = ${org} AND ${inCurrentOrPreviousRange(acceptTs, range)}
          ) t
          GROUP BY GROUPING SETS ((), (d))
        `),
      // pending: PENDING leads with a resolved providerId and retries left that the account may
      // invite under campaign rules (no campaign; or an ACTIVE campaign with no account list, or
      // one that lists this account). Simpler than pendingLeadsSendableByAccount: it does not
      // exclude people this account has already contacted, so it can run slightly high.
      () =>
        db.execute<AccountRow>(sql`
          WITH sent AS (
            SELECT l."linkedinAccountId" AS account_id, count(*)::int AS n
            FROM "Lead" l
            WHERE l."organizationId" = ${org} AND l."requestSentAt" >= ${todayStart} AND l."linkedinAccountId" IS NOT NULL
            GROUP BY 1
          ), pend AS (
            SELECT l."campaignId" AS cid, count(*)::int AS n
            FROM "Lead" l
            WHERE l."organizationId" = ${org} AND l.status = 'PENDING' AND l."providerId" IS NOT NULL
              AND l."inviteRetryCount" < ${MAX_LEAD_RETRIES}
            GROUP BY 1
          )
          SELECT a.id, a.name, a.username, a.status, a."isPremium" AS is_premium,
            COALESCE((SELECT n FROM sent WHERE sent.account_id = a.id), 0) AS sent_today,
            (SELECT COALESCE(sum(pend.n), 0)::int FROM pend
              LEFT JOIN "Campaign" k ON k.id = pend.cid
              WHERE pend.cid IS NULL OR (k.status = 'ACTIVE' AND (
                NOT EXISTS (SELECT 1 FROM "CampaignAccount" ca WHERE ca."campaignId" = k.id)
                OR EXISTS (SELECT 1 FROM "CampaignAccount" ca
                           WHERE ca."campaignId" = k.id AND ca."linkedinAccountId" = a.id)))) AS pending
          FROM "LinkedInAccount" a
          WHERE a."organizationId" = ${org}
          ORDER BY a."createdAt"
        `),
      () =>
        db.execute<CampaignRow>(sql`
          SELECT k.id, k.name, k.status,
            count(l.id)::int AS leads,
            count(l.id) FILTER (WHERE l."requestSentAt" IS NOT NULL)::int AS invited,
            count(l.id) FILTER (WHERE l."acceptMessageSentAt" IS NOT NULL)::int AS accepted,
            count(l.id) FILTER (WHERE l.status = 'REPLIED' OR EXISTS (
              SELECT 1 FROM "Message" m WHERE m."leadId" = l.id AND m.type = 'RECEIVED'
            ))::int AS replied
          FROM "Campaign" k
          LEFT JOIN "Lead" l ON l."campaignId" = k.id AND l."organizationId" = ${org}
          WHERE k."organizationId" = ${org}
          GROUP BY k.id, k.name, k.status
        `),
      () =>
        db.execute<CampaignInviteRow>(sql`
          SELECT l."campaignId" AS campaign_id, ${localDay(inviteTs, range)} AS d, count(*)::int AS invites
          FROM "Lead" l
          WHERE l."organizationId" = ${org} AND l."campaignId" IS NOT NULL AND ${inRange(inviteTs, range)}
          GROUP BY l."campaignId", d
        `),
      () =>
        db.execute<ReplyRow>(sql`
          SELECT ${localDay(sql`m.sent_at`, range)} AS d, count(*)::int AS replied
          FROM crm_conversation_messages m
          WHERE m.direction = 'inbound' AND m.channel = 'linkedin' AND ${inRange(sql`m.sent_at`, range)}
            AND m.conversation_id IN (SELECT id FROM crm_conversations WHERE organization_id = ${org})
          GROUP BY 1
        `),
      () => periodMetrics(rangeWindow(range), filter),
      () => periodMetrics(previousWindow(range), filter),
    ],
    3,
  );
  const messageRows = results[0] as MessageRow[];
  const acceptedRows = results[1] as AcceptedRow[];
  const accountRows = results[2] as AccountRow[];
  const campaignRows = results[3] as CampaignRow[];
  const inviteRows = results[4] as CampaignInviteRow[];
  const replyRows = results[5] as ReplyRow[];
  const current = results[6] as PeriodMetrics;
  const previous = results[7] as PeriodMetrics;

  const mTotal = messageRows.find((r) => r.total);
  const mDays = messageRows.filter((r) => !r.total && r.d !== null) as Array<MessageRow & { d: string }>;
  const aTotal = acceptedRows.find((r) => r.total);
  const aDays = acceptedRows.filter((r) => !r.total && r.d !== null) as Array<AcceptedRow & { d: string }>;

  const invites = current.sent.linkedinInvitations;
  const invitesPrev = previous.sent.linkedinInvitations;
  const accepted = num(aTotal?.accepted);
  const acceptedPrev = num(aTotal?.accepted_prev);
  const replied = current.contactedWhoReplied.byChannel.linkedin;
  const repliedPrev = previous.contactedWhoReplied.byChannel.linkedin;

  const starts = bucketStarts(range);
  const trends = new Map<string, Map<string, number>>();
  for (const r of inviteRows) {
    if (r.d < range.from || r.d > range.to) continue;
    const byBucket = trends.get(r.campaign_id) ?? new Map<string, number>();
    const b = bucketFor(r.d, range);
    byBucket.set(b, (byBucket.get(b) ?? 0) + num(r.invites));
    trends.set(r.campaign_id, byBucket);
  }

  const campaigns = campaignRows
    .map((c) => {
      const byBucket = trends.get(c.id);
      const trend = starts.map((s) => byBucket?.get(s) ?? 0);
      const invitedC = num(c.invited);
      const acceptedC = num(c.accepted);
      return {
        row: {
          id: c.id,
          name: c.name,
          status: c.status,
          leads: num(c.leads),
          invited: invitedC,
          accepted: acceptedC,
          replied: num(c.replied),
          acceptanceRate: ratio(acceptedC, invitedC),
          replyRate: ratio(num(c.replied), acceptedC),
          trend,
        },
        invitedInRange: trend.reduce((a, b) => a + b, 0),
      };
    })
    .sort((a, b) => b.invitedInRange - a.invitedInRange || b.row.leads - a.row.leads)
    .slice(0, CAMPAIGN_ROW_CAP)
    .map((c) => c.row);

  return {
    view: "linkedin",
    range,
    kpis: {
      invites: { value: invites, previous: invitesPrev },
      accepted: { value: accepted, previous: acceptedPrev },
      acceptanceRate: { value: ratio(accepted, invites), previous: ratio(acceptedPrev, invitesPrev) },
      messages: { value: current.sent.linkedinMessages, previous: previous.sent.linkedinMessages },
      contacted: { value: current.peopleContacted.byChannel.linkedin, previous: previous.peopleContacted.byChannel.linkedin },
      replied: { value: replied, previous: repliedPrev },
      replyRate: { value: current.replyRate.byChannel.linkedin, previous: previous.replyRate.byChannel.linkedin },
    },
    activity: toSeries(
      ["invites", "accepted", "replied"] as const,
      range,
      [
        ...mDays.map((r) => ({ date: r.d, invites: num(r.invites) })),
        ...aDays.map((r) => ({ date: r.d, accepted: num(r.accepted) })),
        ...replyRows.map((r) => ({ date: r.d, replied: num(r.replied) })),
      ],
    ),
    funnel: [
      { key: "invited", label: "Invited", value: invites },
      { key: "accepted", label: "Accepted", value: accepted },
      { key: "messaged", label: "Messaged", value: num(mTotal?.messaged) },
      { key: "replied", label: "Replied", value: replied },
    ],
    accounts: accountRows.map((a) => ({
      id: a.id,
      name: a.name ?? a.username,
      status: a.status,
      premium: a.is_premium,
      sentToday: num(a.sent_today),
      dailyLimit: a.is_premium ? DAILY_INVITES_PREMIUM : DAILY_INVITES_FREE,
      pending: num(a.pending),
    })),
    campaigns,
  };
}

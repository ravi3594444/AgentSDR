import "server-only";

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { PeriodMetrics } from "@/lib/reporting/metrics";
import { periodMetrics, reportFilter } from "@/lib/reporting/metrics.server";
import { currentOrganizationId } from "@/lib/tenancy/scope";
import {
  bucketFor,
  bucketStarts,
  ratio,
  toSeries,
  type AnalyticsRange,
  type EmailAnalytics,
} from "./contract";
import { inCurrentOrPreviousRange, inPreviousRange, inRange, localDay, num, previousWindow, rangeWindow, runLimited } from "./server";

const CAMPAIGN_ROW_CAP = 25;

type EmailRow = {
  d: string | null;
  total: boolean;
  first_touch: unknown;
  follow_up: unknown;
  failed: unknown;
};

type ReplyRow = { d: string; replies: unknown };

type SuppressionRow = { bounced: unknown; bounced_prev: unknown; unsub: unknown; unsub_prev: unknown };

type CampaignRow = {
  id: string;
  name: string;
  status: string;
  leads: unknown;
  contacted: unknown;
  replied: unknown;
  bounced: unknown;
};

type CampaignSendRow = { campaign_id: string; d: string; sends: unknown };

type MailboxRow = {
  id: string;
  email_address: string;
  status: string;
  today_emails_sent: number;
  daily_send_limit: number;
};

/**
 * Email view. Eight statements, at most three in flight (runLimited):
 *  1. outreach_emails: first touches and follow-ups sent per day, failed in the range.
 *  2. crm_conversation_messages: inbound email replies per day (the shared reply definition).
 *  3. outreach_suppression_list: bounced / unsubscribed for both periods.
 *  4. campaigns with lead-status counts (all time).
 *  5. sends per campaign per day in the range (feeds sentInRange and the trend).
 *  6. mailboxes now.
 *  7–8. the shared figures (src/lib/reporting/metrics.server.ts) for the range and the one
 *     before: sent, people contacted, contacted who replied, reply rate — the same numbers
 *     Overview shows for email.
 *
 * Indexes that would help at scale: outreach_emails (status, sent_at),
 * crm_conversation_messages (channel, direction, sent_at).
 */
export async function getEmailAnalytics(range: AnalyticsRange): Promise<EmailAnalytics> {
  const org = currentOrganizationId();
  const filter = await reportFilter();
  /** Outreach leads of this organization, reached through their campaign. */
  const orgLeadIds = sql`(SELECT ol.id FROM outreach_leads ol JOIN outreach_campaigns oc ON oc.id = ol.campaign_id WHERE oc.organization_id = ${org})`;
  const sentDay = localDay(sql`e.sent_at`, range);
  const msgDay = localDay(sql`m.sent_at`, range);
  const campaignDay = localDay(sql`e.sent_at`, range);

  const results = await runLimited<unknown>(
    [
      () =>
        db.execute<EmailRow>(sql`
          SELECT d, GROUPING(d) = 1 AS total,
            count(*) FILTER (WHERE status = 'sent' AND step_number = 1)::int AS first_touch,
            count(*) FILTER (WHERE status = 'sent' AND step_number > 1)::int AS follow_up,
            count(*) FILTER (WHERE status = 'failed')::int AS failed
          FROM (
            SELECT e.status, e.step_number,
              CASE WHEN e.status = 'sent' THEN ${sentDay} END AS d
            FROM outreach_emails e
            WHERE ((e.status = 'sent' AND ${inRange(sql`e.sent_at`, range)})
               OR (e.status = 'failed' AND ${inRange(sql`e.created_at`, range)})
            ) AND e.lead_id IN ${orgLeadIds}
          ) t
          GROUP BY GROUPING SETS ((), (d))
        `),
      () =>
        db.execute<ReplyRow>(sql`
          SELECT ${msgDay} AS d, count(*)::int AS replies
          FROM crm_conversation_messages m
          WHERE m.direction = 'inbound' AND m.channel = 'email' AND ${inRange(sql`m.sent_at`, range)}
            AND m.conversation_id IN (SELECT id FROM crm_conversations WHERE organization_id = ${org})
          GROUP BY 1
        `),
      () =>
        db.execute<SuppressionRow>(sql`
          SELECT
            count(*) FILTER (WHERE reason = 'bounced' AND ${inRange(sql`created_at`, range)})::int AS bounced,
            count(*) FILTER (WHERE reason = 'bounced' AND ${inPreviousRange(sql`created_at`, range)})::int AS bounced_prev,
            count(*) FILTER (WHERE reason = 'unsubscribed' AND ${inRange(sql`created_at`, range)})::int AS unsub,
            count(*) FILTER (WHERE reason = 'unsubscribed' AND ${inPreviousRange(sql`created_at`, range)})::int AS unsub_prev
          FROM outreach_suppression_list
          WHERE organization_id = ${org} AND reason IN ('bounced', 'unsubscribed') AND ${inCurrentOrPreviousRange(sql`created_at`, range)}
        `),
      () =>
        db.execute<CampaignRow>(sql`
          SELECT c.id, c.name, c.status,
            count(l.id)::int AS leads,
            count(l.id) FILTER (WHERE l.sequence_status <> 'pending')::int AS contacted,
            count(l.id) FILTER (WHERE l.sequence_status = 'reply_received')::int AS replied,
            count(l.id) FILTER (WHERE l.sequence_status = 'bounced')::int AS bounced
          FROM outreach_campaigns c
          LEFT JOIN outreach_leads l ON l.campaign_id = c.id
          WHERE c.organization_id = ${org}
          GROUP BY c.id, c.name, c.status
          HAVING NOT (c.status = 'draft' AND count(l.id) = 0)
        `),
      () =>
        db.execute<CampaignSendRow>(sql`
          SELECT l.campaign_id, ${campaignDay} AS d, count(*)::int AS sends
          FROM outreach_emails e
          JOIN outreach_leads l ON l.id = e.lead_id
          WHERE e.status = 'sent' AND ${inRange(sql`e.sent_at`, range)}
            AND l.campaign_id IN (SELECT id FROM outreach_campaigns WHERE organization_id = ${org})
          GROUP BY l.campaign_id, d
        `),
      () =>
        db.execute<MailboxRow>(sql`
          SELECT id, email_address, status, today_emails_sent, daily_send_limit
          FROM outreach_mailboxes
          WHERE organization_id = ${org}
          ORDER BY today_emails_sent DESC, email_address
        `),
      () => periodMetrics(rangeWindow(range), filter),
      () => periodMetrics(previousWindow(range), filter),
    ],
    3,
  );
  const emailRows = results[0] as EmailRow[];
  const replyRows = results[1] as ReplyRow[];
  const suppressionRows = results[2] as SuppressionRow[];
  const campaignRows = results[3] as CampaignRow[];
  const campaignSendRows = results[4] as CampaignSendRow[];
  const mailboxRows = results[5] as MailboxRow[];
  const current = results[6] as PeriodMetrics;
  const previous = results[7] as PeriodMetrics;

  const emailTotal = emailRows.find((r) => r.total);
  const emailDays = emailRows.filter((r) => !r.total && r.d !== null) as Array<EmailRow & { d: string }>;
  const sup = suppressionRows[0];

  const starts = bucketStarts(range);
  const trends = new Map<string, Map<string, number>>();
  for (const r of campaignSendRows) {
    if (r.d < range.from || r.d > range.to) continue;
    const byBucket = trends.get(r.campaign_id) ?? new Map<string, number>();
    const b = bucketFor(r.d, range);
    byBucket.set(b, (byBucket.get(b) ?? 0) + num(r.sends));
    trends.set(r.campaign_id, byBucket);
  }

  const campaigns = campaignRows
    .map((c) => {
      const byBucket = trends.get(c.id);
      const trend = starts.map((s) => byBucket?.get(s) ?? 0);
      const contactedC = num(c.contacted);
      const repliedC = num(c.replied);
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        leads: num(c.leads),
        contacted: contactedC,
        sentInRange: trend.reduce((a, b) => a + b, 0),
        replied: repliedC,
        replyRate: ratio(repliedC, contactedC),
        bounced: num(c.bounced),
        trend,
      };
    })
    .sort((a, b) => b.sentInRange - a.sentInRange || b.leads - a.leads)
    .slice(0, CAMPAIGN_ROW_CAP);

  const mailboxes = mailboxRows.map((m) => ({
    id: m.id,
    email: m.email_address,
    status: m.status,
    sentToday: num(m.today_emails_sent),
    dailyLimit: num(m.daily_send_limit),
  }));

  return {
    view: "email",
    range,
    kpis: {
      sent: { value: current.sent.byChannel.email, previous: previous.sent.byChannel.email },
      contacted: { value: current.peopleContacted.byChannel.email, previous: previous.peopleContacted.byChannel.email },
      replied: { value: current.contactedWhoReplied.byChannel.email, previous: previous.contactedWhoReplied.byChannel.email },
      replyRate: { value: current.replyRate.byChannel.email, previous: previous.replyRate.byChannel.email },
      bounced: { value: num(sup?.bounced), previous: num(sup?.bounced_prev) },
      unsubscribed: { value: num(sup?.unsub), previous: num(sup?.unsub_prev) },
    },
    sends: toSeries(
      ["firstTouch", "followUp"] as const,
      range,
      emailDays.map((r) => ({ date: r.d, firstTouch: num(r.first_touch), followUp: num(r.follow_up) })),
    ),
    replies: toSeries(
      ["replies"] as const,
      range,
      replyRows.map((r) => ({ date: r.d, replies: num(r.replies) })),
    ),
    failedSends: num(emailTotal?.failed),
    campaigns,
    mailboxes: {
      total: mailboxes.length,
      connected: mailboxes.filter((m) => m.status === "connected").length,
      failing: mailboxes.filter((m) => m.status === "failed").length,
      sentToday: mailboxes.reduce((a, m) => a + m.sentToday, 0),
      capacityToday: mailboxRows
        .filter((m) => m.status === "connected")
        .reduce((a, m) => a + num(m.daily_send_limit), 0),
      rows: mailboxes,
    },
  };
}

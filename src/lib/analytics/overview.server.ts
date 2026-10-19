import "server-only";

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { REPORT_CHANNELS, type ReportChannel } from "@/lib/reporting/metrics";
import { currentCounts, leadSources, periodMetrics, reportFilter } from "@/lib/reporting/metrics.server";
import { currentOrganizationId } from "@/lib/tenancy/scope";
import {
  ANALYTICS_CHANNELS,
  MEETING_SUBCATEGORY_KEYS,
  type AnalyticsRange,
  type Metric,
  type OverviewAnalytics,
} from "./contract";
import { getCrmSummary, runQueries, STAGE_CHANGE_EVENTS } from "./crm.server";
import { createLimiter, inCurrentOrPreviousRange, inRange, num, previousWindow, rangeWindow } from "./server";

/**
 * The Overview: the CRM summary plus the outreach funnel and channel table.
 * Sends, replies, people contacted and replied, the reply rate, lead sources
 * and the "now" counts are the shared definitions
 * (src/lib/reporting/metrics.server.ts), read for the range and the equally
 * long range before it exactly as Overview (/assistant/results) reads them.
 * Everything goes through one limiter: at most three statements in flight.
 * Counts are per-period events (see contract.ts), so the funnel is not a cohort.
 */

type StageRow = { cur: boolean; ch: string | null; positive: number; meetings: number; customers: number };

const emptyByChannel = () => Object.fromEntries(REPORT_CHANNELS.map((c) => [c, 0])) as Record<ReportChannel, number>;
const isChannel = (ch: string | null): ch is ReportChannel => REPORT_CHANNELS.includes(ch as ReportChannel);

export async function getOverviewAnalytics(range: AnalyticsRange): Promise<OverviewAnalytics> {
  const org = currentOrganizationId();
  const meetingKeys = sql.join(MEETING_SUBCATEGORY_KEYS.map((key) => sql`${key}`), sql`, `);
  const limit = createLimiter(3);
  const filter = await reportFilter();
  const window = rangeWindow(range);

  const [current, previous, now, sources, crmPart, [stageRows, accountRows]] = await Promise.all([
    periodMetrics(window, filter, limit),
    periodMetrics(previousWindow(range), filter, limit),
    currentCounts(filter, limit),
    leadSources(window, filter, limit),
    getCrmSummary(range, limit),
    runQueries(limit, [
      () =>
        // Judgement calls: "positive"/"customer" look at the category a record
        // was moved to (a move within Interested still counts, so meetings are
        // always a subset of positive); by channel, a record belongs to its
        // active_channel now.
        db.execute<StageRow>(sql`
          SELECT ${inRange(sql`e.created_at`, range)} AS cur, r.active_channel AS ch,
            count(DISTINCT e.crm_record_id) FILTER (WHERE e.to_data->>'categoryKey' IN ('interested', 'customer'))::int AS positive,
            count(DISTINCT e.crm_record_id) FILTER (WHERE s.key IN (${meetingKeys}))::int AS meetings,
            count(DISTINCT e.crm_record_id) FILTER (WHERE e.to_data->>'categoryKey' = 'customer')::int AS customers
          FROM crm_events e
          JOIN crm_records r ON r.id = e.crm_record_id AND r.organization_id = ${org}
          LEFT JOIN crm_subcategories s ON s.id = (e.to_data->>'subcategoryId')::uuid
          WHERE e.organization_id = ${org} AND e.event_type IN ${STAGE_CHANGE_EVENTS} AND ${inCurrentOrPreviousRange(sql`e.created_at`, range)}
          GROUP BY GROUPING SETS ((1), (1, 2))`),
      () =>
        // Account health; the queues come from the shared current counts.
        db.execute<Record<string, number>>(sql`
          SELECT
            (SELECT count(*) FROM outreach_mailboxes WHERE organization_id = ${org} AND status = 'failed')::int AS mailboxes,
            (SELECT count(*) FROM "LinkedInAccount" WHERE "organizationId" = ${org} AND status = 'DISCONNECTED')::int AS linkedin,
            (SELECT count(*) FROM whatsapp_accounts WHERE organization_id = ${org} AND status <> 'connected')::int AS whatsapp`),
    ]),
  ]);
  const crm = {
    ...crmPart,
    kpis: { replies: { value: current.replies.total, previous: previous.replies.total }, ...crmPart.kpis },
    drafts: { ...crmPart.drafts, awaitingReview: now.draftsAwaitingReview },
  };

  const stage = {
    all: { cur: { positive: 0, meetings: 0, customers: 0 }, prev: { positive: 0, meetings: 0, customers: 0 } },
    positiveByChannel: emptyByChannel(),
  };
  for (const row of stageRows) {
    if (row.ch === null) {
      stage.all[row.cur ? "cur" : "prev"] = { positive: num(row.positive), meetings: num(row.meetings), customers: num(row.customers) };
    } else if (row.cur && isChannel(row.ch)) {
      stage.positiveByChannel[row.ch] = num(row.positive);
    }
  }

  const metric = (value: number, before: number): Metric => ({ value, previous: before });
  const kpis: OverviewAnalytics["kpis"] = {
    sent: metric(current.sent.total, previous.sent.total),
    contacted: metric(current.peopleContacted.total, previous.peopleContacted.total),
    replied: metric(current.peopleReplied.total, previous.peopleReplied.total),
    contactedWhoReplied: metric(current.contactedWhoReplied.total, previous.contactedWhoReplied.total),
    replyRate: { value: current.replyRate.total, previous: previous.replyRate.total },
    positive: metric(stage.all.cur.positive, stage.all.prev.positive),
    meetings: metric(stage.all.cur.meetings, stage.all.prev.meetings),
    customers: metric(stage.all.cur.customers, stage.all.prev.customers),
  };

  const a = accountRows[0] ?? {};
  // The channel tabs' order, then Instagram when it has activity (it has no tab).
  const shownChannels: ReportChannel[] = [
    ...ANALYTICS_CHANNELS,
    ...REPORT_CHANNELS.filter((channel) => !(ANALYTICS_CHANNELS as readonly string[]).includes(channel)
      && (current.peopleContacted.byChannel[channel] > 0 || current.replies.byChannel[channel] > 0)),
  ];

  return {
    view: "overview",
    range,
    kpis,
    funnel: [
      { key: "contacted", label: "Contacted", value: kpis.contacted.value },
      { key: "replied", label: "Replied", value: kpis.contactedWhoReplied.value },
      { key: "positive", label: "Positive", value: kpis.positive.value },
      { key: "meeting", label: "Meeting", value: kpis.meetings.value },
      { key: "customer", label: "Customer", value: kpis.customers.value },
    ],
    channels: shownChannels.map((channel) => ({
      channel,
      sent: current.sent.byChannel[channel],
      contacted: current.peopleContacted.byChannel[channel],
      replied: current.contactedWhoReplied.byChannel[channel],
      replyRate: current.replyRate.byChannel[channel],
      positive: stage.positiveByChannel[channel],
    })),
    attention: {
      at: now.at,
      needsYou: now.needsYou,
      actionRequired: now.actionRequired,
      overdue: now.followUpsDue,
      draftsAwaitingReview: now.draftsAwaitingReview,
      plansAwaitingStart: now.plansAwaitingStart,
      mailboxesFailing: num(a.mailboxes),
      linkedinDisconnected: num(a.linkedin),
      whatsappDisconnected: num(a.whatsapp),
    },
    metrics: { current, previous },
    now,
    sources,
    crm,
  };
}

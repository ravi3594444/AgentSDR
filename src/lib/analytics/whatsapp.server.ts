import "server-only";

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { currentOrganizationId } from "@/lib/tenancy/scope";
import { outcomeForCall } from "@/lib/calls/overview";
import type { CallStatus } from "@/lib/calls/contract";
import { warmUpEndsAt, whatsappGuardrails } from "@/lib/whatsapp/guardrails";
import { channelRules } from "@/lib/channels/rules.server";
import { dayStart } from "@/lib/reporting/metrics";
import { periodMetrics, reportFilter } from "@/lib/reporting/metrics.server";
import {
  addDays,
  previousRange,
  ratio,
  toSeries,
  type AnalyticsRange,
  type BreakdownRow,
  type WhatsappAnalytics,
  type WhatsappCallOutcome,
} from "./contract";
import { inCurrentOrPreviousRange, inRange, localDay, num, previousWindow, rangeWindow, runLimited } from "./server";

/** runLimited (3 in flight) that keeps each query's own row type. */
function runQueries<const T extends readonly (() => PromiseLike<unknown>)[]>(
  tasks: T,
): Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const wrapped = tasks.map((task) => async () => await task());
  return runLimited(wrapped, 3) as Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }>;
}

/**
 * WhatsApp view: campaign sends with their receipts and replies (the shared
 * definitions, src/lib/reporting/metrics.server.ts, for the range and the
 * one before), calls (call_sessions), chat messages of any origin
 * (whatsapp_*), and the campaign / account snapshots. Eight statements, at
 * most three in flight.
 */

const OUTCOME_LABELS: Record<WhatsappCallOutcome, string> = {
  connected: "Connected",
  didNotPickUp: "Did not pick up",
  notOnWhatsApp: "Not on WhatsApp",
  failed: "Failed",
  inProgress: "In progress",
};
const OUTCOME_ORDER = Object.keys(OUTCOME_LABELS) as WhatsappCallOutcome[];

/**
 * The error text of a call reduced to the two classes that change its
 * outcome (see contactCallStatusForCall in src/lib/calls/contactCallStatus.ts).
 * SQL groups by the class; the outcome itself is still decided in TS by
 * outcomeForCall, so the classification has one source of truth.
 */
const ERROR_CLASS = sql`(CASE WHEN t.error ~* 'isn''t on WhatsApp' THEN 'not_on_whatsapp'
  WHEN t.error ~* '^Upload failed' THEN 'upload_failed' ELSE 'other' END)`;
const CLASS_ERROR: Record<string, string | null> = {
  not_on_whatsapp: "isn't on WhatsApp",
  upload_failed: "Upload failed",
  other: null,
};

export function outcomeForGroup(status: string, errorClass: string): WhatsappCallOutcome {
  return outcomeForCall({ status: status as CallStatus, error: CLASS_ERROR[errorClass] ?? null });
}

/**
 * Judgement call: history imported by "backfill" (src/lib/whatsapp/messages.ts
 * backfillChat) is not marked. It is the only writer that stores a phone/lead
 * message with no `raw` (the live webhook always stores the payload; AgentSDR
 * sends are origin agentsdr) and it inserts long after the message was sent.
 * So a phone/lead row with raw IS NULL that was stored over an hour after its
 * sent_at is treated as backfilled and excluded from message and chat counts.
 */
const LIVE_MESSAGE = sql`NOT (m.raw IS NULL AND m.origin <> 'agentsdr' AND m.created_at - m.sent_at > interval '1 hour')`;

/** Instant at 00:00 of a YYYY-MM-DD date in the range's zone, from the shared calendar. */
const startOf = (date: string, tz: string) => sql`${dayStart(date, tz).toISOString()}::timestamptz`;

type CallRow = { cur: boolean; day: string; status: string; error_class: string; calls: number; talk_ms: number };
type CampaignCallRow = { campaign_id: string; day: string; status: string; error_class: string; calls: number };

export async function getWhatsappAnalytics(range: AnalyticsRange): Promise<WhatsappAnalytics> {
  const { tz } = range;
  const org = currentOrganizationId();
  const filter = await reportFilter();
  /** Chats of this organization's WhatsApp accounts. */
  const orgChatIds = sql`(SELECT wc.id FROM whatsapp_chats wc JOIN whatsapp_accounts wa ON wa.id = wc.account_id WHERE wa.organization_id = ${org})`;
  const prev = previousRange(range);
  const curStart = startOf(range.from, tz);
  const curEnd = startOf(addDays(range.to, 1), tz);
  const prevStart = startOf(prev.from, tz);
  const prevEnd = startOf(addDays(prev.to, 1), tz);
  // Judgement call: a reply counts if it lands within 7 days after the period ends.
  const curReplyBy = startOf(addDays(range.to, 8), tz);
  const prevReplyBy = startOf(addDays(prev.to, 8), tz);
  const endOfToday = sql`((date_trunc('day', now() AT TIME ZONE ${tz}) + interval '1 day') AT TIME ZONE ${tz})`;
  // Same definition as DUE_SQL in src/lib/calls/overview.ts.
  const due = sql`(ccc.stage <> 'done' AND ((ccc.follow_up_at IS NOT NULL AND ccc.follow_up_at < ${endOfToday}) OR (ccc.stage = 'to_call' AND ccc.follow_up_at IS NULL)))`;

  const [callRows, messageRows, chatRows, campaignRows, campaignCallRows, accountRows, current, previous] = await runQueries(
    [
      () =>
        db.execute<CallRow>(sql`
          SELECT ${inRange(sql`t.created_at`, range)} AS cur, ${localDay(sql`t.created_at`, range)} AS day,
                 t.status, ${ERROR_CLASS} AS error_class,
                 count(*)::int AS calls, coalesce(sum(t.duration_ms), 0)::float8 AS talk_ms
          FROM call_sessions t
          WHERE t.organization_id = ${org} AND ${inCurrentOrPreviousRange(sql`t.created_at`, range)}
          GROUP BY 1, 2, 3, 4`),
      () =>
        db.execute<{ cur: boolean; day: string; direction: string; n: number }>(sql`
          SELECT ${inRange(sql`m.sent_at`, range)} AS cur, ${localDay(sql`m.sent_at`, range)} AS day,
                 m.direction, count(*)::int AS n
          FROM whatsapp_messages m
          WHERE m.chat_id IN ${orgChatIds} AND ${inCurrentOrPreviousRange(sql`m.sent_at`, range)} AND ${LIVE_MESSAGE}
          GROUP BY 1, 2, 3`),
      () =>
        // Reply rate: per chat, its first outbound in each period vs the last
        // inbound within 7 days after that period. New chats: first message is
        // AgentSDR's (mirrors the new-chat count in src/lib/whatsapp/send.ts).
        db.execute<Record<string, number>>(sql`
          WITH per_chat AS (
            SELECT m.chat_id,
              min(m.sent_at) FILTER (WHERE m.direction = 'outbound' AND m.sent_at >= ${curStart} AND m.sent_at < ${curEnd}) AS out_cur,
              min(m.sent_at) FILTER (WHERE m.direction = 'outbound' AND m.sent_at >= ${prevStart} AND m.sent_at < ${prevEnd}) AS out_prev,
              max(m.sent_at) FILTER (WHERE m.direction = 'inbound' AND m.sent_at < ${curReplyBy}) AS in_cur,
              max(m.sent_at) FILTER (WHERE m.direction = 'inbound' AND m.sent_at < ${prevReplyBy}) AS in_prev
            FROM whatsapp_messages m
            WHERE m.chat_id IN ${orgChatIds} AND m.sent_at >= ${prevStart} AND m.sent_at < ${curReplyBy} AND ${LIVE_MESSAGE}
            GROUP BY m.chat_id
          ), started AS (
            SELECT f.sent_at, f.origin
            FROM whatsapp_chats c
            CROSS JOIN LATERAL (
              SELECT m.origin, m.sent_at FROM whatsapp_messages m
              WHERE m.chat_id = c.id ORDER BY m.sent_at ASC LIMIT 1
            ) f
            WHERE c.id IN ${orgChatIds} AND c.created_at < ${curEnd}
          )
          SELECT
            (SELECT count(*) FROM per_chat WHERE out_cur IS NOT NULL)::int AS out_cur,
            (SELECT count(*) FROM per_chat WHERE out_cur IS NOT NULL AND in_cur > out_cur)::int AS replied_cur,
            (SELECT count(*) FROM per_chat WHERE out_prev IS NOT NULL)::int AS out_prev,
            (SELECT count(*) FROM per_chat WHERE out_prev IS NOT NULL AND in_prev > out_prev)::int AS replied_prev,
            (SELECT count(*) FROM started WHERE origin = 'agentsdr' AND sent_at >= ${curStart} AND sent_at < ${curEnd})::int AS new_cur,
            (SELECT count(*) FROM started WHERE origin = 'agentsdr' AND sent_at >= ${prevStart} AND sent_at < ${prevEnd})::int AS new_prev`),
      () =>
        db.execute<{ id: string; name: string; leads: number; due: number }>(sql`
          SELECT cc.id, cc.name, count(ccc.id)::int AS leads, count(ccc.id) FILTER (WHERE ${due})::int AS due
          FROM call_campaigns cc
          LEFT JOIN call_campaign_contacts ccc ON ccc.campaign_id = cc.id
          WHERE cc.organization_id = ${org} AND cc.archived_at IS NULL
          GROUP BY cc.id, cc.name, cc.created_at
          ORDER BY cc.created_at DESC
          LIMIT 25`),
      () =>
        db.execute<CampaignCallRow>(sql`
          SELECT ccc.campaign_id, ${localDay(sql`t.created_at`, range)} AS day, t.status, ${ERROR_CLASS} AS error_class,
                 count(*)::int AS calls
          FROM call_sessions t
          JOIN call_campaign_contacts ccc ON ccc.id = t.campaign_contact_id
          WHERE t.organization_id = ${org} AND ${inRange(sql`t.created_at`, range)}
          GROUP BY 1, 2, 3, 4`),
      () =>
        // New chats in the rolling 24 h window, counted as send.ts does: the
        // chat was created in the window and its first message is AgentSDR's.
        db.execute<{
          id: string; name: string | null; phone: string | null; status: string;
          connected_at: Date | string | null; new_chats_24h: number; new_chats_per_day: number | null;
        }>(sql`
          SELECT a.id, a.name, a.phone, a.status, a.connected_at, a.new_chats_per_day,
            (SELECT count(*) FROM whatsapp_chats c
             WHERE c.account_id = a.id AND c.created_at >= now() - interval '24 hours'
               AND (SELECT m.origin FROM whatsapp_messages m WHERE m.chat_id = c.id ORDER BY m.sent_at ASC LIMIT 1) = 'agentsdr'
            )::int AS new_chats_24h
          FROM whatsapp_accounts a
          WHERE a.organization_id = ${org}
          ORDER BY a.is_default DESC, a.created_at ASC`),
      () => periodMetrics(rangeWindow(range), filter),
      () => periodMetrics(previousWindow(range), filter),
    ],
  );

  // ---- calls
  const totals = {
    cur: { calls: 0, connected: 0, talk: 0 },
    prev: { calls: 0, connected: 0, talk: 0 },
  };
  const outcomeCounts = Object.fromEntries(OUTCOME_ORDER.map((o) => [o, 0])) as Record<WhatsappCallOutcome, number>;
  const callDays: Array<{ date: string; connected: number; notConnected: number }> = [];
  for (const row of callRows) {
    const outcome = outcomeForGroup(row.status, row.error_class);
    const n = num(row.calls);
    const t = row.cur ? totals.cur : totals.prev;
    t.calls += n;
    if (outcome === "connected") {
      t.connected += n;
      t.talk += num(row.talk_ms);
    }
    if (!row.cur) continue;
    outcomeCounts[outcome] += n;
    // Judgement call: everything that is not connected, in progress included, is "not connected".
    callDays.push({ date: row.day, connected: outcome === "connected" ? n : 0, notConnected: outcome === "connected" ? 0 : n });
  }

  // ---- messages
  let sentCur = 0, sentPrev = 0, receivedCur = 0, receivedPrev = 0;
  const messageDays: Array<{ date: string; sent: number; received: number }> = [];
  for (const row of messageRows) {
    const n = num(row.n);
    const outbound = row.direction === "outbound";
    if (row.cur) {
      if (outbound) sentCur += n; else receivedCur += n;
      messageDays.push({ date: row.day, sent: outbound ? n : 0, received: outbound ? 0 : n });
    } else if (outbound) sentPrev += n;
    else receivedPrev += n;
  }

  const chat = chatRows[0] ?? {};

  // ---- campaigns
  const byCampaign = new Map<string, { calls: number; connected: number; days: Array<{ date: string; calls: number }> }>();
  for (const row of campaignCallRows) {
    const entry = byCampaign.get(row.campaign_id) ?? { calls: 0, connected: 0, days: [] };
    const n = num(row.calls);
    entry.calls += n;
    if (outcomeForGroup(row.status, row.error_class) === "connected") entry.connected += n;
    entry.days.push({ date: row.day, calls: n });
    byCampaign.set(row.campaign_id, entry);
  }
  const campaigns = campaignRows.map((row) => {
    const entry = byCampaign.get(row.id) ?? { calls: 0, connected: 0, days: [] };
    return {
      id: row.id,
      name: row.name,
      leads: num(row.leads),
      calls: entry.calls,
      connected: entry.connected,
      connectRate: ratio(entry.connected, entry.calls),
      dueToday: num(row.due),
      trend: toSeries(["calls"] as const, range, entry.days).points.map((p) => p.calls),
    };
  });

  // ---- accounts
  const rules = await channelRules("whatsapp");
  const now = new Date();
  const accounts = accountRows.map((row) => ({
    id: row.id,
    name: row.name ?? row.phone ?? "WhatsApp",
    phone: row.phone,
    status: row.status,
    newChats24h: num(row.new_chats_24h),
    newChatLimit: whatsappGuardrails(rules, { newChatsPerDay: row.new_chats_per_day }).newChatsPerDay,
    warmingUpUntil: warmUpEndsAt(row.connected_at ? new Date(row.connected_at) : null, now, rules.warmupHours)?.toISOString() ?? null,
  }));

  const avg = (talk: number, connected: number) => (connected > 0 ? talk / connected : null);
  const outcomes: Array<BreakdownRow<WhatsappCallOutcome>> = OUTCOME_ORDER.map((key) => ({
    key,
    label: OUTCOME_LABELS[key],
    value: outcomeCounts[key],
  }));

  return {
    view: "whatsapp",
    range,
    kpis: {
      calls: { value: totals.cur.calls, previous: totals.prev.calls },
      connected: { value: totals.cur.connected, previous: totals.prev.connected },
      connectRate: { value: ratio(totals.cur.connected, totals.cur.calls), previous: ratio(totals.prev.connected, totals.prev.calls) },
      talkTimeMs: { value: totals.cur.talk, previous: totals.prev.talk },
      avgCallMs: { value: avg(totals.cur.talk, totals.cur.connected), previous: avg(totals.prev.talk, totals.prev.connected) },
      sent: { value: current.sent.byChannel.whatsapp, previous: previous.sent.byChannel.whatsapp },
      delivered: { value: current.delivered.byChannel.whatsapp ?? 0, previous: previous.delivered.byChannel.whatsapp ?? 0 },
      read: { value: current.read.byChannel.whatsapp ?? 0, previous: previous.read.byChannel.whatsapp ?? 0 },
      contacted: { value: current.peopleContacted.byChannel.whatsapp, previous: previous.peopleContacted.byChannel.whatsapp },
      replied: { value: current.contactedWhoReplied.byChannel.whatsapp, previous: previous.contactedWhoReplied.byChannel.whatsapp },
      replyRate: { value: current.replyRate.byChannel.whatsapp, previous: previous.replyRate.byChannel.whatsapp },
      messagesSent: { value: sentCur, previous: sentPrev },
      messagesReceived: { value: receivedCur, previous: receivedPrev },
      chatReplyRate: {
        value: ratio(num(chat.replied_cur), num(chat.out_cur)),
        previous: ratio(num(chat.replied_prev), num(chat.out_prev)),
      },
      newChats: { value: num(chat.new_cur), previous: num(chat.new_prev) },
    },
    calls: toSeries(["connected", "notConnected"] as const, range, callDays),
    outcomes,
    messages: toSeries(["sent", "received"] as const, range, messageDays),
    campaigns,
    accounts,
  };
}

import "server-only";

import { and, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { REPORT_KINDS } from "@/lib/assistant/handoff";
import { outreachRuns } from "@/lib/assistant/schema";
import { channelRules } from "@/lib/channels/rules.server";
import { crmActionableSql, crmActionGroupSql, RAW_RECORD_COLUMNS } from "@/lib/crm/actionGroups.server";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { resolveTimeZone } from "@/lib/timeZone";
import {
  assemblePeriodMetrics,
  leadSourceKey,
  summarizeLeadSources,
  WHOLE_ORGANIZATION,
  type CurrentCounts,
  type LeadSources,
  type MetricRow,
  type PeriodMetrics,
  type ReportScope,
  type ReportWindow,
} from "./metrics";

/**
 * The SQL behind the shared metric definitions (metrics.ts). Overview
 * (results.server.ts) and Analytics (src/lib/analytics/*.server.ts) both
 * read their shared figures here, from the engines' own ledgers:
 *
 * - sends: outreach_emails 'sent', whatsapp_campaign_sends 'sent' (with the
 *   WhatsApp message's delivery and read receipts), LinkedIn "Message" rows
 *   the provider gave an id (a claim without one is in flight, failed or
 *   uncertain), instagram_outreach_queue 'sent';
 * - replies: inbound crm_conversation_messages;
 * - leads: lead_audience_members, with the provider of the search job that
 *   filled the list;
 * - now: owner_decisions, crm_drafts, the Action required queue, plans and
 *   sequences, counted as the navigation badges count them.
 *
 * Everything filters by the current organization, and by the scope's runs,
 * lists and jobs when one is given. Read-only: nothing here starts, approves
 * or sends anything.
 */

/** Runs one query when a slot is free (an Analytics limiter); the default runs it at once. */
export type RunQuery = <T>(task: () => PromiseLike<T>) => Promise<T>;
const direct: RunQuery = async (task) => await task();

/** The organization's business time zone: the "general" Sending rule, else UTC. Both pages report in it. */
export async function organizationTimeZone(): Promise<string> {
  const rules = await channelRules("general").catch(() => null);
  return resolveTimeZone(typeof rules?.timeZone === "string" ? rules.timeZone : "UTC");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validIds = (values: readonly string[]) => [...new Set(values.filter((value) => UUID.test(value)))];

function uuidArray(values: readonly string[]): SQL {
  const valid = validIds(values);
  return valid.length ? sql`ARRAY[${sql.join(valid.map((value) => sql`${value}`), sql`, `)}]::uuid[]` : sql`ARRAY[]::uuid[]`;
}

function textArray(values: readonly string[]): SQL {
  const unique = [...new Set(values)];
  return unique.length ? sql`ARRAY[${sql.join(unique.map((value) => sql`${value}`), sql`, `)}]::text[]` : sql`ARRAY[]::text[]`;
}

/** A scope as the conditions every ledger query adds; nothing for the whole organization. */
export type ReportFilter = {
  org: string;
  scoped: boolean;
  runs: SQL;
  audiences: SQL;
  jobs: SQL;
  emailCampaigns: SQL;
  whatsappCampaigns: SQL;
  linkedinCampaigns: SQL;
  /** The people the scope's runs cover. */
  runPeople: SQL;
  /** ` AND condition` when scoped; empty for the whole organization. */
  only: (condition: SQL) => SQL;
};

export async function reportFilter(scope: ReportScope = WHOLE_ORGANIZATION): Promise<ReportFilter> {
  const org = currentOrganizationId();
  const scoped = scope.kind !== "organization";
  const runIds = validIds(scope.runIds);
  const runs = scoped && runIds.length
    ? await db.select({ id: outreachRuns.id, campaigns: outreachRuns.campaigns }).from(outreachRuns).where(and(inOrg(outreachRuns), inArray(outreachRuns.id, runIds)))
    : [];
  const campaignsOf = (channel: "email" | "whatsapp" | "linkedin") => runs.flatMap((run) => (run.campaigns[channel] ? [run.campaigns[channel]!] : []));
  const R = uuidArray(scope.runIds);
  return {
    org,
    scoped,
    runs: R,
    audiences: uuidArray(scope.audienceIds),
    jobs: uuidArray(scope.jobIds),
    emailCampaigns: uuidArray(campaignsOf("email")),
    whatsappCampaigns: uuidArray(campaignsOf("whatsapp")),
    linkedinCampaigns: textArray(campaignsOf("linkedin")),
    runPeople: sql`(SELECT rl.person_id FROM outreach_run_leads rl WHERE rl.organization_id = ${org} AND rl.run_id = ANY(${R}))`,
    only: (condition: SQL) => (scoped ? sql` AND ${condition}` : sql``),
  };
}

/** `column` (a timestamptz) falls inside the window. */
export function inWindow(column: SQL, window: Pick<ReportWindow, "from" | "to">): SQL {
  const to = sql`${window.to.toISOString()}::timestamptz`;
  return window.from ? sql`(${column} >= ${window.from.toISOString()}::timestamptz AND ${column} < ${to})` : sql`${column} < ${to}`;
}

/** The LinkedIn tables store UTC in `timestamp without time zone`; this reads one as the instant it is. */
export const linkedinInstant = (column: SQL) => sql`(${column} AT TIME ZONE 'UTC')`;

/** LinkedIn message types that are outreach sends: the invitation, the acceptance message and the follow-ups. */
export const LINKEDIN_OUTREACH_TYPES = sql`('INVITATION', 'ACCEPTANCE', 'FOLLOW_UP_1', 'FOLLOW_UP_2', 'FOLLOW_UP_3')`;

/**
 * Every provider-accepted outreach send in the window, one row each:
 * (channel, kind, person_id, at, delivered, read). Receipts are null on
 * channels that report none.
 */
export function sendLedger(window: Pick<ReportWindow, "from" | "to">, f: ReportFilter): SQL {
  return sql`
    SELECT 'email'::text AS channel, 'message'::text AS kind, l.person_id, e.sent_at AS at, NULL::boolean AS delivered, NULL::boolean AS read
      FROM outreach_emails e JOIN outreach_leads l ON l.id = e.lead_id JOIN outreach_campaigns c ON c.id = l.campaign_id
     WHERE c.organization_id = ${f.org} AND e.status = 'sent' AND ${inWindow(sql`e.sent_at`, window)}${f.only(sql`c.id = ANY(${f.emailCampaigns})`)}
    UNION ALL
    SELECT 'whatsapp', 'message', l.person_id, s.sent_at, (wm.delivered_at IS NOT NULL OR wm.read_at IS NOT NULL), (wm.read_at IS NOT NULL)
      FROM whatsapp_campaign_sends s JOIN whatsapp_campaign_leads l ON l.id = s.lead_id JOIN whatsapp_campaigns c ON c.id = l.campaign_id
      LEFT JOIN whatsapp_messages wm ON wm.id = s.whatsapp_message_id
     WHERE c.organization_id = ${f.org} AND s.status = 'sent' AND ${inWindow(sql`s.sent_at`, window)}${f.only(sql`c.id = ANY(${f.whatsappCampaigns})`)}
    UNION ALL
    SELECT 'linkedin', CASE WHEN m.type = 'INVITATION' THEN 'invitation' ELSE 'message' END, l."personId", ${linkedinInstant(sql`m."createdAt"`)}, NULL, NULL
      FROM "Message" m JOIN "Lead" l ON l.id = m."leadId"
     WHERE m."organizationId" = ${f.org} AND l."organizationId" = ${f.org}
       AND m."linkedinMessageId" IS NOT NULL AND m."duplicateOfMessageId" IS NULL AND m.type IN ${LINKEDIN_OUTREACH_TYPES}
       AND ${inWindow(linkedinInstant(sql`m."createdAt"`), window)}${f.only(sql`l."campaignId" = ANY(${f.linkedinCampaigns})`)}
    UNION ALL
    SELECT 'instagram', 'message', q.person_id, q.sent_at, NULL, NULL
      FROM instagram_outreach_queue q
     WHERE q.organization_id = ${f.org} AND q.status = 'sent' AND ${inWindow(sql`q.sent_at`, window)}${f.only(sql`q.run_id = ANY(${f.runs})`)}`;
}

/** Every inbound message in the window: (channel, person_id, at). */
export function replyLedger(window: Pick<ReportWindow, "from" | "to">, f: ReportFilter): SQL {
  return sql`
    SELECT m.channel, m.person_id, m.sent_at AS at
      FROM crm_conversation_messages m JOIN crm_conversations c ON c.id = m.conversation_id
     WHERE c.organization_id = ${f.org} AND m.direction = 'inbound' AND ${inWindow(sql`m.sent_at`, window)}${f.only(sql`m.person_id IN ${f.runPeople}`)}`;
}

/** Sent, delivered, read, replies, people contacted and replied, and the reply rate for one window. One statement. */
export async function periodMetrics(window: Pick<ReportWindow, "from" | "to">, filter: ReportFilter, run: RunQuery = direct): Promise<PeriodMetrics> {
  const rows = await run(() => db.execute<MetricRow>(sql`
    WITH s AS (${sendLedger(window, filter)}),
    r AS (${replyLedger(window, filter)}),
    fc AS (SELECT channel, person_id, min(at) AS first_at FROM s WHERE person_id IS NOT NULL GROUP BY 1, 2),
    fa AS (SELECT person_id, min(first_at) AS first_at FROM fc GROUP BY 1)
    SELECT 'send'::text AS section, s.channel, s.kind, count(*)::int AS n, count(DISTINCT s.person_id)::int AS people,
           count(*) FILTER (WHERE s.delivered)::int AS delivered, count(*) FILTER (WHERE s.read)::int AS read
      FROM s GROUP BY GROUPING SETS ((s.channel, s.kind), (s.channel), ())
    UNION ALL
    SELECT 'reply', r.channel, NULL, count(*)::int, count(DISTINCT r.person_id)::int, 0, 0
      FROM r GROUP BY GROUPING SETS ((r.channel), ())
    UNION ALL
    SELECT 'replied_after', fc.channel, NULL, 0, count(DISTINCT fc.person_id)::int, 0, 0
      FROM fc JOIN r ON r.person_id = fc.person_id AND r.channel = fc.channel AND r.at >= fc.first_at
     GROUP BY fc.channel
    UNION ALL
    SELECT 'replied_after', NULL, NULL, 0, count(DISTINCT fa.person_id)::int, 0, 0
      FROM fa JOIN r ON r.person_id = fa.person_id AND r.at >= fa.first_at`));
  return assemblePeriodMetrics([...rows]);
}

/** Leads still in an active sequence, per channel, now. */
function stillToSendSql(f: ReportFilter): SQL {
  return sql`
    (SELECT count(*) FROM outreach_leads l JOIN outreach_campaigns c ON c.id = l.campaign_id
      WHERE c.organization_id = ${f.org} AND c.status = 'active' AND l.sequence_status IN ('pending', 'initial_sent', 'in_follow_up')${f.only(sql`c.id = ANY(${f.emailCampaigns})`)})::int AS email,
    (SELECT count(*) FROM whatsapp_campaign_leads l JOIN whatsapp_campaigns c ON c.id = l.campaign_id
      WHERE c.organization_id = ${f.org} AND c.status = 'active' AND l.status IN ('queued', 'in_sequence')${f.only(sql`c.id = ANY(${f.whatsappCampaigns})`)})::int AS whatsapp,
    (SELECT count(*) FROM "Lead" l JOIN "Campaign" c ON c.id = l."campaignId" WHERE l."organizationId" = ${f.org} AND c.status = 'ACTIVE'
      AND l.status IN ('PENDING', 'REQUEST_SENT', 'CONNECTED', 'ACCEPT_MESSAGE_SENT', 'FOLLOW_UP_1_SENT', 'FOLLOW_UP_2_SENT')${f.only(sql`c.id = ANY(${f.linkedinCampaigns})`)})::int AS linkedin,
    (SELECT count(*) FROM instagram_outreach_queue q JOIN outreach_runs r ON r.id = q.run_id
      WHERE q.organization_id = ${f.org} AND r.status = 'running' AND q.status IN ('queued', 'resolving', 'sending')${f.only(sql`q.run_id = ANY(${f.runs})`)})::int AS instagram`;
}

const n = (value: unknown) => Number(value ?? 0) || 0;

/** What waits right now, whatever the period: Needs you, drafts, Action required, follow-ups due, plans waiting for Start, leads still to send. */
export async function currentCounts(filter: ReportFilter, run: RunQuery = direct): Promise<CurrentCounts> {
  const f = filter;
  const reports = sql.join(REPORT_KINDS.map((kind) => sql`${kind}`), sql`, `);
  const decisionScope = f.only(sql`(run_id = ANY(${f.runs}) OR person_id IN ${f.runPeople})`);
  const recordScope = f.only(sql`r.person_id IN ${f.runPeople}`);
  const at = new Date();
  const [counts, decisions, plans] = await Promise.all([
    run(() => db.execute<Record<string, unknown>>(sql`
      SELECT
        (SELECT count(*) FROM owner_decisions WHERE organization_id = ${f.org} AND status = 'open' AND kind NOT IN (${reports})${decisionScope})::int AS needs_you,
        (SELECT count(*) FROM crm_drafts d JOIN crm_records r ON r.id = d.crm_record_id
          WHERE r.organization_id = ${f.org} AND d.status = 'awaiting_review'${recordScope})::int AS drafts,
        (SELECT count(*) FROM crm_records r WHERE r.organization_id = ${f.org} AND ${crmActionableSql(RAW_RECORD_COLUMNS)}${recordScope})::int AS action_required,
        (SELECT count(*) FROM crm_records r WHERE r.organization_id = ${f.org} AND ${crmActionGroupSql(RAW_RECORD_COLUMNS)} = 'follow_up'${recordScope})::int AS follow_ups_due,
        ${stillToSendSql(f)}`)),
    run(() => db.execute<{ kind: string; n: number }>(sql`
      SELECT kind, count(*)::int AS n FROM owner_decisions
       WHERE organization_id = ${f.org} AND status = 'open'${decisionScope}
       GROUP BY kind ORDER BY n DESC, kind`)),
    run(() => db.execute<{ id: string; name: string; total: number }>(sql`
      SELECT id, name, count(*) OVER ()::int AS total FROM outreach_runs
       WHERE organization_id = ${f.org} AND status = 'proposed'${f.only(sql`id = ANY(${f.runs})`)}
       ORDER BY created_at DESC LIMIT 5`)),
  ]);
  const row = [...counts][0] ?? {};
  const byKind = [...decisions].map((d) => ({ kind: String(d.kind), count: n(d.n) }));
  const awaiting = [...plans];
  return {
    at: at.toISOString(),
    needsYou: n(row.needs_you),
    openDecisions: byKind.reduce((sum, d) => sum + d.count, 0),
    decisionsByKind: byKind,
    draftsAwaitingReview: n(row.drafts),
    actionRequired: n(row.action_required),
    followUpsDue: n(row.follow_ups_due),
    plansAwaitingStart: n(awaiting[0]?.total),
    plansAwaiting: awaiting.map((plan) => ({ id: String(plan.id), name: String(plan.name) })),
    stillToSend: { email: n(row.email), whatsapp: n(row.whatsapp), linkedin: n(row.linkedin), instagram: n(row.instagram) },
  };
}

type SourceRow = { part: "combination" | "unsaved" | "example"; sources: string[]; people: number; contactable: number; name: string | null };

/** A raw "source|provider" pair from SQL as the shared source key. */
function keyOf(raw: string): string {
  const at = raw.lastIndexOf("|");
  return at < 0 ? leadSourceKey(raw, null) : leadSourceKey(raw.slice(0, at), raw.slice(at + 1) || null);
}

/**
 * Qualified and contactable people per source and provider, each person
 * once in the total, with every source that found them. A lead's provider
 * is the one its search job recorded: Google Maps searches record the
 * built-in scraper or Apify, website searches their search provider.
 * Contactability is the person's latest membership in the window.
 */
export async function leadSources(window: Pick<ReportWindow, "from" | "to">, filter: ReportFilter, run: RunQuery = direct): Promise<LeadSources> {
  const f = filter;
  const rows = await run(() => db.execute<SourceRow>(sql`
    WITH mem AS (
      SELECT m.audience_id, m.person_id, m.status, m.created_at, m.name, m.source
        FROM lead_audience_members m
       WHERE m.organization_id = ${f.org} AND ${inWindow(sql`m.created_at`, window)}${f.only(sql`m.audience_id = ANY(${f.audiences})`)}
    ), prov AS (
      SELECT DISTINCT ON (j.audience_id, j.kind) j.audience_id, j.kind,
             CASE WHEN j.kind = 'web_discovery' THEN j.payload->>'searchProvider' ELSE j.payload->>'provider' END AS provider
        FROM assistant_jobs j
       WHERE j.organization_id = ${f.org} AND j.audience_id IN (SELECT audience_id FROM mem)
         AND (j.kind = 'web_discovery' OR (j.kind = 'discovery' AND coalesce(j.payload->>'target', 'maps') = 'maps'))
       ORDER BY j.audience_id, j.kind, j.created_at DESC
    ), keyed AS (
      SELECT mem.person_id, mem.status, mem.created_at, mem.name,
             mem.source || '|' || coalesce(CASE
               WHEN mem.source = 'google_maps' THEN pd.provider
               WHEN mem.source = 'web_search' OR mem.source LIKE 'discovery:web%' THEN pw.provider
             END, '') AS raw_key
        FROM mem
        LEFT JOIN prov pd ON pd.audience_id = mem.audience_id AND pd.kind = 'discovery'
        LEFT JOIN prov pw ON pw.audience_id = mem.audience_id AND pw.kind = 'web_discovery'
    ), per_person AS (
      SELECT person_id,
             array_agg(DISTINCT raw_key ORDER BY raw_key) AS sources,
             (array_agg(status ORDER BY created_at DESC))[1] = 'eligible' AS contactable,
             (array_agg(name ORDER BY created_at DESC))[1] AS name
        FROM keyed WHERE person_id IS NOT NULL GROUP BY person_id
    )
    SELECT 'combination' AS part, sources, count(*)::int AS people, count(*) FILTER (WHERE contactable)::int AS contactable, NULL::text AS name
      FROM per_person GROUP BY sources
    UNION ALL
    SELECT 'unsaved', ARRAY[raw_key], count(*)::int, 0, NULL FROM keyed WHERE person_id IS NULL GROUP BY raw_key
    UNION ALL
    (SELECT 'example', sources, 1, 0, name FROM per_person WHERE cardinality(sources) > 1 ORDER BY name LIMIT 10)`));

  // Provider spellings that are one source merge here, so a person's set is re-deduplicated.
  const combinations = new Map<string, { sources: string[]; people: number; contactable: number }>();
  const unsaved: { source: string; count: number }[] = [];
  const examples: { name: string; sources: string[] }[] = [];
  for (const row of rows) {
    const keys = [...new Set((row.sources ?? []).map(keyOf))].sort();
    if (row.part === "combination") {
      const id = keys.join("\n");
      const entry = combinations.get(id) ?? { sources: keys, people: 0, contactable: 0 };
      entry.people += n(row.people);
      entry.contactable += n(row.contactable);
      combinations.set(id, entry);
    } else if (row.part === "unsaved") {
      unsaved.push({ source: keys[0] ?? "unknown", count: n(row.people) });
    } else if (keys.length > 1) {
      examples.push({ name: row.name ?? "A lead", sources: keys });
    }
  }
  return summarizeLeadSources({ combinations: [...combinations.values()], unsaved, examples });
}

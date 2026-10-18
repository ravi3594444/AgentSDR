import "server-only";

import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { getByokSettings } from "@/lib/ai/byok";
import { AUTOPILOT_LIMITS } from "@/lib/crm/autopilot";
import { channelRules } from "@/lib/channels/rules.server";
import { describeOpening, describeWeeklyHours, sendingWindow } from "@/lib/channels/sendingWindow";
import { isMigrationControlPaused } from "@/lib/migration/controls";
import { mailboxProviderConnected } from "@/lib/outreach/mailboxProviders";
import { mailboxes } from "@/lib/outreach/schema";
import { resolveTimeZone } from "@/lib/timeZone";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { emailSendingStatus, mailboxDailyRoom } from "./sendingStatus";
import { listRuns, reportRun } from "./outreach.server";
import {
  describeChannelSending,
  figure,
  money,
  ORGANIZATION_SCOPE,
  periodFor,
  scopeIsEmpty,
  scopeLabel,
  summarizeSources,
  type ChannelSending,
  type Period,
  type PeriodKind,
  type ResultsScope,
  type SourceYield,
} from "./results";
import { assistantJobs, assistantMessages, outreachRuns } from "./schema";

/**
 * The owner's results for a period, from what the app recorded: sends from
 * each engine's send records (so someone contacted stays counted after they
 * unsubscribe or change status), replies from the CRM's inbound messages,
 * interest from applied classifications, decisions and automatic replies
 * from the assistant's own ledgers, AI spending from recorded provider
 * costs. LinkedIn connection requests are counted apart from messages.
 * Drafts are never sends; interested is never a sale; a running plan is
 * not a send. A figure the app does not record is null ("not measured").
 *
 * A scope narrower than the organization (results.ts ResultsScope) limits
 * every ledger query to the runs, lead lists and jobs of one run, request
 * or chat: sends through those runs' campaigns, replies, decisions and
 * drafts of the people those runs cover, leads of those lists, spending
 * recorded against those runs. Limits and sending checks stay
 * organization-wide.
 */

export type Results = {
  period: Period;
  scope: { kind: ResultsScope["kind"]; label: string; runs: number; jobs: number; empty: boolean };
  leads: {
    discovered: number;
    imported: number;
    duplicates: number;
    usable: number;
    leftOut: number;
    leftOutReasons: { reason: string; count: number }[];
    /** What each source produced, and how much of it can be reached. */
    bySource: SourceYield[];
  };
  outreach: {
    peopleContacted: number;
    emailsSent: number;
    whatsappSent: number;
    instagramSent: number;
    linkedinInvitations: number;
    linkedinMessages: number;
    repliesReceived: number;
    peopleReplied: number;
    interested: number;
    automaticReplies: number;
    repliesByYou: number;
  };
  interestedPeople: { name: string; what: string | null; at: string }[];
  /**
   * What waits for the owner: replies to review and reply decisions (Needs
   * you), and, apart from those, plans prepared and waiting for Start.
   */
  attention: {
    repliesWaiting: number;
    openDecisions: number;
    byKind: { kind: string; count: number }[];
    heldByAutopilot: { reason: string; count: number }[];
    plansAwaitingStart: number;
    plansAwaiting: { id: string; name: string }[];
  };
  pending: { emailFollowUps: number; whatsappFollowUps: number; linkedinSteps: number; instagramDms: number };
  /** Snapshot of recorded sending gates, not worker liveness. */
  sending: { email: ChannelSending; whatsapp: ChannelSending };
  stopped: { optedOut: number; suppressed: { reason: string; count: number }[]; runLeadsStopped: number };
  failures: { channel: string; reason: string; count: number }[];
  spending: { aiRecordedUsd: number; aiCalls: number; aiCallsWithoutCost: number; byKind: { kind: string; usd: number; calls: number }[]; researchUsd: number; dataSources: string };
  limits: { automaticRepliesLeft24h: number; emailsLeftToday: number | null; researchLeftToday: number | null; whatsappNewChatsLeftToday: null };
  runs: { id: string; name: string; status: string; mode: "Automatic" | "Review"; channels: { channel: string; contacted: number; messagesSent: number | null; replied: number; stopped: number }[] }[];
};

type Row = Record<string, unknown>;

async function rows(query: SQL): Promise<Row[]> {
  return (await db.execute(query)) as unknown as Row[];
}

async function one(query: SQL): Promise<Row> {
  return (await rows(query))[0] ?? {};
}

const n = (value: unknown) => Number(value ?? 0) || 0;

export async function organizationTimeZone(): Promise<string> {
  const rules = await channelRules("general").catch(() => null);
  return resolveTimeZone(typeof rules?.timeZone === "string" ? rules.timeZone : "UTC");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidArray(values: readonly string[]): SQL {
  const valid = [...new Set(values.filter((value) => UUID.test(value)))];
  return valid.length ? sql`ARRAY[${sql.join(valid.map((value) => sql`${value}`), sql`, `)}]::uuid[]` : sql`ARRAY[]::uuid[]`;
}

function textArray(values: readonly string[]): SQL {
  const unique = [...new Set(values)];
  return unique.length ? sql`ARRAY[${sql.join(unique.map((value) => sql`${value}`), sql`, `)}]::text[]` : sql`ARRAY[]::text[]`;
}

/** One run's scope: the run, its lead list, and the jobs that searched for it or launch it. */
export async function runScope(runId: string): Promise<ResultsScope | null> {
  const [run] = await db.select({ id: outreachRuns.id, name: outreachRuns.name, audienceId: outreachRuns.audienceId }).from(outreachRuns)
    .where(and(inOrg(outreachRuns), eq(outreachRuns.id, runId))).limit(1);
  if (!run) return null;
  const jobs = await db.select({ id: assistantJobs.id }).from(assistantJobs)
    .where(and(inOrg(assistantJobs), or(eq(assistantJobs.runId, run.id), eq(assistantJobs.audienceId, run.audienceId))));
  return { kind: "run", name: run.name, runIds: [run.id], audienceIds: [run.audienceId], jobIds: jobs.map((job) => job.id) };
}

/**
 * One owner request's scope (its message id): the plans that carry it as
 * their requestId, the searches started for it (requestMessageId, or the
 * outreach request of contactAfter), their lead lists, and the plans'
 * launch jobs.
 */
export async function requestScope(requestId: string): Promise<ResultsScope> {
  const [runs, searches] = await Promise.all([
    db.select({ id: outreachRuns.id, audienceId: outreachRuns.audienceId }).from(outreachRuns)
      .where(and(inOrg(outreachRuns), sql`${outreachRuns.plan} ->> 'requestId' = ${requestId}`)),
    db.select({ id: assistantJobs.id, audienceId: assistantJobs.audienceId }).from(assistantJobs)
      .where(and(inOrg(assistantJobs), or(
        sql`${assistantJobs.payload} ->> 'requestMessageId' = ${requestId}`,
        sql`${assistantJobs.payload} -> 'contactAfter' ->> 'requestId' = ${requestId}`,
      ))),
  ]);
  return withLaunchJobs({ kind: "request", runIds: runs.map((run) => run.id), audienceIds: [...runs.map((run) => run.audienceId), ...searches.flatMap((job) => (job.audienceId ? [job.audienceId] : []))], jobIds: searches.map((job) => job.id) });
}

/** One chat's scope: its plans (by thread, or shown in it), its jobs and the lead lists they used. */
export async function threadScope(threadId: string): Promise<ResultsScope> {
  const [runs, shown, jobs] = await Promise.all([
    db.select({ id: outreachRuns.id, audienceId: outreachRuns.audienceId }).from(outreachRuns)
      .where(and(inOrg(outreachRuns), eq(outreachRuns.threadId, threadId))),
    db.selectDistinct({ runId: sql<string>`${assistantMessages.toolResult} -> 'data' ->> 'runId'` }).from(assistantMessages)
      .where(and(inOrg(assistantMessages), eq(assistantMessages.threadId, threadId), sql`${assistantMessages.toolResult} -> 'data' ->> 'runId' is not null`)),
    db.select({ id: assistantJobs.id, audienceId: assistantJobs.audienceId }).from(assistantJobs)
      .where(and(inOrg(assistantJobs), eq(assistantJobs.threadId, threadId))),
  ]);
  const shownIds = shown.map((row) => row.runId).filter((id) => UUID.test(id) && !runs.some((run) => run.id === id));
  const extra = shownIds.length
    ? await db.select({ id: outreachRuns.id, audienceId: outreachRuns.audienceId }).from(outreachRuns).where(and(inOrg(outreachRuns), inArray(outreachRuns.id, shownIds)))
    : [];
  const all = [...runs, ...extra];
  return withLaunchJobs({ kind: "thread", runIds: all.map((run) => run.id), audienceIds: [...all.map((run) => run.audienceId), ...jobs.flatMap((job) => (job.audienceId ? [job.audienceId] : []))], jobIds: jobs.map((job) => job.id) });
}

async function withLaunchJobs(scope: ResultsScope): Promise<ResultsScope> {
  const launches = scope.runIds.length
    ? await db.select({ id: assistantJobs.id }).from(assistantJobs).where(and(inOrg(assistantJobs), inArray(assistantJobs.runId, scope.runIds)))
    : [];
  return { ...scope, audienceIds: [...new Set(scope.audienceIds)], jobIds: [...new Set([...scope.jobIds, ...launches.map((job) => job.id)])] };
}

export async function results(kind: PeriodKind, now = new Date(), scope: ResultsScope = ORGANIZATION_SCOPE): Promise<Results> {
  const period = periodFor(kind, await organizationTimeZone(), now);
  const org = currentOrganizationId();
  const from = period.from;
  const to = period.to;
  const ts = (value: Date) => sql`${value.toISOString()}::timestamptz`;
  const inRange = (column: SQL) => (from ? sql`${column} >= ${ts(from)} AND ${column} < ${ts(to)}` : sql`${column} < ${ts(to)}`);
  const utc = (column: SQL) => sql`(${column} AT TIME ZONE 'UTC')`;

  // The scope, as conditions every ledger query adds (nothing for the whole organization).
  const scoped = scope.kind !== "organization";
  const scopeRuns = scoped && scope.runIds.length
    ? await db.select({ id: outreachRuns.id, campaigns: outreachRuns.campaigns }).from(outreachRuns).where(and(inOrg(outreachRuns), inArray(outreachRuns.id, scope.runIds)))
    : [];
  const campaignsOf = (channel: "email" | "whatsapp" | "linkedin") => scopeRuns.flatMap((run) => (run.campaigns[channel] ? [run.campaigns[channel]!] : []));
  const R = uuidArray(scope.runIds);
  const A = uuidArray(scope.audienceIds);
  const J = uuidArray(scope.jobIds);
  const E = uuidArray(campaignsOf("email"));
  const W = uuidArray(campaignsOf("whatsapp"));
  const L = textArray(campaignsOf("linkedin"));
  const only = (condition: SQL) => (scoped ? sql` AND ${condition}` : sql``);
  const runPeople = sql`(SELECT rl.person_id FROM outreach_run_leads rl WHERE rl.organization_id = ${org} AND rl.run_id = ANY(${R}))`;

  const [members, reasons, discoveryDuplicates, listDuplicates] = await Promise.all([
    rows(sql`SELECT source, status, count(*)::int AS n FROM lead_audience_members WHERE organization_id = ${org} AND ${inRange(sql`created_at`)}${only(sql`audience_id = ANY(${A})`)} GROUP BY source, status`),
    rows(sql`SELECT reason, count(*)::int AS n FROM lead_audience_members WHERE organization_id = ${org} AND status = 'excluded' AND ${inRange(sql`created_at`)}${only(sql`audience_id = ANY(${A})`)} GROUP BY reason ORDER BY n DESC LIMIT 6`),
    one(sql`SELECT coalesce(sum((result->>'duplicates')::int), 0)::int AS n FROM assistant_jobs WHERE organization_id = ${org} AND kind IN ('discovery', 'linkedin_search') AND status = 'succeeded' AND ${inRange(sql`finished_at`)}${only(sql`id = ANY(${J})`)}`),
    one(sql`SELECT coalesce(sum((criteria->'imported'->>'updated')::int), 0)::int AS n FROM lead_audiences WHERE organization_id = ${org} AND source = 'list' AND ${inRange(sql`created_at`)}${only(sql`id = ANY(${A})`)}`),
  ]);
  const memberCount = (filter: (row: Row) => boolean) => members.filter(filter).reduce((sum, row) => sum + n(row.n), 0);

  const emailSends = sql`SELECT l.person_id FROM outreach_emails e JOIN outreach_leads l ON l.id = e.lead_id JOIN outreach_campaigns c ON c.id = l.campaign_id
    WHERE c.organization_id = ${org} AND e.status = 'sent' AND ${inRange(sql`e.sent_at`)}${only(sql`c.id = ANY(${E})`)}`;
  const whatsappSends = sql`SELECT l.person_id FROM whatsapp_campaign_sends s JOIN whatsapp_campaign_leads l ON l.id = s.lead_id JOIN whatsapp_campaigns c ON c.id = l.campaign_id
    WHERE c.organization_id = ${org} AND s.status = 'sent' AND ${inRange(sql`s.sent_at`)}${only(sql`c.id = ANY(${W})`)}`;
  const linkedinSends = sql`SELECT l."personId" AS person_id, m.type FROM "Message" m JOIN "Lead" l ON l.id = m."leadId"
    WHERE m."organizationId" = ${org} AND m."linkedinMessageId" IS NOT NULL AND m."duplicateOfMessageId" IS NULL
      AND m.type IN ('INVITATION', 'ACCEPTANCE', 'FOLLOW_UP_1', 'FOLLOW_UP_2', 'FOLLOW_UP_3') AND ${inRange(utc(sql`m."createdAt"`))}${only(sql`l."campaignId" = ANY(${L})`)}`;

  const instagramSends = sql`SELECT q.person_id FROM instagram_outreach_queue q WHERE q.organization_id=${org} AND q.status='sent' AND ${inRange(sql`q.sent_at`)}${only(sql`q.run_id = ANY(${R})`)}`;

  const [email, whatsapp, instagram, linkedin, contacted, crmSends, inbound, interested, interestedPeople] = await Promise.all([
    one(sql`SELECT count(*)::int AS n FROM (${emailSends}) x`),
    one(sql`SELECT count(*)::int AS n FROM (${whatsappSends}) x`),
    one(sql`SELECT count(*)::int AS n FROM (${instagramSends}) x`),
    one(sql`SELECT count(*) FILTER (WHERE type = 'INVITATION')::int AS invitations, count(*) FILTER (WHERE type <> 'INVITATION')::int AS messages FROM (${linkedinSends}) x`),
    one(sql`SELECT count(DISTINCT person_id)::int AS n FROM (${emailSends} UNION ALL ${whatsappSends} UNION ALL ${instagramSends} UNION ALL SELECT person_id FROM (${linkedinSends}) li) x`),
    one(sql`SELECT count(*) FILTER (WHERE a.idempotency_key LIKE 'autopilot:%')::int AS auto, count(*) FILTER (WHERE a.idempotency_key NOT LIKE 'autopilot:%')::int AS manual
      FROM crm_send_attempts a JOIN crm_drafts d ON d.id = a.draft_id JOIN crm_records r ON r.id = d.crm_record_id
      WHERE r.organization_id = ${org} AND a.status IN ('sent', 'reconciled') AND ${inRange(sql`a.created_at`)}${only(sql`r.person_id IN ${runPeople}`)}`),
    one(sql`SELECT count(*)::int AS messages, count(DISTINCT m.person_id)::int AS people FROM crm_conversation_messages m JOIN crm_conversations c ON c.id = m.conversation_id
      WHERE c.organization_id = ${org} AND m.direction = 'inbound' AND ${inRange(sql`m.sent_at`)}${only(sql`m.person_id IN ${runPeople}`)}`),
    one(sql`SELECT count(DISTINCT cl.crm_record_id)::int AS n FROM crm_classifications cl JOIN crm_records r ON r.id = cl.crm_record_id
      WHERE r.organization_id = ${org} AND cl.applied_category_key = 'interested' AND cl.status IN ('auto_applied', 'accepted') AND ${inRange(sql`cl.created_at`)}${only(sql`r.person_id IN ${runPeople}`)}`),
    rows(sql`SELECT DISTINCT ON (r.id) coalesce(p.full_name, p.raw->>'businessName', p.email, p.phone, 'A lead') AS name, s.key AS what, cl.created_at AS at
      FROM crm_classifications cl JOIN crm_records r ON r.id = cl.crm_record_id JOIN people p ON p.id = r.person_id LEFT JOIN crm_subcategories s ON s.id = cl.applied_subcategory_id
      WHERE r.organization_id = ${org} AND cl.applied_category_key = 'interested' AND cl.status IN ('auto_applied', 'accepted') AND ${inRange(sql`cl.created_at`)}${only(sql`r.person_id IN ${runPeople}`)}
      ORDER BY r.id, cl.created_at DESC LIMIT 20`),
  ]);

  const [waiting, decisions, held, pending, optedOut, suppressed, runLeadsStopped, failures, usage, research, awaiting] = await Promise.all([
    one(sql`SELECT count(*)::int AS n FROM crm_drafts d JOIN crm_records r ON r.id = d.crm_record_id WHERE r.organization_id = ${org} AND d.status = 'awaiting_review'${only(sql`r.person_id IN ${runPeople}`)}`),
    rows(sql`SELECT kind, count(*)::int AS n FROM owner_decisions WHERE organization_id = ${org} AND status = 'open'${only(sql`(run_id = ANY(${R}) OR person_id IN ${runPeople})`)} GROUP BY kind ORDER BY n DESC`),
    rows(sql`SELECT coalesce(reason, 'held') AS reason, count(*)::int AS n FROM autopilot_replies WHERE organization_id = ${org} AND status = 'held' AND ${inRange(sql`updated_at`)}${only(sql`run_id = ANY(${R})`)} GROUP BY 1 ORDER BY n DESC LIMIT 6`),
    one(sql`SELECT
        (SELECT count(*) FROM outreach_leads l JOIN outreach_campaigns c ON c.id = l.campaign_id WHERE c.organization_id = ${org} AND c.status = 'active' AND l.sequence_status IN ('pending', 'initial_sent', 'in_follow_up')${only(sql`c.id = ANY(${E})`)})::int AS email,
        (SELECT count(*) FROM whatsapp_campaign_leads l JOIN whatsapp_campaigns c ON c.id = l.campaign_id WHERE c.organization_id = ${org} AND c.status = 'active' AND l.status IN ('queued', 'in_sequence')${only(sql`c.id = ANY(${W})`)})::int AS whatsapp,
        (SELECT count(*) FROM "Lead" l JOIN "Campaign" c ON c.id = l."campaignId" WHERE l."organizationId" = ${org} AND c.status = 'ACTIVE'
           AND l.status IN ('PENDING', 'REQUEST_SENT', 'CONNECTED', 'ACCEPT_MESSAGE_SENT', 'FOLLOW_UP_1_SENT', 'FOLLOW_UP_2_SENT')${only(sql`c.id = ANY(${L})`)})::int AS linkedin,
        (SELECT count(*) FROM instagram_outreach_queue q JOIN outreach_runs r ON r.id=q.run_id WHERE q.organization_id=${org} AND r.status='running' AND q.status IN ('queued','resolving','sending')${only(sql`q.run_id = ANY(${R})`)})::int AS instagram`),
    one(sql`SELECT count(*)::int AS n FROM crm_person_contact_policies cp JOIN people p ON p.id = cp.person_id WHERE p.organization_id = ${org} AND cp.do_not_contact AND ${inRange(sql`cp.set_at`)}${only(sql`cp.person_id IN ${runPeople}`)}`),
    rows(sql`SELECT reason, count(*)::int AS n FROM outreach_suppression_list WHERE organization_id = ${org} AND ${inRange(sql`created_at`)}${only(sql`lower(email) IN (SELECT lower(p.email) FROM people p WHERE p.organization_id = ${org} AND p.email IS NOT NULL AND p.id IN ${runPeople})`)} GROUP BY reason ORDER BY n DESC`),
    one(sql`SELECT count(*)::int AS n FROM outreach_run_leads WHERE organization_id = ${org} AND status <> 'active' AND ${inRange(sql`updated_at`)}${only(sql`run_id = ANY(${R})`)}`),
    rows(sql`
      SELECT 'email' AS channel, coalesce(e.error, 'no reason recorded') AS reason, count(*)::int AS n FROM outreach_emails e JOIN outreach_leads l ON l.id = e.lead_id JOIN outreach_campaigns c ON c.id = l.campaign_id
        WHERE c.organization_id = ${org} AND e.status = 'failed' AND ${inRange(sql`e.created_at`)}${only(sql`c.id = ANY(${E})`)} GROUP BY 1, 2
      UNION ALL
      SELECT 'whatsapp', coalesce(s.error, 'no reason recorded'), count(*)::int FROM whatsapp_campaign_sends s JOIN whatsapp_campaign_leads l ON l.id = s.lead_id JOIN whatsapp_campaigns c ON c.id = l.campaign_id
        WHERE c.organization_id = ${org} AND s.status = 'failed' AND ${inRange(sql`s.created_at`)}${only(sql`c.id = ANY(${W})`)} GROUP BY 1, 2
      UNION ALL
      SELECT 'linkedin', 'failed (the LinkedIn engine records no reason)', count(*)::int FROM "Lead" l WHERE l."organizationId" = ${org} AND l.status = 'FAILED' AND ${inRange(utc(sql`l."updatedAt"`))}${only(sql`l."campaignId" = ANY(${L})`)} HAVING count(*) > 0
      UNION ALL
      SELECT 'instagram', coalesce(q.error,q.status), count(*)::int FROM instagram_outreach_queue q WHERE q.organization_id=${org} AND q.status IN ('failed','uncertain') AND ${inRange(sql`q.updated_at`)}${only(sql`q.run_id = ANY(${R})`)} GROUP BY 1,2
      UNION ALL
      SELECT 'replies', coalesce(a.error, a.status), count(*)::int FROM crm_send_attempts a JOIN crm_drafts d ON d.id = a.draft_id JOIN crm_records r ON r.id = d.crm_record_id
        WHERE r.organization_id = ${org} AND a.status IN ('failed', 'delivery_uncertain') AND ${inRange(sql`a.created_at`)}${only(sql`r.person_id IN ${runPeople}`)} GROUP BY 1, 2
      UNION ALL
      SELECT 'lead search', coalesce(j.error, 'failed'), count(*)::int FROM assistant_jobs j WHERE j.organization_id = ${org} AND j.status = 'failed' AND ${inRange(sql`j.finished_at`)}${only(sql`j.id = ANY(${J})`)} GROUP BY 1, 2
      ORDER BY 3 DESC LIMIT 10`),
    rows(sql`SELECT kind, coalesce(sum(cost_usd), 0)::float AS usd, count(*)::int AS calls, count(*) FILTER (WHERE cost_usd IS NULL)::int AS unknown
      FROM assistant_usage WHERE organization_id = ${org} AND ${inRange(sql`created_at`)}${only(sql`run_id = ANY(${R})`)} GROUP BY kind`),
    one(sql`SELECT coalesce(sum(cost_usd), 0)::float AS usd FROM lead_research WHERE organization_id = ${org} AND ${inRange(sql`created_at`)}${only(sql`company_id IN (SELECT p.company_id FROM lead_audience_members m JOIN people p ON p.id = m.person_id WHERE m.organization_id = ${org} AND m.audience_id = ANY(${A}))`)}`).catch(() => ({ usd: 0 })),
    // Plans prepared and waiting for Start, now: not reply decisions, and not sends.
    rows(sql`SELECT id, name, count(*) OVER ()::int AS total FROM outreach_runs WHERE organization_id = ${org} AND status = 'proposed'${only(sql`id = ANY(${R})`)} ORDER BY created_at DESC LIMIT 5`),
  ]);

  // Limits now.
  const dayStart = periodFor("today", period.timeZone, now).from!;
  const [autopilotUsed, mailboxRows, emailQueue, researchToday, byok, whatsappRules, whatsappSenders, googleConnected, unipileConnected] = await Promise.all([
    one(sql`SELECT count(*)::int AS n FROM autopilot_replies WHERE organization_id = ${org} AND status IN ('reserved', 'sent', 'failed') AND created_at >= ${ts(new Date(now.getTime() - 24 * 3_600_000))}`),
    db.select().from(mailboxes).where(inOrg(mailboxes)),
    rows(sql`SELECT q.mailbox_id, count(*)::int AS n FROM outreach_mailbox_queue q
      JOIN outreach_leads l ON l.id=q.lead_id JOIN outreach_campaigns c ON c.id=l.campaign_id
      WHERE c.organization_id=${org} AND c.status='active' GROUP BY q.mailbox_id`),
    one(sql`SELECT count(*)::int AS n FROM lead_research WHERE organization_id = ${org} AND created_at >= ${ts(dayStart)}`).catch(() => null),
    getByokSettings().catch(() => null),
    channelRules("whatsapp"),
    one(sql`SELECT count(DISTINCT a.id)::int AS n FROM whatsapp_accounts a
      JOIN whatsapp_campaign_accounts ca ON ca.account_id=a.id JOIN whatsapp_campaigns c ON c.id=ca.campaign_id
      WHERE a.organization_id=${org} AND c.organization_id=${org} AND a.status='connected' AND a.unipile_account_id<>''
        AND c.status='active' AND c.archived_at IS NULL`),
    mailboxProviderConnected("google"),
    mailboxProviderConnected("unipile"),
  ]);
  const connectedMailboxes = mailboxRows.filter((row) => row.status === "connected");
  const mailboxRoom = { mailboxes: connectedMailboxes.length, room: connectedMailboxes.reduce((sum, row) => sum + mailboxDailyRoom(row, now), 0) };
  const emailSending = emailSendingStatus(mailboxRows.map((row) => ({
    ...row,
    activeQueue: n(emailQueue.find((q) => q.mailbox_id === row.id)?.n),
    providerConnected: row.provider === "google" ? googleConnected : unipileConnected,
  })), { now, paused: isMigrationControlPaused("emailOutbound") });

  // The snapshot measures connection and campaign windows; the worker still
  // checks due leads, per-account gaps, warm-up and new-chat limits before POST.
  const whatsappHours = whatsappRules.sendingHours;
  const whatsappWindow = sendingWindow(whatsappHours, now);
  const whatsappBlockedBy: ChannelSending["blockedBy"] = isMigrationControlPaused("whatsappOutbound")
    ? "paused"
    : !unipileConnected || !n(whatsappSenders.n)
      ? "no_sender"
      : !whatsappWindow.open
        ? "outside_hours"
        : n(pending.whatsapp) <= 0
          ? "nothing_queued"
          : null;
  const whatsappSending: ChannelSending = {
    open: whatsappBlockedBy === null,
    blockedBy: whatsappBlockedBy,
    nextOpenAt: whatsappWindow.opensAt?.toISOString() ?? null,
    nextOpenLabel: whatsappWindow.opensAt && whatsappHours ? describeOpening(whatsappWindow.opensAt, whatsappHours.timezone) : null,
    hours: describeWeeklyHours(whatsappHours),
    queued: n(pending.whatsapp),
    detail: "the sender still checks due times, account gaps, warm-up and new-chat limits",
  };

  const runList = scoped ? scope.runIds.slice(0, 50) : (await listRuns(10)).map((run) => run.id);
  const runs: Results["runs"] = [];
  for (const runId of runList) {
    if (runs.length >= 10) break;
    const report = await reportRun(runId);
    if (!report || ["proposed", "cancelled"].includes(report.status)) continue;
    runs.push({
      id: report.runId,
      name: report.name,
      status: report.status,
      mode: report.autopilot ? "Automatic" : "Review",
      channels: report.channels.map((c) => ({ channel: c.channel, contacted: c.contacted, messagesSent: c.messagesSent, replied: c.replied, stopped: c.stopped })),
    });
  }

  return {
    period,
    scope: { kind: scope.kind, label: scopeLabel(scope), runs: scope.runIds.length, jobs: scope.jobIds.length, empty: scopeIsEmpty(scope) },
    leads: {
      discovered: memberCount((row) => row.source !== "list"),
      imported: memberCount((row) => row.source === "list"),
      duplicates: n(discoveryDuplicates.n) + n(listDuplicates.n),
      usable: memberCount((row) => row.status === "eligible"),
      leftOut: memberCount((row) => row.status === "excluded"),
      leftOutReasons: reasons.map((row) => ({ reason: String(row.reason ?? "unknown"), count: n(row.n) })),
      bySource: summarizeSources(
        members.map((row) => ({ source: String(row.source ?? "unknown"), status: String(row.status ?? ""), count: n(row.n) })),
      ),
    },
    outreach: {
      peopleContacted: n(contacted.n),
      emailsSent: n(email.n),
      whatsappSent: n(whatsapp.n),
      instagramSent: n(instagram.n),
      linkedinInvitations: n(linkedin.invitations),
      linkedinMessages: n(linkedin.messages),
      repliesReceived: n(inbound.messages),
      peopleReplied: n(inbound.people),
      interested: n(interested.n),
      automaticReplies: n(crmSends.auto),
      repliesByYou: n(crmSends.manual),
    },
    interestedPeople: interestedPeople.map((row) => ({ name: String(row.name), what: row.what ? String(row.what).replace(/_/g, " ") : null, at: new Date(String(row.at)).toISOString() })),
    attention: {
      repliesWaiting: n(waiting.n),
      openDecisions: decisions.reduce((sum, row) => sum + n(row.n), 0),
      byKind: decisions.map((row) => ({ kind: String(row.kind), count: n(row.n) })),
      heldByAutopilot: held.map((row) => ({ reason: String(row.reason), count: n(row.n) })),
      plansAwaitingStart: n(awaiting[0]?.total),
      plansAwaiting: awaiting.map((row) => ({ id: String(row.id), name: String(row.name) })),
    },
    pending: { emailFollowUps: n(pending.email), whatsappFollowUps: n(pending.whatsapp), linkedinSteps: n(pending.linkedin), instagramDms: n(pending.instagram) },
    sending: { email: emailSending, whatsapp: whatsappSending },
    stopped: {
      optedOut: n(optedOut.n),
      suppressed: suppressed.map((row) => ({ reason: String(row.reason), count: n(row.n) })),
      runLeadsStopped: n(runLeadsStopped.n),
    },
    failures: failures.filter((row) => n(row.n) > 0).map((row) => ({ channel: String(row.channel), reason: String(row.reason).slice(0, 200), count: n(row.n) })),
    spending: {
      aiRecordedUsd: usage.reduce((sum, row) => sum + Number(row.usd ?? 0), 0),
      aiCalls: usage.reduce((sum, row) => sum + n(row.calls), 0),
      aiCallsWithoutCost: usage.reduce((sum, row) => sum + n(row.unknown), 0),
      byKind: usage.map((row) => ({ kind: String(row.kind), usd: Number(row.usd ?? 0), calls: n(row.calls) })),
      researchUsd: Number(research?.usd ?? 0),
      dataSources: "Google Maps lead search is self-hosted (no per-search fee). LinkedIn search runs on your Unipile subscription (not metered here). Classification and reply drafting by the CRM are not metered here.",
    },
    limits: {
      automaticRepliesLeft24h: Math.max(0, AUTOPILOT_LIMITS.perDay - n(autopilotUsed.n)),
      emailsLeftToday: n(mailboxRoom.mailboxes) ? n(mailboxRoom.room) : null,
      researchLeftToday: researchToday && byok?.researchModel ? Math.max(0, n(byok.researchDailyLimit) - n(researchToday.n)) : null,
      whatsappNewChatsLeftToday: null,
    },
    runs,
  };
}

/** A run in one phrase, from its engines' records: a running plan with nothing recorded sent says so. */
function runPhrase(run: Results["runs"][number]): string {
  const sent = run.channels.map((c) => `${c.channel} ${c.contacted} contacted${c.messagesSent === null ? "" : `, ${c.messagesSent} sent`}${c.replied ? `, ${c.replied} replied` : ""}`);
  return `“${run.name}” ${run.status}, ${run.mode} replies (${sent.length ? `so far ${sent.join("; ")}` : "no campaign launched yet, nothing sent"})`;
}

/** The results as a few plain sentences, for the chat and the daily summary. */
export function resultsText(r: Results): string {
  const o = r.outreach;
  const a = r.attention;
  const scoped = r.scope.kind !== "organization";
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const lines = [
    `Results for ${r.period.label} (${r.period.timeZone})${scoped ? `, ${r.scope.label} only` : ""}:`,
    ...(r.scope.empty
      ? [`Nothing is recorded for ${r.scope.label} yet: no search or plan of it is saved, so its figures below are 0. The whole organization's results include other work.`]
      : []),
    `Leads: ${r.leads.discovered} found by search, ${r.leads.imported} from your lists, ${r.leads.duplicates} duplicates merged, ${r.leads.usable} contactable, ${r.leads.leftOut} left out${r.leads.leftOutReasons.length ? ` (${r.leads.leftOutReasons.slice(0, 3).map((x) => `${x.count} × ${x.reason}`).join("; ")})` : ""}.`,
    ...(r.leads.bySource.length
      ? [`Sources: ${r.leads.bySource.map((s) => `${s.label} ${s.contactable}/${s.found} with a contact route`).join("; ")}.`]
      : []),
    `Outreach: ${o.peopleContacted} people contacted; ${o.emailsSent} emails, ${o.whatsappSent} WhatsApp messages, ${o.linkedinInvitations} LinkedIn connection requests, ${o.linkedinMessages} LinkedIn messages and ${o.instagramSent} initial Instagram DMs confirmed sent.`,
    ...(r.runs.length ? [`Plans started${scoped ? "" : " (latest)"}: ${r.runs.map(runPhrase).join("; ")}.`] : []),
    `Replies: ${o.repliesReceived} received from ${o.peopleReplied} people; ${o.interested} interested${r.interestedPeople.length ? ` (${r.interestedPeople.slice(0, 5).map((p) => p.name).join(", ")})` : ""}. Answered: ${o.automaticReplies} automatically, ${o.repliesByYou} by you.`,
    `Waiting for you: ${a.repliesWaiting} replies to review, ${plural(a.openDecisions, "reply decision")}${a.byKind.length ? ` (${a.byKind.map((x) => `${x.count} ${x.kind.replace(/_/g, " ")}`).join(", ")})` : ""}; separately, ${plural(a.plansAwaitingStart, "plan")} waiting for your Start${a.plansAwaiting.length ? ` (${a.plansAwaiting.map((plan) => `“${plan.name}”`).join(", ")}${a.plansAwaitingStart > a.plansAwaiting.length ? ", …" : ""})` : ""}.`,
    `Still to send: ${r.pending.emailFollowUps} email leads, ${r.pending.whatsappFollowUps} WhatsApp leads, ${r.pending.linkedinSteps} LinkedIn leads in sequence, ${r.pending.instagramDms} initial Instagram DMs.`,
    `Stopped: ${r.stopped.optedOut} opted out${r.stopped.suppressed.length ? `, ${r.stopped.suppressed.map((x) => `${x.count} ${x.reason}`).join(", ")}` : ""}.`,
    r.failures.length ? `Failures: ${r.failures.slice(0, 4).map((f) => `${f.count} ${f.channel} (${f.reason})`).join("; ")}.` : "Failures: none recorded.",
    `AI spending recorded${scoped ? " against these plans" : ""}: ${money(r.spending.aiRecordedUsd)} over ${r.spending.aiCalls} assistant calls${r.spending.aiCallsWithoutCost ? ` (${r.spending.aiCallsWithoutCost} without a reported cost)` : ""}; research ${money(r.spending.researchUsd)}.`,
    `Limits left${scoped ? " (organization-wide)" : ""}: ${r.limits.automaticRepliesLeft24h} automatic replies in the next 24 hours; ${figure(r.limits.emailsLeftToday)} emails today; WhatsApp new chats ${figure(r.limits.whatsappNewChatsLeftToday)}.`,
  ];
  // Why a channel with leads left is not sending, in the engine's own terms.
  if (r.pending.emailFollowUps + r.pending.whatsappFollowUps > 0) {
    lines.push(
      `Sending checks${scoped ? " (organization-wide)" : ""}: email ${describeChannelSending(r.sending.email)}; WhatsApp ${describeChannelSending(r.sending.whatsapp)}.`,
    );
  }
  return lines.join("\n");
}

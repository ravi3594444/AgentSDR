import "server-only";

import { and, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { getByokSettings } from "@/lib/ai/byok";
import { AUTOPILOT_LIMITS } from "@/lib/crm/autopilot";
import { channelRules } from "@/lib/channels/rules.server";
import { describeOpening, describeWeeklyHours, describeWorkingHours, sendingWindow, workingWindow } from "@/lib/channels/sendingWindow";
import { isMigrationControlPaused } from "@/lib/migration/controls";
import { mailboxProviderConnected } from "@/lib/outreach/mailboxProviders";
import { mailboxes, type MailboxProvider } from "@/lib/outreach/schema";
import { resolveTimeZone } from "@/lib/timeZone";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { listRuns, reportRun } from "./outreach.server";
import { describeChannelSending, figure, money, periodFor, type ChannelSending, type Period, type PeriodKind } from "./results";

/**
 * The owner's results for a period, from what the app recorded: sends from
 * each engine's send records (so someone contacted stays counted after they
 * unsubscribe or change status), replies from the CRM's inbound messages,
 * interest from applied classifications, decisions and automatic replies
 * from the assistant's own ledgers, AI spending from recorded provider
 * costs. LinkedIn connection requests are counted apart from messages.
 * Drafts are never sends; interested is never a sale. A figure the app
 * does not record is null ("not measured").
 */

export type Results = {
  period: Period;
  leads: { discovered: number; imported: number; duplicates: number; usable: number; leftOut: number; leftOutReasons: { reason: string; count: number }[] };
  outreach: {
    peopleContacted: number;
    emailsSent: number;
    whatsappSent: number;
    linkedinInvitations: number;
    linkedinMessages: number;
    repliesReceived: number;
    peopleReplied: number;
    interested: number;
    automaticReplies: number;
    repliesByYou: number;
  };
  interestedPeople: { name: string; what: string | null; at: string }[];
  attention: { repliesWaiting: number; openDecisions: number; byKind: { kind: string; count: number }[]; heldByAutopilot: { reason: string; count: number }[] };
  pending: { emailFollowUps: number; whatsappFollowUps: number; linkedinSteps: number };
  /** Whether each channel can send right now, and why not when it cannot. */
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

export async function results(kind: PeriodKind, now = new Date()): Promise<Results> {
  const period = periodFor(kind, await organizationTimeZone(), now);
  const org = currentOrganizationId();
  const from = period.from;
  const to = period.to;
  const ts = (value: Date) => sql`${value.toISOString()}::timestamptz`;
  const inRange = (column: SQL) => (from ? sql`${column} >= ${ts(from)} AND ${column} < ${ts(to)}` : sql`${column} < ${ts(to)}`);
  const utc = (column: SQL) => sql`(${column} AT TIME ZONE 'UTC')`;

  const [members, reasons, discoveryDuplicates, listDuplicates] = await Promise.all([
    rows(sql`SELECT source, status, count(*)::int AS n FROM lead_audience_members WHERE organization_id = ${org} AND ${inRange(sql`created_at`)} GROUP BY source, status`),
    rows(sql`SELECT reason, count(*)::int AS n FROM lead_audience_members WHERE organization_id = ${org} AND status = 'excluded' AND ${inRange(sql`created_at`)} GROUP BY reason ORDER BY n DESC LIMIT 6`),
    one(sql`SELECT coalesce(sum((result->>'duplicates')::int), 0)::int AS n FROM assistant_jobs WHERE organization_id = ${org} AND kind IN ('discovery', 'linkedin_search') AND status = 'succeeded' AND ${inRange(sql`finished_at`)}`),
    one(sql`SELECT coalesce(sum((criteria->'imported'->>'updated')::int), 0)::int AS n FROM lead_audiences WHERE organization_id = ${org} AND source = 'list' AND ${inRange(sql`created_at`)}`),
  ]);
  const memberCount = (filter: (row: Row) => boolean) => members.filter(filter).reduce((sum, row) => sum + n(row.n), 0);

  const emailSends = sql`SELECT l.person_id FROM outreach_emails e JOIN outreach_leads l ON l.id = e.lead_id JOIN outreach_campaigns c ON c.id = l.campaign_id
    WHERE c.organization_id = ${org} AND e.status = 'sent' AND ${inRange(sql`e.sent_at`)}`;
  const whatsappSends = sql`SELECT l.person_id FROM whatsapp_campaign_sends s JOIN whatsapp_campaign_leads l ON l.id = s.lead_id JOIN whatsapp_campaigns c ON c.id = l.campaign_id
    WHERE c.organization_id = ${org} AND s.status = 'sent' AND ${inRange(sql`s.sent_at`)}`;
  const linkedinSends = sql`SELECT l."personId" AS person_id, m.type FROM "Message" m JOIN "Lead" l ON l.id = m."leadId"
    WHERE m."organizationId" = ${org} AND m."linkedinMessageId" IS NOT NULL AND m."duplicateOfMessageId" IS NULL
      AND m.type IN ('INVITATION', 'ACCEPTANCE', 'FOLLOW_UP_1', 'FOLLOW_UP_2', 'FOLLOW_UP_3') AND ${inRange(utc(sql`m."createdAt"`))}`;

  const [email, whatsapp, linkedin, contacted, crmSends, inbound, interested, interestedPeople] = await Promise.all([
    one(sql`SELECT count(*)::int AS n FROM (${emailSends}) x`),
    one(sql`SELECT count(*)::int AS n FROM (${whatsappSends}) x`),
    one(sql`SELECT count(*) FILTER (WHERE type = 'INVITATION')::int AS invitations, count(*) FILTER (WHERE type <> 'INVITATION')::int AS messages FROM (${linkedinSends}) x`),
    one(sql`SELECT count(DISTINCT person_id)::int AS n FROM (${emailSends} UNION ALL ${whatsappSends} UNION ALL SELECT person_id FROM (${linkedinSends}) li) x`),
    one(sql`SELECT count(*) FILTER (WHERE a.idempotency_key LIKE 'autopilot:%')::int AS auto, count(*) FILTER (WHERE a.idempotency_key NOT LIKE 'autopilot:%')::int AS manual
      FROM crm_send_attempts a JOIN crm_drafts d ON d.id = a.draft_id JOIN crm_records r ON r.id = d.crm_record_id
      WHERE r.organization_id = ${org} AND a.status IN ('sent', 'reconciled') AND ${inRange(sql`a.created_at`)}`),
    one(sql`SELECT count(*)::int AS messages, count(DISTINCT m.person_id)::int AS people FROM crm_conversation_messages m JOIN crm_conversations c ON c.id = m.conversation_id
      WHERE c.organization_id = ${org} AND m.direction = 'inbound' AND ${inRange(sql`m.sent_at`)}`),
    one(sql`SELECT count(DISTINCT cl.crm_record_id)::int AS n FROM crm_classifications cl JOIN crm_records r ON r.id = cl.crm_record_id
      WHERE r.organization_id = ${org} AND cl.applied_category_key = 'interested' AND cl.status IN ('auto_applied', 'accepted') AND ${inRange(sql`cl.created_at`)}`),
    rows(sql`SELECT DISTINCT ON (r.id) coalesce(p.full_name, p.raw->>'businessName', p.email, p.phone, 'A lead') AS name, s.key AS what, cl.created_at AS at
      FROM crm_classifications cl JOIN crm_records r ON r.id = cl.crm_record_id JOIN people p ON p.id = r.person_id LEFT JOIN crm_subcategories s ON s.id = cl.applied_subcategory_id
      WHERE r.organization_id = ${org} AND cl.applied_category_key = 'interested' AND cl.status IN ('auto_applied', 'accepted') AND ${inRange(sql`cl.created_at`)}
      ORDER BY r.id, cl.created_at DESC LIMIT 20`),
  ]);

  const [waiting, decisions, held, pending, optedOut, suppressed, runLeadsStopped, failures, usage, research] = await Promise.all([
    one(sql`SELECT count(*)::int AS n FROM crm_drafts d JOIN crm_records r ON r.id = d.crm_record_id WHERE r.organization_id = ${org} AND d.status = 'awaiting_review'`),
    rows(sql`SELECT kind, count(*)::int AS n FROM owner_decisions WHERE organization_id = ${org} AND status = 'open' GROUP BY kind ORDER BY n DESC`),
    rows(sql`SELECT coalesce(reason, 'held') AS reason, count(*)::int AS n FROM autopilot_replies WHERE organization_id = ${org} AND status = 'held' AND ${inRange(sql`updated_at`)} GROUP BY 1 ORDER BY n DESC LIMIT 6`),
    one(sql`SELECT
        (SELECT count(*) FROM outreach_leads l JOIN outreach_campaigns c ON c.id = l.campaign_id WHERE c.organization_id = ${org} AND c.status = 'active' AND l.sequence_status IN ('pending', 'initial_sent', 'in_follow_up'))::int AS email,
        (SELECT count(*) FROM whatsapp_campaign_leads l JOIN whatsapp_campaigns c ON c.id = l.campaign_id WHERE c.organization_id = ${org} AND c.status = 'active' AND l.status IN ('queued', 'in_sequence'))::int AS whatsapp,
        (SELECT count(*) FROM "Lead" l JOIN "Campaign" c ON c.id = l."campaignId" WHERE l."organizationId" = ${org} AND c.status = 'ACTIVE'
           AND l.status IN ('PENDING', 'REQUEST_SENT', 'CONNECTED', 'ACCEPT_MESSAGE_SENT', 'FOLLOW_UP_1_SENT', 'FOLLOW_UP_2_SENT'))::int AS linkedin`),
    one(sql`SELECT count(*)::int AS n FROM crm_person_contact_policies cp JOIN people p ON p.id = cp.person_id WHERE p.organization_id = ${org} AND cp.do_not_contact AND ${inRange(sql`cp.set_at`)}`),
    rows(sql`SELECT reason, count(*)::int AS n FROM outreach_suppression_list WHERE organization_id = ${org} AND ${inRange(sql`created_at`)} GROUP BY reason ORDER BY n DESC`),
    one(sql`SELECT count(*)::int AS n FROM outreach_run_leads WHERE organization_id = ${org} AND status <> 'active' AND ${inRange(sql`updated_at`)}`),
    rows(sql`
      SELECT 'email' AS channel, coalesce(e.error, 'no reason recorded') AS reason, count(*)::int AS n FROM outreach_emails e JOIN outreach_leads l ON l.id = e.lead_id JOIN outreach_campaigns c ON c.id = l.campaign_id
        WHERE c.organization_id = ${org} AND e.status = 'failed' AND ${inRange(sql`e.created_at`)} GROUP BY 1, 2
      UNION ALL
      SELECT 'whatsapp', coalesce(s.error, 'no reason recorded'), count(*)::int FROM whatsapp_campaign_sends s JOIN whatsapp_campaign_leads l ON l.id = s.lead_id JOIN whatsapp_campaigns c ON c.id = l.campaign_id
        WHERE c.organization_id = ${org} AND s.status = 'failed' AND ${inRange(sql`s.created_at`)} GROUP BY 1, 2
      UNION ALL
      SELECT 'linkedin', 'failed (the LinkedIn engine records no reason)', count(*)::int FROM "Lead" l WHERE l."organizationId" = ${org} AND l.status = 'FAILED' AND ${inRange(utc(sql`l."updatedAt"`))} HAVING count(*) > 0
      UNION ALL
      SELECT 'replies', coalesce(a.error, a.status), count(*)::int FROM crm_send_attempts a JOIN crm_drafts d ON d.id = a.draft_id JOIN crm_records r ON r.id = d.crm_record_id
        WHERE r.organization_id = ${org} AND a.status IN ('failed', 'delivery_uncertain') AND ${inRange(sql`a.created_at`)} GROUP BY 1, 2
      UNION ALL
      SELECT 'lead search', coalesce(j.error, 'failed'), count(*)::int FROM assistant_jobs j WHERE j.organization_id = ${org} AND j.status = 'failed' AND ${inRange(sql`j.finished_at`)} GROUP BY 1, 2
      ORDER BY 3 DESC LIMIT 10`),
    rows(sql`SELECT kind, coalesce(sum(cost_usd), 0)::float AS usd, count(*)::int AS calls, count(*) FILTER (WHERE cost_usd IS NULL)::int AS unknown
      FROM assistant_usage WHERE organization_id = ${org} AND ${inRange(sql`created_at`)} GROUP BY kind`),
    one(sql`SELECT coalesce(sum(cost_usd), 0)::float AS usd FROM lead_research WHERE organization_id = ${org} AND ${inRange(sql`created_at`)}`).catch(() => ({ usd: 0 })),
  ]);

  // Limits now.
  const dayStart = periodFor("today", period.timeZone, now).from!;
  const [autopilotUsed, mailboxRows, emailQueue, researchToday, byok, whatsappRules] = await Promise.all([
    one(sql`SELECT count(*)::int AS n FROM autopilot_replies WHERE organization_id = ${org} AND status IN ('reserved', 'sent', 'failed') AND created_at >= ${ts(new Date(now.getTime() - 24 * 3_600_000))}`),
    db
      .select({
        provider: mailboxes.provider,
        workingHours: mailboxes.workingHours,
        dailySendLimit: mailboxes.dailySendLimit,
        todayEmailsSent: mailboxes.todayEmailsSent,
      })
      .from(mailboxes)
      .where(and(inOrg(mailboxes), eq(mailboxes.status, "connected"))),
    one(sql`SELECT count(*)::int AS n FROM outreach_mailbox_queue q JOIN outreach_mailboxes m ON m.id = q.mailbox_id WHERE m.organization_id = ${org}`),
    one(sql`SELECT count(*)::int AS n FROM lead_research WHERE organization_id = ${org} AND created_at >= ${ts(dayStart)}`).catch(() => null),
    getByokSettings().catch(() => null),
    channelRules("whatsapp"),
  ]);
  const mailboxRoom = { mailboxes: mailboxRows.length, room: mailboxRows.reduce((sum, row) => sum + Math.max(0, row.dailySendLimit - row.todayEmailsSent), 0) };

  // Whether each channel can send now, from the same gates its engine uses:
  // the working-hours window, the provider connection, the daily room and a
  // built queue (email), or the campaign sending hours and the pause switch
  // (WhatsApp). This is what lets the assistant answer "why nothing sent"
  // with the reason instead of a guess.
  const emailWindows = mailboxRows.map((row) => ({ row, window: workingWindow(row.workingHours, now) }));
  const emailOpen = emailWindows.find((entry) => entry.window.open) ?? null;
  const emailNext =
    emailWindows
      .flatMap((entry) => (entry.window.opensAt ? [entry.window.opensAt] : []))
      .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  const emailGoverning =
    emailOpen ??
    emailWindows.find((entry) => entry.window.opensAt?.getTime() === emailNext?.getTime()) ??
    emailWindows[0] ??
    null;
  const providerConnected = new Map<MailboxProvider, boolean>();
  let emailSendable = 0;
  for (const { row } of emailWindows) {
    if (!providerConnected.has(row.provider)) providerConnected.set(row.provider, await mailboxProviderConnected(row.provider));
    if (providerConnected.get(row.provider)) emailSendable += 1;
  }
  const emailBlockedBy: ChannelSending["blockedBy"] = isMigrationControlPaused("emailOutbound")
    ? "paused"
    : emailSendable === 0
      ? "no_sender"
      : !emailOpen
        ? "outside_hours"
        : mailboxRoom.room <= 0
          ? "daily_limit"
          : n(emailQueue.n) <= 0
            ? "nothing_queued"
            : null;
  const emailSending: ChannelSending = {
    open: emailBlockedBy === null,
    blockedBy: emailBlockedBy,
    nextOpenAt: !emailOpen && emailNext ? emailNext.toISOString() : null,
    nextOpenLabel:
      !emailOpen && emailNext
        ? describeOpening(emailNext, emailGoverning?.row.workingHours.timezone ?? period.timeZone)
        : null,
    hours: emailGoverning ? describeWorkingHours(emailGoverning.row.workingHours) : null,
    queued: n(pending.email),
  };

  const whatsappHours = whatsappRules.sendingHours;
  const whatsappWindow = sendingWindow(whatsappHours, now);
  const whatsappBlockedBy: ChannelSending["blockedBy"] = isMigrationControlPaused("whatsappOutbound")
    ? "paused"
    : !whatsappWindow.open
      ? "outside_hours"
      : n(pending.whatsapp) <= 0
        ? "nothing_queued"
        : null;
  const whatsappSending: ChannelSending = {
    open: whatsappBlockedBy === null,
    blockedBy: whatsappBlockedBy,
    nextOpenAt: whatsappWindow.opensAt?.toISOString() ?? null,
    nextOpenLabel:
      whatsappWindow.opensAt && whatsappHours
        ? describeOpening(whatsappWindow.opensAt, whatsappHours.timezone)
        : null,
    hours: describeWeeklyHours(whatsappHours),
    queued: n(pending.whatsapp),
  };

  const runList = await listRuns(10);
  const runs: Results["runs"] = [];
  for (const run of runList.filter((r) => !["proposed", "cancelled"].includes(r.status))) {
    const report = await reportRun(run.id);
    runs.push({
      id: run.id,
      name: run.name,
      status: run.status,
      mode: run.autopilot ? "Automatic" : "Review",
      channels: (report?.channels ?? []).map((c) => ({ channel: c.channel, contacted: c.contacted, messagesSent: c.messagesSent, replied: c.replied, stopped: c.stopped })),
    });
  }

  return {
    period,
    leads: {
      discovered: memberCount((row) => row.source !== "list"),
      imported: memberCount((row) => row.source === "list"),
      duplicates: n(discoveryDuplicates.n) + n(listDuplicates.n),
      usable: memberCount((row) => row.status === "eligible"),
      leftOut: memberCount((row) => row.status === "excluded"),
      leftOutReasons: reasons.map((row) => ({ reason: String(row.reason ?? "unknown"), count: n(row.n) })),
    },
    outreach: {
      peopleContacted: n(contacted.n),
      emailsSent: n(email.n),
      whatsappSent: n(whatsapp.n),
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
    },
    pending: { emailFollowUps: n(pending.email), whatsappFollowUps: n(pending.whatsapp), linkedinSteps: n(pending.linkedin) },
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

/** The results as a few plain sentences, for the chat and the daily summary. */
export function resultsText(r: Results): string {
  const o = r.outreach;
  const lines = [
    `Results for ${r.period.label} (${r.period.timeZone}):`,
    `Leads: ${r.leads.discovered} found by search, ${r.leads.imported} from your lists, ${r.leads.duplicates} duplicates merged, ${r.leads.usable} contactable, ${r.leads.leftOut} left out${r.leads.leftOutReasons.length ? ` (${r.leads.leftOutReasons.slice(0, 3).map((x) => `${x.count} × ${x.reason}`).join("; ")})` : ""}.`,
    `Outreach: ${o.peopleContacted} people contacted; ${o.emailsSent} emails, ${o.whatsappSent} WhatsApp messages, ${o.linkedinInvitations} LinkedIn connection requests and ${o.linkedinMessages} LinkedIn messages sent.`,
    `Replies: ${o.repliesReceived} received from ${o.peopleReplied} people; ${o.interested} interested${r.interestedPeople.length ? ` (${r.interestedPeople.slice(0, 5).map((p) => p.name).join(", ")})` : ""}. Answered: ${o.automaticReplies} automatically, ${o.repliesByYou} by you.`,
    `Waiting for you: ${r.attention.repliesWaiting} replies to review, ${r.attention.openDecisions} decisions${r.attention.byKind.length ? ` (${r.attention.byKind.map((x) => `${x.count} ${x.kind.replace(/_/g, " ")}`).join(", ")})` : ""}.`,
    `Still to send: ${r.pending.emailFollowUps} email leads, ${r.pending.whatsappFollowUps} WhatsApp leads, ${r.pending.linkedinSteps} LinkedIn leads in sequence.`,
    `Stopped: ${r.stopped.optedOut} opted out${r.stopped.suppressed.length ? `, ${r.stopped.suppressed.map((x) => `${x.count} ${x.reason}`).join(", ")}` : ""}.`,
    r.failures.length ? `Failures: ${r.failures.slice(0, 4).map((f) => `${f.count} ${f.channel} (${f.reason})`).join("; ")}.` : "Failures: none recorded.",
    `AI spending recorded: ${money(r.spending.aiRecordedUsd)} over ${r.spending.aiCalls} assistant calls${r.spending.aiCallsWithoutCost ? ` (${r.spending.aiCallsWithoutCost} without a reported cost)` : ""}; research ${money(r.spending.researchUsd)}.`,
    `Limits left: ${r.limits.automaticRepliesLeft24h} automatic replies in the next 24 hours; ${figure(r.limits.emailsLeftToday)} emails today; WhatsApp new chats ${figure(r.limits.whatsappNewChatsLeftToday)}.`,
  ];
  // Why a channel with leads left is not sending, in the engine's own terms.
  if (r.pending.emailFollowUps + r.pending.whatsappFollowUps > 0) {
    lines.push(
      `Sending now: email ${describeChannelSending(r.sending.email)}; WhatsApp ${describeChannelSending(r.sending.whatsapp)}.`,
    );
  }
  return lines.join("\n");
}

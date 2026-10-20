import "server-only";
import { and, count, eq, gte, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { channelRules } from "@/lib/channels/rules.server";
import { featureEnabled } from "@/lib/features/flags.server";
import { instagramOutreachReady } from "@/lib/instagram/outreach.server";
import { isMigrationControlPaused } from "@/lib/migration/controls";
import { emailDeliveryGates } from "@/lib/outreach/deliveryDiagnostics";
import { mailboxProviderConnected } from "@/lib/outreach/mailboxProviders";
import { mailboxes } from "@/lib/outreach/schema";
import {
  isWithinWorkingHours,
  mailboxHoursFromWeekly,
  nextWindowStart,
} from "@/lib/outreach/workingHours";
import { isPlatformConnected } from "@/lib/platform/credentials";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { NEW_CHAT_WINDOW_MS, whatsappGuardrails } from "@/lib/whatsapp/guardrails";
import { campaignAccounts, leads as linkedinLeads, linkedInAccounts } from "@/lib/linkedin/schema";
import { withOrganizationHours } from "@/lib/linkedin/workingHours";
import { organizationTimeZone } from "@/lib/reporting/metrics.server";
import { platformJob } from "@/lib/scheduler/schedules";
import { dailyAt, nextSlotAt } from "@/lib/scheduler/slots";
import { emailSenderStatus, linkedinSenderStatus, whatsappSenderStatus, type SenderStatus } from "./runEvidence";
import { outreachRuns } from "./schema";

/**
 * Read-only snapshot. It reports stored gates, not a claim that a worker or
 * provider is healthy. Times in gates and details are written in the
 * organization's time zone (`displayTimeZone`), which the panel names.
 */
export async function diagnoseDelivery(runId?: string) {
  const org = currentOrganizationId();
  const now = new Date();
  const displayTimeZone = await organizationTimeZone();
  const [run] = runId
    ? await db
        .select()
        .from(outreachRuns)
        .where(and(inOrg(outreachRuns), eq(outreachRuns.id, runId)))
    : [];
  if (runId && !run) throw new Error("No such outreach run");
  // A plan's senders are only those of the channels it uses (channels, not campaigns: a starting plan has none yet).
  const sendsOn = (channel: "email" | "instagram") => !run || run.channels.includes(channel);
  const emailCampaign = run?.campaigns.email ?? null;
  const campaignScope = run
    ? emailCampaign
      ? sql`c.id::text=${emailCampaign}`
      : sql`false`
    : sql`true`;
  const mailboxList = sendsOn("email") ? await db.select().from(mailboxes).where(inOrg(mailboxes)) : [];
  const [google, unipile] = await Promise.all([
    mailboxProviderConnected("google"),
    mailboxProviderConnected("unipile"),
  ]);
  const queue = await db.execute<{
    mailbox_id: string;
    n: number;
  }>(sql`select q.mailbox_id, count(*)::int as n from outreach_mailbox_queue q
    join outreach_leads l on l.id=q.lead_id join outreach_campaigns c on c.id=l.campaign_id
    where c.organization_id=${org} and c.status='active' and ${campaignScope} group by q.mailbox_id`);
  const email = mailboxList.map((mailbox) => {
    const activeQueue = Number(
      queue.find((row) => row.mailbox_id === mailbox.id)?.n ?? 0,
    );
    return {
      mailbox: mailbox.emailAddress,
      activeQueue,
      timezone: mailbox.workingHours.timezone,
      workingHours: mailbox.workingHours,
      nextSendAt: mailbox.nextEmailTime?.toISOString() ?? null,
      lastError: mailbox.lastError,
      gates: emailDeliveryGates(mailbox, {
        providerConnected: mailbox.provider === "google" ? google : unipile,
        paused: isMigrationControlPaused("emailOutbound"),
        activeQueue,
        now,
      }),
    };
  });
  const emailCampaigns = await db.execute<{
    name: string;
    status: string;
    pending: number;
    unassigned: number;
    next_due: string | null;
  }>(sql`select c.name,c.status,
    count(l.id) filter(where l.sequence_status in ('pending','initial_sent','in_follow_up'))::int as pending,
    count(l.id) filter(where l.sequence_status='pending' and l.mailbox_id is null)::int as unassigned,
    min(l.next_send_at) filter(where l.sequence_status in ('initial_sent','in_follow_up'))::text as next_due
    from outreach_campaigns c left join outreach_leads l on l.campaign_id=c.id where c.organization_id=${org} and ${campaignScope}
    and (c.status in ('active','paused') or ${Boolean(run)}) group by c.id order by c.created_at desc limit 20`);
  const errors = await db.execute<{
    reason: string;
    n: number;
  }>(sql`select coalesce(e.error,'No reason recorded') as reason,count(*)::int as n
    from outreach_emails e join outreach_leads l on l.id=e.lead_id join outreach_campaigns c on c.id=l.campaign_id
    where c.organization_id=${org} and ${campaignScope} and e.status='failed' and e.created_at>now()-interval '7 days'
    group by e.error order by n desc limit 5`);
  let instagram: {
    account: string;
    queued: number;
    attempted24h: number;
    limit: number;
    gates: string[];
  }[] = [];
  let instagramErrors: { status: string; reason: string; n: number }[] = [];
  if (sendsOn("instagram") && (await featureEnabled("instagram")) && (await instagramOutreachReady())) {
    const rules = await channelRules("instagram");
    const accounts = await db.execute<{
      id: string;
      username: string | null;
      status: string;
      next_send: string | null;
      queued: number;
      used: number;
    }>(sql`select a.id,a.username,a.status,a.outreach_next_send_at::text as next_send,
      (select count(*)::int from instagram_outreach_queue q where q.account_id=a.id and q.organization_id=${org} and q.status in ('queued','resolving','sending') and (${runId ?? null}::uuid is null or q.run_id=${runId ?? null}::uuid)) as queued,
      (select count(*)::int from instagram_outreach_queue q where q.account_id=a.id and q.organization_id=${org} and q.attempted_at>now()-interval '24 hours') as used
      from instagram_accounts a where a.organization_id=${org}`);
    instagram = accounts.map((a) => ({
      account: a.username ? `@${a.username}` : a.id,
      queued: Number(a.queued),
      attempted24h: Number(a.used),
      limit: rules.newChatsPerDay,
      gates: [
        !unipile ? "Unipile is disconnected" : null,
        a.status !== "connected" ? `Account is ${a.status}` : null,
        isMigrationControlPaused("instagramOutbound")
          ? "Instagram outbound is paused by the server's migration controls"
          : null,
        rules.sendingHours &&
        !isWithinWorkingHours(mailboxHoursFromWeekly(rules.sendingHours), now)
          ? `Outside sending hours (${rules.sendingHours.timezone})`
          : null,
        a.next_send && new Date(a.next_send) > now
          ? `Next send allowed at ${new Date(a.next_send).toISOString()}`
          : null,
        Number(a.used) >= rules.newChatsPerDay
          ? "Rolling 24-hour initial DM limit used"
          : null,
      ].filter((x): x is string => Boolean(x)),
    }));
    instagramErrors = Array.from(
      await db.execute<{
        status: string;
        reason: string;
        n: number;
      }>(sql`select status,coalesce(error,status) as reason,count(*)::int as n
      from instagram_outreach_queue where organization_id=${org} and status in ('failed','uncertain','cancelled')
      and (${runId ?? null}::uuid is null or run_id=${runId ?? null}::uuid) and updated_at>now()-interval '7 days' group by status,error order by n desc limit 5`),
    );
  }
  const whatsapp = await whatsappSenders(run?.campaigns.whatsapp ?? null, Boolean(run), now, displayTimeZone);
  const linkedin = await linkedinSenders(run?.campaigns.linkedin ?? null, Boolean(run), now, displayTimeZone);
  const instagramRules = instagram.length ? await channelRules("instagram") : null;
  const senders: SenderStatus[] = [
    ...email.map((m) => emailSenderStatus({ mailbox: m.mailbox, workingHours: m.workingHours, nextEmailTime: m.nextSendAt ? new Date(m.nextSendAt) : null, gates: m.gates, queued: m.activeQueue, now })),
    ...whatsapp,
    ...linkedin,
    ...instagram.map((a): SenderStatus => {
      const hours = instagramRules?.sendingHours ? mailboxHoursFromWeekly(instagramRules.sendingHours) : null;
      const nextSend = a.gates.find((gate) => gate.startsWith("Next send allowed at "))?.slice("Next send allowed at ".length) ?? null;
      // Only the hours and the per-account gap have a known end here.
      const timed = a.gates.every((gate) => gate.startsWith("Outside sending hours") || gate.startsWith("Next send allowed at "));
      const opens = hours && a.gates.some((gate) => gate.startsWith("Outside sending hours")) ? nextWindowStart(hours, now) : null;
      const next = [opens, nextSend ? new Date(nextSend) : null].filter((date): date is Date => Boolean(date)).sort((x, y) => y.getTime() - x.getTime())[0] ?? null;
      return { channel: "instagram", account: a.account, timezone: hours?.timezone ?? null, gates: a.gates, nextAt: a.gates.length && timed ? next?.toISOString() ?? null : null, queued: a.queued, note: null, limits: null, details: [] };
    }),
  ];
  const lines = [
    run
      ? `“${run.name}” is ${run.status}${run.error ? `: ${run.error}` : ""}.`
      : "Current delivery snapshot:",
    ...email.map(
      (m) =>
        `${m.mailbox}: ${m.activeQueue} queued. ${m.gates.map((g) => g.reason).join("; ") || "No recorded send gate is blocking this mailbox"}.${m.lastError ? ` Last mailbox error: ${m.lastError}` : ""}`,
    ),
    ...emailCampaigns.map(
      (c) =>
        `Email “${c.name}”: ${c.status}, ${c.pending} pending, ${c.unassigned} unassigned${c.next_due ? `; earliest follow-up due ${c.next_due}` : ""}.`,
    ),
    ...errors.map((e) => `${e.n} recorded email failures: ${e.reason}`),
    ...instagram.map(
      (a) =>
        `Instagram ${a.account}: ${a.queued} awaiting delivery, ${a.attempted24h}/${a.limit} initial DM attempts in 24 hours. ${a.gates.join("; ") || "No recorded account gate is blocking sends"}.`,
    ),
    ...instagramErrors.map((e) => `${e.n} Instagram ${e.status}: ${e.reason}`),
    ...whatsapp.map(
      (w) =>
        `WhatsApp ${w.account}: ${w.queued} awaiting their next message. ${w.gates.join("; ") || "No recorded number gate is blocking sends"}${w.nextAt ? `; next send allowed at ${w.nextAt}` : ""}.${w.timezone ? ` Sending hours are in ${w.timezone}.` : " No campaign sending hours are set (any time)."}${[w.limits, ...w.details].filter(Boolean).map((line) => ` ${line}`).join("")}`,
    ),
    ...linkedin.map(
      (l) =>
        `LinkedIn ${l.account}: ${l.queued} invitations waiting. ${l.gates.join("; ") || "No recorded account gate is blocking sends"}${l.nextAt ? `; next send allowed at ${l.nextAt}` : ""}.${l.timezone ? ` Working hours are in ${l.timezone}.` : " No working hours are set (any time)."}${[l.limits, ...l.details].filter(Boolean).map((line) => ` ${line}`).join("")}`,
    ),
    `Times above are in ${displayTimeZone}, the organization's time zone, unless written as ISO times.`,
    "This snapshot does not measure worker liveness or confirm future delivery. Lead cities do not determine a sender's sending timezone.",
  ];
  if (!email.length && sendsOn("email")) lines.splice(1, 0, "No email mailbox is configured.");
  return {
    at: now.toISOString(),
    /** The zone the gates' and details' times are written in, for the panel to show its own times in too. */
    displayTimeZone,
    runStatus: run?.status ?? null,
    email,
    emailCampaigns: Array.from(emailCampaigns),
    errors: Array.from(errors),
    instagram,
    instagramErrors,
    whatsapp,
    senders,
    linkedin,
    /** Channels this snapshot does not cover, so a card can say so instead of implying all is well (every channel is covered now). */
    notCovered: [] as string[],
    summary: lines.join("\n"),
  };
}

/**
 * The WhatsApp numbers a run's campaign sends from (or every number of the
 * organization), with the gates send.ts applies under its lock, read the same way.
 */
async function whatsappSenders(campaignId: string | null, forRun: boolean, now: Date, displayTimeZone: string): Promise<SenderStatus[]> {
  if (forRun && !campaignId) return [];
  const org = currentOrganizationId();
  const accounts = await db.execute<{
    id: string; name: string | null; phone: string | null; status: string; connected_at: string | null; new_chats_per_day: number | null;
    last_sent: string | null; new_chat_times: string[]; queued: number; first_queued: number; last_refusal: string | null; last_refusal_at: string | null;
  }>(sql`select a.id, a.name, a.phone, a.status, a.connected_at::text, a.new_chats_per_day, a.last_refusal, a.last_refusal_at::text,
      (select max(m.sent_at)::text from whatsapp_messages m join whatsapp_chats c on c.id = m.chat_id where c.account_id = a.id and m.origin = 'agentsdr') as last_sent,
      (select coalesce(array_agg(c.created_at::text order by c.created_at), '{}'::text[]) from whatsapp_chats c where c.account_id = a.id and c.created_at >= ${new Date(now.getTime() - NEW_CHAT_WINDOW_MS).toISOString()}::timestamptz
        and (select m.origin from whatsapp_messages m where m.chat_id = c.id order by m.sent_at asc limit 1) = 'agentsdr') as new_chat_times,
      (select count(*)::int from whatsapp_campaign_leads l join whatsapp_campaigns wc on wc.id = l.campaign_id
        where wc.organization_id = ${org} and l.status in ('queued', 'in_sequence') and (l.account_id = a.id or l.account_id is null)
          and (${campaignId}::uuid is null or l.campaign_id = ${campaignId}::uuid)) as queued,
      (select count(*)::int from whatsapp_campaign_leads l join whatsapp_campaigns wc on wc.id = l.campaign_id
        where wc.organization_id = ${org} and l.status in ('queued', 'in_sequence') and l.current_step = 0 and (l.account_id = a.id or l.account_id is null)
          and (${campaignId}::uuid is null or l.campaign_id = ${campaignId}::uuid)) as first_queued
    from whatsapp_accounts a
    where a.organization_id = ${org}
      and (${campaignId}::uuid is null or a.id in (select ca.account_id from whatsapp_campaign_accounts ca where ca.campaign_id = ${campaignId}::uuid))
    order by a.created_at`);
  if (!accounts.length) return [];
  const [rules, unipile] = await Promise.all([channelRules("whatsapp"), isPlatformConnected("unipile")]);
  const hours = rules.sendingHours ? mailboxHoursFromWeekly(rules.sendingHours) : null;
  return accounts.map((a) => whatsappSenderStatus({
    account: a.phone || a.name || a.id,
    status: a.status,
    unipileConnected: unipile,
    paused: isMigrationControlPaused("whatsappOutbound"),
    sendingHours: hours,
    guardrails: whatsappGuardrails(rules, { newChatsPerDay: a.new_chats_per_day }),
    connectedAt: a.connected_at ? new Date(a.connected_at) : null,
    lastSentAt: a.last_sent ? new Date(a.last_sent) : null,
    newChatTimes: a.new_chat_times.map((time) => new Date(time)),
    queued: Number(a.queued),
    firstMessagesQueued: Number(a.first_queued),
    lastRefusal: a.last_refusal && a.last_refusal_at ? { reason: a.last_refusal, at: new Date(a.last_refusal_at) } : null,
    displayTimeZone,
    now,
  }));
}

/**
 * The LinkedIn accounts a run's campaign sends from (or every account of the
 * organization), with the checks the LinkedIn engine makes before each run:
 * working hours (the account's own, else the organization's), the gap
 * between runs, the daily invitation limit, the account's state.
 */
async function linkedinSenders(campaignId: string | null, forRun: boolean, now: Date, displayTimeZone: string): Promise<SenderStatus[]> {
  if (forRun && !campaignId) return [];
  const accounts = campaignId
    ? await db.select({ account: linkedInAccounts }).from(campaignAccounts)
      .innerJoin(linkedInAccounts, eq(linkedInAccounts.id, campaignAccounts.linkedinAccountId))
      .where(and(inOrg(linkedInAccounts), eq(campaignAccounts.campaignId, campaignId)))
      .then((rows) => rows.map((row) => row.account))
    : await db.select().from(linkedInAccounts).where(inOrg(linkedInAccounts));
  if (!accounts.length) return [];
  const [rules, unipile, general] = await Promise.all([channelRules("linkedin"), isPlatformConnected("unipile"), channelRules("general").catch(() => null)]);
  // The LinkedIn engine's scheduled run, and the organization's daily rollover that clears the invitation-limit flag.
  const outreachJob = platformJob("linkedin-run-outreach");
  const checkEveryMinutes = outreachJob.enabled && outreachJob.schedule.kind === "interval" ? outreachJob.schedule.minutes : null;
  const limitResetsAt = general ? nextDailyReset(general.timeZone, general.dayStartsAt, now) : null;
  // The engine counts a day's invitations from the server's own midnight (sendInvitations).
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const nextDayStart = new Date(todayStart.getTime() + 86_400_000);
  return Promise.all(accounts.map(async (account) => {
    const [sent] = await db.select({ n: count() }).from(linkedinLeads)
      .where(and(inOrg(linkedinLeads), eq(linkedinLeads.linkedinAccountId, account.id), ne(linkedinLeads.status, "PENDING"), gte(linkedinLeads.requestSentAt, todayStart)));
    const [waiting] = await db.select({ n: count() }).from(linkedinLeads)
      .where(and(
        inOrg(linkedinLeads),
        eq(linkedinLeads.status, "PENDING"),
        campaignId ? eq(linkedinLeads.campaignId, campaignId) : sql`true`,
        or(eq(linkedinLeads.linkedinAccountId, account.id), isNull(linkedinLeads.linkedinAccountId)),
      ));
    return linkedinSenderStatus({
      account: account.username ? `@${account.username.replace(/^@/, "")}` : account.name ?? account.id,
      status: account.status,
      limitReached: account.limitReached,
      unipileConnected: unipile,
      paused: isMigrationControlPaused("linkedinOutbound"),
      hours: withOrganizationHours(account, rules.workingHours),
      nextAllowedRun: account.nextAllowedRun,
      invitationsToday: Number(sent?.n ?? 0),
      invitationsPerDay: account.dailyInviteLimit ?? (account.isPremium ? rules.invitesPerDayPremium : rules.invitesPerDayFree),
      nextDayStart,
      queued: Number(waiting?.n ?? 0),
      checkEveryMinutes,
      limitResetsAt,
      displayTimeZone,
      now,
    });
  }));
}

/** The organization's next new-day time (its daily rollover), after now; null when its settings cannot be read. */
function nextDailyReset(timeZone: unknown, dayStartsAt: unknown, now: Date): Date | null {
  if (typeof timeZone !== "string" || typeof dayStartsAt !== "string") return null;
  try {
    return nextSlotAt(dailyAt(dayStartsAt, timeZone), new Date(now.getTime() + 1));
  } catch {
    return null;
  }
}

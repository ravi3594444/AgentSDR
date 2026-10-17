import "server-only";
import { and, eq, sql } from "drizzle-orm";
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
} from "@/lib/outreach/workingHours";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { outreachRuns } from "./schema";

/** Read-only snapshot. It reports stored gates, not a claim that a worker or provider is healthy. */
export async function diagnoseDelivery(runId?: string) {
  const org = currentOrganizationId();
  const now = new Date();
  const [run] = runId
    ? await db
        .select()
        .from(outreachRuns)
        .where(and(inOrg(outreachRuns), eq(outreachRuns.id, runId)))
    : [];
  if (runId && !run) throw new Error("No such outreach run");
  const emailCampaign = run?.campaigns.email ?? null;
  const campaignScope = run
    ? emailCampaign
      ? sql`c.id::text=${emailCampaign}`
      : sql`false`
    : sql`true`;
  const mailboxList = await db.select().from(mailboxes).where(inOrg(mailboxes));
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
  if ((await featureEnabled("instagram")) && (await instagramOutreachReady())) {
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
    "This snapshot does not measure worker liveness or confirm future delivery. Lead cities do not determine a sender's sending timezone.",
  ];
  if (!email.length) lines.splice(1, 0, "No email mailbox is configured.");
  return {
    at: now.toISOString(),
    runStatus: run?.status ?? null,
    email,
    emailCampaigns: Array.from(emailCampaigns),
    errors: Array.from(errors),
    instagram,
    instagramErrors,
    summary: lines.join("\n"),
  };
}

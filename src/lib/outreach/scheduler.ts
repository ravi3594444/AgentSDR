/**
 * Send scheduler — Phase 2 of AgentSDR-app's two-phase send model, ported
 * from send-mails.ts's processAllMailBoxQueue(). Each tick drains at most one
 * queued lead per connected mailbox with spare capacity from
 * outreach_mailbox_queue (the Postgres equivalent of AgentSDR-app's
 * per-mailbox Redis list), gated by the gap between sends
 * (mailbox.nextEmailTime) and the mailbox's daily limit. Sending is always
 * on: there are no sending hours; a mailbox's time zone only sets the day its
 * daily counter belongs to.
 *
 * The queue is built once a day by buildMailboxQueues() (see buildQueue.ts)
 * and again after a launch or resume. The tick does not pick leads itself,
 * except through its repair: every REPAIR_EVERY_MS it looks for organizations
 * with due work missing from the queue (a follow-up that fell due after the
 * day's build, the leads of a build that failed) and tops their queues up
 * (topUpMailboxQueues). An empty queue with nothing due is left alone.
 * Invoked every 10 seconds by the in-process scheduler (internalScheduler.ts), or
 * by hand through /api/outreach/tick.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, people } from "@/lib/leads/schema";
import { personVariables } from "@/lib/leads/variables";
import { mailboxes, outreachLeads, outreachEmails, outreachCampaigns, outreachMailboxQueue } from "./schema";
import type { OutreachLeadStatus, SequenceStep } from "./schema";
import type { SendEmailParams, SendEmailResult } from "./gmail";
import { mailboxProviderConnected, sendFromMailbox, type SendingMailbox } from "./mailboxProviders";
import type { MailboxProvider } from "./schema";
import { isSuppressed } from "./suppression";
import { EMAIL_DNC_BLOCKED_ERROR, leadAfterSend, leadDueNow, mailboxAtDailyLimit } from "./sendRules";
import { topUpMailboxQueues } from "./buildQueue";
import { newLeadAllowance, recordNewLead, releaseNewLead } from "@/lib/channels/dailyLeadLimit.server";
import { channelRules } from "@/lib/channels/rules.server";
import { fillTemplate, renderEmail, unsubscribePostUrl } from "./render";
import { isMigrationControlPaused } from "@/lib/migration/controls";
import { isPersonDoNotContact } from "@/lib/crm/policies";
import { candidateRoutes } from "@/lib/crm/wrongNumber";
import { wrongRouteSendRefusal } from "@/lib/crm/wrongRoutes";
import { inOrg, currentOrganizationId, runInOrganization } from "@/lib/tenancy/scope";
import { leadsInOrg } from "./orgScope";

/** When this mailbox may send again: the organization's minimum gap, in seconds. */
async function nextEmailSendTime(): Promise<Date> {
  const { secondsBetweenSends } = await channelRules("email");
  return new Date(Date.now() + secondsBetweenSends * 1000);
}

export type TickResult = {
  mailboxesWithQueue: number;
  sent: number;
  skippedSuppressed: number;
  skippedThrottle: number;
  skippedAlreadyClaimed: number;
  skippedDailyLimit: number;
  /** A claimed row whose lead is not due (left from before the lead advanced): dropped, nothing sent early. */
  skippedNotDue: number;
  /** A first email the daily lead limit refused at its claim: nothing claimed or sent; the lead stays pending for the next build. */
  skippedDailyLeadLimit: number;
  /** Rows the repair added for due work that was missing from the queue. */
  toppedUp: number;
  failed: number;
};

type SendFunction = (params: SendEmailParams, mailbox: SendingMailbox) => Promise<SendEmailResult>;

/** How often the tick looks for due work missing from the queue, and for at most how many organizations at once. */
const REPAIR_EVERY_MS = 10 * 60_000;
const REPAIR_ORGANIZATIONS = 25;
let lastRepairAt = 0;

/**
 * The repair before the sends: "auto" every REPAIR_EVERY_MS (the in-process
 * scheduler and the tick route), "now" on this tick (checks), "off" (the
 * default: a call that did not ask for it never prepares anything).
 */
type Repair = "auto" | "now" | "off";

/**
 * Drains one queued lead per connected mailbox that currently has a
 * non-empty queue — mirrors processAllMailBoxQueue()'s per-mailbox loop: for
 * each mailbox with a queued send, check the gap between sends
 * (mailbox.nextEmailTime) and the daily limit, pop the front of that
 * mailbox's queue (lowest `position`), check the lead is due, send, and set
 * the next gap. The repair before it tops up due work missing from the
 * queue; nothing else here picks leads. `organizationIds` limits the tick and
 * its repair to those organizations (a check's own); every one otherwise.
 */
export async function runSchedulerTick(options: { send?: SendFunction; now?: Date; repair?: Repair; organizationIds?: string[] } = {}): Promise<TickResult> {
  const result: TickResult = {
    mailboxesWithQueue: 0,
    sent: 0,
    skippedSuppressed: 0,
    skippedThrottle: 0,
    skippedAlreadyClaimed: 0,
    skippedDailyLimit: 0,
    skippedNotDue: 0,
    skippedDailyLeadLimit: 0,
    toppedUp: 0,
    failed: 0,
  };
  if (isMigrationControlPaused("emailOutbound")) {
    console.warn("[outreach/scheduler] Email outbound is paused; tick skipped");
    return result;
  }
  const now = options.now ?? new Date();
  const send: SendFunction = options.send ?? ((params, mailbox) => sendFromMailbox(mailbox, params));

  const only = options.organizationIds ?? null;

  // The repair first, so what it prepares goes out in this same tick.
  const repair = options.repair ?? "off";
  if (repair === "now" || (repair === "auto" && Date.now() - lastRepairAt >= REPAIR_EVERY_MS)) {
    if (repair === "auto") lastRepairAt = Date.now();
    await repairQueues(result, now, only);
  }

  // One global loop, one scope per organization: the queue rows are grouped by
  // the organization their mailbox belongs to, and each organization's portion
  // runs in its own scope so the provider checks and every query below act
  // for that organization only.
  const queuedOrganizations = only && !only.length ? [] : await db
    .selectDistinct({ organizationId: mailboxes.organizationId })
    .from(outreachMailboxQueue)
    .innerJoin(mailboxes, eq(outreachMailboxQueue.mailboxId, mailboxes.id))
    .where(only ? inArray(mailboxes.organizationId, only) : undefined);
  for (const { organizationId } of queuedOrganizations) {
    try {
      await runInOrganization(organizationId, () => tickOrganization(result, now, send, Boolean(options.send)));
    } catch (err) {
      console.error(`[outreach/scheduler] organization ${organizationId} tick failed:`, err);
      result.failed += 1;
    }
  }
  return result;
}

const IN_SEQUENCE: OutreachLeadStatus[] = ["pending", "initial_sent", "in_follow_up"];

/**
 * The organizations with due email work nobody prepared: a lead of an active
 * campaign whose step is due, that is not queued, whose step nobody claimed,
 * with an address and a connected mailbox to send it. One platform-level
 * enumeration, like the tick's own below; each top-up then runs in its
 * organization's scope. A queue that is empty because nothing is due yet
 * matches nothing. At most REPAIR_ORGANIZATIONS a pass: those with a due
 * follow-up first (a first email can wait for the next build; a follow-up
 * is late), the rest in an order that changes every pass, so organizations
 * whose backlog a top-up cannot shrink (a full mailbox, the daily lead
 * limit) never keep the others out.
 */
async function organizationsMissingWork(now: Date, only: string[] | null): Promise<string[]> {
  if (only && !only.length) return [];
  const at = now.toISOString();
  const rows = await db.execute<{ organization_id: string }>(sql`
    select c.organization_id, bool_or(l.sequence_status in ('initial_sent', 'in_follow_up')) as follow_up
      from outreach_leads l
      join outreach_campaigns c on c.id = l.campaign_id and c.status = 'active'
     where (
             (l.sequence_status = 'pending' and l.mailbox_id is null and (l.next_send_at is null or l.next_send_at <= ${at}::timestamptz))
          or (l.sequence_status in ('initial_sent', 'in_follow_up') and l.next_send_at <= ${at}::timestamptz
              and exists (select 1 from outreach_mailboxes m where m.id = l.mailbox_id and m.status = 'connected'))
           )
       and exists (select 1 from outreach_mailboxes m where m.organization_id = c.organization_id and m.status = 'connected')
       and exists (select 1 from people p where p.id = l.person_id and coalesce(p.email, '') <> '')
       and not exists (select 1 from outreach_mailbox_queue q where q.lead_id = l.id)
       and not exists (select 1 from outreach_emails e where e.lead_id = l.id and e.step_number = l.current_step + 1)
       ${only ? sql`and c.organization_id in (${sql.join(only.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``}
     group by c.organization_id
     order by follow_up desc, md5(c.organization_id::text || ${String(Math.floor(now.getTime() / REPAIR_EVERY_MS))})
     limit ${REPAIR_ORGANIZATIONS}`);
  return Array.from(rows).map((row) => row.organization_id);
}

/** Tops up the queues of organizations with due work missing from them (buildQueue.ts topUpMailboxQueues). */
async function repairQueues(result: TickResult, now: Date, only: string[] | null) {
  let organizations: string[];
  try {
    organizations = await organizationsMissingWork(now, only);
  } catch (err) {
    console.error("[outreach/scheduler] looking for due work missing from the queue failed:", err);
    return;
  }
  for (const organizationId of organizations) {
    const part = await topUpMailboxQueues({ organizationIds: [organizationId], now });
    result.toppedUp += part.followUpsQueued + part.newLeadsQueued;
    for (const failure of part.failedOrganizations) console.error(`[outreach/scheduler] topping up organization ${failure.organizationId} failed: ${failure.error}`);
  }
}

async function tickOrganization(result: TickResult, now: Date, send: SendFunction, injectedSender: boolean) {
  // Each mailbox sends through its own provider (Google Workspace or
  // Unipile), connected per organization: a mailbox whose provider is not
  // connected is skipped, not the organization or the tick. An injected
  // sender (tests) bypasses both, so only the real one needs credentials.
  const providerConnected = new Map<MailboxProvider, boolean>();
  const canSend = async (provider: MailboxProvider) => {
    if (injectedSender) return true;
    if (!providerConnected.has(provider)) {
      const connected = await mailboxProviderConnected(provider);
      if (!connected) console.log(`[outreach/scheduler] ${provider} is not connected for organization ${currentOrganizationId()}; its mailboxes are skipped`);
      providerConnected.set(provider, connected);
    }
    return providerConnected.get(provider)!;
  };

  const queuedMailboxIds = await db
    .selectDistinct({ mailboxId: outreachMailboxQueue.mailboxId })
    .from(outreachMailboxQueue)
    .innerJoin(mailboxes, eq(outreachMailboxQueue.mailboxId, mailboxes.id))
    .where(inOrg(mailboxes));
  if (queuedMailboxIds.length === 0) return;
  result.mailboxesWithQueue += queuedMailboxIds.length;

  const campaignById = new Map(
    (await db.select().from(outreachCampaigns).where(inOrg(outreachCampaigns))).map((c) => [c.id, c]),
  );

  for (const { mailboxId } of queuedMailboxIds) {
    const [mailbox] = await db.select().from(mailboxes).where(and(inOrg(mailboxes), eq(mailboxes.id, mailboxId))).limit(1);
    if (!mailbox || mailbox.status !== "connected") continue;
    if (!(await canSend(mailbox.provider))) continue;

    if (mailbox.nextEmailTime && mailbox.nextEmailTime > now) {
      result.skippedThrottle += 1;
      continue;
    }
    // The queue is sized to the daily allowance when it is built, but a
    // rebuild (a launch or resume mid-day) and a send that lowered the limit
    // since must not push a mailbox past it.
    if (mailboxAtDailyLimit(mailbox, now)) {
      result.skippedDailyLimit += 1;
      continue;
    }

    // Claim and remove one row atomically. SELECT-then-DELETE allowed two
    // scheduler instances to read and send the same recipient.
    const claimed = await db.execute<typeof outreachMailboxQueue.$inferSelect>(sql`
      delete from outreach_mailbox_queue
      where id = (
        select q.id
        from outreach_mailbox_queue q
        join outreach_leads l on l.id = q.lead_id
        join outreach_campaigns c on c.id = l.campaign_id
        where q.mailbox_id = ${mailboxId} and c.status = 'active'
          and c.organization_id = ${currentOrganizationId()}
        order by q.position asc
        for update of q skip locked
        limit 1
      )
      returning id, mailbox_id as "mailboxId", lead_id as "leadId", position,
                created_at as "createdAt"
    `);
    const queued = claimed[0];
    if (!queued) continue;

    const [row] = await db
      .select({ lead: outreachLeads, person: people, company: companies })
      .from(outreachLeads)
      .innerJoin(people, eq(outreachLeads.personId, people.id))
      .leftJoin(companies, eq(people.companyId, companies.id))
      .where(and(leadsInOrg(), inOrg(people), eq(outreachLeads.id, queued.leadId)))
      .limit(1);
    if (!row?.person.email) continue;
    const lead = { ...row.lead, email: row.person.email, variables: personVariables(row.person, row.company) };
    if (!IN_SEQUENCE.includes(lead.sequenceStatus)) continue;
    // A row left from before the lead advanced (a rebuild overlapping its
    // send) must not send the next follow-up early: only what is due goes out.
    if (!leadDueNow(lead, now)) {
      result.skippedNotDue += 1;
      continue;
    }
    const campaign = campaignById.get(lead.campaignId);
    if (!campaign || campaign.status !== "active") continue;

    await sendNextStep(lead, campaign, mailbox, now, result, send);
  }
}

async function sendNextStep(
  lead: typeof outreachLeads.$inferSelect & { email: string; variables: Record<string, string> },
  campaign: typeof outreachCampaigns.$inferSelect,
  mailbox: typeof mailboxes.$inferSelect,
  now: Date,
  result: TickResult,
  send: SendFunction,
) {
  // Re-read at the last possible point. A campaign can be paused after the
  // daily queue was built or while this worker was processing another inbox.
  const [currentCampaign] = await db
    .select({ status: outreachCampaigns.status })
    .from(outreachCampaigns)
    .where(and(inOrg(outreachCampaigns), eq(outreachCampaigns.id, campaign.id)))
    .limit(1);
  if (currentCampaign?.status !== "active") return;
  const step: SequenceStep | undefined = campaign.sequence[lead.currentStep];
  if (!step) {
    await db
      .update(outreachLeads)
      .set({ sequenceStatus: "sequence_completed", updatedAt: now })
      .where(and(leadsInOrg(), eq(outreachLeads.id, lead.id)));
    return;
  }

  // An address recorded as a wrong number (it reached someone else) is as
  // closed to a campaign as an unsubscribed one.
  if (await isSuppressed(lead.email) || await wrongRouteSendRefusal(db, { channel: "email", routes: candidateRoutes("email", { email: lead.email }) })) {
    await db
      .update(outreachLeads)
      .set({ sequenceStatus: "suppressed", updatedAt: now })
      .where(and(leadsInOrg(), eq(outreachLeads.id, lead.id)));
    result.skippedSuppressed += 1;
    return;
  }

  // Oldest-first — matches AgentSDR-app's send-mails.ts semantics exactly:
  // a step with its own subject sends as a fresh, unthreaded message; only
  // a blank subject inherits the last-subjected prior send's subject and
  // threads (In-Reply-To + full References chain) off it.
  const pastSentEmails = await db
    .select()
    .from(outreachEmails)
    .where(and(eq(outreachEmails.leadId, lead.id), eq(outreachEmails.status, "sent")))
    .orderBy(asc(outreachEmails.sentAt));

  let subject = fillTemplate(step.subject, lead.variables);
  let inReplyTo: string | undefined;
  let references: string[] | undefined;
  let gmailThreadId: string | undefined;
  let providerReplyTo: string | undefined;

  if (!subject.trim()) {
    for (let i = pastSentEmails.length - 1; i >= 0; i--) {
      if (pastSentEmails[i].subject?.trim()) {
        inReplyTo = pastSentEmails[i].messageId ?? undefined;
        references = pastSentEmails.map((e) => e.messageId ?? "").filter(Boolean);
        gmailThreadId = pastSentEmails[i].threadId ?? undefined;
        // A Unipile mailbox threads by the earlier email's provider id instead.
        providerReplyTo = pastSentEmails[i].gmailMessageId ?? undefined;
        // "Re:" matches what a human reply looks like, and this genuinely is
        // one — step 1 really was delivered and the In-Reply-To/References
        // headers below back it up. Only faking "Re:" on a FIRST contact is a
        // spam signal. Guard against stacking "Re: Re:" on later steps.
        const priorSubject = pastSentEmails[i].subject!;
        subject = /^re:\s/i.test(priorSubject) ? priorSubject : `Re: ${priorSubject}`;
        break;
      }
    }
  }

  // Body goes through the shared renderer so the preview and the real send can
  // never drift — composing the steps here by hand is exactly how the HTML
  // footer ended up correct in preview but stale in sends.
  const { body, html } = renderEmail(step, lead, mailbox.signatureHtml);

  // The unique (lead, step) index is the durable provider-call claim. If a
  // worker crashes after Gmail accepts the message but before local state is
  // advanced, a later queue rebuild must not call Gmail for the same step.
  // Its time is the tick's: the clock the daily lead limit judged it by.
  const claimRow = {
    leadId: lead.id,
    mailboxId: mailbox.id,
    stepNumber: step.stepNumber,
    subject,
    body,
    status: "scheduled" as const,
    inReplyTo,
    references,
    createdAt: now,
  };
  const claimTarget = { target: [outreachEmails.leadId, outreachEmails.stepNumber] };
  // A first email also takes one of the day's new-lead places, in one
  // transaction with its claim, under the organization's new-leads lock: the
  // only lock taken here, after the queue row this tick already holds.
  // Refused: nothing is claimed or sent, the mailbox's gap is untouched, and
  // the lead stays pending for the next build.
  const claim = lead.currentStep === 0
    ? await db.transaction(async (tx) => {
      const allowance = await newLeadAllowance(tx, { personId: lead.personId, now });
      if (!allowance.ok) return { refused: allowance.reason };
      const [row] = await tx.insert(outreachEmails).values(claimRow).onConflictDoNothing(claimTarget).returning();
      if (row && allowance.counted) await recordNewLead(tx, { personId: lead.personId, channel: "email", at: now });
      return { row };
    })
    : { row: (await db.insert(outreachEmails).values(claimRow).onConflictDoNothing(claimTarget).returning())[0] };
  if ("refused" in claim) {
    console.log(`[outreach/scheduler] the first email to lead ${lead.id} waits: ${claim.refused}`);
    result.skippedDailyLeadLimit += 1;
    return;
  }
  const emailRow = claim.row;
  if (!emailRow) {
    result.skippedAlreadyClaimed += 1;
    return;
  }

  // Re-check Person-global DNC after claiming and immediately before Gmail.
  // This closes the race where DNC is set while a queued send is being built.
  if (await isPersonDoNotContact(db, lead.personId)) {
    await db.update(outreachEmails).set({
      status: "failed",
      error: EMAIL_DNC_BLOCKED_ERROR,
    }).where(eq(outreachEmails.id, emailRow.id));
    // Nothing went out: a first email's place is given back.
    if (lead.currentStep === 0) await releaseNewLead(db, { personId: lead.personId, since: now });
    await db.update(outreachLeads).set({
      sequenceStatus: "suppressed",
      nextSendAt: null,
      updatedAt: now,
    }).where(and(leadsInOrg(), eq(outreachLeads.id, lead.id)));
    result.skippedSuppressed += 1;
    return;
  }

  try {
    const sendResult = await send({
      from: mailbox.emailAddress,
      fromName: mailbox.displayName,
      to: [lead.email],
      subject,
      text: body,
      // Without an explicit html part gmail.ts falls back to `html ?? text`,
      // which ships the plain-text body as HTML — collapsing line breaks and
      // leaving every URL unclickable.
      html,
      inReplyTo,
      references,
      threadId: gmailThreadId,
      providerReplyTo,
      unsubscribeUrl: unsubscribePostUrl(lead.email),
    }, mailbox);

    const nextStep = campaign.sequence[lead.currentStep + 1];
    const after = leadAfterSend(lead, campaign.sequence.length, nextStep ? nextStep.waitDays : null, now);

    await db
      .update(outreachEmails)
      .set({
        status: "sent",
        sentAt: now,
        gmailMessageId: sendResult.id,
        messageId: sendResult.messageId,
        threadId: sendResult.threadId,
      })
      .where(eq(outreachEmails.id, emailRow.id));

    const advanced = await db
      .update(outreachLeads)
      .set({ mailboxId: mailbox.id, ...after, updatedAt: now })
      .where(and(leadsInOrg(), eq(outreachLeads.id, lead.id), inArray(outreachLeads.sequenceStatus, IN_SEQUENCE)))
      .returning({ id: outreachLeads.id });
    if (!advanced.length) {
      // Stopped while sending (reply, bounce, unsubscribe): keep that status.
      await db
        .update(outreachLeads)
        .set({ mailboxId: mailbox.id, currentStep: after.currentStep, nextSendAt: null, updatedAt: now })
        .where(and(leadsInOrg(), eq(outreachLeads.id, lead.id)));
    }

    await db
      .update(mailboxes)
      .set({ todayEmailsSent: sql`${mailboxes.todayEmailsSent} + 1`, nextEmailTime: await nextEmailSendTime() })
      .where(and(inOrg(mailboxes), eq(mailboxes.id, mailbox.id)));

    result.sent += 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A transport error can occur after Gmail accepted the message. Keep the
    // unique claim even when status is failed; retries require explicit
    // provider reconciliation instead of risking a duplicate delivery.
    await db.update(outreachEmails).set({ status: "failed", error: message }).where(eq(outreachEmails.id, emailRow.id));
    result.failed += 1;
  }
}

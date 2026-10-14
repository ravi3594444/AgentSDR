/**
 * Send scheduler — Phase 2 of AgentSDR-app's two-phase send model, ported
 * from send-mails.ts's processAllMailBoxQueue() line-for-line. Each tick
 * drains at most one queued lead per connected mailbox with spare capacity
 * from outreach_mailbox_queue (the Postgres equivalent of AgentSDR-app's
 * per-mailbox Redis list), gated by the same throttle (mailbox.nextEmailTime)
 * and working-hours checks. The queue itself is built once a day by
 * buildMailboxQueues() (see buildQueue.ts) — this function does NOT pick
 * leads on its own; if the queue is empty for a mailbox, nothing sends from
 * it until the next daily build. Meant to be invoked repeatedly by an
 * external cron via /api/outreach/tick.
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
import { isWithinWorkingHours } from "./workingHours";
import { leadAfterSend, mailboxAtDailyLimit } from "./sendRules";
import { channelRules } from "@/lib/channels/rules.server";
import { pickInRange } from "@/lib/channels/rules";
import { fillTemplate, renderEmail, unsubscribePostUrl } from "./render";
import { isMigrationControlPaused } from "@/lib/migration/controls";
import { isPersonDoNotContact } from "@/lib/crm/policies";
import { inOrg, currentOrganizationId, runInOrganization } from "@/lib/tenancy/scope";
import { leadsInOrg } from "./orgScope";

/** When this mailbox may send again: a random gap from the organization's sending rules. */
async function randomNextSendDelay(): Promise<Date> {
  const { sendGapMinutes } = await channelRules("email");
  return new Date(Date.now() + pickInRange(sendGapMinutes) * 60 * 1000);
}

type TickResult = {
  mailboxesWithQueue: number;
  sent: number;
  skippedSuppressed: number;
  skippedThrottle: number;
  skippedOutsideHours: number;
  skippedAlreadyClaimed: number;
  skippedDailyLimit: number;
  failed: number;
};

/**
 * Drains one queued lead per connected mailbox that currently has a
 * non-empty queue — mirrors processAllMailBoxQueue()'s per-mailbox loop
 * exactly: for each mailbox with a queued send, check the throttle gate
 * (mailbox.nextEmailTime), check working hours, pop the front of that
 * mailbox's queue (lowest `position`), send, and set the next throttle time.
 * Does NOT pick leads itself — that's buildMailboxQueues()'s job, run once
 * daily. If a mailbox's queue is empty, this is a no-op for it until the
 * next daily build.
 */
type SendFunction = (params: SendEmailParams, mailbox: SendingMailbox) => Promise<SendEmailResult>;

export async function runSchedulerTick(options: { send?: SendFunction; now?: Date } = {}): Promise<TickResult> {
  const result: TickResult = {
    mailboxesWithQueue: 0,
    sent: 0,
    skippedSuppressed: 0,
    skippedThrottle: 0,
    skippedOutsideHours: 0,
    skippedAlreadyClaimed: 0,
    skippedDailyLimit: 0,
    failed: 0,
  };
  if (isMigrationControlPaused("emailOutbound")) {
    console.warn("[outreach/scheduler] Email outbound is paused; tick skipped");
    return result;
  }
  const now = options.now ?? new Date();
  const send: SendFunction = options.send ?? ((params, mailbox) => sendFromMailbox(mailbox, params));

  // One global loop, one scope per organization: the queue rows are grouped by
  // the organization their mailbox belongs to, and each organization's portion
  // runs in its own scope so the provider checks and every query below act
  // for that organization only.
  const queuedOrganizations = await db
    .selectDistinct({ organizationId: mailboxes.organizationId })
    .from(outreachMailboxQueue)
    .innerJoin(mailboxes, eq(outreachMailboxQueue.mailboxId, mailboxes.id));
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
    if (!isWithinWorkingHours(mailbox.workingHours, now)) {
      result.skippedOutsideHours += 1;
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
    if (!["pending", "initial_sent", "in_follow_up"].includes(lead.sequenceStatus)) continue;
    const campaign = campaignById.get(lead.campaignId);
    if (!campaign || campaign.status !== "active") continue;

    await sendNextStep(lead, campaign, mailbox, now, result, send);
  }
}

const IN_SEQUENCE: OutreachLeadStatus[] = ["pending", "initial_sent", "in_follow_up"];

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

  if (await isSuppressed(lead.email)) {
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
  const [emailRow] = await db
    .insert(outreachEmails)
    .values({
      leadId: lead.id,
      mailboxId: mailbox.id,
      stepNumber: step.stepNumber,
      subject,
      body,
      status: "scheduled",
      inReplyTo,
      references,
    })
    .onConflictDoNothing({ target: [outreachEmails.leadId, outreachEmails.stepNumber] })
    .returning();
  if (!emailRow) {
    result.skippedAlreadyClaimed += 1;
    return;
  }

  // Re-check Person-global DNC after claiming and immediately before Gmail.
  // This closes the race where DNC is set while a queued send is being built.
  if (await isPersonDoNotContact(db, lead.personId)) {
    await db.update(outreachEmails).set({
      status: "failed",
      error: "Blocked by Person-global Do Not Contact policy before provider submission",
    }).where(eq(outreachEmails.id, emailRow.id));
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
      .set({ todayEmailsSent: sql`${mailboxes.todayEmailsSent} + 1`, nextEmailTime: await randomNextSendDelay() })
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

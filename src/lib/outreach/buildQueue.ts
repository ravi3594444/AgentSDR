/**
 * Daily queue build — Phase 1 of AgentSDR-app's two-phase send model, ported
 * from make-mailbox-queue-for-team.ts line-for-line (minus the team/domain
 * layer v2 doesn't have, and Redis lists swapped for the outreach_mailbox_queue
 * table). Runs once a day per organization, at the start of that
 * organization's day (the daily rollover, src/lib/scheduler/dailyRollover.ts;
 * /api/outreach/build-queue triggers it by hand or from an external cron),
 * and again after a launch, a resume or a campaign activation, before the
 * frequent send tick drains it.
 *
 * Two-pass fill per mailbox, in this order:
 *   Pass A — leads already mid-sequence and due now get queued first,
 *     ordered by nextSendAt ASC then currentStep DESC: the most-overdue lead
 *     wins, and among equally-due leads the one furthest into its sequence
 *     (e.g. on its 4th follow-up) is queued ahead of one just starting out.
 *     Matches AgentSDR-app's `ORDER BY lead.nextFollowup, lead.followups DESC`.
 *   Pass B — brand-new (`pending`) leads round-robin fill whatever capacity
 *     is left over, same as AgentSDR-app's PENDING-lead fill pass, within the
 *     daily lead limit's remaining places (dailyLeadLimit.server.ts).
 * Neither pass queues a lead whose current step is already claimed (an
 * outreach_emails row: sent, in flight, or failed and never retried on its
 * own), nor one whose person has no email address: the tick would only use
 * up the slot.
 *
 * All or nothing: an organization's queue is replaced in one transaction
 * under its `email-queue:<org>` advisory lock, so a build that fails part way
 * leaves the previous queue in place, and two builds of one organization run
 * one after the other. While a build runs, the tick skips the rows it holds
 * (FOR UPDATE … SKIP LOCKED) and sends nothing for that organization.
 *
 * A top-up (topUpMailboxQueues, run by the send tick's repair) adds due work
 * missing from the queue: a follow-up that fell due after the day's build, or
 * the leads of a build that failed. It deletes nothing and never resets a
 * daily counter; a mailbox whose counter is from an earlier local day is
 * skipped until the daily build resets it (sendRules.ts topUpRoom).
 */
import { and, asc, count, desc, eq, inArray, isNull, lte, max, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { contactedByAutomation, newLeadsToday } from "@/lib/channels/dailyLeadLimit.server";
import { mailboxes, outreachCampaigns, outreachLeads, outreachMailboxQueue } from "./schema";
import { newLeadsToQueue, topUpRoom } from "./sendRules";
import { isSameLocalDay } from "./workingHours";
import { isMigrationControlPaused } from "@/lib/migration/controls";
import { currentOrganizationId, inOrg, runInOrganization } from "@/lib/tenancy/scope";
import { leadsInOrg, orgMailboxIds } from "./orgScope";

type MailboxCapacity = {
  mailboxId: string;
  queue: string[]; // lead ids, in order
  currentAvailableCapacity: number;
  /** The position the first new row takes: after what a top-up finds already queued. */
  start: number;
};

export type BuildQueueResult = {
  mailboxesConsidered: number;
  followUpsQueued: number;
  newLeadsQueued: number;
  /** Organizations whose queue could not be built, with the error: each keeps the queue it had. */
  failedOrganizations: { organizationId: string; error: string }[];
};

type Mode = "rebuild" | "top_up";
type Counts = Omit<BuildQueueResult, "failedOrganizations">;

/** How long a build waits for a lock (another build of the organization, a row a send holds) before it gives up and reports the failure. */
const LOCK_TIMEOUT = "15s";

export function emailQueueLockKey(organizationId: string): string {
  return `email-queue:${organizationId}`;
}

/**
 * Builds the queues of every organization that has a mailbox, or only of
 * `organizationIds` when given (the daily rollover passes one). `now` is
 * the build's clock (tests move it to another day).
 */
export async function buildMailboxQueues(options: { organizationIds?: string[]; now?: Date } = {}): Promise<BuildQueueResult> {
  return forOrganizations("rebuild", options);
}

/** Adds due work missing from the queues of `organizationIds` (see the header); the send tick's repair calls it. */
export async function topUpMailboxQueues(options: { organizationIds: string[]; now?: Date }): Promise<BuildQueueResult> {
  return forOrganizations("top_up", options);
}

/**
 * What a launch, a resume or an activation says when the queue it rebuilt
 * could not be prepared: in the owner's words (the database's own error
 * stays in the server log). The send tick's repair tops the queue up every
 * 10 minutes, resetting a mailbox's daily counter first when its day changed.
 */
export const QUEUE_NOT_PREPARED_NOTE = "Its emails are not in the sending queue yet (the queue could not be updated just now); it is topped up again within 10 minutes.";

/**
 * Rebuilds the queue of the organization in scope after a launch, a resume
 * or an activation, so what was started mid-day sends today. Its failure
 * never fails the launch: the campaign stays active, the send tick's repair
 * prepares its emails, and the note returned says so for the caller to show.
 */
export async function rebuildEmailQueue(): Promise<string | null> {
  try {
    const result = await buildMailboxQueues({ organizationIds: [currentOrganizationId()] });
    // buildMailboxQueues logged the organization's own error.
    return result.failedOrganizations.length ? QUEUE_NOT_PREPARED_NOTE : null;
  } catch (error) {
    console.error("[outreach/buildQueue] rebuilding the queue after a launch failed:", errorText(error));
    return QUEUE_NOT_PREPARED_NOTE;
  }
}

async function forOrganizations(mode: Mode, options: { organizationIds?: string[]; now?: Date }): Promise<BuildQueueResult> {
  const total: BuildQueueResult = { mailboxesConsidered: 0, followUpsQueued: 0, newLeadsQueued: 0, failedOrganizations: [] };
  if (isMigrationControlPaused("emailOutbound")) {
    console.warn(`[outreach/buildQueue] Email outbound is paused; queue ${mode === "rebuild" ? "rebuild" : "top-up"} skipped`);
    return total;
  }
  const now = options.now ?? new Date();

  // One run, one scope per organization: every organization's queue is
  // built from its own mailboxes, campaigns and leads and nothing else.
  const withMailboxes = await db.selectDistinct({ organizationId: mailboxes.organizationId }).from(mailboxes);
  const wanted = options.organizationIds ? new Set(options.organizationIds) : null;
  const organizations = wanted ? withMailboxes.filter((o) => wanted.has(o.organizationId)) : withMailboxes;
  for (const { organizationId } of organizations) {
    try {
      const part = await runInOrganization(organizationId, () => buildOrganizationQueues(mode, now));
      total.mailboxesConsidered += part.mailboxesConsidered;
      total.followUpsQueued += part.followUpsQueued;
      total.newLeadsQueued += part.newLeadsQueued;
    } catch (err) {
      console.error(`[outreach/buildQueue] organization ${organizationId} ${mode} failed:`, err);
      total.failedOrganizations.push({ organizationId, error: errorText(err) });
    }
  }
  return total;
}

/** The innermost cause's words: the database's own error, not the query text (and its lead ids) a driver wraps it in. */
function errorText(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Error && current.cause instanceof Error; depth += 1) current = current.cause;
  return current instanceof Error ? current.message : String(current);
}

async function buildOrganizationQueues(mode: Mode, now: Date): Promise<Counts> {
  const organizationId = currentOrganizationId();
  // The daily lead limit's places left today: an upper bound on the first
  // emails worth queuing. Each claim still asks newLeadAllowance itself.
  const day = await newLeadsToday(now);
  const places = Math.max(0, day.limit - day.used);
  const contacted = await contactedByAutomation(sql`${outreachLeads.personId}`);

  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`set local lock_timeout = '${LOCK_TIMEOUT}'`));
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${emailQueueLockKey(organizationId)}, 0))`);

    const connectedMailboxes = await tx
      .select()
      .from(mailboxes)
      .where(and(inOrg(mailboxes), eq(mailboxes.status, "connected")));

    // Reset each mailbox's daily counter only if it hasn't already been reset
    // today (in that mailbox's own timezone) — safe to repeat any number of
    // times a day (a duplicate cron fire, a manual re-run, a top-up) without
    // granting a second full daily allowance by re-zeroing todayEmailsSent.
    // A top-up does it too, so a day whose build failed, or a mailbox whose
    // midnight comes before the workspace's day starts, still gets its work.
    const mailboxesNeedingReset = connectedMailboxes.filter(
      (m) => !isSameLocalDay(m.sendCounterResetAt, now, m.workingHours.timezone),
    );
    if (mailboxesNeedingReset.length > 0) {
      await tx
        .update(mailboxes)
        .set({ todayEmailsSent: 0, sendCounterResetAt: now })
        .where(and(inOrg(mailboxes), inArray(mailboxes.id, mailboxesNeedingReset.map((m) => m.id))));
    }
    const resetIds = new Set(mailboxesNeedingReset.map((m) => m.id));
    const current = connectedMailboxes.map((m) => (resetIds.has(m.id) ? { ...m, todayEmailsSent: 0, sendCounterResetAt: now } : m));

    const queues = new Map<string, MailboxCapacity>();
    // First emails already queued and not yet claimed hold a place each until claimed (a top-up keeps them).
    let placesLeft = places;
    if (mode === "rebuild") {
      // Supersede the previous queue: inside this transaction, so it stays if the build fails.
      await tx.delete(outreachMailboxQueue).where(inArray(outreachMailboxQueue.mailboxId, orgMailboxIds()));
      for (const mailbox of current) {
        queues.set(mailbox.id, { mailboxId: mailbox.id, queue: [], currentAvailableCapacity: Math.max(0, mailbox.dailySendLimit - mailbox.todayEmailsSent), start: 0 });
      }
    } else if (current.length > 0) {
      const [held] = await tx
        .select({ n: count() })
        .from(outreachMailboxQueue)
        .innerJoin(outreachLeads, eq(outreachLeads.id, outreachMailboxQueue.leadId))
        .where(and(inArray(outreachMailboxQueue.mailboxId, current.map((m) => m.id)), eq(outreachLeads.sequenceStatus, "pending"), sql`not ${contacted}`));
      placesLeft = Math.max(0, places - Number(held?.n ?? 0));
      const existing = new Map(
        (await tx
          .select({ mailboxId: outreachMailboxQueue.mailboxId, rows: count(), last: max(outreachMailboxQueue.position) })
          .from(outreachMailboxQueue)
          .where(inArray(outreachMailboxQueue.mailboxId, current.map((m) => m.id)))
          .groupBy(outreachMailboxQueue.mailboxId)).map((row) => [row.mailboxId, row]),
      );
      for (const mailbox of current) {
        const queued = existing.get(mailbox.id);
        const room = topUpRoom(mailbox, Number(queued?.rows ?? 0), now);
        if (room === null || room === 0) continue;
        queues.set(mailbox.id, { mailboxId: mailbox.id, queue: [], currentAvailableCapacity: room, start: (queued?.last ?? -1) + 1 });
      }
    }

    const activeCampaigns = await tx.select({ id: outreachCampaigns.id }).from(outreachCampaigns).where(and(inOrg(outreachCampaigns), eq(outreachCampaigns.status, "active")));
    if (activeCampaigns.length === 0 || queues.size === 0) {
      return { mailboxesConsidered: queues.size, followUpsQueued: 0, newLeadsQueued: 0 };
    }
    const activeCampaignIds = activeCampaigns.map((c) => c.id);
    const mailboxIds = [...queues.keys()];

    // Every pass: a lead of an active campaign, not queued yet, whose current
    // step nobody claimed, with an address to send to.
    const queueable = and(
      leadsInOrg(),
      inArray(outreachLeads.campaignId, activeCampaignIds),
      sql`not exists (select 1 from outreach_mailbox_queue q where q.lead_id = ${outreachLeads.id})`,
      sql`not exists (select 1 from outreach_emails e where e.lead_id = ${outreachLeads.id} and e.step_number = ${outreachLeads.currentStep} + 1)`,
      sql`exists (select 1 from people p where p.id = ${outreachLeads.personId} and coalesce(p.email, '') <> '')`,
    );

    // Pass A: leads mid-sequence, due now, pinned to a mailbox with capacity —
    // most-overdue and deepest-into-sequence first.
    const dueFollowUps = await tx
      .select({ id: outreachLeads.id, mailboxId: outreachLeads.mailboxId })
      .from(outreachLeads)
      .where(
        and(
          queueable,
          inArray(outreachLeads.mailboxId, mailboxIds),
          or(eq(outreachLeads.sequenceStatus, "initial_sent"), eq(outreachLeads.sequenceStatus, "in_follow_up")),
          lte(outreachLeads.nextSendAt, now),
        ),
      )
      .orderBy(asc(outreachLeads.nextSendAt), desc(outreachLeads.currentStep));

    let followUpsQueued = 0;
    for (const lead of dueFollowUps) {
      if (!lead.mailboxId) continue;
      const cap = queues.get(lead.mailboxId);
      if (!cap) continue;
      if (cap.queue.length >= cap.currentAvailableCapacity) continue;
      cap.queue.push(lead.id);
      followUpsQueued += 1;
    }

    // Pass B: brand-new leads round-robin fill whatever capacity remains.
    const netCapacity = Array.from(queues.values()).reduce(
      (sum, cap) => sum + Math.max(0, cap.currentAvailableCapacity - cap.queue.length),
      0,
    );

    let newLeadsQueued = 0;
    if (netCapacity > 0) {
      const pending = and(
        queueable,
        eq(outreachLeads.sequenceStatus, "pending"),
        isNull(outreachLeads.mailboxId),
        or(isNull(outreachLeads.nextSendAt), lte(outreachLeads.nextSendAt, now)),
      );
      const firstEmails = (where: typeof pending, limit: number) => tx
        .select({ id: outreachLeads.id, createdAt: outreachLeads.createdAt })
        .from(outreachLeads)
        .where(where)
        .orderBy(asc(outreachLeads.createdAt))
        .limit(limit);
      let newLeadIds: string[];
      if (placesLeft >= netCapacity) {
        newLeadIds = (await firstEmails(pending, netCapacity)).map((lead) => lead.id);
      } else {
        // Fewer places than capacity: people automated outreach already
        // reached take none, so they are not stuck behind the limit.
        const reached = await firstEmails(and(pending, contacted), netCapacity);
        const fresh = placesLeft > 0 ? await firstEmails(and(pending, sql`not ${contacted}`), placesLeft) : [];
        const candidates = [
          ...reached.map((lead) => ({ ...lead, contacted: true })),
          ...fresh.map((lead) => ({ ...lead, contacted: false })),
        ].sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
        newLeadIds = newLeadsToQueue(candidates, { places: placesLeft, capacity: netCapacity });
      }

      const cycle = Array.from(queues.values()).filter((cap) => cap.queue.length < cap.currentAvailableCapacity);
      for (const leadId of newLeadIds) {
        const cap = cycle.shift();
        if (!cap) break;
        cap.queue.push(leadId);
        newLeadsQueued += 1;
        if (cap.queue.length < cap.currentAvailableCapacity) cycle.push(cap);
      }
    }

    const rows: Array<{ mailboxId: string; leadId: string; position: number }> = [];
    for (const cap of queues.values()) {
      cap.queue.forEach((leadId, index) => rows.push({ mailboxId: cap.mailboxId, leadId, position: cap.start + index }));
    }
    if (rows.length > 0) {
      await tx.insert(outreachMailboxQueue).values(rows)
        .onConflictDoNothing({ target: outreachMailboxQueue.leadId });
    }

    return { mailboxesConsidered: queues.size, followUpsQueued, newLeadsQueued };
  });
}

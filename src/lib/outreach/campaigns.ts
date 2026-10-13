import { eq, desc, asc, and, count, max, inArray, or, sql, lte, gte, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, people } from "@/lib/leads/schema";
import { personVariables, variableValue } from "@/lib/leads/variables";
import { outreachCampaigns, outreachLeads, outreachEmails, mailboxes } from "./schema";
import type { SequenceStep, CampaignStatus, OutreachLeadStatus } from "./schema";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { leadsInOrg, orgLeadIds } from "./orgScope";
import { isPlatformConnected } from "@/lib/platform/credentials";
import type { EmailLaunchFacts } from "./launch";

export async function listCampaigns() {
  const rows = await db.select().from(outreachCampaigns).where(inOrg(outreachCampaigns)).orderBy(desc(outreachCampaigns.createdAt));
  const counts = await db
    .select({ campaignId: outreachLeads.campaignId, total: count() })
    .from(outreachLeads)
    .where(leadsInOrg())
    .groupBy(outreachLeads.campaignId);
  const countByCampaign = new Map(counts.map((c) => [c.campaignId, c.total]));
  return rows.map((c) => ({ ...c, leadCount: countByCampaign.get(c.id) ?? 0 }));
}

/** List view needs reply rate + last-activity per campaign on top of the lead count — one grouped query each, no N+1. */
export async function listCampaignsWithStats() {
  const campaigns = await listCampaigns();

  const replied = await db
    .select({ campaignId: outreachLeads.campaignId, total: count() })
    .from(outreachLeads)
    .where(and(leadsInOrg(), eq(outreachLeads.sequenceStatus, "reply_received")))
    .groupBy(outreachLeads.campaignId);
  const repliedByCampaign = new Map(replied.map((r) => [r.campaignId, r.total]));

  const lastSent = await db
    .select({ campaignId: outreachLeads.campaignId, lastSentAt: max(outreachEmails.sentAt) })
    .from(outreachEmails)
    .innerJoin(outreachLeads, eq(outreachEmails.leadId, outreachLeads.id))
    .where(and(leadsInOrg(), eq(outreachEmails.status, "sent")))
    .groupBy(outreachLeads.campaignId);
  const lastSentByCampaign = new Map(lastSent.map((r) => [r.campaignId, r.lastSentAt]));

  // Emails actually delivered, counted per campaign. This is the "Sent" column and
  // exceeds leadCount once follow-up steps go out — one email row per step per lead.
  const sent = await db
    .select({ campaignId: outreachLeads.campaignId, total: count() })
    .from(outreachEmails)
    .innerJoin(outreachLeads, eq(outreachEmails.leadId, outreachLeads.id))
    .where(and(leadsInOrg(), eq(outreachEmails.status, "sent")))
    .groupBy(outreachLeads.campaignId);
  const sentByCampaign = new Map(sent.map((r) => [r.campaignId, r.total]));

  // Progress is measured in sends, not in fully-settled leads. Counting only
  // leads that reached the end of the sequence reports 0% for a campaign where
  // every lead has had step 1 of 4 — which is most of a campaign's lifetime.
  //
  // The denominator is the sends the campaign will ever make: leadCount * steps,
  // less the steps that leads who exited early (replied, bounced, suppressed)
  // will never receive. currentStep is how many steps that lead has had, so
  // steps - currentStep is what its exit removed from the workload.
  const exited = await db
    .select({
      campaignId: outreachLeads.campaignId,
      total: count(),
      stepsTaken: sql<number>`coalesce(sum(${outreachLeads.currentStep}), 0)::int`,
    })
    .from(outreachLeads)
    .where(
      and(leadsInOrg(), inArray(outreachLeads.sequenceStatus, ["reply_received", "bounced", "suppressed"])),
    )
    .groupBy(outreachLeads.campaignId);
  const exitedByCampaign = new Map(exited.map((r) => [r.campaignId, r]));

  return campaigns.map((c) => {
    const repliedCount = repliedByCampaign.get(c.id) ?? 0;
    const sentCount = sentByCampaign.get(c.id) ?? 0;
    const steps = c.sequence.length;
    const exit = exitedByCampaign.get(c.id);
    // Steps the early-exited leads will never receive, removed from the workload.
    const forfeited = exit ? exit.total * steps - exit.stepsTaken : 0;
    const plannedSends = Math.max(c.leadCount * steps - forfeited, 0);
    return {
      ...c,
      repliedCount,
      sentCount,
      replyRate: c.leadCount > 0 ? repliedCount / c.leadCount : null,
      /** 0–1 share of the campaign's planned sends already delivered; null when there is no sequence or no leads. */
      progress: plannedSends > 0 ? Math.min(sentCount / plannedSends, 1) : null,
      lastActivityAt: lastSentByCampaign.get(c.id) ?? null,
    };
  });
}

/** Sitewide summary for the list page's stat row. */
export async function getOutreachOverview() {
  const campaigns = await db.select({ status: outreachCampaigns.status }).from(outreachCampaigns).where(inOrg(outreachCampaigns));
  const activeCampaigns = campaigns.filter((c) => c.status === "active").length;

  const [{ totalLeads = 0 } = {}] = await db.select({ totalLeads: count() }).from(outreachLeads).where(leadsInOrg());

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const sentRows = await db
    .select({ status: outreachEmails.status, sentAt: outreachEmails.sentAt })
    .from(outreachEmails)
    .innerJoin(outreachLeads, eq(outreachEmails.leadId, outreachLeads.id))
    .where(and(leadsInOrg(), eq(outreachEmails.status, "sent")));
  const emailsSentLast7d = sentRows.filter((r) => r.sentAt && r.sentAt >= weekAgo).length;

  const [{ totalReplied = 0 } = {}] = await db
    .select({ totalReplied: count() })
    .from(outreachLeads)
    .where(and(leadsInOrg(), eq(outreachLeads.sequenceStatus, "reply_received")));

  return {
    activeCampaigns,
    totalLeads,
    emailsSentLast7d,
    avgReplyRate: totalLeads > 0 ? totalReplied / totalLeads : null,
  };
}

export async function getCampaign(id: string) {
  const [row] = await db.select().from(outreachCampaigns).where(and(inOrg(outreachCampaigns), eq(outreachCampaigns.id, id))).limit(1);
  return row ?? null;
}

export async function createCampaign(input: { name: string }) {
  const [row] = await db
    .insert(outreachCampaigns)
    .values({ organizationId: currentOrganizationId(), name: input.name.trim(), status: "draft", sequence: [] })
    .returning();
  return row;
}

export async function updateCampaignSequence(id: string, sequence: SequenceStep[]) {
  await db
    .update(outreachCampaigns)
    .set({ sequence, updatedAt: new Date() })
    .where(and(inOrg(outreachCampaigns), eq(outreachCampaigns.id, id)));
}

export async function updateCampaignName(id: string, name: string) {
  await db
    .update(outreachCampaigns)
    .set({ name: name.trim(), updatedAt: new Date() })
    .where(and(inOrg(outreachCampaigns), eq(outreachCampaigns.id, id)));
}

/** Lead statuses that can still receive a step. */
const SENDABLE_LEAD_STATUSES: OutreachLeadStatus[] = ["pending", "initial_sent", "in_follow_up"];

/** What emailLaunchProblems needs to know about this campaign, read now. */
export async function emailLaunchFacts(campaign: { id: string; sequence: unknown }): Promise<EmailLaunchFacts> {
  const [[mailboxCount], [leadCount], googleConnected] = await Promise.all([
    db.select({ n: count() }).from(mailboxes).where(and(inOrg(mailboxes), eq(mailboxes.status, "connected"))),
    db
      .select({ n: count() })
      .from(outreachLeads)
      .innerJoin(people, eq(outreachLeads.personId, people.id))
      .where(and(
        leadsInOrg(),
        inOrg(people),
        eq(outreachLeads.campaignId, campaign.id),
        inArray(outreachLeads.sequenceStatus, SENDABLE_LEAD_STATUSES),
        isNotNull(people.email),
      )),
    isPlatformConnected("google"),
  ]);
  return {
    sequence: campaign.sequence,
    googleConnected,
    connectedMailboxes: Number(mailboxCount?.n ?? 0),
    usableLeads: Number(leadCount?.n ?? 0),
  };
}

export async function setCampaignStatus(id: string, status: CampaignStatus) {
  await db.update(outreachCampaigns).set({ status, updatedAt: new Date() }).where(and(inOrg(outreachCampaigns), eq(outreachCampaigns.id, id)));
}

export async function deleteCampaign(id: string) {
  await db.delete(outreachCampaigns).where(and(inOrg(outreachCampaigns), eq(outreachCampaigns.id, id)));
}

export async function getCampaignLeads(campaignId: string) {
  const rows = await db
    .select({ lead: outreachLeads, person: people, company: companies })
    .from(outreachLeads)
    .innerJoin(people, eq(outreachLeads.personId, people.id))
    .leftJoin(companies, eq(people.companyId, companies.id))
    .where(and(leadsInOrg(), inOrg(people), eq(outreachLeads.campaignId, campaignId)))
    .orderBy(desc(outreachLeads.createdAt));
  return rows.map(({ lead, person, company }) => resolveLeadProfile(lead, person, company));
}

function resolveLeadProfile(lead: typeof outreachLeads.$inferSelect, person: typeof people.$inferSelect, company: typeof companies.$inferSelect | null) {
  const variables = personVariables(person, company);
  return {
    ...lead,
    email: person.email ?? "",
    firstName: variableValue(variables, "firstName"),
    lastName: variableValue(variables, "lastName"),
    company: variableValue(variables, "company") ?? variableValue(variables, "companyName"),
    customFields: variables,
  };
}

/**
 * The merge fields actually available for a campaign's sequence: the built-in
 * lead columns that have at least one non-empty value, plus every distinct
 * customFields key across its leads (one per unrecognized CSV/XLSX column —
 * see leadImport.ts). Drives the token chips in the sequence editor so the
 * user only sees fields that will actually resolve to something.
 */
export async function getCampaignMergeFields(campaignId: string) {
  const leads = await db
    .select({ person: people, company: companies })
    .from(outreachLeads)
    .innerJoin(people, eq(outreachLeads.personId, people.id))
    .leftJoin(companies, eq(people.companyId, companies.id))
    .where(and(leadsInOrg(), inOrg(people), eq(outreachLeads.campaignId, campaignId)));

  const customKeys: string[] = [];
  const seen = new Set<string>();
  for (const { person, company } of leads) {
    for (const [key, value] of Object.entries(personVariables(person, company))) {
      if (!value || seen.has(key.toLowerCase())) continue;
      seen.add(key.toLowerCase());
      customKeys.push(key);
    }
  }

  return customKeys.map((key) => ({ token: key, label: humanizeKey(key) }));
}

/** "jobTitle" -> "Job title", the inverse of leadImport's toCamelCaseKey, for chip tooltips. */
function humanizeKey(key: string): string {
  const spaced = key.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/** A lead row plus the per-row extras the leads table renders. */
export type LeadRow = ReturnType<typeof resolveLeadProfile> & {
  /** Subject/body of the most recent sent email, for the "Last message" column. */
  lastMessageSubject: string | null;
  lastMessageBody: string | null;
  lastMessageAt: Date | null;
  /** Emails already sent to this lead — the numerator of sequence progress. */
  sentCount: number;
};

export type LeadPage = {
  leads: LeadRow[];
  total: number;
  page: number;
  pageSize: number;
  counts: Record<string, number>;
  /** Steps in the campaign's sequence — the denominator of sequence progress. */
  sequenceLength: number;
};

const LEAD_STATUS_FILTERS: Record<string, OutreachLeadStatus[]> = {
  pending: ["pending"],
  in_sequence: ["initial_sent", "in_follow_up", "reply_processing"],
  replied: ["reply_received"],
  // completed and suppressed had no filter, which left those leads reachable
  // only by search — a campaign that has run to the end could not be listed.
  completed: ["sequence_completed"],
  bounced: ["bounced"],
  suppressed: ["suppressed"],
};

/**
 * One page of a campaign's leads, filtered and searched in SQL rather than in
 * the browser. The previous approach shipped every lead into the page payload
 * and sliced to 200 client-side, which both bloated the document and made
 * leads past 200 unreachable except by search.
 *
 * Status counts are computed over the whole campaign, not the page, so the
 * filter tabs keep showing totals.
 */
export async function getCampaignLeadsPage(
  campaignId: string,
  opts: { page?: number; pageSize?: number; filter?: string; search?: string } = {},
): Promise<LeadPage> {
  const requestedPageSize = Number.isFinite(opts.pageSize) ? Math.floor(opts.pageSize!) : 20;
  const requestedPage = Number.isFinite(opts.page) ? Math.floor(opts.page!) : 1;
  const pageSize = Math.min(Math.max(requestedPageSize, 1), 200);
  const page = Math.max(requestedPage, 1);

  const conditions = [leadsInOrg(), eq(outreachLeads.campaignId, campaignId)];

  const statuses = opts.filter ? LEAD_STATUS_FILTERS[opts.filter] : undefined;
  if (statuses) conditions.push(inArray(outreachLeads.sequenceStatus, statuses));

  const search = opts.search?.trim();
  if (search) {
    const term = `%${search.toLowerCase()}%`;
    conditions.push(
      or(
        sql`lower(coalesce((select email from people where id = ${outreachLeads.personId} and organization_id = ${currentOrganizationId()}), '')) like ${term}`,
        sql`lower(coalesce((select first_name from people where id = ${outreachLeads.personId} and organization_id = ${currentOrganizationId()}), '')) like ${term}`,
        sql`lower(coalesce((select last_name from people where id = ${outreachLeads.personId} and organization_id = ${currentOrganizationId()}), '')) like ${term}`,
        sql`lower(coalesce((select full_name from people where id = ${outreachLeads.personId} and organization_id = ${currentOrganizationId()}), '')) like ${term}`,
        sql`lower(coalesce((select title from people where id = ${outreachLeads.personId} and organization_id = ${currentOrganizationId()}), '')) like ${term}`,
        sql`lower(coalesce((select raw::text from people where id = ${outreachLeads.personId} and organization_id = ${currentOrganizationId()}), '')) like ${term}`,
        sql`exists (
          select 1 from people p
          join companies c on c.id = p.company_id
          where p.id = ${outreachLeads.personId}
            and p.organization_id = ${currentOrganizationId()}
            and (lower(coalesce(c.name, '')) like ${term} or lower(c.domain) like ${term})
        )`,
      )!,
    );
  }

  const where = and(...conditions);

  const [rows, [{ value: total }], statusRows] = await Promise.all([
    db
      .select({ lead: outreachLeads, person: people, company: companies })
      .from(outreachLeads)
      .innerJoin(people, eq(outreachLeads.personId, people.id))
      .leftJoin(companies, eq(people.companyId, companies.id))
      .where(where)
      // id breaks ties: a bulk import gives every row the same createdAt, so
      // ordering on it alone is non-deterministic and rows leak across pages.
      .orderBy(desc(outreachLeads.createdAt), asc(outreachLeads.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ value: count() }).from(outreachLeads).where(where),
    db
      .select({ status: outreachLeads.sequenceStatus, value: count() })
      .from(outreachLeads)
      .where(and(leadsInOrg(), eq(outreachLeads.campaignId, campaignId)))
      .groupBy(outreachLeads.sequenceStatus),
  ]);

  const byStatus = new Map(statusRows.map((r) => [r.status, r.value]));
  const sum = (keys: OutreachLeadStatus[]) => keys.reduce((n, k) => n + (byStatus.get(k) ?? 0), 0);
  const counts: Record<string, number> = {
    all: statusRows.reduce((n, r) => n + r.value, 0),
  };
  for (const [id, keys] of Object.entries(LEAD_STATUS_FILTERS)) counts[id] = sum(keys);

  // Last message and sent count are fetched only for the leads on this page —
  // a campaign-wide join would scan every email row to render fifty of them.
  const leadIds = rows.map((r) => r.lead.id);
  const emailRows = leadIds.length
    ? await db
        .select({
          leadId: outreachEmails.leadId,
          subject: outreachEmails.subject,
          body: outreachEmails.body,
          sentAt: outreachEmails.sentAt,
        })
        .from(outreachEmails)
        .where(and(inArray(outreachEmails.leadId, leadIds), eq(outreachEmails.status, "sent")))
        .orderBy(asc(outreachEmails.sentAt))
    : [];

  const lastByLead = new Map<string, { subject: string | null; body: string | null; sentAt: Date | null }>();
  const sentByLead = new Map<string, number>();
  for (const e of emailRows) {
    // Rows arrive oldest-first, so the final write per lead is the latest send.
    lastByLead.set(e.leadId, { subject: e.subject, body: e.body, sentAt: e.sentAt });
    sentByLead.set(e.leadId, (sentByLead.get(e.leadId) ?? 0) + 1);
  }

  const campaign = await getCampaign(campaignId);

  const leads: LeadRow[] = rows.map(({ lead, person, company }) => {
    const r = resolveLeadProfile(lead, person, company);
    const last = lastByLead.get(r.id);
    return {
      ...r,
      lastMessageSubject: last?.subject ?? null,
      lastMessageBody: last?.body ?? null,
      lastMessageAt: last?.sentAt ?? null,
      sentCount: sentByLead.get(r.id) ?? 0,
    };
  });

  return {
    leads,
    total,
    page,
    pageSize,
    counts,
    sequenceLength: campaign?.sequence.length ?? 0,
  };
}

export async function getLead(leadId: string) {
  const [row] = await db.select({ lead: outreachLeads, person: people, company: companies }).from(outreachLeads).innerJoin(people, eq(outreachLeads.personId, people.id)).leftJoin(companies, eq(people.companyId, companies.id)).where(and(leadsInOrg(), inOrg(people), eq(outreachLeads.id, leadId))).limit(1);
  return row ? resolveLeadProfile(row.lead, row.person, row.company) : null;
}

/** One row per scheduled/sent sequence step for a lead — the raw material the activity timeline is derived from. */
/**
 * A lead's send history. The sending mailbox is joined in so the activity panel
 * can name the actual From address rather than a generic "your mailbox" — it is
 * assigned per-lead at first send, so it isn't knowable from the campaign alone.
 */
export async function getLeadEmails(leadId: string) {
  const rows = await db
    .select({ email: outreachEmails, fromAddress: mailboxes.emailAddress })
    .from(outreachEmails)
    .leftJoin(mailboxes, eq(outreachEmails.mailboxId, mailboxes.id))
    .where(and(eq(outreachEmails.leadId, leadId), inArray(outreachEmails.leadId, orgLeadIds())))
    .orderBy(outreachEmails.stepNumber);

  return rows.map((r) => ({ ...r.email, fromAddress: r.fromAddress }));
}

export async function getCampaignStats(campaignId: string) {
  const leads = await getCampaignLeads(campaignId);
  // Every email row for the campaign, split by status. Sent plus scheduled plus
  // failed is the total send workload, which the progress card reports against.
  const emailsByStatus = await db
    .select({ status: outreachEmails.status, count: count() })
    .from(outreachEmails)
    .innerJoin(outreachLeads, eq(outreachEmails.leadId, outreachLeads.id))
    .where(and(leadsInOrg(), eq(outreachLeads.campaignId, campaignId)))
    .groupBy(outreachEmails.status);

  const byStatus = new Map(emailsByStatus.map((r) => [r.status, r.count]));
  const emailsSent = byStatus.get("sent") ?? 0;
  const emailsScheduled = byStatus.get("scheduled") ?? 0;
  const emailsFailed = byStatus.get("failed") ?? 0;

  return {
    totalLeads: leads.length,
    pending: leads.filter((l) => l.sequenceStatus === "pending").length,
    inSequence: leads.filter((l) => l.sequenceStatus === "initial_sent" || l.sequenceStatus === "in_follow_up" || l.sequenceStatus === "reply_processing").length,
    replied: leads.filter((l) => l.sequenceStatus === "reply_received").length,
    completed: leads.filter((l) => l.sequenceStatus === "sequence_completed").length,
    bounced: leads.filter((l) => l.sequenceStatus === "bounced").length,
    suppressed: leads.filter((l) => l.sequenceStatus === "suppressed").length,
    emailsSent,
    emailsScheduled,
    emailsFailed,
    /** Sent + scheduled + failed — the denominator for "N of M sends processed". */
    emailsTotal: emailsSent + emailsScheduled + emailsFailed,
    /** Leads that have been emailed at least once. */
    contacted: leads.filter((l) => l.sequenceStatus !== "pending").length,
  };
}

/**
 * Per-step send counts for the Analytics tab's step breakdown. We don't
 * record which step a reply followed, so this reports sent volume per step
 * only — not a per-step reply rate, which would have to be fabricated.
 */
export async function getCampaignStepBreakdown(campaignId: string) {
  const sentByStep = await db
    .select({ stepNumber: outreachEmails.stepNumber, count: count() })
    .from(outreachEmails)
    .innerJoin(outreachLeads, eq(outreachEmails.leadId, outreachLeads.id))
    .where(and(leadsInOrg(), eq(outreachLeads.campaignId, campaignId), eq(outreachEmails.status, "sent")))
    .groupBy(outreachEmails.stepNumber)
    .orderBy(outreachEmails.stepNumber);

  return sentByStep.map((s) => ({ stepNumber: s.stepNumber, sent: s.count }));
}

export type DailySends = {
  /** ISO date (YYYY-MM-DD) in the requested timezone. */
  date: string;
  sent: number;
  scheduled: number;
  failed: number;
}[];

/**
 * Daily send volume for the campaign's activity chart. Sent and failed are
 * bucketed by when they went out; scheduled rows have no sentAt yet, so they
 * bucket by nextSendAt on the lead — that is the forward-looking half of the
 * chart.
 *
 * Bucketing happens in Postgres at the given IANA timezone so a send at
 * 11pm local doesn't land on the next UTC day.
 */
export async function getCampaignDailySends(
  campaignId: string,
  opts: { days?: number; timeZone?: string } = {},
): Promise<DailySends> {
  const days = Math.min(Math.max(opts.days ?? 14, 1), 90);

  // The timezone is inlined rather than bound. Postgres compares GROUP BY
  // expressions to SELECT expressions before binding parameters, so passing it
  // as a placeholder yields $1 here and $3 there — textually different, and the
  // query is rejected as "must appear in the GROUP BY clause". The value is
  // restricted to IANA-shaped names so inlining cannot inject.
  const requested = opts.timeZone ?? "UTC";
  const tz = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(requested) ? requested : "UTC";
  const bucket = sql<string>`to_char(date_trunc('day', coalesce(${outreachEmails.sentAt}, ${outreachLeads.nextSendAt}) at time zone ${sql.raw(`'${tz}'`)}), 'YYYY-MM-DD')`;

  const rows = await db
    .select({
      date: bucket,
      status: outreachEmails.status,
      total: count(),
    })
    .from(outreachEmails)
    .innerJoin(outreachLeads, eq(outreachEmails.leadId, outreachLeads.id))
    .where(
      and(
        leadsInOrg(),
        eq(outreachLeads.campaignId, campaignId),
        sql`coalesce(${outreachEmails.sentAt}, ${outreachLeads.nextSendAt}) is not null`,
      ),
    )
    .groupBy(bucket, outreachEmails.status);

  const byDate = new Map<string, { sent: number; scheduled: number; failed: number }>();
  for (const r of rows) {
    if (!r.date) continue;
    const bucket = byDate.get(r.date) ?? { sent: 0, scheduled: 0, failed: 0 };
    if (r.status === "sent") bucket.sent += r.total;
    else if (r.status === "scheduled") bucket.scheduled += r.total;
    else if (r.status === "failed") bucket.failed += r.total;
    byDate.set(r.date, bucket);
  }

  // Emit a continuous window ending today so the chart has no gaps, and days
  // with no activity still render an axis label.
  const out: DailySends = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const bucket = byDate.get(key) ?? { sent: 0, scheduled: 0, failed: 0 };
    out.push({ date: key, ...bucket });
  }
  return out;
}

export type CampaignPulse = {
  /** Emails scheduled to go out before tomorrow starts. */
  followUpsToday: number;
  /** Leads that received their first email today — new people reached, not follow-ups. */
  newLeadsReachedToday: number;
  /** Steps defined on the campaign's sequence. */
  activeSequences: number;
  /** Soonest upcoming send, or null when nothing is queued. */
  nextSendAt: Date | null;
};

/** The header strip above the campaign tabs: what is queued and when it fires. */
export async function getCampaignPulse(campaignId: string): Promise<CampaignPulse> {
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [[{ dueToday = 0 } = {}], [{ reachedToday = 0 } = {}], [{ soonest = null } = {}], campaign] = await Promise.all([
    db
      .select({ dueToday: count() })
      .from(outreachEmails)
      .innerJoin(outreachLeads, eq(outreachEmails.leadId, outreachLeads.id))
      .where(
        and(
          leadsInOrg(),
          eq(outreachLeads.campaignId, campaignId),
          eq(outreachEmails.status, "scheduled"),
          lte(outreachLeads.nextSendAt, endOfToday),
        ),
      ),
    // Step 1 only: a lead is "reached" the first time it hears from us, so a
    // follow-up going out today does not make that lead newly reached.
    db
      .select({ reachedToday: count() })
      .from(outreachEmails)
      .innerJoin(outreachLeads, eq(outreachEmails.leadId, outreachLeads.id))
      .where(
        and(
          leadsInOrg(),
          eq(outreachLeads.campaignId, campaignId),
          eq(outreachEmails.status, "sent"),
          eq(outreachEmails.stepNumber, 1),
          gte(outreachEmails.sentAt, startOfToday),
          lte(outreachEmails.sentAt, endOfToday),
        ),
      ),
    db
      .select({ soonest: sql<Date | null>`min(${outreachLeads.nextSendAt})` })
      .from(outreachLeads)
      .where(
        and(
          leadsInOrg(),
          eq(outreachLeads.campaignId, campaignId),
          isNotNull(outreachLeads.nextSendAt),
        ),
      ),
    getCampaign(campaignId),
  ]);

  return {
    followUpsToday: dueToday,
    newLeadsReachedToday: reachedToday,
    activeSequences: campaign?.sequence.length ?? 0,
    nextSendAt: soonest ? new Date(soonest) : null,
  };
}

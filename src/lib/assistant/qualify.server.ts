import "server-only";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, people } from "@/lib/leads/schema";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { effectiveBusinessProfile } from "./businessContext.server";
import { applyRequestRules, EMPTY_FUNNEL, requestSubject, websiteStatusFact, type LeadFunnel } from "./leadFit";
import type { LeadApproach } from "./messages";
import { displayBusinessName } from "./pitch";
import { leadAudienceMembers, type LeadFit } from "./schema";
import { businessContext, sortLeads, type WriterCost } from "./writer.server";

/**
 * Judging a request's leads against what the owner asked for (pilot fix F02,
 * leadFit.ts). A search serving an objective ends with a "qualifying" stage
 * that calls assessMembers on its list; the objective's driver judges what
 * is left (lists added by hand, rows saved before this existed, a failed
 * attempt); prepareOutreach reuses the stored verdicts. A member is claimed
 * under a short lease while judged, and the first verdict stored wins, so a
 * retried step, a second process or a recovered worker never judges or
 * counts one twice.
 */

/** Leads judged per model call (the sorter's batch). */
export const JUDGE_BATCH = 25;
/** How long a claim on an unjudged member holds before another process may take it. */
const CLAIM_LEASE_MS = 5 * 60_000;

export type PersonRow = { person: typeof people.$inferSelect; company: typeof companies.$inferSelect | null };

export async function loadPeople(personIds: string[]): Promise<Map<string, PersonRow>> {
  if (!personIds.length) return new Map();
  const rows = await db.select({ person: people, company: companies }).from(people)
    .leftJoin(companies, and(eq(companies.id, people.companyId), inOrg(companies)))
    .where(and(inOrg(people), inArray(people.id, personIds)));
  return new Map(rows.map((row) => [row.person.id, row]));
}

/** What the sorting and writing models may know of a lead: its public facts, title, company and short own fields. */
export function leadFacts(memberFacts: Record<string, string>, row: PersonRow | undefined): Record<string, string> {
  const out: Record<string, string> = { ...memberFacts };
  if (!row) return out;
  if (row.person.fullName && !out.name) out.name = row.person.fullName;
  if (row.person.title) out.title ??= row.person.title;
  if (row.company?.name) out.company ??= row.company.name;
  if (out.company) out.company = displayBusinessName(out.company);
  if (row.company?.domain && !out.website) {
    out.website = row.company.domain;
    out.websiteStatus ??= websiteStatusFact({ state: "domain_unchecked" });
  }
  for (const [field, value] of Object.entries((row.person.raw ?? {}) as Record<string, unknown>)) {
    if (Object.keys(out).length >= 14) break;
    if (typeof value !== "string" || !value.trim() || value.length > 200) continue;
    if (/^p_[0-9a-f]{8}/.test(field) || ["addedVia", "discoveredVia"].includes(field)) continue;
    out[field] ??= value;
  }
  return out;
}

export type JudgedLead = { fit: LeadFit; reason: string; group: string; approach: LeadApproach };

/**
 * Judges leads against the request, a batch per model call, then applies
 * the code's own rules (applyRequestRules). The model judges against the
 * request's subject (requestSubject: what to find, not how the research
 * runs, so "do not contact anyone" or "$0" is never a requirement a lead
 * fails); the code's rules read the whole request. With a request, whether a
 * lead matches comes from requestFit, and a "skip" only keeps it out of the
 * messages; a no_match is never messaged; a lead that names no business or
 * person is at most unconfirmed (leadFit.ts). Throws when the model fails.
 */
export async function judgeLeads(input: { facts: Record<string, string>[]; request: string | null; context: string; cost: WriterCost; knownGroups?: string[] }): Promise<JudgedLead[]> {
  const known = [...(input.knownGroups ?? [])];
  const out: JudgedLead[] = [];
  const subject = input.request === null ? null : requestSubject(input.request);
  for (let start = 0; start < input.facts.length; start += JUDGE_BATCH) {
    const batch = input.facts.slice(start, start + JUDGE_BATCH).map((facts, offset) => ({ index: start + offset, facts }));
    const sorted = await sortLeads({ context: input.context, request: subject, leads: batch, knownGroups: known, cost: input.cost });
    for (const { index, facts } of batch) {
      const sort = sorted.get(index)!;
      const { fit, reason } = applyRequestRules(input.request ?? "", facts, sort);
      out[index] = { fit, reason, group: sort.group, approach: fit === "no_match" && sort.approach !== "skip" ? "skip" : sort.approach };
      if (!known.some((label) => label.toLowerCase() === sort.group.toLowerCase())) known.push(sort.group);
    }
  }
  return out;
}

/** Stores verdicts on lead list members; a member that already has one keeps it. */
export async function storeVerdicts(verdicts: readonly { memberId: string; verdict: JudgedLead }[], requestId: string | null): Promise<void> {
  for (const { memberId, verdict } of verdicts) {
    await db.update(leadAudienceMembers).set({
      fit: verdict.fit,
      fitReason: verdict.reason.slice(0, 500),
      fitGroup: verdict.group.slice(0, 120),
      fitApproach: verdict.approach,
      fitRequestId: requestId,
      fitAt: new Date(),
      fitClaimedAt: null,
    }).where(and(inOrg(leadAudienceMembers), eq(leadAudienceMembers.id, memberId), isNull(leadAudienceMembers.fitAt)));
  }
}

/** Contacts the owner typed into the chat (leadFit.ts typedByOwner): a match given by them, never judged again. */
export async function markGivenByOwner(audienceId: string, personIds: readonly string[], requestId: string | null): Promise<void> {
  if (!personIds.length) return;
  await db.update(leadAudienceMembers).set({
    fit: "match",
    fitReason: "Given by you in the chat.",
    fitGroup: "Your contacts",
    fitApproach: "standard",
    fitRequestId: requestId,
    fitAt: new Date(),
    fitClaimedAt: null,
  }).where(and(inOrg(leadAudienceMembers), eq(leadAudienceMembers.audienceId, audienceId), inArray(leadAudienceMembers.personId, [...personIds]), isNull(leadAudienceMembers.fitAt)));
}

type Claimed = { id: string; personId: string; facts: Record<string, string> };

/** Claims up to `limit` contactable members of these lists that have no verdict and no live claim. */
async function claimUnjudged(audienceIds: readonly string[], limit: number): Promise<Claimed[]> {
  if (!audienceIds.length) return [];
  const rows = await db.execute<{ id: string; person_id: string; facts: Record<string, string> | null }>(sql`
    with picked as (
      select id from lead_audience_members
      where organization_id = ${currentOrganizationId()}
        and audience_id in (${sql.join(audienceIds.map((id) => sql`${id}::uuid`), sql`, `)})
        and status = 'eligible' and person_id is not null and fit_at is null
        and (fit_claimed_at is null or fit_claimed_at < now() - make_interval(secs => ${CLAIM_LEASE_MS / 1000}))
      order by created_at, id
      limit ${limit}
      for update skip locked
    )
    update lead_audience_members m set fit_claimed_at = now()
    from picked where m.id = picked.id
    returning m.id, m.person_id, m.facts`);
  return [...rows].map((row) => ({ id: row.id, personId: row.person_id, facts: row.facts ?? {} }));
}

async function releaseClaims(ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  await db.update(leadAudienceMembers).set({ fitClaimedAt: null })
    .where(and(inOrg(leadAudienceMembers), inArray(leadAudienceMembers.id, [...ids]), isNull(leadAudienceMembers.fitAt)));
}

/** Contactable members of these lists still without a verdict. */
export async function unjudgedMembers(audienceIds: readonly string[]): Promise<number> {
  if (!audienceIds.length) return 0;
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(leadAudienceMembers).where(and(
    inOrg(leadAudienceMembers),
    inArray(leadAudienceMembers.audienceId, [...audienceIds]),
    eq(leadAudienceMembers.status, "eligible"),
    sql`${leadAudienceMembers.personId} is not null`,
    isNull(leadAudienceMembers.fitAt),
  ));
  return Number(row?.n ?? 0);
}

/**
 * Judges up to `maxBatches` batches of these lists' unjudged contactable
 * members against the request and stores the verdicts. Throws when the
 * model fails (the claims are released for the next attempt). `remaining`
 * counts members still without a verdict, some perhaps claimed elsewhere.
 */
export async function assessMembers(input: { audienceIds: readonly string[]; request: string; requestId: string | null; maxBatches?: number; heartbeat?: () => Promise<void> }): Promise<{ judged: number; remaining: number }> {
  let judged = 0;
  let context: string | null = null;
  for (let round = 0; round < (input.maxBatches ?? 2); round += 1) {
    const claimed = await claimUnjudged(input.audienceIds, JUDGE_BATCH);
    if (!claimed.length) break;
    try {
      context ??= await businessContext(await effectiveBusinessProfile());
      const rows = await loadPeople([...new Set(claimed.map((member) => member.personId))]);
      const verdicts = await judgeLeads({ facts: claimed.map((member) => leadFacts(member.facts, rows.get(member.personId))), request: input.request, context, cost: { calls: 0, usd: null } });
      await storeVerdicts(claimed.map((member, index) => ({ memberId: member.id, verdict: verdicts[index]! })), input.requestId);
      judged += claimed.length;
    } catch (error) {
      await releaseClaims(claimed.map((member) => member.id));
      throw error;
    }
    await input.heartbeat?.();
  }
  return { judged, remaining: await unjudgedMembers(input.audienceIds) };
}

/**
 * These lists' leads by distinct person (leadFit.ts LeadFunnel): found,
 * contactable, and of the contactable, matching, not matching, unconfirmed
 * or not judged yet, with the routes of the matching and the commonest
 * reasons for a no-match.
 */
export async function audienceFunnel(audienceIds: readonly string[]): Promise<LeadFunnel & { routes: { email: number; whatsapp: number; linkedin: number; instagram: number } }> {
  const none = { email: 0, whatsapp: 0, linkedin: 0, instagram: 0 };
  if (!audienceIds.length) return { ...EMPTY_FUNNEL, routes: none };
  const ids = sql.join(audienceIds.map((id) => sql`${id}::uuid`), sql`, `);
  const org = currentOrganizationId();
  const [counts] = [...await db.execute<Record<string, number>>(sql`
    with m as (
      select coalesce(person_id::text, id::text) as who, status, fit, channels
      from lead_audience_members where organization_id = ${org} and audience_id in (${ids})
    ), p as (
      select who,
        bool_or(status = 'eligible') as contactable,
        bool_or(status = 'eligible' and fit = 'no_match') as no_match,
        bool_or(status = 'eligible' and fit = 'match') as match,
        bool_or(status = 'eligible' and fit = 'unconfirmed') as unconfirmed,
        bool_or(status = 'eligible' and 'email' = any(channels)) as email,
        bool_or(status = 'eligible' and 'whatsapp' = any(channels)) as whatsapp,
        bool_or(status = 'eligible' and 'linkedin' = any(channels)) as linkedin,
        bool_or(status = 'eligible' and 'instagram' = any(channels)) as instagram
      from m group by who
    ), q as (
      select *, contactable and not no_match and match as qualified from p
    )
    select count(*)::int as found,
      (count(*) filter (where contactable))::int as contactable,
      (count(*) filter (where qualified))::int as qualified,
      (count(*) filter (where contactable and no_match))::int as not_matching,
      (count(*) filter (where contactable and not no_match and not match and unconfirmed))::int as unconfirmed,
      (count(*) filter (where contactable and not no_match and not match and not unconfirmed))::int as pending,
      (count(*) filter (where qualified and email))::int as r_email,
      (count(*) filter (where qualified and whatsapp))::int as r_whatsapp,
      (count(*) filter (where qualified and linkedin))::int as r_linkedin,
      (count(*) filter (where qualified and instagram))::int as r_instagram,
      (select count(*)::int from lead_audience_members where organization_id = ${org} and audience_id in (${ids}) and status = 'eligible' and person_id is not null and fit_at is null) as pending_members
    from q`)];
  const reasons = [...await db.execute<{ reason: string; count: number }>(sql`
    select fit_reason as reason, count(distinct coalesce(person_id::text, id::text))::int as count
    from lead_audience_members
    where organization_id = ${org} and audience_id in (${ids}) and status = 'eligible' and fit = 'no_match' and fit_reason is not null
    group by fit_reason order by count desc, fit_reason limit 3`)];
  const n = (key: string) => Number(counts?.[key] ?? 0);
  return {
    found: n("found"),
    contactable: n("contactable"),
    qualified: n("qualified"),
    notMatching: n("not_matching"),
    unconfirmed: n("unconfirmed"),
    pending: n("pending"),
    pendingMembers: n("pending_members"),
    noMatchReasons: reasons.map((row) => ({ reason: row.reason, count: Number(row.count) })),
    routes: { email: n("r_email"), whatsapp: n("r_whatsapp"), linkedin: n("r_linkedin"), instagram: n("r_instagram") },
  };
}

import "server-only";

import { and, desc, eq, ilike, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { isMissingTable } from "@/lib/features/flags.server";
import { inquiries } from "@/lib/intake/schema";
import { people } from "@/lib/leads/schema";
import { inOrg } from "@/lib/tenancy/scope";
import { addAudienceMembers, createAudience, summarizeAudience, type AudienceSummary } from "./audiences.server";
import { inquiryFacts, inquirySignal, matchReasonForExisting, peopleSourceLabel, type ExistingLeadsFrom } from "./existingLeads";
import { outreachRunLeads, outreachRuns } from "./schema";

/**
 * "Use my existing leads or inquiries": a lead list made from people
 * already in the lead database — everyone, the latest import, those
 * matching a word, or the people who sent an inquiry. It only prepares:
 * nobody is contacted until the owner approves a plan with Start. People
 * already in a running or paused outreach run are left out (so nobody gets
 * two sequences at once); Do Not Contact and unsubscribed people are
 * excluded with the reason by addAudienceMembers, like every other list.
 */

export const MAX_EXISTING_LEADS = 500;

export type ExistingLeadsInput = {
  from: ExistingLeadsFrom;
  /** A word to match in the name, company, email, title or the person's details. */
  search?: string | null;
  maxLeads?: number;
  /** Inquiries only: also people whose inquiry came from an imported history (never by default). */
  includeHistorical?: boolean;
  listName?: string | null;
  threadId: string | null;
  userId: string | null;
};

type Candidate = {
  personId: string;
  createdAt: Date;
  source: string;
  inquiry: { source: "website_form" | "instagram"; message: string | null; pageUrl: string | null; at: Date; historical: boolean } | null;
};

async function latestImportSource(): Promise<{ source: string; since: Date } | null> {
  const [latest] = await db.select({ source: people.source, createdAt: people.createdAt }).from(people)
    .where(inOrg(people)).orderBy(desc(people.createdAt)).limit(1);
  if (!latest) return null;
  // The latest import: people from the same source created within a day of the newest one.
  return { source: latest.source, since: new Date(latest.createdAt.getTime() - 24 * 60 * 60 * 1000) };
}

async function inquiryCandidates(input: ExistingLeadsInput, limit: number): Promise<Candidate[]> {
  try {
    const rows = await db.select({
      personId: inquiries.personId,
      source: inquiries.source,
      message: inquiries.message,
      pageUrl: inquiries.pageUrl,
      at: sql<Date>`coalesce(${inquiries.submittedAt}, ${inquiries.receivedAt})`,
      historical: inquiries.historical,
      personCreatedAt: people.createdAt,
      personSource: people.source,
    }).from(inquiries)
      .innerJoin(people, and(eq(people.id, inquiries.personId), inOrg(people)))
      .where(and(
        inOrg(inquiries),
        isNotNull(inquiries.personId),
        eq(inquiries.status, "received"),
        ...(input.includeHistorical ? [] : [eq(inquiries.historical, false)]),
        ...searchConditions(input.search),
      ))
      .orderBy(desc(inquiries.receivedAt))
      .limit(limit * 3);
    const seen = new Set<string>();
    const out: Candidate[] = [];
    for (const row of rows) {
      if (!row.personId || seen.has(row.personId)) continue;
      seen.add(row.personId);
      out.push({
        personId: row.personId,
        createdAt: row.personCreatedAt,
        source: row.personSource,
        inquiry: { source: row.source, message: row.message, pageUrl: row.pageUrl, at: new Date(row.at), historical: row.historical },
      });
    }
    return out;
  } catch (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
}

function searchConditions(search: string | null | undefined): SQL[] {
  const term = search?.trim() ? `%${search.trim().replace(/[\\%_]/g, (char) => `\\${char}`)}%` : null;
  if (!term) return [];
  return [or(
    ilike(people.fullName, term),
    ilike(people.email, term),
    ilike(people.title, term),
    sql`exists (select 1 from companies c where c.id = ${people.companyId} and c.organization_id = ${people.organizationId} and c.name ilike ${term})`,
    sql`${people.raw}::text ilike ${term}`,
    sql`${people.custom}::text ilike ${term}`,
  )!];
}

async function peopleCandidates(input: ExistingLeadsInput, limit: number): Promise<Candidate[]> {
  const latest = input.from === "latest_import" ? await latestImportSource() : null;
  if (input.from === "latest_import" && !latest) return [];
  const rows = await db.select({ personId: people.id, createdAt: people.createdAt, source: people.source }).from(people)
    .where(and(
      inOrg(people),
      ...(latest ? [eq(people.source, latest.source), sql`${people.createdAt} >= ${latest.since.toISOString()}::timestamptz`] : []),
      ...searchConditions(input.search),
    ))
    .orderBy(desc(people.createdAt))
    .limit(limit * 2);
  // Someone who wrote in keeps their own words however the list was made.
  const latestInquiry = await latestInquiries(rows.map((row) => row.personId), Boolean(input.includeHistorical));
  return rows.map((row) => ({ ...row, inquiry: latestInquiry.get(row.personId) ?? null }));
}

/** Each person's latest usable inquiry (fresh ones only unless history is asked for). */
async function latestInquiries(personIds: string[], includeHistorical: boolean): Promise<Map<string, NonNullable<Candidate["inquiry"]>>> {
  const out = new Map<string, NonNullable<Candidate["inquiry"]>>();
  if (!personIds.length) return out;
  try {
    const rows = await db.select({
      personId: inquiries.personId,
      source: inquiries.source,
      message: inquiries.message,
      pageUrl: inquiries.pageUrl,
      at: sql<Date>`coalesce(${inquiries.submittedAt}, ${inquiries.receivedAt})`,
      historical: inquiries.historical,
    }).from(inquiries)
      .where(and(inOrg(inquiries), inArray(inquiries.personId, personIds), eq(inquiries.status, "received"), ...(includeHistorical ? [] : [eq(inquiries.historical, false)])))
      .orderBy(desc(inquiries.receivedAt));
    for (const row of rows) {
      if (row.personId && !out.has(row.personId)) out.set(row.personId, { source: row.source, message: row.message, pageUrl: row.pageUrl, at: new Date(row.at), historical: row.historical });
    }
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }
  return out;
}

/** People of `ids` already in a running, paused or starting outreach run: they get no second sequence. */
async function inActiveRuns(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await db.select({ personId: outreachRunLeads.personId }).from(outreachRunLeads)
    .innerJoin(outreachRuns, eq(outreachRuns.id, outreachRunLeads.runId))
    .where(and(
      inOrg(outreachRunLeads),
      inArray(outreachRunLeads.personId, ids),
      eq(outreachRunLeads.status, "active"),
      inArray(outreachRuns.status, ["starting", "running", "paused"]),
    ));
  return new Set(rows.map((row) => row.personId));
}

export type ExistingLeadsResult = {
  audienceId: string | null;
  audience: AudienceSummary | null;
  matched: number;
  alreadyInRuns: number;
};

export async function createExistingLeadsAudience(input: ExistingLeadsInput): Promise<ExistingLeadsResult> {
  const limit = Math.min(MAX_EXISTING_LEADS, Math.max(1, Math.round(input.maxLeads ?? 100)));
  const candidates = input.from === "inquiries" ? await inquiryCandidates(input, limit) : await peopleCandidates(input, limit);
  const busy = await inActiveRuns(candidates.map((candidate) => candidate.personId));
  const chosen = candidates.filter((candidate) => !busy.has(candidate.personId)).slice(0, limit);
  if (!chosen.length) return { audienceId: null, audience: null, matched: candidates.length, alreadyInRuns: busy.size };

  const today = new Date().toISOString().slice(0, 10);
  const name = input.listName?.trim().slice(0, 200)
    || (input.from === "inquiries" ? `Inquiries (${today})` : input.from === "latest_import" ? `Latest import (${today})` : input.search?.trim() ? `Leads matching “${input.search.trim()}” (${today})` : `Existing leads (${today})`);
  const audienceId = await createAudience({
    name,
    source: "list",
    criteria: { source: input.from === "inquiries" ? "inquiries" : "existing", from: input.from, search: input.search?.trim() || null, includeHistorical: Boolean(input.includeHistorical), leftOutInRuns: busy.size },
    threadId: input.threadId,
    userId: input.userId,
  });
  await addAudienceMembers(audienceId, chosen.map((candidate) => ({
    personId: candidate.personId,
    source: candidate.inquiry ? `inquiry:${candidate.inquiry.source}` : "existing",
    sourceUrl: candidate.inquiry?.pageUrl ?? null,
    facts: candidate.inquiry ? inquiryFacts(candidate.inquiry) : {},
    // Why each one is on the list, and what they actually said.
    matchReason: candidate.inquiry
      ? `Sent an inquiry on ${candidate.inquiry.at.toISOString().slice(0, 10)} through ${candidate.inquiry.source === "instagram" ? "Instagram" : "your website form"}${candidate.inquiry.historical ? " (imported history)" : ""}.`
      : matchReasonForExisting({ createdAt: candidate.createdAt, sourceLabel: peopleSourceLabel(candidate.source), search: input.search ?? null }),
    signals: candidate.inquiry ? inquirySignal(candidate.inquiry) : [],
  })));
  return { audienceId, audience: await summarizeAudience(audienceId), matched: candidates.length, alreadyInRuns: busy.size };
}

export type InquiryOverview = {
  fresh: number;
  historical: number;
  unusable: number;
  bySource: { source: string; count: number }[];
  latest: { at: string; source: string; name: string | null; message: string | null }[];
};

/** Recent inquiries at a glance, for the assistant ("any new inquiries?"). Empty before the migration. */
export async function inquiryOverview(sinceDays = 30): Promise<InquiryOverview> {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
  try {
    const rows = await db.select({
      source: inquiries.source,
      historical: inquiries.historical,
      status: inquiries.status,
      name: inquiries.name,
      message: inquiries.message,
      receivedAt: inquiries.receivedAt,
    }).from(inquiries)
      .where(and(inOrg(inquiries), sql`${inquiries.receivedAt} >= ${since.toISOString()}::timestamptz`))
      .orderBy(desc(inquiries.receivedAt))
      .limit(500);
    const bySource = new Map<string, number>();
    for (const row of rows.filter((item) => !item.historical && item.status === "received")) bySource.set(row.source, (bySource.get(row.source) ?? 0) + 1);
    return {
      fresh: rows.filter((row) => !row.historical && row.status === "received").length,
      historical: rows.filter((row) => row.historical).length,
      unusable: rows.filter((row) => row.status === "unusable").length,
      bySource: [...bySource.entries()].map(([source, count]) => ({ source, count })),
      latest: rows.filter((row) => !row.historical).slice(0, 5).map((row) => ({ at: row.receivedAt.toISOString(), source: row.source, name: row.name, message: row.message?.slice(0, 200) ?? null })),
    };
  } catch (error) {
    if (isMissingTable(error)) return { fresh: 0, historical: 0, unusable: 0, bySource: [], latest: [] };
    throw error;
  }
}

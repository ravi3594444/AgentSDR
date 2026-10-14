import "server-only";

import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crmPersonContactPolicies } from "@/lib/crm/schema";
import { companies, people } from "@/lib/leads/schema";
import { suppressionList } from "@/lib/outreach/schema";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { contactChannels, countReasons } from "./audiences";
import {
  leadAudienceMembers,
  leadAudiences,
  type AudienceChannel,
  type AudienceSource,
  type ContactEvidence,
} from "./schema";

/**
 * Audiences: the leads one outreach run works through, whether the
 * assistant found them or the owner uploaded them. Members are People rows
 * (so every campaign, CRM and DNC rule applies) plus the businesses that
 * were found but cannot be contacted, kept with the reason.
 */

export async function createAudience(input: {
  name: string;
  source: AudienceSource;
  criteria?: Record<string, unknown>;
  threadId?: string | null;
  userId?: string | null;
}): Promise<string> {
  const [row] = await db.insert(leadAudiences).values({
    organizationId: currentOrganizationId(),
    name: input.name.slice(0, 200),
    source: input.source,
    criteria: input.criteria ?? {},
    threadId: input.threadId ?? null,
    createdBy: input.userId ?? null,
  }).returning({ id: leadAudiences.id });
  return row!.id;
}

export async function getAudience(id: string) {
  const [row] = await db.select().from(leadAudiences).where(and(inOrg(leadAudiences), eq(leadAudiences.id, id))).limit(1);
  return row ?? null;
}

type PersonFacts = {
  id: string;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  name: string;
  companyId: string | null;
  doNotContact: boolean;
  emailSuppressed: boolean;
};

/** People with what decides their channels, read in three queries whatever the count. */
export async function loadPersonFacts(personIds: readonly string[]): Promise<Map<string, PersonFacts>> {
  const facts = new Map<string, PersonFacts>();
  if (!personIds.length) return facts;
  const rows = await db.select({
    id: people.id,
    email: people.email,
    phone: people.phone,
    linkedinUrl: people.linkedinUrl,
    firstName: people.firstName,
    lastName: people.lastName,
    fullName: people.fullName,
    companyId: people.companyId,
    companyName: companies.name,
  }).from(people)
    .leftJoin(companies, and(eq(companies.id, people.companyId), inOrg(companies)))
    .where(and(inOrg(people), inArray(people.id, [...personIds])));
  const dnc = new Set((await db.select({ personId: crmPersonContactPolicies.personId }).from(crmPersonContactPolicies)
    .where(and(inArray(crmPersonContactPolicies.personId, rows.map((row) => row.id)), eq(crmPersonContactPolicies.doNotContact, true))))
    .map((row) => row.personId));
  const emails = rows.map((row) => row.email?.toLowerCase()).filter((email): email is string => Boolean(email));
  const suppressed = new Set(emails.length
    ? (await db.select({ email: suppressionList.email }).from(suppressionList)
      .where(and(inOrg(suppressionList), inArray(suppressionList.email, emails)))).map((row) => row.email)
    : []);
  for (const row of rows) {
    const name = row.fullName?.trim()
      || [row.firstName, row.lastName].filter(Boolean).join(" ").trim()
      || row.companyName?.trim()
      || row.email
      || row.phone
      || "Unnamed lead";
    facts.set(row.id, {
      id: row.id,
      email: row.email,
      phone: row.phone,
      linkedinUrl: row.linkedinUrl ? `https://www.linkedin.com/in/${row.linkedinUrl.replace(/^.*\/in\//, "")}` : null,
      name,
      companyId: row.companyId,
      doNotContact: dnc.has(row.id),
      emailSuppressed: row.email ? suppressed.has(row.email.toLowerCase()) : false,
    });
  }
  return facts;
}

export type NewMember =
  | {
      personId: string;
      source: string;
      sourceUrl?: string | null;
      evidence?: ContactEvidence[];
      facts?: Record<string, string>;
    }
  | {
      personId: null;
      name: string;
      reason: string;
      companyId?: string | null;
      source: string;
      sourceUrl?: string | null;
      evidence?: ContactEvidence[];
      facts?: Record<string, string>;
    };

/**
 * Adds leads to an audience. A person's channels and eligibility are worked
 * out from the person as stored now (DNC, suppression, contact details); a
 * person already in the audience is left as it is.
 */
export async function addAudienceMembers(audienceId: string, members: readonly NewMember[]): Promise<{ added: number; eligible: number; excluded: number }> {
  const facts = await loadPersonFacts(members.flatMap((member) => (member.personId !== null ? [member.personId] : [])));
  const values: (typeof leadAudienceMembers.$inferInsert)[] = [];
  for (const member of members) {
    if (member.personId !== null) {
      const person = facts.get(member.personId);
      if (!person) continue;
      const { channels, reason } = contactChannels(person);
      values.push({
        organizationId: currentOrganizationId(),
        audienceId,
        personId: person.id,
        companyId: person.companyId,
        name: person.name.slice(0, 300),
        status: channels.length ? "eligible" : "excluded",
        reason,
        channels,
        source: member.source,
        sourceUrl: member.sourceUrl ?? null,
        evidence: member.evidence ?? [],
        facts: member.facts ?? {},
      });
    } else {
      values.push({
        organizationId: currentOrganizationId(),
        audienceId,
        personId: null,
        companyId: member.companyId ?? null,
        name: member.name.slice(0, 300),
        status: "excluded",
        reason: member.reason,
        channels: [],
        source: member.source,
        sourceUrl: member.sourceUrl ?? null,
        evidence: member.evidence ?? [],
        facts: member.facts ?? {},
      });
    }
  }
  let added = 0;
  let eligible = 0;
  for (let index = 0; index < values.length; index += 500) {
    const inserted = await db.insert(leadAudienceMembers).values(values.slice(index, index + 500)).onConflictDoNothing()
      .returning({ status: leadAudienceMembers.status });
    added += inserted.length;
    eligible += inserted.filter((row) => row.status === "eligible").length;
  }
  return { added, eligible, excluded: added - eligible };
}

export type AudienceSummary = {
  id: string;
  name: string;
  source: AudienceSource;
  criteria: Record<string, unknown>;
  total: number;
  eligible: number;
  byChannel: Record<AudienceChannel, number>;
  excluded: { reason: string; count: number }[];
  samples: { name: string; channels: AudienceChannel[]; sourceUrl: string | null; evidence: ContactEvidence[] }[];
};

export async function summarizeAudience(audienceId: string): Promise<AudienceSummary | null> {
  const audience = await getAudience(audienceId);
  if (!audience) return null;
  const members = await db.select({
    status: leadAudienceMembers.status,
    reason: leadAudienceMembers.reason,
    channels: leadAudienceMembers.channels,
    name: leadAudienceMembers.name,
    sourceUrl: leadAudienceMembers.sourceUrl,
    evidence: leadAudienceMembers.evidence,
  }).from(leadAudienceMembers)
    .where(and(inOrg(leadAudienceMembers), eq(leadAudienceMembers.audienceId, audienceId)))
    .orderBy(asc(leadAudienceMembers.createdAt));
  const byChannel: Record<AudienceChannel, number> = { email: 0, whatsapp: 0, linkedin: 0 };
  for (const member of members) for (const channel of member.channels) byChannel[channel] += 1;
  const eligibleMembers = members.filter((member) => member.status === "eligible");
  return {
    id: audience.id,
    name: audience.name,
    source: audience.source,
    criteria: audience.criteria,
    total: members.length,
    eligible: eligibleMembers.length,
    byChannel,
    excluded: countReasons(members.filter((member) => member.status === "excluded").map((member) => member.reason)),
    samples: eligibleMembers.slice(0, 5).map((member) => ({
      name: member.name,
      channels: member.channels,
      sourceUrl: member.sourceUrl,
      evidence: member.evidence.slice(0, 4),
    })),
  };
}

/** The eligible people of an audience, oldest first. */
export async function eligibleAudienceMembers(audienceId: string) {
  return db.select({
    personId: leadAudienceMembers.personId,
    name: leadAudienceMembers.name,
    channels: leadAudienceMembers.channels,
    facts: leadAudienceMembers.facts,
    sourceUrl: leadAudienceMembers.sourceUrl,
  }).from(leadAudienceMembers)
    .where(and(inOrg(leadAudienceMembers), eq(leadAudienceMembers.audienceId, audienceId), eq(leadAudienceMembers.status, "eligible")))
    .orderBy(asc(leadAudienceMembers.createdAt));
}

export async function listAudiences(limit = 20) {
  const rows = await db.select({
    id: leadAudiences.id,
    name: leadAudiences.name,
    source: leadAudiences.source,
    createdAt: leadAudiences.createdAt,
    total: count(leadAudienceMembers.id),
    eligible: sql<number>`count(*) filter (where ${leadAudienceMembers.status} = 'eligible')`,
  }).from(leadAudiences)
    .leftJoin(leadAudienceMembers, eq(leadAudienceMembers.audienceId, leadAudiences.id))
    .where(inOrg(leadAudiences))
    .groupBy(leadAudiences.id)
    .orderBy(sql`${leadAudiences.createdAt} desc`)
    .limit(limit);
  return rows.map((row) => ({ ...row, total: Number(row.total), eligible: Number(row.eligible) }));
}

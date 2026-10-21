import "server-only";

import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { crmPipelines, crmRecords } from "@/lib/crm/schema";
import { prospectName } from "@/lib/leads/displayName";
import { companies, people } from "@/lib/leads/schema";
import { inOrg } from "@/lib/tenancy/scope";
import { getAudience, memberInsights } from "./audiences.server";
import { countProspects, derivedMatchReason, qualifyProspect, type Prospect, type ProspectCounts } from "./qualification";
import { leadAudienceMembers } from "./schema";

export type AudienceProspects = {
  audience: { id: string; name: string; source: string; createdAt: string; criteria: Record<string, unknown> };
  counts: ProspectCounts;
  prospects: Prospect[];
};

const MAX_PROSPECTS = 500;

/** Every lead of one list as qualification.ts shows it; null for a list of another organization. */
export async function audienceProspects(audienceId: string): Promise<AudienceProspects | null> {
  const audience = await getAudience(audienceId);
  if (!audience) return null;
  const members = await db.select().from(leadAudienceMembers)
    .where(and(inOrg(leadAudienceMembers), eq(leadAudienceMembers.audienceId, audienceId)))
    .orderBy(asc(leadAudienceMembers.createdAt))
    .limit(MAX_PROSPECTS);
  const personIds = [...new Set(members.flatMap((member) => (member.personId ? [member.personId] : [])))];
  // The default pipeline's record says whether they ever replied and how the CRM classified it.
  const records = personIds.length
    ? await db.select({ personId: crmRecords.personId, categoryKey: crmRecords.categoryKey, lastInboundAt: crmRecords.lastInboundAt })
      .from(crmRecords)
      .innerJoin(crmPipelines, eq(crmPipelines.id, crmRecords.pipelineId))
      .where(and(inOrg(crmRecords), inArray(crmRecords.personId, personIds), eq(crmPipelines.isDefault, true)))
    : [];
  const crmByPerson = new Map(records.map((record) => [record.personId, record]));
  // A member stored under its email or phone is shown by the business its person was saved under (displayName.ts); nothing is written.
  const persons = personIds.length
    ? await db.select({ id: people.id, fullName: people.fullName, firstName: people.firstName, lastName: people.lastName, email: people.email, phone: people.phone, raw: people.raw, companyName: companies.name })
      .from(people)
      .leftJoin(companies, and(eq(companies.id, people.companyId), inOrg(companies)))
      .where(and(inOrg(people), inArray(people.id, personIds)))
    : [];
  const personById = new Map(persons.map((person) => [person.id, person]));
  const nameOf = (member: (typeof members)[number]) => {
    const person = member.personId ? personById.get(member.personId) ?? null : null;
    return prospectName(member.name, person, person ? { name: person.companyName } : null);
  };
  const insights = await memberInsights(members.map((member) => member.id));
  const prospects = members.map((member) => qualifyProspect({
    personId: member.personId,
    name: nameOf(member),
    status: member.status,
    reason: member.reason,
    channels: member.channels,
    source: member.source,
    sourceUrl: member.sourceUrl,
    evidence: member.evidence,
    facts: member.facts,
    matchReason: insights.get(member.id)?.matchReason ?? derivedMatchReason(member.source, audience.criteria, member.facts),
    signals: insights.get(member.id)?.signals ?? [],
    createdAt: member.createdAt,
    crm: member.personId ? crmByPerson.get(member.personId) ?? null : null,
  }));
  return {
    audience: { id: audience.id, name: audience.name, source: audience.source, createdAt: audience.createdAt.toISOString(), criteria: audience.criteria },
    counts: countProspects(prospects),
    prospects,
  };
}

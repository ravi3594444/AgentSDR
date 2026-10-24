import { and, eq, desc, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { people } from "@/lib/leads/schema";
import { outreachCampaigns, outreachLeads, outreachMailboxQueue, suppressionList } from "./schema";
import type { OutreachLeadStatus, SuppressionReason } from "./schema";
import { currentOrganizationId, inOrg, runInOrganization } from "@/lib/tenancy/scope";
import { leadsInOrg } from "./orgScope";

export async function isSuppressed(email: string, executor: Pick<typeof db, "select"> = db): Promise<boolean> {
  const [row] = await executor
    .select({ email: suppressionList.email })
    .from(suppressionList)
    .where(and(inOrg(suppressionList), eq(suppressionList.email, email.trim().toLowerCase())))
    .limit(1);
  return Boolean(row);
}

export async function addToSuppressionList(email: string, reason: SuppressionReason, note?: string | null) {
  const normalized = email.trim().toLowerCase();
  await db
    .insert(suppressionList)
    .values({ organizationId: currentOrganizationId(), email: normalized, reason, note: note ?? null })
    .onConflictDoNothing({ target: [suppressionList.organizationId, suppressionList.email] });
}

/** Atomically suppress an identity, halt all campaign enrollments, and clear queued work. */
export async function suppressEmailOutreach(
  email: string,
  reason: SuppressionReason,
  note?: string | null,
  sequenceStatus: Extract<OutreachLeadStatus, "bounced" | "suppressed"> = "suppressed",
) {
  const normalized = email.trim().toLowerCase();
  await db.transaction(async (tx) => {
    await tx.insert(suppressionList)
      .values({ organizationId: currentOrganizationId(), email: normalized, reason, note: note ?? null })
      .onConflictDoNothing({ target: [suppressionList.organizationId, suppressionList.email] });
    const leadIds = tx.select({ id: outreachLeads.id })
      .from(outreachLeads)
      .innerJoin(people, eq(outreachLeads.personId, people.id))
      .where(and(leadsInOrg(), inOrg(people), eq(people.email, normalized)));
    await tx.delete(outreachMailboxQueue).where(inArray(outreachMailboxQueue.leadId, leadIds));
    await tx.update(outreachLeads)
      .set({ sequenceStatus, nextSendAt: null, updatedAt: new Date() })
      .where(and(leadsInOrg(), inArray(outreachLeads.id, leadIds)));
  });
}

/**
 * Organizations that have an outreach lead for this address. Deliberately
 * unscoped: it exists for legacy unsubscribe tokens, which name no
 * organization, so the address is suppressed wherever it was mailed from.
 */
export async function organizationsMailing(email: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ organizationId: outreachCampaigns.organizationId })
    .from(outreachLeads)
    .innerJoin(outreachCampaigns, eq(outreachLeads.campaignId, outreachCampaigns.id))
    .innerJoin(people, eq(outreachLeads.personId, people.id))
    .where(and(eq(people.organizationId, outreachCampaigns.organizationId), eq(people.email, email.trim().toLowerCase())));
  return rows.map((r) => r.organizationId);
}

/** Suppress an address in every organization that mailed it (legacy unsubscribe tokens). */
export async function suppressEmailOutreachEverywhere(
  email: string,
  reason: SuppressionReason,
  note?: string | null,
): Promise<string[]> {
  const organizationIds = await organizationsMailing(email);
  for (const organizationId of organizationIds) {
    await runInOrganization(organizationId, () => suppressEmailOutreach(email, reason, note));
  }
  return organizationIds;
}

export async function removeFromSuppressionList(email: string) {
  await db.delete(suppressionList).where(and(inOrg(suppressionList), eq(suppressionList.email, email.trim().toLowerCase())));
}

export async function listSuppressed() {
  return db.select().from(suppressionList).where(inOrg(suppressionList)).orderBy(desc(suppressionList.createdAt));
}

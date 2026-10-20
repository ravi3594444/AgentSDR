import { and, count, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { leads } from "@/lib/linkedin/schema";
import { inOrg } from "@/lib/tenancy/scope";

export const statusCountsByCampaignIds = async (
  campaignIds: string[]
): Promise<Record<string, Record<string, number>>> => {
  if (campaignIds.length === 0) return {};

  const groups = await db
    .select({ campaignId: leads.campaignId, status: leads.status, count: count() })
    .from(leads)
    .where(and(inOrg(leads), inArray(leads.campaignId, campaignIds)))
    .groupBy(leads.campaignId, leads.status);

  const result: Record<string, Record<string, number>> = {};
  for (const row of groups) {
    if (!row.campaignId) continue;
    if (!result[row.campaignId]) result[row.campaignId] = {};
    result[row.campaignId][row.status] = row.count;
  }
  return result;
};

/**
 * Leads with a recorded invitation (requestSentAt), per campaign: the
 * campaign's "Invited" count. A stop cancels a lead's status but keeps this
 * time, so the count does not drop when a campaign is stopped.
 */
export const invitedCountsByCampaignIds = async (campaignIds: string[]): Promise<Record<string, number>> => {
  if (campaignIds.length === 0) return {};
  const groups = await db
    .select({ campaignId: leads.campaignId, count: count() })
    .from(leads)
    .where(and(inOrg(leads), inArray(leads.campaignId, campaignIds), isNotNull(leads.requestSentAt)))
    .groupBy(leads.campaignId);
  const result: Record<string, number> = {};
  for (const row of groups) if (row.campaignId) result[row.campaignId] = row.count;
  return result;
};

export const statusCountsForCampaign = async (campaignId: string) => {
  const groups = await db
    .select({ status: leads.status, count: count() })
    .from(leads)
    .where(and(inOrg(leads), eq(leads.campaignId, campaignId)))
    .groupBy(leads.status);

  const counts: Record<string, number> = {};
  for (const row of groups) {
    counts[row.status] = row.count;
  }
  return counts;
};

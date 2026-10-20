import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { requirePageOrgContext } from "@/lib/auth/context";
import { inOrg, runInOrganization } from "@/lib/tenancy/scope";
import { db } from "@/lib/db";
import { campaignAccounts, campaigns as campaignsTable, leads, linkedInAccounts } from "@/lib/linkedin/schema";
import { CampaignsClient, type CampaignRow } from "@/components/linkedin/CampaignsClient";
import { invitedCountsByCampaignIds, statusCountsByCampaignIds } from "@/lib/linkedin/campaignLeadStats";

export const metadata = { title: "Campaigns" };

export const dynamic = "force-dynamic";

export default async function CampaignsPage() {
  const ctx = await requirePageOrgContext();
  return runInOrganization(ctx.organizationId, async () => {
    const [campaigns, accounts] = await Promise.all([
      db
        .select({
          id: campaignsTable.id,
          name: campaignsTable.name,
          description: campaignsTable.description,
          status: campaignsTable.status,
          type: campaignsTable.type,
          createdAt: campaignsTable.createdAt,
        })
        .from(campaignsTable)
        .where(inOrg(campaignsTable))
        .orderBy(desc(campaignsTable.createdAt)),
      db
        .select({
          id: linkedInAccounts.id,
          username: linkedInAccounts.username,
          name: linkedInAccounts.name,
          profilePictureUrl: linkedInAccounts.profilePictureUrl,
        })
        .from(linkedInAccounts)
        .where(and(inOrg(linkedInAccounts), eq(linkedInAccounts.status, "CONNECTED")))
        .orderBy(asc(linkedInAccounts.username)),
    ]);

    const campaignIds = campaigns.map((c) => c.id);

    // Prisma's nested `accounts: { select: { linkedInAccount: ... } }` and
    // `_count: { select: { leads: true } }` become two grouped side queries,
    // keyed by campaign id.
    const [accountRows, leadCountRows] = await Promise.all([
      campaignIds.length
        ? db
            .select({
              campaignId: campaignAccounts.campaignId,
              id: linkedInAccounts.id,
              username: linkedInAccounts.username,
              name: linkedInAccounts.name,
              profilePictureUrl: linkedInAccounts.profilePictureUrl,
            })
            .from(campaignAccounts)
            .innerJoin(linkedInAccounts, eq(campaignAccounts.linkedinAccountId, linkedInAccounts.id))
            .where(and(inOrg(linkedInAccounts), inArray(campaignAccounts.campaignId, campaignIds)))
        : [],
      campaignIds.length
        ? db
            .select({ campaignId: leads.campaignId, leadCount: count() })
            .from(leads)
            .where(and(inOrg(leads), inArray(leads.campaignId, campaignIds)))
            .groupBy(leads.campaignId)
        : [],
    ]);

    const accountsByCampaign: Record<
      string,
      { id: string; username: string; name: string | null; profilePictureUrl: string | null }[]
    > = {};
    for (const row of accountRows) {
      (accountsByCampaign[row.campaignId] ??= []).push({
        id: row.id,
        username: row.username,
        name: row.name,
        profilePictureUrl: row.profilePictureUrl,
      });
    }

    const leadCountByCampaign: Record<string, number> = {};
    for (const row of leadCountRows) {
      if (row.campaignId) leadCountByCampaign[row.campaignId] = row.leadCount;
    }

    const [statusByCampaign, invitedByCampaign] = await Promise.all([statusCountsByCampaignIds(campaignIds), invitedCountsByCampaignIds(campaignIds)]);

    const rows: CampaignRow[] = campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      status: c.status,
      type: c.type,
      accounts: accountsByCampaign[c.id] ?? [],
      totalLeads: leadCountByCampaign[c.id] ?? 0,
      statusCounts: statusByCampaign[c.id] ?? {},
      invitedCount: invitedByCampaign[c.id] ?? 0,
      createdAt: c.createdAt.toISOString(),
    }));

    return <CampaignsClient campaigns={rows} accounts={accounts} />;
  });
}

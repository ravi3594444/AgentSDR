import { notFound } from "next/navigation";
import { requirePageOrgContext } from "@/lib/auth/context";
import { inOrg, runInOrganization } from "@/lib/tenancy/scope";
import { and, asc, count, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { campaignAccounts, campaigns, leads, linkedInAccounts } from "@/lib/linkedin/schema";
import { CampaignDetailClient } from "@/components/linkedin/CampaignDetailClient";
import { listCampaignLeadsPage } from "@/lib/linkedin/campaignLeads";
import { invitedCountsByCampaignIds, statusCountsForCampaign } from "@/lib/linkedin/campaignLeadStats";

export const dynamic = "force-dynamic";

export default async function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePageOrgContext();
  return runInOrganization(ctx.organizationId, async () => {
    const { id } = await params;

    // Prisma's nested `accounts` include and `_count: { select: { leads: true } }`
    // become side queries keyed off the campaign id.
    const [campaignRows, campaignAccountRows, [{ totalLeads }], accounts, statusCounts, initialLeadsPage, invited] =
      await Promise.all([
        db
          .select({
            id: campaigns.id,
            name: campaigns.name,
            description: campaigns.description,
            status: campaigns.status,
            type: campaigns.type,
            createdAt: campaigns.createdAt,
            invitationMessage: campaigns.invitationMessage,
            acceptanceMessage: campaigns.acceptanceMessage,
            followUp1Message: campaigns.followUp1Message,
            followUp2Message: campaigns.followUp2Message,
            followUp3Message: campaigns.followUp3Message,
          })
          .from(campaigns)
          .where(and(inOrg(campaigns), eq(campaigns.id, id)))
          .limit(1),
        db
          .select({
            id: linkedInAccounts.id,
            username: linkedInAccounts.username,
            name: linkedInAccounts.name,
            profilePictureUrl: linkedInAccounts.profilePictureUrl,
          })
          .from(campaignAccounts)
          .innerJoin(linkedInAccounts, eq(campaignAccounts.linkedinAccountId, linkedInAccounts.id))
          .where(and(inOrg(linkedInAccounts), eq(campaignAccounts.campaignId, id))),
        db.select({ totalLeads: count() }).from(leads).where(and(inOrg(leads), eq(leads.campaignId, id))),
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
        statusCountsForCampaign(id),
        listCampaignLeadsPage(id, 1),
        invitedCountsByCampaignIds([id]),
      ]);

    const campaign = campaignRows[0];

    if (!campaign) notFound();

    return (
      <CampaignDetailClient
        campaign={{
          id: campaign.id,
          name: campaign.name,
          description: campaign.description,
          status: campaign.status,
          type: campaign.type,
          createdAt: campaign.createdAt.toISOString(),
          invitationMessage: campaign.invitationMessage,
          acceptanceMessage: campaign.acceptanceMessage,
          followUp1Message: campaign.followUp1Message,
          followUp2Message: campaign.followUp2Message,
          followUp3Message: campaign.followUp3Message,
          accounts: campaignAccountRows,
          totalLeads,
          statusCounts,
          invitedCount: invited[id] ?? 0,
        }}
        initialLeadsPage={initialLeadsPage}
        accounts={accounts}
      />
    );
  });
}

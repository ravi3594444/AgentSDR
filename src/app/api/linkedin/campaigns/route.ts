import { NextRequest, NextResponse } from "next/server";
import { withLinkedinOrg } from "@/lib/linkedin/organizations.server";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  campaignAccounts,
  campaigns as campaignsTable,
  leads,
  linkedInAccounts,
  type CampaignType,
  type CampaignStatus,
} from "@/lib/linkedin/schema";
import { linkedinSequenceError, normalizeLinkedinSequence } from "@/lib/linkedin/campaignSequence";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";

const ACCOUNT_SELECT = {
  id: linkedInAccounts.id,
  username: linkedInAccounts.username,
  name: linkedInAccounts.name,
  profilePictureUrl: linkedInAccounts.profilePictureUrl,
};

type CampaignAccountRow = { id: string; username: string; name: string | null; profilePictureUrl: string | null };

/**
 * Accounts assigned to each campaign, keyed by campaignId. Replaces Prisma's
 * `accounts: { include: { linkedInAccount: { select: ACCOUNT_SELECT } } } }`.
 */
async function accountsByCampaignId(campaignIds: string[]): Promise<Map<string, CampaignAccountRow[]>> {
  const map = new Map<string, CampaignAccountRow[]>();
  if (campaignIds.length === 0) return map;

  const rows = await db
    .select({ campaignId: campaignAccounts.campaignId, ...ACCOUNT_SELECT })
    .from(campaignAccounts)
    .innerJoin(linkedInAccounts, eq(campaignAccounts.linkedinAccountId, linkedInAccounts.id))
    .where(and(inOrg(linkedInAccounts), inArray(campaignAccounts.campaignId, campaignIds)));

  for (const { campaignId, ...account } of rows) {
    const list = map.get(campaignId) ?? [];
    list.push(account);
    map.set(campaignId, list);
  }
  return map;
}

export async function GET(req: Request) {
  return withLinkedinOrg(req, async () => {
    const campaigns = await db
      .select()
      .from(campaignsTable)
      .where(inOrg(campaignsTable))
      .orderBy(desc(campaignsTable.createdAt));

    const campaignIds = campaigns.map((c) => c.id);
    const accountsByCampaign = await accountsByCampaignId(campaignIds);

    // Replaces `_count: { leads: true }` + `leads: { select: { status: true } }`:
    // one grouped count gives both the per-status tally and the total.
    const statusRows = campaignIds.length
      ? await db
          .select({
            campaignId: leads.campaignId,
            status: leads.status,
            count: count(),
            // Invited: the invitation's own record, kept when a stop cancels the lead.
            invited: sql<number>`count(*) filter (where ${leads.requestSentAt} is not null)::int`,
          })
          .from(leads)
          .where(and(inOrg(leads), inArray(leads.campaignId, campaignIds)))
          .groupBy(leads.campaignId, leads.status)
      : [];

    const statusCountsByCampaign = new Map<string, Record<string, number>>();
    const totalLeadsByCampaign = new Map<string, number>();
    const invitedByCampaign = new Map<string, number>();
    for (const row of statusRows) {
      if (!row.campaignId) continue;
      invitedByCampaign.set(row.campaignId, (invitedByCampaign.get(row.campaignId) ?? 0) + Number(row.invited));
      const counts = statusCountsByCampaign.get(row.campaignId) ?? {};
      counts[row.status] = (counts[row.status] ?? 0) + row.count;
      statusCountsByCampaign.set(row.campaignId, counts);
      totalLeadsByCampaign.set(row.campaignId, (totalLeadsByCampaign.get(row.campaignId) ?? 0) + row.count);
    }

    const data = campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      status: c.status,
      type: c.type,
      accounts: accountsByCampaign.get(c.id) ?? [],
      totalLeads: totalLeadsByCampaign.get(c.id) ?? 0,
      statusCounts: statusCountsByCampaign.get(c.id) ?? {},
      invitedCount: invitedByCampaign.get(c.id) ?? 0,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    }));

    return NextResponse.json({ ok: true, campaigns: data });
  });
}

export async function POST(req: NextRequest) {
  return withLinkedinOrg(req, async () => {
    try {
      const { name, description, linkedinAccountIds, type, status, invitationMessage, acceptanceMessage, followUp1Message, followUp2Message, followUp3Message } = await req.json();
      if (!name?.trim()) {
        return NextResponse.json({ ok: false, error: "Name is required" }, { status: 400 });
      }
      const ids: string[] = Array.isArray(linkedinAccountIds)
        ? [...new Set(linkedinAccountIds.filter((id: unknown): id is string => typeof id === "string" && Boolean(id.trim())))]
        : [];
      const campaignType: CampaignType = type === "PERSONAL" ? "PERSONAL" : "REGULAR";
      if (status === "ACTIVE") {
        return NextResponse.json(
          { ok: false, error: "Create the campaign paused, then add leads and launch it" },
          { status: 400 },
        );
      }
      const campaignStatus: CampaignStatus = "PAUSED";
      const sequence = normalizeLinkedinSequence({ invitationMessage, acceptanceMessage, followUp1Message, followUp2Message, followUp3Message });
      const sequenceError = linkedinSequenceError(sequence);
      if (sequenceError) {
        return NextResponse.json({ ok: false, error: sequenceError }, { status: 400 });
      }

      if (ids.length) {
        const connected = await db
          .select({ id: linkedInAccounts.id })
          .from(linkedInAccounts)
          .where(and(inOrg(linkedInAccounts), inArray(linkedInAccounts.id, ids)));
        if (connected.length !== ids.length) {
          return NextResponse.json({ ok: false, error: "One or more LinkedIn senders no longer exist" }, { status: 400 });
        }
      }

      const campaign = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(campaignsTable)
          .values({
            organizationId: currentOrganizationId(),
            name: name.trim(),
            description: description?.trim() || null,
            type: campaignType,
            status: campaignStatus,
            invitationMessage: sequence.invitationMessage || null,
            acceptanceMessage: sequence.acceptanceMessage || null,
            followUp1Message: sequence.followUp1Message || null,
            followUp2Message: sequence.followUp2Message || null,
            followUp3Message: sequence.followUp3Message || null,
            updatedAt: new Date(),
          })
          .returning();

        if (ids.length) {
          await tx
            .insert(campaignAccounts)
            .values(ids.map((id) => ({ campaignId: created.id, linkedinAccountId: id })));
        }

        return created;
      });

      const accounts = ids.length
        ? await db
            .select(ACCOUNT_SELECT)
            .from(campaignAccounts)
            .innerJoin(linkedInAccounts, eq(campaignAccounts.linkedinAccountId, linkedInAccounts.id))
            .where(eq(campaignAccounts.campaignId, campaign.id))
        : [];

      return NextResponse.json({
        ok: true,
        campaign: {
          ...campaign,
          accounts,
          totalLeads: 0,
          statusCounts: {} as Record<string, number>,
          createdAt: campaign.createdAt.toISOString(),
          updatedAt: campaign.updatedAt.toISOString(),
        },
      });
    } catch (err) {
      return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
    }
  });
}

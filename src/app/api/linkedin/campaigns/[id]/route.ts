import { NextRequest, NextResponse } from "next/server";
import { withLinkedinOrg } from "@/lib/linkedin/organizations.server";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { inOrg } from "@/lib/tenancy/scope";
import {
  campaignAccounts,
  campaigns,
  connections,
  leads,
  linkedInAccounts,
  messages,
  type CampaignStatus,
} from "@/lib/linkedin/schema";
import { companies, people } from "@/lib/leads/schema";
import { personProfile } from "@/lib/leads/variables";
import {
  LINKEDIN_SEQUENCE_FIELDS,
  linkedinSequenceError,
  normalizeLinkedinSequence,
} from "@/lib/linkedin/campaignSequence";
import { isPlatformConnected } from "@/lib/platform/credentials";
import type { LeadStatus } from "@/lib/linkedin/schema";

/** Leads the engine can still act on: everything not replied, completed, failed or cancelled. */
const WORKABLE_LEAD_STATUSES: LeadStatus[] = ["PENDING", "REQUEST_SENT", "CONNECTED", "ACCEPT_MESSAGE_SENT", "FOLLOW_UP_1_SENT", "FOLLOW_UP_2_SENT"];

const ACCOUNT_SELECT = {
  id: linkedInAccounts.id,
  username: linkedInAccounts.username,
  name: linkedInAccounts.name,
  profilePictureUrl: linkedInAccounts.profilePictureUrl,
};

/**
 * The accounts assigned to a campaign. Replaces Prisma's
 * `accounts: { include: { linkedInAccount: { select: ACCOUNT_SELECT } } } }`,
 * already flattened to the bare account rows the callers expect.
 */
function campaignAccountsFor(campaignId: string) {
  return db
    .select(ACCOUNT_SELECT)
    .from(campaignAccounts)
    .innerJoin(linkedInAccounts, eq(campaignAccounts.linkedinAccountId, linkedInAccounts.id))
    .where(and(inOrg(linkedInAccounts), eq(campaignAccounts.campaignId, campaignId)));
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withLinkedinOrg(_req, async () => {
    const { id } = await params;
    const [campaign] = await db.select().from(campaigns).where(and(inOrg(campaigns), eq(campaigns.id, id))).limit(1);

    if (!campaign) {
      return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    }

    const accounts = await campaignAccountsFor(id);

    // Prisma's nested `leads: { select: { ..., linkedInAccount: { select: ... } } } }`.
    // linkedinAccountId is nullable, so the account join must be a leftJoin.
    const leadRows = await db
      .select({
        id: leads.id,
        sourceLinkedinIdentifier: leads.sourceLinkedinIdentifier,
        stagedName: leads.name,
        stagedHeadline: leads.headline,
        stagedLocation: leads.location,
        stagedProfilePictureUrl: leads.profilePictureUrl,
        person: people,
        company: companies,
        status: leads.status,
        requestSentAt: leads.requestSentAt,
        invitationMessage: leads.invitationMessage,
        acceptanceMessage: leads.acceptanceMessage,
        followUp1Message: leads.followUp1Message,
        followUp1SentAt: leads.followUp1SentAt,
        followUp2Message: leads.followUp2Message,
        followUp2SentAt: leads.followUp2SentAt,
        followUp3Message: leads.followUp3Message,
        followUp3SentAt: leads.followUp3SentAt,
        accountUsername: linkedInAccounts.username,
        accountName: linkedInAccounts.name,
        accountProfilePictureUrl: linkedInAccounts.profilePictureUrl,
        createdAt: leads.createdAt,
      })
      .from(leads)
      .leftJoin(people, eq(leads.personId, people.id))
      .leftJoin(companies, eq(people.companyId, companies.id))
      .leftJoin(linkedInAccounts, eq(leads.linkedinAccountId, linkedInAccounts.id))
      .where(and(inOrg(leads), eq(leads.campaignId, id)))
      .orderBy(desc(leads.updatedAt));

    const campaignLeads = leadRows.map(
      ({ accountUsername, accountName, accountProfilePictureUrl, person, company, ...lead }) => ({
        ...lead,
        invitationMessage: campaign.invitationMessage ?? lead.invitationMessage,
        acceptanceMessage: campaign.acceptanceMessage ?? lead.acceptanceMessage,
        followUp1Message: campaign.followUp1Message ?? lead.followUp1Message,
        followUp2Message: campaign.followUp2Message ?? lead.followUp2Message,
        followUp3Message: campaign.followUp3Message ?? lead.followUp3Message,
        ...(person ? personProfile(person, company) : {
          email: null,
          linkedinUrl: lead.sourceLinkedinIdentifier ?? "",
          firstName: null,
          lastName: null,
          name: lead.stagedName,
          headline: lead.stagedHeadline,
          location: lead.stagedLocation,
          profilePictureUrl: lead.stagedProfilePictureUrl,
          company: null,
          variables: {},
        }),
        linkedInAccount:
          accountUsername === null
            ? null
            : {
                username: accountUsername,
                name: accountName,
                profilePictureUrl: accountProfilePictureUrl,
              },
      })
    );

    const statusCounts: Record<string, number> = {};
    for (const lead of campaignLeads) {
      statusCounts[lead.status] = (statusCounts[lead.status] ?? 0) + 1;
    }

    return NextResponse.json({
      ok: true,
      campaign: {
        id: campaign.id,
        name: campaign.name,
        description: campaign.description,
        status: campaign.status,
        type: campaign.type,
        invitationMessage: campaign.invitationMessage,
        acceptanceMessage: campaign.acceptanceMessage,
        followUp1Message: campaign.followUp1Message,
        followUp2Message: campaign.followUp2Message,
        followUp3Message: campaign.followUp3Message,
        accounts,
        totalLeads: campaignLeads.length,
        statusCounts,
        createdAt: campaign.createdAt.toISOString(),
        updatedAt: campaign.updatedAt.toISOString(),
      },
      leads: campaignLeads.map((l) => ({
        ...l,
        requestSentAt: l.requestSentAt?.toISOString() ?? null,
        followUp1SentAt: l.followUp1SentAt?.toISOString() ?? null,
        followUp2SentAt: l.followUp2SentAt?.toISOString() ?? null,
        followUp3SentAt: l.followUp3SentAt?.toISOString() ?? null,
        createdAt: l.createdAt.toISOString(),
      })),
    });
  });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withLinkedinOrg(req, async () => {
    const { id } = await params;
    try {
      const { name, description, linkedinAccountIds, status, invitationMessage, acceptanceMessage, followUp1Message, followUp2Message, followUp3Message } = await req.json();

      const [existingCampaign] = await db.select().from(campaigns).where(and(inOrg(campaigns), eq(campaigns.id, id))).limit(1);
      if (!existingCampaign) {
        return NextResponse.json({ ok: false, error: "Campaign not found" }, { status: 404 });
      }
      if (name !== undefined && (typeof name !== "string" || !name.trim())) {
        return NextResponse.json({ ok: false, error: "Name is required" }, { status: 400 });
      }
      if (status !== undefined && status !== "ACTIVE" && status !== "PAUSED") {
        return NextResponse.json({ ok: false, error: "Invalid campaign status" }, { status: 400 });
      }

      const sequenceInput = { invitationMessage, acceptanceMessage, followUp1Message, followUp2Message, followUp3Message };
      const hasSequenceUpdate = LINKEDIN_SEQUENCE_FIELDS.some((field) => sequenceInput[field] !== undefined);
      if (hasSequenceUpdate) {
        const sequence = normalizeLinkedinSequence({
          invitationMessage: invitationMessage ?? existingCampaign.invitationMessage,
          acceptanceMessage: acceptanceMessage ?? existingCampaign.acceptanceMessage,
          followUp1Message: followUp1Message ?? existingCampaign.followUp1Message,
          followUp2Message: followUp2Message ?? existingCampaign.followUp2Message,
          followUp3Message: followUp3Message ?? existingCampaign.followUp3Message,
        });
        const sequenceError = linkedinSequenceError(sequence);
        if (sequenceError) {
          return NextResponse.json({ ok: false, error: sequenceError }, { status: 400 });
        }
      }

      // Update scalar fields
      const scalarUpdate: { name?: string; description?: string | null; status?: CampaignStatus; invitationMessage?: string | null; acceptanceMessage?: string | null; followUp1Message?: string | null; followUp2Message?: string | null; followUp3Message?: string | null } = {
        ...(name !== undefined && { name: name.trim() }),
        ...(description !== undefined && { description: description?.trim() || null }),
        ...(status !== undefined && { status: status as CampaignStatus }),
        ...(invitationMessage !== undefined && { invitationMessage: invitationMessage?.trim() || null }),
        ...(acceptanceMessage !== undefined && { acceptanceMessage: acceptanceMessage?.trim() || null }),
        ...(followUp1Message !== undefined && { followUp1Message: followUp1Message?.trim() || null }),
        ...(followUp2Message !== undefined && { followUp2Message: followUp2Message?.trim() || null }),
        ...(followUp3Message !== undefined && { followUp3Message: followUp3Message?.trim() || null }),
      };
      // Prisma issued the UPDATE even with an empty `data` (it still bumps
      // @updatedAt); Drizzle rejects an empty `set`, so only skip when there is
      // genuinely nothing to write.
      const ids = Array.isArray(linkedinAccountIds)
        ? [...new Set(linkedinAccountIds.filter((accountId: unknown): accountId is string => typeof accountId === "string" && Boolean(accountId.trim())))]
        : null;

      if (ids?.length) {
        const found = await db.select({ id: linkedInAccounts.id }).from(linkedInAccounts).where(and(inOrg(linkedInAccounts), inArray(linkedInAccounts.id, ids)));
        if (found.length !== ids.length) {
          return NextResponse.json({ ok: false, error: "One or more LinkedIn senders no longer exist" }, { status: 400 });
        }
      }

      if (status === "ACTIVE") {
        // Server-side launch rules (the wizard checks the same to disable its
        // button): Unipile connected, a valid sequence, connected senders and
        // a lead the engine can still work.
        if (!(await isPlatformConnected("unipile"))) {
          return NextResponse.json(
            { ok: false, error: "Connect Unipile in Settings → LinkedIn → Connection before launching" },
            { status: 409 },
          );
        }
        const effectiveSequenceError = linkedinSequenceError(normalizeLinkedinSequence({
          invitationMessage: invitationMessage ?? existingCampaign.invitationMessage,
          acceptanceMessage: acceptanceMessage ?? existingCampaign.acceptanceMessage,
          followUp1Message: followUp1Message ?? existingCampaign.followUp1Message,
          followUp2Message: followUp2Message ?? existingCampaign.followUp2Message,
          followUp3Message: followUp3Message ?? existingCampaign.followUp3Message,
        }));
        if (effectiveSequenceError) {
          return NextResponse.json({ ok: false, error: effectiveSequenceError }, { status: 400 });
        }
        const effectiveAccountIds = ids ?? (
          await db
            .select({ id: campaignAccounts.linkedinAccountId })
            .from(campaignAccounts)
            .where(and(
              eq(campaignAccounts.campaignId, id),
              inArray(campaignAccounts.campaignId, db.select({ id: campaigns.id }).from(campaigns).where(inOrg(campaigns))),
            ))
        ).map((row) => row.id);

        if (effectiveAccountIds.length === 0) {
          return NextResponse.json(
            { ok: false, error: "Assign at least one connected LinkedIn sender before launching" },
            { status: 400 },
          );
        }

        const [connectedSenders, campaignLeads] = await Promise.all([
          db
            .select({ id: linkedInAccounts.id })
            .from(linkedInAccounts)
            .where(
              and(
                inOrg(linkedInAccounts),
                inArray(linkedInAccounts.id, effectiveAccountIds),
                eq(linkedInAccounts.status, "CONNECTED"),
              ),
            ),
          db.select({ value: count() }).from(leads).where(and(inOrg(leads), eq(leads.campaignId, id), inArray(leads.status, WORKABLE_LEAD_STATUSES))),
        ]);

        if (connectedSenders.length !== effectiveAccountIds.length) {
          return NextResponse.json(
            { ok: false, error: "Every assigned LinkedIn sender must be connected before launching" },
            { status: 400 },
          );
        }
        if (Number(campaignLeads[0]?.value ?? 0) === 0) {
          return NextResponse.json(
            { ok: false, error: "Add at least one lead that has not replied, completed or failed before launching" },
            { status: 400 },
          );
        }
      }

      await db.transaction(async (tx) => {
        if (Object.keys(scalarUpdate).length > 0) {
          await tx.update(campaigns).set(scalarUpdate).where(and(inOrg(campaigns), eq(campaigns.id, id)));
        }

        if (ids) {
          await tx.delete(campaignAccounts).where(eq(campaignAccounts.campaignId, id));
          if (ids.length > 0) {
            await tx.insert(campaignAccounts).values(ids.map((linkedinAccountId) => ({ campaignId: id, linkedinAccountId })));
          }
        }
      });

      const [campaign] = await db.select().from(campaigns).where(and(inOrg(campaigns), eq(campaigns.id, id))).limit(1);
      // Prisma dereferenced `campaign!` here, so a missing id threw into the
      // catch below and answered 500; keep it an error rather than an `ok: true`
      // with a half-empty campaign.
      if (!campaign) return NextResponse.json({ ok: false, error: "Campaign not found" }, { status: 404 });
      const accounts = await campaignAccountsFor(id);

      return NextResponse.json({ ok: true, campaign: { ...campaign, accounts } });
    } catch (err) {
      return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
    }
  });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withLinkedinOrg(_req, async () => {
    const { id } = await params;
    try {
      await db.transaction(async (tx) => {
        // Do not leave the UI waiting behind a long-running import transaction.
        // A lock timeout rolls this transaction back and lets the user retry once
        // the import has finished.
        await tx.execute(sql`set local lock_timeout = '5s'`);

        // Prisma's `{ lead: { campaignId: id } }` relation filters become
        // subqueries over the campaign's lead ids.
        const campaignLeadIds = tx
          .select({ id: leads.id })
          .from(leads)
          .where(and(inOrg(leads), eq(leads.campaignId, id)));

        await tx.delete(messages).where(and(inOrg(messages), inArray(messages.leadId, campaignLeadIds)));
        await tx.delete(connections).where(and(inOrg(connections), inArray(connections.leadId, campaignLeadIds)));
        await tx.delete(leads).where(and(inOrg(leads), eq(leads.campaignId, id)));
        await tx.delete(campaigns).where(and(inOrg(campaigns), eq(campaigns.id, id)));
      });
      return NextResponse.json({ ok: true });
    } catch (err) {
      if ((err as { code?: string })?.code === "55P03") {
        return NextResponse.json(
          { ok: false, error: "This campaign is still being updated by an import. Wait for the import to finish, then try deleting it again." },
          { status: 409 },
        );
      }
      return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
    }
  });
}

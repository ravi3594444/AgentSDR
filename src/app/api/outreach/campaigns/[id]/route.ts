import { NextRequest, NextResponse } from "next/server";
import {
  getCampaign,
  updateCampaignName,
  updateCampaignSequence,
  setCampaignStatus,
  deleteCampaign,
  getCampaignStats,
  emailLaunchFacts,
} from "@/lib/outreach/campaigns";
import type { CampaignStatus } from "@/lib/outreach/schema";
import { withOrgContext, authContextErrorResponse } from "@/lib/auth/context";
import { emailLaunchProblems, parseSequence } from "@/lib/outreach/launch";
import { buildMailboxQueues } from "@/lib/outreach/buildQueue";
import { currentOrganizationId } from "@/lib/tenancy/scope";

const CAMPAIGN_STATUSES: readonly CampaignStatus[] = ["draft", "active", "paused", "completed"];

// GET /api/outreach/campaigns/[id]
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    return await withOrgContext(_req, async () => {
      const { id } = await params;
      const campaign = await getCampaign(id);
      if (!campaign) return NextResponse.json({ error: "not found" }, { status: 404 });
      const stats = await getCampaignStats(id);
      return NextResponse.json({ campaign, stats });
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

// PATCH /api/outreach/campaigns/[id] — { name?, sequence?, status? }
// Going active (launch or resume) is refused with 409 and every reason
// (`problems`) unless Google is connected, a mailbox is connected, the
// sequence is complete and a lead can still receive it; see launch.ts.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    return await withOrgContext(req, async () => {
      const { id } = await params;
      const campaign = await getCampaign(id);
      if (!campaign) return NextResponse.json({ error: "not found" }, { status: 404 });

      let body: { name?: string; sequence?: unknown; status?: CampaignStatus };
      try {
        body = await req.json();
      } catch {
        return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
      }

      // The column has no CHECK constraint: an unknown status would be stored
      // and the campaign would drop out of every status filter.
      if (body.status !== undefined && !CAMPAIGN_STATUSES.includes(body.status)) {
        return NextResponse.json({ error: `status must be one of ${CAMPAIGN_STATUSES.join(", ")}` }, { status: 400 });
      }
      if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim())) {
        return NextResponse.json({ error: "name is required" }, { status: 400 });
      }
      let sequence = campaign.sequence;
      if (body.sequence !== undefined) {
        const parsed = parseSequence(body.sequence);
        if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
        sequence = parsed.sequence;
      }
      const activating = body.status === "active" && campaign.status !== "active";
      if (activating) {
        const problems = emailLaunchProblems(await emailLaunchFacts({ id, sequence }));
        if (problems.length) {
          return NextResponse.json({ error: problems.join(" "), problems }, { status: 409 });
        }
      }

      if (body.name !== undefined) await updateCampaignName(id, body.name);
      if (body.sequence !== undefined) await updateCampaignSequence(id, sequence);
      if (body.status) await setCampaignStatus(id, body.status);
      // The daily queue was built at the start of the organization's day; rebuild
      // it now so a campaign launched or resumed mid-day starts today, within
      // each mailbox's remaining daily allowance and sending hours. Safe to
      // re-run: it never re-grants a mailbox's daily allowance.
      if (activating) {
        await buildMailboxQueues({ organizationIds: [currentOrganizationId()] }).catch((error) => {
          console.error(`[outreach] queue rebuild after activating campaign ${id} failed:`, error);
        });
      }

      const updated = await getCampaign(id);
      return NextResponse.json({ campaign: updated });
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

// DELETE /api/outreach/campaigns/[id]
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    return await withOrgContext(_req, async () => {
      const { id } = await params;
      // Another organization's campaign is not found, not "deleted".
      if (!(await getCampaign(id))) return NextResponse.json({ error: "not found" }, { status: 404 });
      await deleteCampaign(id);
      return NextResponse.json({ ok: true });
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

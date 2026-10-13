import { NextRequest, NextResponse } from "next/server";
import {
  getCampaign,
  updateCampaignName,
  updateCampaignSequence,
  setCampaignStatus,
  deleteCampaign,
  getCampaignStats,
} from "@/lib/outreach/campaigns";
import type { SequenceStep, CampaignStatus } from "@/lib/outreach/schema";
import { withOrgContext, authContextErrorResponse } from "@/lib/auth/context";

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
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    return await withOrgContext(req, async () => {
      const { id } = await params;
      const campaign = await getCampaign(id);
      if (!campaign) return NextResponse.json({ error: "not found" }, { status: 404 });

      let body: { name?: string; sequence?: SequenceStep[]; status?: CampaignStatus };
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
      if (body.name !== undefined) {
        if (!body.name.trim()) return NextResponse.json({ error: "name is required" }, { status: 400 });
        await updateCampaignName(id, body.name);
      }
      if (body.sequence) await updateCampaignSequence(id, body.sequence);
      if (body.status) await setCampaignStatus(id, body.status);

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

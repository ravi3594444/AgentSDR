import { NextRequest, NextResponse } from "next/server";
import { getCampaign, getCampaignMergeFields } from "@/lib/outreach/campaigns";
import { withOrgContext, authContextErrorResponse } from "@/lib/auth/context";

// GET /api/outreach/campaigns/[id]/merge-fields
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    return await withOrgContext(_req, async () => {
      const { id } = await params;
      if (!(await getCampaign(id))) return NextResponse.json({ error: "not found" }, { status: 404 });
      const fields = await getCampaignMergeFields(id);
      return NextResponse.json({ fields });
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

import { NextRequest, NextResponse } from "next/server";
import { getCampaign, getCampaignLeads, getCampaignLeadsPage } from "@/lib/outreach/campaigns";
import { withOrgContext, authContextErrorResponse } from "@/lib/auth/context";

// GET /api/outreach/campaigns/[id]/leads
// Paginated when ?page is present; returns every lead otherwise, which the
// preview modal's lead picker still relies on.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    return await withOrgContext(req, async () => {
      const { id } = await params;
      if (!(await getCampaign(id))) return NextResponse.json({ error: "not found" }, { status: 404 });
      const { searchParams } = new URL(req.url);

      if (!searchParams.has("page")) {
        const leads = await getCampaignLeads(id);
        return NextResponse.json({ leads });
      }

      const result = await getCampaignLeadsPage(id, {
        page: Number(searchParams.get("page")) || 1,
        pageSize: Number(searchParams.get("pageSize")) || 20,
        filter: searchParams.get("filter") ?? undefined,
        search: searchParams.get("search") ?? undefined,
      });
      return NextResponse.json(result);
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

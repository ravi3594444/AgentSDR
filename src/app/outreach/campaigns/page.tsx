import CampaignListClient from "@/components/outreach/CampaignListClient";
import { listCampaignsWithStats } from "@/lib/outreach/campaigns";
import { requirePageOrgContext } from "@/lib/auth/context";
import { runInOrganization } from "@/lib/tenancy/scope";

export const dynamic = "force-dynamic";

export const metadata = { title: "Email campaigns" };

export default async function OutreachCampaignsPage() {
  const ctx = await requirePageOrgContext();
  const campaigns = await runInOrganization(ctx.organizationId, () => listCampaignsWithStats());

  return (
    <div className="flex h-full overflow-hidden bg-bg-white-0">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <CampaignListClient campaigns={campaigns} />
      </div>
    </div>
  );
}

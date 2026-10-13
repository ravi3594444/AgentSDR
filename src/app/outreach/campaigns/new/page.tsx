import CampaignWizard from "@/components/outreach/wizard/CampaignWizard";
import { PageContainer } from "@/components/page/PageHeader";

export const metadata = { title: "New email campaign" };

export default function NewCampaignPage() {
  return (
    <PageContainer>
      <CampaignWizard />
    </PageContainer>
  );
}

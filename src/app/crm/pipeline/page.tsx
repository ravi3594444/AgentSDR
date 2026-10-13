import { CrmLayout } from "@/components/crm/CrmLayout";
import { CrmPipelineClient } from "@/components/crm/CrmPipelineClient";

export const metadata = { title: "Pipeline" };

export default function CrmPipelinePage() {
  return <CrmLayout><CrmPipelineClient /></CrmLayout>;
}

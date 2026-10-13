import { CrmLayout } from "@/components/crm/CrmLayout";
import { CrmActionsClient } from "@/components/crm/CrmActionsClient";

export const metadata = { title: "Action required" };

export default function CrmActionsPage() {
  return <CrmLayout><CrmActionsClient /></CrmLayout>;
}

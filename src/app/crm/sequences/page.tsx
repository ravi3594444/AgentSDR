import { CrmLayout } from "@/components/crm/CrmLayout";
import CrmSequencesClient from "@/components/crm/CrmSequencesClient";

export const metadata = { title: "Sequences" };

export default function CrmSequencesPage() {
  return <CrmLayout><CrmSequencesClient /></CrmLayout>;
}

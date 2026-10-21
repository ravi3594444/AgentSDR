import { CrmLayout } from "@/components/crm/CrmLayout";
import CrmRecordClient, { BOARD_BACK } from "@/components/crm/CrmRecordClient";

export default async function CrmRecordPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ from?: string | string[] }> }) {
  const [{ id }, { from }] = await Promise.all([params, searchParams]);
  return <CrmLayout><CrmRecordClient recordId={id} back={from === "board" ? BOARD_BACK : undefined} /></CrmLayout>;
}

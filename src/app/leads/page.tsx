import LeadsClient from "@/components/leads/LeadsClient";
import { PAGE_SIZE, type LeadsTab } from "@/components/leads/leadTypes";
import { CrmLayout } from "@/components/crm/CrmLayout";
import { CrmPipelineClient } from "@/components/crm/CrmPipelineClient";
import { requirePageOrgContext } from "@/lib/auth/context";
import { runInOrganization } from "@/lib/tenancy/scope";
import { listCompanies, listPeoplePage } from "@/lib/leads/records";

export const dynamic = "force-dynamic";
export const metadata = { title: "Leads" };

/** Leads: the list of people and companies, or (`?view=board`) every open lead by pipeline stage. */
export default async function LeadsPage({ searchParams }: { searchParams: Promise<{ tab?: string | string[]; view?: string | string[] }> }) {
  const ctx = await requirePageOrgContext();
  const { tab, view } = await searchParams;
  if (view === "board") return <CrmLayout><CrmPipelineClient /></CrmLayout>;
  const initialTab: LeadsTab = tab === "companies" ? "companies" : "people";
  const result = await runInOrganization(ctx.organizationId, () =>
    initialTab === "companies" ? listCompanies({ limit: PAGE_SIZE }) : listPeoplePage({ limit: PAGE_SIZE }),
  );
  return <LeadsClient initialTab={initialTab} initialRows={result.rows} initialTotal={result.total} />;
}

import type { Metadata } from "next";
import { PlatformAdminClient } from "@/components/platform/PlatformAdminClient";
import { PageContainer, PageHeader } from "@/components/page/PageHeader";
import { requirePageOperator } from "@/lib/auth/operatorAccess.server";
import { brandTitle } from "@/lib/brand";

export const metadata: Metadata = { title: { absolute: brandTitle("Platform") } };
export const dynamic = "force-dynamic";

/**
 * The operator panel: the platform's default provider keys (store, replace,
 * remove; masked), the Included AI engine and model, adopting an existing
 * organization's keys as defaults, and use by workspace. Platform operators
 * only (an explicit grant, scripts/grant-platform-operator.ts); everyone
 * else gets the 404 page, workspace owners and admins included.
 */
export default async function PlatformPage() {
  await requirePageOperator();
  return (
    <PageContainer>
      <PageHeader
        title="Platform"
        description="The default keys every workspace on the Included service runs on, and what each workspace used. Only platform operators see this page; workspace owners and admins do not."
      />
      <PlatformAdminClient />
    </PageContainer>
  );
}

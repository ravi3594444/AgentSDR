import type { Metadata } from "next";
import { ActivityClient } from "@/components/activity/ActivityClient";
import { PageContainer } from "@/components/page/PageHeader";
import { requirePageOrgContext } from "@/lib/auth/context";
import { brandTitle } from "@/lib/brand";

export const metadata: Metadata = { title: { absolute: brandTitle("Activity") } };
export const dynamic = "force-dynamic";

/**
 * The organization's background work and the replies it brought, across
 * every chat (src/lib/activity/). Looking here never starts or sends anything.
 */
export default async function ActivityPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  await requirePageOrgContext();
  const { view } = await searchParams;
  return (
    <PageContainer>
      <ActivityClient initialView={view === "replies" ? "replies" : "work"} />
    </PageContainer>
  );
}

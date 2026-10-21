import type { Metadata } from "next";
import { RequestsClient } from "@/components/assistant/RequestsClient";
import { PageContainer } from "@/components/page/PageHeader";
import { requirePageOrgContext } from "@/lib/auth/context";
import { brandTitle } from "@/lib/brand";

export const metadata: Metadata = { title: { absolute: brandTitle("Requests") } };
export const dynamic = "force-dynamic";

/**
 * Every request and its progress (src/lib/assistant/requests.server.ts),
 * from every chat, plus campaigns made by hand. It took over Activity's work
 * list; Activity's replies are the Inbox's All conversations.
 */
export default async function RequestsPage() {
  await requirePageOrgContext();
  return (
    <PageContainer>
      <RequestsClient />
    </PageContainer>
  );
}

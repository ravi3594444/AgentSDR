import Link from "next/link";
import { RiInstagramLine } from "@remixicon/react";
import * as Button from "@/components/alignui/button";
import { Frame, FramePanel } from "@/components/analytics/kit/Frame";
import { InstagramMessagesClient } from "@/components/instagram/InstagramMessagesClient";
import { EmptyState } from "@/components/page/EmptyState";
import { requirePageOrgContext } from "@/lib/auth/context";
import { featureEnabled } from "@/lib/features/flags.server";
import { runInOrganization } from "@/lib/tenancy/scope";

export const dynamic = "force-dynamic";

export const metadata = { title: "Messages" };

/** The Instagram inbox: read-only — replies are drafted and sent from Action required. */
export default async function InstagramMessagesPage({ searchParams }: { searchParams: Promise<{ chat?: string }> }) {
  const ctx = await requirePageOrgContext();
  const enabled = await runInOrganization(ctx.organizationId, () => featureEnabled("instagram"));
  if (!enabled) {
    return (
      <Frame className="mx-auto mt-10 max-w-2xl">
        <FramePanel>
          <EmptyState
            icon={RiInstagramLine}
            title="Instagram messages are off"
            description="An owner or admin can turn them on under Optional features in Settings → Providers & features."
            action={
              <Button.Root asChild variant="neutral" mode="stroke" size="small">
                <Link href="/settings/advanced">Settings → Providers & features</Link>
              </Button.Root>
            }
          />
        </FramePanel>
      </Frame>
    );
  }
  const { chat } = await searchParams;
  return <InstagramMessagesClient initialChatId={chat ?? null} />;
}

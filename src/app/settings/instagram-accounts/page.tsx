import Link from "next/link";
import { RiInstagramLine } from "@remixicon/react";
import * as Button from "@/components/alignui/button";
import { Frame, FramePanel } from "@/components/analytics/kit/Frame";
import { InstagramAccountsClient } from "@/components/instagram/InstagramAccountsClient";
import { EmptyState } from "@/components/page/EmptyState";
import { PlatformConnectPrompt, RequiresPlatform } from "@/components/settings/RequiresPlatform";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { requirePageOrgContext } from "@/lib/auth/context";
import { featureState } from "@/lib/features/flags.server";
import { runInOrganization } from "@/lib/tenancy/scope";

export const dynamic = "force-dynamic";

export const metadata = { title: "Instagram accounts" };

const DESCRIPTION = "The Instagram accounts whose direct messages you read and answer here, linked through Unipile.";

/**
 * Settings → Instagram → Accounts. Only reachable from the rail while the
 * organization's Instagram feature is on; opened directly with it off, it
 * says so and points to where it is turned on.
 */
export default async function InstagramAccountsPage() {
  const ctx = await requirePageOrgContext();
  const features = await runInOrganization(ctx.organizationId, () => featureState());

  if (!features.instagram) {
    return (
      <SettingsPage title="Instagram accounts" description={DESCRIPTION}>
        <Frame className="mx-auto max-w-2xl">
          <FramePanel>
            <EmptyState
              icon={RiInstagramLine}
              title="Instagram messages are off"
              description="An owner or admin can turn them on under Optional features. Nothing is read from Instagram until then."
              action={
                <Button.Root asChild variant="neutral" mode="stroke" size="small">
                  <Link href="/settings/advanced">Settings → Providers & features</Link>
                </Button.Root>
              }
            />
          </FramePanel>
        </Frame>
      </SettingsPage>
    );
  }

  return (
    <RequiresPlatform
      platform="unipile"
      fallback={
        <SettingsPage title="Instagram accounts" description={DESCRIPTION}>
          {/* The gate's prompt, under the page header the client component would have supplied. */}
          <PlatformConnectPrompt platform="unipile" description="Instagram accounts are linked through Unipile, the same connection LinkedIn and WhatsApp use. Connect it once and this unlocks." />
        </SettingsPage>
      }
    >
      <InstagramAccountsClient inquiryIntakeOn={features.inquiry_intake} />
    </RequiresPlatform>
  );
}

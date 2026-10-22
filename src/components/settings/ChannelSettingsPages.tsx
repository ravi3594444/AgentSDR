import type { ReactNode } from "react";
import { ServiceModeNotice } from "@/components/settings/ServiceModeNotice";
import { ComingSoonCard, PlatformConnection, type ComingSoonConnection } from "@/components/settings/PlatformConnection";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { requirePageOrgContext } from "@/lib/auth/context";
import type { PlatformKey } from "@/lib/platform/catalog";
import { listPlatformStatus } from "@/lib/platform/credentials";
import { runInOrganization } from "@/lib/tenancy/scope";

/**
 * The page every channel section in Settings has besides its accounts list:
 * Connection, the platform integrations it runs on, one card each. Each
 * route under /settings is a one-line use of it, plus its @modal/(.)settings
 * twin. Channels have no sending-rules page: their pacing is automatic, and
 * the one sending setting is the daily lead limit (/settings/sending).
 */

export async function ConnectionSettingsPage({
  platforms,
  comingSoon = [],
  title,
  description,
  children,
}: {
  platforms: { platform: PlatformKey; note?: string }[];
  /** Connections planned for this channel, shown after the real ones. */
  comingSoon?: ComingSoonConnection[];
  title: string;
  description: string;
  /** Anything else the channel runs on, after its integrations. */
  children?: ReactNode;
}) {
  const ctx = await requirePageOrgContext();
  const statuses = await runInOrganization(ctx.organizationId, () => listPlatformStatus());
  return (
    <SettingsPage title={title} description={description} width="narrow">
      <div className="flex flex-col gap-6">
        {platforms.some(({ platform }) => platform === "unipile") && <ServiceModeNotice service="unipile" />}
        {platforms.map(({ platform, note }) => (
          <PlatformConnection key={platform} platformKey={platform} status={statuses.find((s) => s.key === platform) ?? null} note={note} />
        ))}
        {comingSoon.map((connection) => (
          <ComingSoonCard key={connection.name} connection={connection} />
        ))}
        {children}
      </div>
    </SettingsPage>
  );
}

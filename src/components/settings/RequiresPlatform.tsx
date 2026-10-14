import Link from "next/link";
import type { ReactNode } from "react";
import { RiPlugLine } from "@remixicon/react";

import * as Button from "@/components/alignui/button";
import { Frame, FramePanel } from "@/components/analytics/kit/Frame";
import { DocsLink } from "@/components/page/DocsLink";
import { EmptyState } from "@/components/page/EmptyState";
import { getPlatformIntegration, PLATFORM_SETTINGS_HREF, type PlatformKey } from "@/lib/platform/catalog";
import { requirePageOrgContext } from "@/lib/auth/context";
import { isPlatformConnected } from "@/lib/platform/credentials";
import { runInOrganization } from "@/lib/tenancy/scope";

/**
 * Renders `children` while the platform integration is connected (any one of
 * them, when given several), otherwise a "Connect X" prompt linking to the
 * integration's Connection page in Settings (`settingsHref` overrides it,
 * e.g. WhatsApp's for Unipile) and to our guide for it (`guideHref`
 * overrides the catalog's, where the channel matters). Reads the database,
 * so the page using it must be dynamic. Resolves the page's organization
 * itself, so callers need no scope.
 */
export async function RequiresPlatform({
  platform,
  children,
  fallback,
  settingsHref,
  guideHref,
  description,
  className,
}: {
  /** Several: the children need any one of them (e.g. email sends through Google Workspace or Unipile). */
  platform: PlatformKey | PlatformKey[];
  /** Where every Connect button leads, when not each integration's own page. */
  settingsHref?: string;
  guideHref?: string;
  /** Replaces the prompt's description, e.g. to explain a choice between several. */
  description?: string;
  children: ReactNode;
  /** Replaces the Connect prompt — `null` to render nothing (e.g. for a header action). */
  fallback?: ReactNode;
  /** Wraps the Connect prompt only, e.g. in the page padding a layout leaves to its pages. */
  className?: string;
}) {
  const ctx = await requirePageOrgContext();
  const platforms = Array.isArray(platform) ? platform : [platform];
  const connected = await runInOrganization(ctx.organizationId, async () =>
    (await Promise.all(platforms.map((key) => isPlatformConnected(key)))).some(Boolean));
  if (connected) return <>{children}</>;
  if (fallback !== undefined) return <>{fallback}</>;
  const prompt = <PlatformConnectPrompt platform={platform} settingsHref={settingsHref} guideHref={guideHref} description={description} />;
  return className ? <div className={className}>{prompt}</div> : prompt;
}

/** The "Connect X to use this" card on its own, with Connect and "How to connect". No database access. */
export function PlatformConnectPrompt({
  platform,
  settingsHref,
  guideHref,
  description,
}: {
  platform: PlatformKey | PlatformKey[];
  settingsHref?: string;
  guideHref?: string;
  description?: string;
}) {
  const keys = Array.isArray(platform) ? platform : [platform];
  const integrations = keys.map((key) => ({ key, integration: getPlatformIntegration(key) }));
  const names = integrations.map(({ integration }) => integration?.name ?? "this integration");
  const first = integrations[0]?.integration ?? null;
  const guide = guideHref ?? first?.guideUrl;
  const defaultDescription = keys.length === 1
    ? first
      ? `${first.name} powers ${first.enables.join(" and ").toLowerCase()}. Add its credentials once and this unlocks.`
      : undefined
    : `Connect any one of them and this unlocks.`;

  return (
    <Frame className="mx-auto max-w-2xl">
      <FramePanel>
        <EmptyState
          icon={RiPlugLine}
          title={`Connect ${names.join(" or ")} to use this`}
          description={description ?? defaultDescription}
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              {integrations.map(({ key, integration }, index) => (
                <Button.Root key={key} asChild variant={index === 0 ? "primary" : "neutral"} mode={index === 0 ? "filled" : "stroke"} size="small">
                  <Link href={settingsHref ?? PLATFORM_SETTINGS_HREF[key]}>Connect {integration?.name ?? "this integration"}</Link>
                </Button.Root>
              ))}
              {guide && <DocsLink href={guide} />}
            </div>
          }
        />
      </FramePanel>
    </Frame>
  );
}

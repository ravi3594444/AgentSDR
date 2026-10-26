import type { Metadata } from "next";
import Link from "next/link";
import { RiArrowRightSLine } from "@remixicon/react";
import * as Badge from "@/components/alignui/badge";
import * as Button from "@/components/alignui/button";
import { Frame, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { PageContainer, PageHeader } from "@/components/page/PageHeader";
import { requirePageOrgContext } from "@/lib/auth/context";
import { BRAND, brandTitle } from "@/lib/brand";
import { READINESS_COLOR, READINESS_LABEL, type ReadinessItem, type ReadinessKey } from "@/lib/onboarding/readiness";
import { loadReadiness } from "@/lib/onboarding/readiness.server";
import { runInOrganization } from "@/lib/tenancy/scope";

export const metadata: Metadata = { title: { absolute: brandTitle("Getting started") } };

// Reads this organization's saved state on every visit.
export const dynamic = "force-dynamic";

/**
 * Getting Started: one checklist over the settings and pages that already
 * exist. Every status comes from saved state (src/lib/onboarding/), so it
 * cannot be ticked off by hand, and no link leads anywhere new.
 */
export default async function GettingStartedPage() {
  const ctx = await requirePageOrgContext();
  const items = await runInOrganization(ctx.organizationId, () => loadReadiness(ctx));
  const byKey = new Map(items.map((item) => [item.key, item]));
  const pick = (...keys: ReadinessKey[]) => keys.map((key) => byKey.get(key)).filter((item): item is ReadinessItem => Boolean(item));
  const channels = pick("email", "linkedin", "whatsapp", "instagram");
  const connectedChannels = channels.filter((item) => (item.connectedSenders ?? 0) > 0).length;
  const checks = pick("leads", "campaigns", "replySync", "replies");
  const attention = checks.filter((item) => item.status === "needs_attention").length;

  return (
    <PageContainer>
      <PageHeader
        title="Getting started"
        description={`Add your business details, connect a sending account, then tell ${BRAND.name} who you want to reach.`}
        badge={
          <Badge.Root variant="lighter" size="medium" color={connectedChannels ? "green" : "gray"}>
            {connectedChannels ? `${connectedChannels} ${connectedChannels === 1 ? "channel" : "channels"} connected` : "Connect your first account"}
          </Badge.Root>
        }
        actions={<Button.Root variant="primary" mode="filled" size="small" asChild><Link href="/assistant">Open Outreach<RiArrowRightSLine className="size-4" aria-hidden="true" /></Link></Button.Root>}
      />
      <p className="mt-3 text-paragraph-sm text-text-sub-600">You only need one sending account to start. <Link href="/settings/sending" className="text-primary-base hover:underline">Set your daily lead limit</Link>, then choose Review or Automatic replies on your plan.</p>
      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-12 lg:gap-5">
        <Section className="lg:col-span-12" title="1. Your business & workspace" items={pick("workspace")} />
        <Section
          className="lg:col-span-12"
          title="2. Connect a sending account"
          description="Choose the channels your customers use. You can add more later."
          items={channels}
        />
        <Section className="lg:col-span-12" title="3. Check your reply assistant" description="AI sorts replies and writes answers; replies follow each plan's Review or Automatic mode." items={pick("ai")} />
        <details open={attention > 0} className="rounded-xl border border-stroke-soft-200 bg-bg-white-0 lg:col-span-12">
          <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-4 text-label-sm text-text-strong-950 sm:px-5">Sending & reply checks<span className="text-paragraph-xs text-text-sub-600">{attention ? `${attention} need attention` : "View checks"}</span></summary>
          <Section title="Outreach checks" items={checks} className="rounded-none border-0 border-t shadow-none" />
        </details>
      </div>
      <p className="mt-4 max-w-3xl text-paragraph-xs text-text-sub-600">
        Confirm sending and replies with a recipient you control. A connected account alone does not confirm delivery.
      </p>
    </PageContainer>
  );
}

function Section({ title, description, items, className }: { title: string; description?: string; items: ReadinessItem[]; className?: string }) {
  return (
    <Frame className={className}>
      <FrameHeader title={title} description={description} />
      <FramePanel className="p-0 sm:p-0">
        <ul className="divide-y divide-stroke-soft-200">
          {items.map((item) => (
            <li key={item.key} className="px-4 py-4 sm:px-5">
              <Step item={item} />
            </li>
          ))}
        </ul>
      </FramePanel>
    </Frame>
  );
}

function Step({ item }: { item: ReadinessItem }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-label-md text-text-strong-950">{item.title}</h3>
          <Badge.Root variant="lighter" size="medium" color={READINESS_COLOR[item.status]} className="whitespace-nowrap">
            <Badge.Dot />
            {READINESS_LABEL[item.status]}
          </Badge.Root>
        </div>
        {item.connectedSenders !== undefined && item.connectedSenders > 0 && item.status !== "connected" && <p className="mt-1 text-paragraph-sm text-text-strong-950">{item.connectedSenders} connected {item.connectedSenders === 1 ? "account" : "accounts"}; check the setup note below.</p>}
        <p className="mt-1 text-paragraph-sm text-text-strong-950">{item.summary}</p>
        {item.details.length > 0 && (
          <details className="mt-2 text-paragraph-xs text-text-sub-600"><summary className="cursor-pointer rounded outline-none focus-visible:ring-2 focus-visible:ring-primary-base">Details</summary><ul className="mt-1.5 space-y-0.5">
            {item.details.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul></details>
        )}
        {item.next && (
          <p className="mt-2 flex items-start gap-1 text-paragraph-sm text-text-sub-600">
            <RiArrowRightSLine className="mt-0.5 size-4 shrink-0 text-primary-base" aria-hidden="true" />
            <span>
              <span className="sr-only">Next step: </span>
              {item.next}
            </span>
          </p>
        )}
      </div>
      <nav aria-label={`${item.title} pages`} className="flex shrink-0 flex-wrap gap-x-4 gap-y-1 sm:max-w-[16rem] sm:flex-col sm:items-end">
        {item.links.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="inline-flex items-center gap-0.5 rounded text-label-sm text-primary-base outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary-base"
          >
            {link.label}
            <RiArrowRightSLine className="size-4" aria-hidden="true" />
          </Link>
        ))}
      </nav>
    </div>
  );
}

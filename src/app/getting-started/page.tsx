import type { Metadata } from "next";
import Link from "next/link";
import { RiArrowRightSLine } from "@remixicon/react";
import * as Badge from "@/components/alignui/badge";
import { Frame, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { PageContainer, PageHeader } from "@/components/page/PageHeader";
import { requirePageOrgContext } from "@/lib/auth/context";
import { BRAND, brandTitle } from "@/lib/brand";
import { READINESS_COLOR, READINESS_LABEL, isReady, type ReadinessItem, type ReadinessKey } from "@/lib/onboarding/readiness";
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
  const channels = pick("email", "linkedin", "whatsapp");
  const connectedChannels = channels.filter((item) => item.status === "connected").length;
  const ready = items.filter((item) => isReady(item.status)).length;

  return (
    <PageContainer>
      <PageHeader
        title="Getting started"
        description={`Set up ${BRAND.name} one step at a time. Each status is read from what this workspace has saved; it updates when you come back.`}
        badge={
          <Badge.Root variant="lighter" size="medium" color={ready === items.length ? "green" : "gray"}>
            {ready} of {items.length} ready
          </Badge.Root>
        }
      />
      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-12 lg:gap-5">
        <Section className="lg:col-span-12" title="Workspace" items={pick("workspace")} />
        <Section
          className="lg:col-span-12"
          title="Channels"
          description={`Connect at least one channel to send. ${connectedChannels} of ${channels.length} connected.`}
          items={channels}
        />
        <Section className="lg:col-span-12" title="AI" description="Optional for sending; it sorts replies and drafts answers for your review." items={pick("ai")} />
        <Section className="lg:col-span-12" title="Outreach" items={pick("leads", "campaigns", "replySync", "replies")} />
      </div>
      <p className="mt-4 max-w-3xl text-paragraph-xs text-text-sub-600">
        Connected means the saved credentials passed a live check when they were saved and an account is linked. It does not prove
        that a message was delivered or a reply received. Incoming replies is that proof: it turns done only once a real reply has
        arrived in this workspace on each connected channel.
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
        <p className="mt-1 text-paragraph-sm text-text-strong-950">{item.summary}</p>
        {item.details.length > 0 && (
          <ul className="mt-1.5 space-y-0.5 text-paragraph-xs text-text-sub-600">
            {item.details.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
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

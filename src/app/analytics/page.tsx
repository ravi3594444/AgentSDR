import AnalyticsClient from "@/components/analytics/AnalyticsClient";
import { parseView } from "@/components/analytics/range";
import { requirePageOrgContext } from "@/lib/auth/context";
import { organizationTimeZone } from "@/lib/reporting/metrics.server";
import { runInOrganization } from "@/lib/tenancy/scope";
import { resolveTimeZone } from "@/lib/timeZone";

export const dynamic = "force-dynamic";
export const metadata = { title: "Analytics" };

type Search = Promise<{ view?: string | string[]; range?: string | string[]; tz?: string | string[] }>;

/**
 * Analytics reports in the organization's business time zone, as Overview
 * does; an explicit ?tz= overrides it for this view and is labelled.
 */
export default async function AnalyticsPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  const view = parseView(first(params.view));
  const range = first(params.range);
  const override = first(params.tz);
  const ctx = await requirePageOrgContext();
  const timeZone = await runInOrganization(ctx.organizationId, organizationTimeZone);
  return (
    <div className="mx-auto w-full max-w-[1440px] px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      <AnalyticsClient
        initialView={view}
        initialRange={range ?? "30d"}
        organizationTimeZone={timeZone}
        timeZoneOverride={override ? resolveTimeZone(override) : null}
      />
    </div>
  );
}

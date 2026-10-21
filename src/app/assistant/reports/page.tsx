import type { Metadata } from "next";
import ReportsClient from "@/components/assistant/ReportsClient";
import type { ResultsPayload } from "@/components/assistant/ResultsClient";
import { parseView } from "@/components/analytics/range";
import { requirePageOrgContext } from "@/lib/auth/context";
import { listDailySummaries } from "@/lib/assistant/dailySummary.server";
import { listOpenDecisions } from "@/lib/assistant/decisions.server";
import { results } from "@/lib/assistant/results.server";
import type { PeriodKind } from "@/lib/assistant/results";
import { brandTitle } from "@/lib/brand";
import { organizationTimeZone } from "@/lib/reporting/metrics.server";
import { runInOrganization } from "@/lib/tenancy/scope";
import { resolveTimeZone } from "@/lib/timeZone";

export const metadata: Metadata = { title: { absolute: brandTitle("Reports") } };
export const dynamic = "force-dynamic";

type Search = Promise<{ view?: string | string[]; range?: string | string[]; tz?: string | string[] }>;

/** The period a By channel preset covers, for the summary numbers; anything else opens on the last 7 days. */
const PERIOD_OF: Record<string, PeriodKind> = { today: "today", yesterday: "yesterday", "7d": "last_7_days", "30d": "last_30_days" };

/**
 * Reports (src/components/assistant/ReportsClient.tsx): Overview's numbers,
 * then Analytics' channel views, in the business time zone. ?view, ?range
 * and ?tz are Analytics' own, so its old links open the same thing here.
 */
export default async function ReportsPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  const view = first(params.view);
  const range = first(params.range);
  const override = first(params.tz);
  const ctx = await requirePageOrgContext();
  const payload = await runInOrganization(ctx.organizationId, async () => {
    const [data, decisions, summaries, timeZone] = await Promise.all([results(PERIOD_OF[range ?? ""] ?? "last_7_days"), listOpenDecisions(50), listDailySummaries(14), organizationTimeZone()]);
    return { results: data, decisions, summaries, timeZone };
  });
  return (
    <ReportsClient
      initial={JSON.parse(JSON.stringify({ results: payload.results, decisions: payload.decisions, summaries: payload.summaries })) as ResultsPayload}
      analytics={{ view: parseView(view), range: range ?? "30d", organizationTimeZone: payload.timeZone, timeZoneOverride: override ? resolveTimeZone(override) : null, open: Boolean(view || range || override) }}
    />
  );
}

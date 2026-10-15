import type { NextRequest } from "next/server";
import { listDailySummaries } from "@/lib/assistant/dailySummary.server";
import { listOpenDecisions } from "@/lib/assistant/decisions.server";
import { assistantRoute } from "@/lib/assistant/http.server";
import { PERIOD_KINDS, type PeriodKind } from "@/lib/assistant/results";
import { results } from "@/lib/assistant/results.server";

export const dynamic = "force-dynamic";

// GET /api/assistant/results?period=today|yesterday|last_7_days|last_30_days|all_time
export async function GET(request: NextRequest) {
  return assistantRoute(request, { mutation: false }, async () => {
    const requested = request.nextUrl.searchParams.get("period") ?? "last_7_days";
    const period = (PERIOD_KINDS as readonly string[]).includes(requested) ? requested as PeriodKind : "last_7_days";
    const [data, decisions, summaries] = await Promise.all([results(period), listOpenDecisions(50), listDailySummaries(14)]);
    return Response.json({ results: data, decisions, summaries });
  });
}

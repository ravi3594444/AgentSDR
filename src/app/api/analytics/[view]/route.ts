import type { NextRequest } from "next/server";
import { authContextErrorResponse, withOrgContext } from "@/lib/auth/context";
import { ANALYTICS_VIEWS, type AnalyticsRange, type AnalyticsResponse, type AnalyticsView } from "@/lib/analytics/contract";
import { getEmailAnalytics } from "@/lib/analytics/email.server";
import { getLinkedinAnalytics } from "@/lib/analytics/linkedin.server";
import { getOverviewAnalytics } from "@/lib/analytics/overview.server";
import { AnalyticsRangeError, parseAnalyticsRange } from "@/lib/analytics/server";
import { getWhatsappAnalytics } from "@/lib/analytics/whatsapp.server";

export const dynamic = "force-dynamic";

const LOADERS: Record<AnalyticsView, (range: AnalyticsRange) => Promise<AnalyticsResponse>> = {
  overview: getOverviewAnalytics,
  email: getEmailAnalytics,
  linkedin: getLinkedinAnalytics,
  whatsapp: getWhatsappAnalytics,
};

/**
 * GET /api/analytics/{overview|email|linkedin|whatsapp}?range=7d (a preset, or YYYY-MM-DD..YYYY-MM-DD)
 * or ?from=YYYY-MM-DD&to=YYYY-MM-DD; &tz=Area/City overrides the organization's business time zone.
 * Behind the site auth like every other /api route (src/proxy.ts). Read-only.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ view: string }> }) {
  const { view } = await context.params;
  if (!(ANALYTICS_VIEWS as readonly string[]).includes(view)) {
    return Response.json({ error: `Unknown analytics view: ${view}` }, { status: 404 });
  }
  try {
    return await withOrgContext(request, async () => {
      const range = await parseAnalyticsRange(request.nextUrl.searchParams);
      return Response.json(await LOADERS[view as AnalyticsView](range));
    });
  } catch (error) {
    const denied = authContextErrorResponse(error);
    if (denied) return denied;
    if (error instanceof AnalyticsRangeError) return Response.json({ error: error.message }, { status: 400 });
    console.error(`[analytics:${view}]`, error);
    return Response.json({ error: "Could not load analytics" }, { status: 500 });
  }
}

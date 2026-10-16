import { authContextErrorResponse, withOrgContext } from "@/lib/auth/context";
import type { NavData } from "@/components/nav/navConfig";
import { featureState } from "@/lib/features/flags.server";
import { loadNavBadges } from "@/lib/nav/badges.server";

export const dynamic = "force-dynamic";

/**
 * GET /api/nav/badges — the sidebar's live counts (src/lib/nav/badges.server.ts)
 * and the organization's optional features, which decide whether entries
 * tied to one (Instagram) show at all.
 */
export async function GET(request: Request) {
  try {
    return await withOrgContext(request, async () => {
      const [badges, features] = await Promise.all([loadNavBadges(), featureState()]);
      return Response.json({ ...badges, features } satisfies NavData, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) {
    const denied = authContextErrorResponse(error);
    if (denied) return denied;
    console.error("[nav:badges]", error);
    return Response.json({ error: "Could not load counts" }, { status: 500 });
  }
}

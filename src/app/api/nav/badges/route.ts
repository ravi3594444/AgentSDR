import { authContextErrorResponse, withOrgContext } from "@/lib/auth/context";
import { loadNavBadges } from "@/lib/nav/badges.server";

export const dynamic = "force-dynamic";

/** GET /api/nav/badges — the sidebar's live counts (src/lib/nav/badges.server.ts). */
export async function GET(request: Request) {
  try {
    return await withOrgContext(request, async () => Response.json(await loadNavBadges(), { headers: { "Cache-Control": "no-store" } }));
  } catch (error) {
    const denied = authContextErrorResponse(error);
    if (denied) return denied;
    console.error("[nav:badges]", error);
    return Response.json({ error: "Could not load counts" }, { status: 500 });
  }
}

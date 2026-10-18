import type { NextRequest } from "next/server";
import { markRepliesSeen } from "@/lib/activity/activity.server";
import { assistantRoute } from "@/lib/assistant/http.server";

export const dynamic = "force-dynamic";

// POST /api/activity/seen — { until }: the person looked at the replies list,
// which showed replies recorded up to `until` (the newest it showed; now when
// absent): those are no longer new to them (the navigation badge). The seen
// time is held to now and never moves back. Nothing else changes.
export async function POST(request: NextRequest) {
  return assistantRoute(request, { mutation: false }, async (ctx) => {
    if (!ctx.userId) return Response.json({ error: "Sign in to keep track of new replies." }, { status: 400 });
    const body = (await request.json().catch(() => null)) as { until?: unknown } | null;
    let until: Date | undefined;
    if (body?.until !== undefined) {
      if (typeof body.until !== "string" || Number.isNaN(Date.parse(body.until))) return Response.json({ error: "Send { until: \"<ISO time>\" }." }, { status: 400 });
      until = new Date(body.until);
    }
    await markRepliesSeen(ctx.userId, until);
    return Response.json({ ok: true });
  });
}

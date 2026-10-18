import type { NextRequest } from "next/server";
import { markRepliesSeen } from "@/lib/activity/activity.server";
import { assistantRoute } from "@/lib/assistant/http.server";

export const dynamic = "force-dynamic";

// POST /api/activity/seen — the person looked at the replies list: what has
// arrived is no longer new to them (the navigation badge). Nothing else changes.
export async function POST(request: NextRequest) {
  return assistantRoute(request, { mutation: false }, async (ctx) => {
    if (!ctx.userId) return Response.json({ error: "Sign in to keep track of new replies." }, { status: 400 });
    await markRepliesSeen(ctx.userId);
    return Response.json({ ok: true });
  });
}

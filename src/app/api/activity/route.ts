import type { NextRequest } from "next/server";
import { listReplies, listWork } from "@/lib/activity/activity.server";
import { assistantRoute } from "@/lib/assistant/http.server";

export const dynamic = "force-dynamic";

const CHANNELS = new Set(["email", "whatsapp", "linkedin", "instagram"]);

// GET /api/activity?view=work|replies&channel= — the organization's
// background work and incoming replies across every chat (src/lib/activity/).
// Reading starts, approves and sends nothing.
export async function GET(request: NextRequest) {
  return assistantRoute(request, { mutation: false }, async (ctx) => {
    const params = new URL(request.url).searchParams;
    if (params.get("view") === "replies") {
      const channel = params.get("channel");
      return Response.json(await listReplies({ userId: ctx.userId, channel: channel && CHANNELS.has(channel) ? channel : null }), { headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({ work: await listWork() }, { headers: { "Cache-Control": "no-store" } });
  });
}

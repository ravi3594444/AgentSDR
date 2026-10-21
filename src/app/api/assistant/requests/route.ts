import type { NextRequest } from "next/server";
import { assistantRoute } from "@/lib/assistant/http.server";
import { listRequests } from "@/lib/assistant/requests.server";

export const dynamic = "force-dynamic";

const CHANNELS = new Set(["email", "whatsapp", "linkedin", "instagram"]);

// GET /api/assistant/requests?channel=&state=open|done — every piece of
// outreach work by what started it, open first, plus campaigns made by hand
// that no run owns (src/lib/assistant/requests.server.ts). Reading only.
export async function GET(request: NextRequest) {
  return assistantRoute(request, { mutation: false }, async () => {
    const params = request.nextUrl.searchParams;
    const channel = params.get("channel");
    const state = params.get("state");
    return Response.json(await listRequests({
      channel: channel && CHANNELS.has(channel) ? channel : null,
      state: state === "open" || state === "done" ? state : null,
    }));
  });
}

import type { NextRequest } from "next/server";
import { listNeedsYou } from "@/lib/assistant/handoff.server";
import { assistantRoute } from "@/lib/assistant/http.server";
import { organizationTimeZone } from "@/lib/reporting/metrics.server";

export const dynamic = "force-dynamic";

// GET /api/assistant/needs-you — leads waiting for a person, most urgent first
// (src/lib/assistant/handoff.server.ts), after settling the ones a person
// already answered in the chat, with the organization's time zone the cards
// write their times in.
export async function GET(request: NextRequest) {
  return assistantRoute(request, { mutation: false }, async () => {
    const [needsYou, timeZone] = await Promise.all([listNeedsYou(), organizationTimeZone()]);
    return Response.json({ ...needsYou, timeZone });
  });
}

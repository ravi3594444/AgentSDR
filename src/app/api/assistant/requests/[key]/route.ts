import type { NextRequest } from "next/server";
import { assistantRoute } from "@/lib/assistant/http.server";
import { requestSummary } from "@/lib/assistant/requests.server";

export const dynamic = "force-dynamic";

// GET /api/assistant/requests/[key] — one request's figures, blocker, next
// step and children (src/lib/assistant/requests.ts for the keys). Another
// organization's key, or one that is not a key, is a 404.
export async function GET(request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return assistantRoute(request, { mutation: false }, async () => {
    const summary = await requestSummary(decodeURIComponent(key));
    return summary ? Response.json(summary) : Response.json({ error: "That request does not exist." }, { status: 404 });
  });
}

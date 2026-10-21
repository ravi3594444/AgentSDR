import type { NextRequest } from "next/server";
import { assistantRoute } from "@/lib/assistant/http.server";
import { threadRequests } from "@/lib/assistant/requests.server";

export const dynamic = "force-dynamic";

// GET /api/assistant/threads/[id]/requests — the requests this chat started,
// newest first, for the panel beside it. Another organization's chat lists nothing.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return assistantRoute(request, { mutation: false }, async () => {
    const valid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    return Response.json({ requests: valid ? await threadRequests(id) : [] });
  });
}

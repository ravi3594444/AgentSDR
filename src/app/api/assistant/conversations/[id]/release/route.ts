import type { NextRequest } from "next/server";
import { DecisionError, releaseConversation } from "@/lib/assistant/decisions.server";
import { assistantRoute } from "@/lib/assistant/http.server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/assistant/conversations/[id]/release — "Let the assistant reply":
// removes the owner's takeover of this conversation and answers the latest
// unanswered message now (src/lib/assistant/decisions.server.ts).
export async function POST(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  return assistantRoute(request, { mutation: true }, async () => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: "That conversation does not exist." }, { status: 404 });
    try {
      return Response.json({ ok: true, ...(await releaseConversation(id)) });
    } catch (error) {
      if (error instanceof DecisionError) return Response.json({ error: error.message }, { status: 404 });
      throw error;
    }
  });
}

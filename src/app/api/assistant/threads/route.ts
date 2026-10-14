import type { NextRequest } from "next/server";
import { assistantRoute } from "@/lib/assistant/http.server";
import { createThread } from "@/lib/assistant/threads.server";

export const dynamic = "force-dynamic";

// POST /api/assistant/threads — a new, empty conversation. The business
// profile, lead lists and runs belong to the organization, not the thread,
// so a new conversation still knows them.
export async function POST(request: NextRequest) {
  return assistantRoute(request, { mutation: true }, async (ctx) => {
    const thread = await createThread(ctx.userId);
    return Response.json({ threadId: thread.id }, { status: 201 });
  });
}

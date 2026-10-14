import type { NextRequest } from "next/server";
import { assistantRoute, assistantState } from "@/lib/assistant/http.server";

export const dynamic = "force-dynamic";

// GET /api/assistant?threadId=…&setup=1 — the chat thread (the latest when
// none is named), its background jobs and plans, and with setup=1 what is
// connected. The page polls this while the assistant or a job is working.
export async function GET(request: NextRequest) {
  return assistantRoute(request, { mutation: false }, async (ctx) => {
    const threadId = request.nextUrl.searchParams.get("threadId");
    const withSetup = request.nextUrl.searchParams.get("setup") === "1";
    return Response.json(await assistantState(threadId && /^[0-9a-f-]{36}$/i.test(threadId) ? threadId : null, ctx, withSetup));
  });
}

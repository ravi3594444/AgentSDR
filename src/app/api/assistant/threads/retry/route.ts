import type { NextRequest } from "next/server";
import { AssistantBusyError, runAgentTurn } from "@/lib/assistant/agent.server";
import { assistantRoute, assistantState } from "@/lib/assistant/http.server";
import { getThread, threadBusy } from "@/lib/assistant/threads.server";

export const dynamic = "force-dynamic";

// POST /api/assistant/threads/retry — { threadId }: the Retry button under a
// turn the AI model could not finish. It takes the turn again for the owner's
// latest request, with no new message: what is already done stays in the
// conversation as TOOL results, so it is neither repeated nor lost.
export async function POST(request: NextRequest) {
  return assistantRoute(request, { mutation: true }, async (ctx) => {
    const body = (await request.json().catch(() => null)) as { threadId?: unknown } | null;
    const threadId = typeof body?.threadId === "string" && /^[0-9a-f-]{36}$/i.test(body.threadId) ? body.threadId : null;
    if (!threadId) return Response.json({ error: "Send the threadId to retry." }, { status: 400 });
    if (!(await getThread(threadId))) return Response.json({ error: "That conversation does not exist." }, { status: 404 });
    if (await threadBusy(threadId)) return Response.json({ error: new AssistantBusyError().message }, { status: 409 });
    try {
      await runAgentTurn({ threadId, userId: ctx.userId, text: null });
    } catch (error) {
      if (error instanceof AssistantBusyError) return Response.json({ error: error.message }, { status: 409 });
      throw error;
    }
    return Response.json(await assistantState(threadId, ctx, false));
  });
}

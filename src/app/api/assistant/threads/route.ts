import type { NextRequest } from "next/server";
import { assistantRoute, assistantState, canManageAutopilot } from "@/lib/assistant/http.server";
import { autonomyCaps, setThreadAutonomous } from "@/lib/assistant/autonomy.server";
import { addMessage, createThread } from "@/lib/assistant/threads.server";

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

// PATCH /api/assistant/threads — { threadId, autonomous }: Autonomous mode
// for one conversation (src/lib/assistant/autonomy.ts). Turning it on lets
// plans start without the Start button in Automatic mode, so it needs an
// owner or admin, the same as choosing Automatic on a plan; anyone may turn
// it off.
export async function PATCH(request: NextRequest) {
  return assistantRoute(request, { mutation: true }, async (ctx) => {
    const body = (await request.json().catch(() => null)) as { threadId?: unknown; autonomous?: unknown } | null;
    const threadId = typeof body?.threadId === "string" && /^[0-9a-f-]{36}$/i.test(body.threadId) ? body.threadId : null;
    if (!threadId || typeof body?.autonomous !== "boolean") return Response.json({ error: "Send threadId and autonomous (true or false)." }, { status: 400 });
    if (body.autonomous && !canManageAutopilot(ctx)) {
      return Response.json({ error: "Only an owner or admin can turn on Autonomous mode: it starts outreach and answers replies without asking." }, { status: 403 });
    }
    if (!(await setThreadAutonomous(threadId, body.autonomous, ctx.userId))) return Response.json({ error: "That conversation does not exist." }, { status: 404 });
    const who = ctx.userName?.trim() || "Someone";
    if (body.autonomous) {
      const caps = await autonomyCaps();
      await addMessage({ threadId, role: "event", content: `${who} turned on Autonomous mode: the assistant works without asking, and plans it prepares start on their own in Automatic mode, up to ${caps.runsPerDay} plans, ${caps.leadsPerDay} leads and ${caps.searchesPerDay} searches a day (Settings → Sending defaults). Turn it off at any time.` });
    } else {
      await addMessage({ threadId, role: "event", content: `${who} turned off Autonomous mode: plans wait for your Start again.` });
    }
    return Response.json(await assistantState(threadId, ctx, false));
  });
}

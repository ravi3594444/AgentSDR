import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { assistantRoute, canManageAutopilot } from "@/lib/assistant/http.server";
import { getRun, OutreachError, setRunPaused, startOutreachRun } from "@/lib/assistant/outreach.server";
import { outreachRuns } from "@/lib/assistant/schema";
import { addMessage } from "@/lib/assistant/threads.server";
import { inOrg } from "@/lib/tenancy/scope";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/assistant/runs/[id] — { action: "start" | "pause" | "resume" | "cancel", autopilot? }
// "start" is the owner's approval of a proposed plan: the only way outreach
// starts. Turning the reply autopilot on with it needs an owner or admin.
export async function POST(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  return assistantRoute(request, { mutation: true }, async (ctx) => {
    const body = (await request.json().catch(() => ({}))) as { action?: unknown; autopilot?: unknown };
    const run = /^[0-9a-f-]{36}$/i.test(id) ? await getRun(id) : null;
    if (!run) return Response.json({ error: "That outreach plan does not exist." }, { status: 404 });
    try {
      if (body.action === "start") {
        const autopilot = typeof body.autopilot === "boolean" ? body.autopilot : run.autopilot;
        if (autopilot && !canManageAutopilot(ctx)) {
          return Response.json({ error: "Only an owner or admin can let the assistant answer replies automatically. Start without it, or ask one of them." }, { status: 403 });
        }
        const started = await startOutreachRun(id, ctx.userId, { autopilot });
        if (run.threadId) {
          await addMessage({ threadId: run.threadId, role: "event", content: `${ctx.userName || "The owner"} approved the outreach plan “${run.name}”${autopilot ? " with the reply autopilot on" : ""}. Writing each lead's opening line, then launching.` });
        }
        return Response.json({ ok: true, jobId: started.jobId });
      }
      if (body.action === "pause" || body.action === "resume") {
        const result = await setRunPaused(id, body.action === "pause");
        if (run.threadId && result.changed.length) {
          await addMessage({ threadId: run.threadId, role: "event", content: `${ctx.userName || "The owner"} ${body.action === "pause" ? "paused" : "resumed"} “${run.name}” (${result.changed.join(", ")}).${result.problems.length ? ` Problems: ${result.problems.join("; ")}` : ""}` });
        }
        return Response.json({ ok: result.changed.length > 0, ...result });
      }
      if (body.action === "cancel") {
        const cancelled = await db.update(outreachRuns).set({ status: "cancelled", updatedAt: new Date() })
          .where(and(inOrg(outreachRuns), eq(outreachRuns.id, id), eq(outreachRuns.status, "proposed")))
          .returning({ id: outreachRuns.id });
        if (!cancelled.length) return Response.json({ error: "Only a plan that has not started can be discarded." }, { status: 409 });
        if (run.threadId) await addMessage({ threadId: run.threadId, role: "event", content: `The outreach plan “${run.name}” was discarded.` });
        return Response.json({ ok: true });
      }
      return Response.json({ error: "action must be start, pause, resume or cancel" }, { status: 400 });
    } catch (error) {
      if (error instanceof OutreachError) return Response.json({ error: error.message }, { status: 409 });
      throw error;
    }
  });
}

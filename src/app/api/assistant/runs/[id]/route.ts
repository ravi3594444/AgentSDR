import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { assistantRoute, canManageAutopilot } from "@/lib/assistant/http.server";
import { getRun, OutreachError, setRunPaused, setRunReplyMode, startInquiryRun, startOutreachRun, stopRun } from "@/lib/assistant/outreach.server";
import { AUTOPILOT_LIMITS } from "@/lib/crm/autopilot";
import { outreachRuns } from "@/lib/assistant/schema";
import { addMessage } from "@/lib/assistant/threads.server";
import { recordRequestApproval } from "@/lib/assistant/requestApproval.server";
import { inOrg } from "@/lib/tenancy/scope";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/assistant/runs/[id] — { action: "start" | "pause" | "resume" | "stop" | "cancel" | "mode", mode?: "automatic" | "review" }
// "start" is the owner's approval of a proposed plan: the only way outreach
// starts, and it names the reply mode. Automatic replies (at start or by
// "mode" later) are an expansion only an owner or admin may approve;
// switching to Review, pausing and stopping are open to every member.
export async function POST(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  return assistantRoute(request, { mutation: true }, async (ctx) => {
    const body = (await request.json().catch(() => ({}))) as { action?: unknown; autopilot?: unknown; mode?: unknown; applyToRequest?: unknown };
    const requestedMode = body.mode === "automatic" ? true : body.mode === "review" ? false : typeof body.autopilot === "boolean" ? body.autopilot : null;
    const run = /^[0-9a-f-]{36}$/i.test(id) ? await getRun(id) : null;
    if (!run) return Response.json({ error: "That outreach plan does not exist." }, { status: 404 });
    try {
      if (body.action === "start") {
        if (requestedMode === null) return Response.json({ error: "Choose Automatic or Review replies to start." }, { status: 400 });
        const autopilot = requestedMode;
        if (autopilot && !canManageAutopilot(ctx)) {
          return Response.json({ error: "Only an owner or admin can let the assistant answer replies automatically. Start in Review mode, or ask one of them." }, { status: 403 });
        }
        if (run.plan.kind === "inquiries") {
          await startInquiryRun(id, ctx.userId, autopilot);
          if (run.threadId) {
            await addMessage({
              threadId: run.threadId,
              role: "event",
              content: `${ctx.userName || "The owner"} started answering new Instagram inquiries (“${run.name}”) in ${autopilot ? "Automatic" : "Review"} mode. Only people whose first message arrives from now on, on the accounts that treat new messages as inquiries, are covered; imported history and earlier chats are never answered by it. ${autopilot
                ? `Ordinary questions are answered from your saved information once the answer is written and checked, at most ${AUTOPILOT_LIMITS.perConversation} per conversation and ${AUTOPILOT_LIMITS.perDay} in 24 hours; anything else comes to you as a decision.`
                : "Each answer to a reply is drafted and waits for you in the Inbox (Needs you)."}`,
            });
          }
          return Response.json({ ok: true, jobId: null });
        }
        const started = await startOutreachRun(id, ctx.userId, { autopilot });
        const applyToRequest = body.applyToRequest === true && Boolean(run.plan.requestId);
        if (run.threadId) {
          await addMessage({
            threadId: run.threadId,
            role: "event",
            content: `${ctx.userName || "The owner"} approved the outreach plan “${run.name}” in ${autopilot ? "Automatic" : "Review"} mode${applyToRequest ? ", for the rest of this request too: its other plans start on their own as they are ready, with the same mode, channels and limits" : ""}. ${autopilot
              ? `Ordinary replies from these leads are answered from your saved information as soon as the answer is written and checked, at most ${AUTOPILOT_LIMITS.perConversation} per conversation and ${AUTOPILOT_LIMITS.perDay} in 24 hours; anything else comes to you as a decision.`
              : "Each answer to a reply is drafted and waits for you in the Inbox (Needs you)."} Writing each lead's opening line, then launching.`,
          });
        }
        // The rest of the same request (other cities or searches) under this one approval.
        // The plan has started either way: a failure here only means the rest waits for its own Start.
        const applied = applyToRequest
          ? await recordRequestApproval(id, { autopilot, approvedBy: ctx.userId }).catch((error) => {
            console.error("[assistant/runs] recording the request approval failed:", error);
            return null;
          })
          : null;
        return Response.json({ ok: true, jobId: started.jobId, ...(applied ? { alsoStarted: applied.started, notStarted: applied.skipped } : {}) });
      }
      if (body.action === "pause" || body.action === "resume") {
        const result = await setRunPaused(id, body.action === "pause");
        if (run.threadId && result.changed.length) {
          await addMessage({ threadId: run.threadId, role: "event", content: `${ctx.userName || "The owner"} ${body.action === "pause" ? "paused" : "resumed"} “${run.name}” (${result.changed.join(", ")}).${result.notes.length ? ` Note: ${result.notes.join("; ")}` : ""}${result.problems.length ? ` Problems: ${result.problems.join("; ")}` : ""}` });
        }
        return Response.json({ ok: result.changed.length > 0, ...result });
      }
      if (body.action === "stop") {
        const result = await stopRun(id);
        if (run.threadId) {
          await addMessage({ threadId: run.threadId, role: "event", content: `${ctx.userName || "The owner"} stopped “${run.name}”. Nothing more is sent for it and no reply is answered automatically.${result.problems.length ? ` Problems: ${result.problems.join("; ")}` : ""}` });
        }
        return Response.json({ ok: true, ...result });
      }
      if (body.action === "mode") {
        if (requestedMode === null) return Response.json({ error: "mode must be automatic or review" }, { status: 400 });
        if (requestedMode && !canManageAutopilot(ctx)) return Response.json({ error: "Only an owner or admin can switch a run to Automatic replies." }, { status: 403 });
        await setRunReplyMode(id, requestedMode);
        if (run.threadId) {
          await addMessage({ threadId: run.threadId, role: "event", content: `${ctx.userName || "The owner"} switched “${run.name}” to ${requestedMode ? "Automatic" : "Review"} replies.` });
        }
        return Response.json({ ok: true });
      }
      if (body.action === "cancel") {
        const cancelled = await db.update(outreachRuns).set({ status: "cancelled", updatedAt: new Date() })
          .where(and(inOrg(outreachRuns), eq(outreachRuns.id, id), eq(outreachRuns.status, "proposed")))
          .returning({ id: outreachRuns.id });
        if (!cancelled.length) return Response.json({ error: "Only a plan that has not started can be discarded." }, { status: 409 });
        if (run.threadId) await addMessage({ threadId: run.threadId, role: "event", content: `The outreach plan “${run.name}” was discarded.` });
        return Response.json({ ok: true });
      }
      return Response.json({ error: "action must be start, pause, resume, stop, mode or cancel" }, { status: 400 });
    } catch (error) {
      if (error instanceof OutreachError) return Response.json({ error: error.message }, { status: 409 });
      throw error;
    }
  });
}

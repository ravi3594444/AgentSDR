import type { NextRequest } from "next/server";
import { answerDecision, DecisionError, getDecision, resolveDecision } from "@/lib/assistant/decisions.server";
import { assistantRoute } from "@/lib/assistant/http.server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/assistant/decisions/[id] — { action: "answer", answer } | { action: "resolve" } | { action: "takeover" }
// "answer" saves the owner's answer to knowledge and rewrites the waiting
// reply with it; "takeover" keeps the autopilot out of that conversation.
export async function POST(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  return assistantRoute(request, { mutation: true }, async (ctx) => {
    const body = (await request.json().catch(() => ({}))) as { action?: unknown; answer?: unknown };
    const decision = /^[0-9a-f-]{36}$/i.test(id) ? await getDecision(id) : null;
    if (!decision) return Response.json({ error: "That decision does not exist." }, { status: 404 });
    try {
      if (body.action === "answer") {
        if (typeof body.answer !== "string" || !body.answer.trim()) return Response.json({ error: "Write the answer." }, { status: 400 });
        return Response.json({ ok: true, ...(await answerDecision(id, body.answer.slice(0, 4_000), ctx.userId)) });
      }
      if (body.action === "resolve" || body.action === "takeover") {
        await resolveDecision(id, { takeover: body.action === "takeover", userId: ctx.userId });
        return Response.json({ ok: true });
      }
      return Response.json({ error: "action must be answer, resolve or takeover" }, { status: 400 });
    } catch (error) {
      if (error instanceof DecisionError) return Response.json({ error: error.message }, { status: 409 });
      throw error;
    }
  });
}

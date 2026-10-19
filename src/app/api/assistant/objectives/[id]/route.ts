import type { NextRequest } from "next/server";
import { assistantRoute } from "@/lib/assistant/http.server";
import { getObjective, objectiveViewById, setObjectiveState } from "@/lib/assistant/objective.server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/assistant/objectives/[id] — one owner request's research: its
// target, found, spend, time left, sources, status and stop reason. Reading
// it never starts, pauses or stops anything.
export async function GET(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  return assistantRoute(request, { mutation: false }, async () => {
    const view = UUID.test(id) ? await objectiveViewById(id) : null;
    if (!view) return Response.json({ error: "That research does not exist." }, { status: 404 });
    return Response.json({ objective: view });
  });
}

// POST /api/assistant/objectives/[id] — { action: "pause" | "resume" | "cancel" }
// Pausing and cancelling stop new work (no new search, paid call or
// continuation) and keep every lead already saved; searches already running
// finish. Cancelling ends it with its final report. Open to every member,
// like pausing or stopping an outreach plan.
export async function POST(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  return assistantRoute(request, { mutation: true }, async (ctx) => {
    const body = (await request.json().catch(() => ({}))) as { action?: unknown };
    if (body.action !== "pause" && body.action !== "resume" && body.action !== "cancel") {
      return Response.json({ error: "action must be pause, resume or cancel" }, { status: 400 });
    }
    if (!UUID.test(id) || !(await getObjective(id))) return Response.json({ error: "That research does not exist." }, { status: 404 });
    const { changed } = await setObjectiveState(id, body.action, { name: ctx.userName || null });
    return Response.json({ ok: changed, objective: await objectiveViewById(id) });
  });
}

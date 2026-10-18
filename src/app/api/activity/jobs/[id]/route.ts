import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { cancelJob } from "@/lib/activity/activity.server";
import { assistantRoute } from "@/lib/assistant/http.server";
import { assistantJobs } from "@/lib/assistant/schema";
import { addMessage } from "@/lib/assistant/threads.server";
import { db } from "@/lib/db";
import { inOrg } from "@/lib/tenancy/scope";

export const dynamic = "force-dynamic";

// POST /api/activity/jobs/[id] — { action: "cancel" }: stops a queued or
// running background job (a search). No further step runs; a provider run
// it already started finishes on the provider's side and stays counted.
// Found leads already saved are kept. The chat that started it is told.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return assistantRoute(request, { mutation: true }, async (ctx) => {
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: "Unknown job." }, { status: 404 });
    const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
    if (body?.action !== "cancel") return Response.json({ error: "Send { action: \"cancel\" }." }, { status: 400 });
    const [job] = await db.select({ threadId: assistantJobs.threadId, kind: assistantJobs.kind }).from(assistantJobs).where(and(inOrg(assistantJobs), eq(assistantJobs.id, id))).limit(1);
    if (!job) return Response.json({ error: "Unknown job." }, { status: 404 });
    if (!(await cancelJob(id))) return Response.json({ error: "It has already finished." }, { status: 409 });
    if (job.threadId) {
      await addMessage({ threadId: job.threadId, role: "event", content: `${ctx.userName?.trim() || "The owner"} cancelled a background search from Activity. Leads it had already saved are kept.` });
    }
    return Response.json({ ok: true });
  });
}

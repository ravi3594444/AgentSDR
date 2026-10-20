import type { NextRequest } from "next/server";
import { diagnoseDelivery } from "@/lib/assistant/deliveryDiagnostics.server";
import { assistantRoute } from "@/lib/assistant/http.server";

export const dynamic = "force-dynamic";

// GET /api/assistant/runs/[id]/delivery — each sending account of the plan:
// its configured time zone, the gates recorded right now and the earliest
// time it may send (runEvidence.ts). Read-only; it starts and sends nothing,
// and no gate is not proof that a worker is running.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return assistantRoute(request, { mutation: false }, async () => {
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: "That outreach plan does not exist." }, { status: 404 });
    try {
      const diagnostics = await diagnoseDelivery(id);
      return Response.json({ at: diagnostics.at, displayTimeZone: diagnostics.displayTimeZone, senders: diagnostics.senders, notCovered: diagnostics.notCovered }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      if (error instanceof Error && error.message === "No such outreach run") return Response.json({ error: "That outreach plan does not exist." }, { status: 404 });
      throw error;
    }
  });
}

import type { NextRequest } from "next/server";
import { assistantRoute, canManageAutopilot } from "@/lib/assistant/http.server";
import { isAutopilotOn, setAutopilot } from "@/lib/crm/autopilot.server";

export const dynamic = "force-dynamic";

// POST /api/assistant/autopilot — { enabled } — whether ordinary replies are
// answered without waiting for a person (rules: src/lib/crm/autopilot.ts).
// Owners and admins only; anyone may turn it off.
export async function POST(request: NextRequest) {
  return assistantRoute(request, { mutation: true }, async (ctx) => {
    const body = (await request.json().catch(() => ({}))) as { enabled?: unknown };
    if (typeof body.enabled !== "boolean") return Response.json({ error: "enabled must be true or false" }, { status: 400 });
    if (body.enabled && !canManageAutopilot(ctx)) return Response.json({ error: "Only an owner or admin can turn the reply autopilot on." }, { status: 403 });
    await setAutopilot(body.enabled);
    return Response.json({ enabled: await isAutopilotOn() });
  });
}

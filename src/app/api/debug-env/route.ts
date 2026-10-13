import { NextResponse } from "next/server";
import { authContextErrorResponse, withOrgContext } from "@/lib/auth/context";
import { getByokSettings } from "@/lib/ai/byok";
import { getAiConnection } from "@/lib/ai/connections";
import { planAiRuntime } from "@/lib/ai/runtimePlan";
import { resolveParentDomain } from "@/lib/qualification/parentLookup";

export async function GET(request: Request) {
  try {
    return await withOrgContext(request, async () => {
    const parentDomain = await resolveParentDomain("kiehls.com");
    const settings = await getByokSettings();
    const connection = settings.connectionId ? await getAiConnection(settings.connectionId) : null;
    const planned = planAiRuntime(settings, connection);
    return NextResponse.json({
      parentDomain,
      ai: {
        provider: connection?.providerKey ?? null,
        configured: planned.ok,
        problem: planned.ok ? null : planned.error,
        model: settings.defaultModel,
      },
    });
    });
  } catch (e) {
    const denied = authContextErrorResponse(e);
    if (denied) return denied;
    return NextResponse.json({ fetchError: String(e) });
  }
}

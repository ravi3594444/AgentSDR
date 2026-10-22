import { NextResponse } from "next/server";
import { authContextErrorResponse, withOrgContext } from "@/lib/auth/context";
import { getByokSettings, isManagedAiConnectionId } from "@/lib/ai/byok";
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
    // The Included engine's provider and model are the platform's configuration, not the workspace's.
    const included = isManagedAiConnectionId(settings.connectionId);
    return NextResponse.json({
      parentDomain,
      ai: {
        provider: included ? "included" : connection?.providerKey ?? null,
        configured: planned.ok,
        problem: planned.ok ? null : included ? "The included AI service is not available right now" : planned.error,
        model: included ? null : settings.defaultModel,
      },
    });
    });
  } catch (e) {
    const denied = authContextErrorResponse(e);
    if (denied) return denied;
    return NextResponse.json({ fetchError: String(e) });
  }
}

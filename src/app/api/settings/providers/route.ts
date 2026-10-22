import { NextRequest, NextResponse } from "next/server";
import { authContextErrorResponse, can, requirePermission, withOrgContext } from "@/lib/auth/context";
import { assertSameOriginMutation, CrmRequestError } from "@/lib/crm/http";
import { isManagedService, type ServiceMode } from "@/lib/managed/catalog";
import { serviceChoices } from "@/lib/managed/choices.server";
import { setServiceMode } from "@/lib/managed/modes.server";
import { MANAGED_UNIPILE_ENABLED } from "@/lib/platform/credentials";
import { resyncUnipileAccounts } from "@/lib/platform/unipileAccounts.server";

// Settings → Advanced → Use your own providers: per service, Included service
// or My own provider. Every member can read the choices (never a key, engine
// or model); changing one takes the integrations permission (owners and
// admins). Switching never moves a key: the workspace's own saved credentials
// stay saved either way, and the platform's never reach the workspace.

function failure(error: unknown, fallback: string): Response {
  const denied = authContextErrorResponse(error);
  if (denied) return denied;
  if (error instanceof CrmRequestError) return NextResponse.json({ error: error.message }, { status: error.status });
  console.error("[settings/providers]", error);
  return NextResponse.json({ error: fallback }, { status: 500 });
}

// GET /api/settings/providers — { services, canManage }
export async function GET(request: NextRequest) {
  try {
    return await withOrgContext(request, async (ctx) => NextResponse.json({ services: await serviceChoices(), canManage: can(ctx, { integrations: ["manage"] }) }));
  } catch (error) {
    return failure(error, "Could not read the provider choices");
  }
}

// PUT /api/settings/providers — { service, mode: "managed" | "own" }
export async function PUT(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    return await withOrgContext(request, async (ctx) => {
      requirePermission(ctx, { integrations: ["manage"] });
      const body = (await request.json().catch(() => null)) as { service?: unknown; mode?: unknown } | null;
      if (!isManagedService(body?.service)) return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
      if (body?.mode !== "managed" && body?.mode !== "own") return NextResponse.json({ error: "Choose Included service or My own provider" }, { status: 400 });
      if (body.service === "unipile" && body.mode === "managed" && !MANAGED_UNIPILE_ENABLED) {
        return NextResponse.json({ error: "Account connections are not offered as an Included service on this server yet." }, { status: 409 });
      }
      await setServiceMode(body.service, body.mode as ServiceMode, ctx.userId);
      // Another Unipile: the accounts it lists are read again now (ownership still decides which are this workspace's).
      if (body.service === "unipile") void resyncUnipileAccounts(ctx.organizationId);
      return NextResponse.json({ services: await serviceChoices() });
    });
  } catch (error) {
    return failure(error, "Could not save the choice");
  }
}

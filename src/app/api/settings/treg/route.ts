import { NextRequest, NextResponse } from "next/server";
import { authContextErrorResponse, can, requirePermission, withOrgContext } from "@/lib/auth/context";
import { featureEnabled } from "@/lib/features/flags.server";
import { saveTregSettings, TregSettingsError, tregSettingsView } from "@/lib/treg/treg.server";

// The organization's Treg key (src/lib/treg/). Every member can read the
// settings (never the key); saving takes the integrations permission
// (owners and admins), like the Apify connection. Nothing here tops up or
// changes the Treg account.

function failure(error: unknown, fallback: string): Response {
  const denied = authContextErrorResponse(error);
  if (denied) return denied;
  const status = error instanceof TregSettingsError ? 400 : 500;
  if (status === 500) console.error("[settings/treg]", error);
  return NextResponse.json({ error: error instanceof Error ? error.message : fallback }, { status });
}

// GET /api/settings/treg — { enabled, settings, canManage }
export async function GET(req: NextRequest) {
  try {
    return await withOrgContext(req, async (ctx) => NextResponse.json({
      enabled: await featureEnabled("treg"),
      settings: await tregSettingsView(),
      canManage: can(ctx, { integrations: ["manage"] }),
    }));
  } catch (error) {
    return failure(error, "Could not read the Treg settings");
  }
}

// PUT /api/settings/treg — { key?, dailyCapUsd? }
export async function PUT(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Send the settings as JSON" }, { status: 400 });
  try {
    return await withOrgContext(req, async (ctx) => {
      requirePermission(ctx, { integrations: ["manage"] });
      if (!(await featureEnabled("treg"))) {
        return NextResponse.json({ error: "Turn on Treg tools under Optional features first." }, { status: 409 });
      }
      return NextResponse.json({ settings: await saveTregSettings({ key: body.key, dailyCapUsd: body.dailyCapUsd }, ctx.userId) });
    });
  } catch (error) {
    return failure(error, "Could not save the Treg settings");
  }
}

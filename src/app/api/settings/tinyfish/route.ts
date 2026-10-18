import { NextRequest, NextResponse } from "next/server";
import { authContextErrorResponse, can, requirePermission, withOrgContext } from "@/lib/auth/context";
import { saveTinyfishSettings, TinyfishSettingsError, tinyfishSettingsView } from "@/lib/tinyfish/tinyfish.server";

// The organization's TinyFish key (src/lib/tinyfish/): web search, page
// reading and the remote browser. Every member can read the settings (never
// the key); saving takes the integrations permission (owners and admins).
// Unlike Tavily it is not behind an optional feature: web access is core.

function failure(error: unknown, fallback: string): Response {
  const denied = authContextErrorResponse(error);
  if (denied) return denied;
  const status = error instanceof TinyfishSettingsError ? 400 : 500;
  if (status === 500) console.error("[settings/tinyfish]", error);
  return NextResponse.json({ error: error instanceof Error ? error.message : fallback }, { status });
}

// GET /api/settings/tinyfish — { settings, canManage }
export async function GET(req: NextRequest) {
  try {
    return await withOrgContext(req, async (ctx) => NextResponse.json({
      settings: await tinyfishSettingsView(),
      canManage: can(ctx, { integrations: ["manage"] }),
    }));
  } catch (error) {
    return failure(error, "Could not read the TinyFish settings");
  }
}

// PUT /api/settings/tinyfish — { key?, useForWebSearch?, browserMinutesPerDay? }
export async function PUT(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Send the settings as JSON" }, { status: 400 });
  try {
    return await withOrgContext(req, async (ctx) => {
      requirePermission(ctx, { integrations: ["manage"] });
      return NextResponse.json({
        settings: await saveTinyfishSettings({ key: body.key, useForWebSearch: body.useForWebSearch, browserMinutesPerDay: body.browserMinutesPerDay }, ctx.userId),
      });
    });
  } catch (error) {
    return failure(error, "Could not save the TinyFish settings");
  }
}

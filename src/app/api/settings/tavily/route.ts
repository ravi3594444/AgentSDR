import { NextRequest, NextResponse } from "next/server";
import { authContextErrorResponse, can, requirePermission, withOrgContext } from "@/lib/auth/context";
import { featureEnabled } from "@/lib/features/flags.server";
import { saveTavilySettings, TavilySettingsError, tavilySettingsView } from "@/lib/tavily/tavily.server";

// The organization's Tavily key (src/lib/tavily/), the web search behind
// website searches. Every member can read the settings (never the key);
// saving takes the integrations permission (owners and admins), like the
// Apify and Treg connections. Nothing here changes the Tavily plan.

function failure(error: unknown, fallback: string): Response {
  const denied = authContextErrorResponse(error);
  if (denied) return denied;
  const status = error instanceof TavilySettingsError ? 400 : 500;
  if (status === 500) console.error("[settings/tavily]", error);
  return NextResponse.json({ error: error instanceof Error ? error.message : fallback }, { status });
}

// GET /api/settings/tavily — { enabled, settings, canManage }
export async function GET(req: NextRequest) {
  try {
    return await withOrgContext(req, async (ctx) => NextResponse.json({
      enabled: await featureEnabled("web_discovery"),
      settings: await tavilySettingsView(),
      canManage: can(ctx, { integrations: ["manage"] }),
    }));
  } catch (error) {
    return failure(error, "Could not read the Tavily settings");
  }
}

// PUT /api/settings/tavily — { key?, dailySearches? }
export async function PUT(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Send the settings as JSON" }, { status: 400 });
  try {
    return await withOrgContext(req, async (ctx) => {
      requirePermission(ctx, { integrations: ["manage"] });
      if (!(await featureEnabled("web_discovery"))) {
        return NextResponse.json({ error: "Turn on Website and directory search under Optional features first." }, { status: 409 });
      }
      return NextResponse.json({ settings: await saveTavilySettings({ key: body.key, dailySearches: body.dailySearches }, ctx.userId) });
    });
  } catch (error) {
    return failure(error, "Could not save the Tavily settings");
  }
}

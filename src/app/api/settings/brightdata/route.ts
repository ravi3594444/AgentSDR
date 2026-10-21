import { NextRequest, NextResponse } from "next/server";
import { authContextErrorResponse, can, requirePermission, withOrgContext } from "@/lib/auth/context";
import { featureEnabled } from "@/lib/features/flags.server";
import { BrightdataSettingsError, brightdataSettingsView, saveBrightdataSettings } from "@/lib/brightdata/brightdata.server";

// The organization's Bright Data key (src/lib/brightdata/), the research
// provider behind social research. Every member can read the settings
// (never the key); saving takes the integrations permission (owners and
// admins), like the Apify and Tavily connections. Nothing here changes the
// Bright Data plan or its zones.

function failure(error: unknown, fallback: string): Response {
  const denied = authContextErrorResponse(error);
  if (denied) return denied;
  const status = error instanceof BrightdataSettingsError ? 400 : 500;
  if (status === 500) console.error("[settings/brightdata]", error);
  return NextResponse.json({ error: error instanceof Error ? error.message : fallback }, { status });
}

// GET /api/settings/brightdata — { enabled, settings, canManage }
export async function GET(req: NextRequest) {
  try {
    return await withOrgContext(req, async (ctx) => NextResponse.json({
      enabled: await featureEnabled("brightdata"),
      settings: await brightdataSettingsView(),
      canManage: can(ctx, { integrations: ["manage"] }),
    }));
  } catch (error) {
    return failure(error, "Could not read the Bright Data settings");
  }
}

// PUT /api/settings/brightdata — { key?, monthlyCredits?, maxRecordsPerSearch?, serpZone?, redditEnabled? }
export async function PUT(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Send the settings as JSON" }, { status: 400 });
  try {
    return await withOrgContext(req, async (ctx) => {
      requirePermission(ctx, { integrations: ["manage"] });
      if (!(await featureEnabled("brightdata"))) {
        return NextResponse.json({ error: "Turn on Bright Data research under Optional features first." }, { status: 409 });
      }
      const settings = await saveBrightdataSettings({
        key: body.key, monthlyCredits: body.monthlyCredits, maxRecordsPerSearch: body.maxRecordsPerSearch, serpZone: body.serpZone, redditEnabled: body.redditEnabled,
      }, ctx.userId);
      return NextResponse.json({ settings });
    });
  } catch (error) {
    return failure(error, "Could not save the Bright Data settings");
  }
}

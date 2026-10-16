import { NextRequest, NextResponse } from "next/server";
import { authContextErrorResponse, can, requirePermission, withOrgContext } from "@/lib/auth/context";
import { apifySettingsView, ApifySettingsError, saveApifySettings } from "@/lib/apify/apify.server";
import { featureEnabled } from "@/lib/features/flags.server";

// The organization's Apify connection (src/lib/apify/). Every member can
// read it (never the token); saving takes the integrations permission
// (owners and admins), like connecting a channel. Nothing here tops up,
// upgrades or changes the Apify account.

function failure(error: unknown, fallback: string): Response {
  const denied = authContextErrorResponse(error);
  if (denied) return denied;
  const status = error instanceof ApifySettingsError ? 400 : 500;
  if (status === 500) console.error("[settings/apify]", error);
  return NextResponse.json({ error: error instanceof Error ? error.message : fallback }, { status });
}

// GET /api/settings/apify — { enabled, settings, canManage }
export async function GET(req: NextRequest) {
  try {
    return await withOrgContext(req, async (ctx) => NextResponse.json({
      enabled: await featureEnabled("apify_discovery"),
      settings: await apifySettingsView(),
      canManage: can(ctx, { integrations: ["manage"] }),
    }));
  } catch (error) {
    return failure(error, "Could not read the Apify settings");
  }
}

// PUT /api/settings/apify — { token?, approvedActors?, monthlyBudgetUsd?, maxChargePerRunUsd?, maxResultsPerRun? }
export async function PUT(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Send the settings as JSON" }, { status: 400 });
  try {
    return await withOrgContext(req, async (ctx) => {
      requirePermission(ctx, { integrations: ["manage"] });
      if (!(await featureEnabled("apify_discovery"))) {
        return NextResponse.json({ error: "Turn on Apify discovery under Optional features first." }, { status: 409 });
      }
      return NextResponse.json({ settings: await saveApifySettings(body, ctx.userId) });
    });
  } catch (error) {
    return failure(error, "Could not save the Apify settings");
  }
}

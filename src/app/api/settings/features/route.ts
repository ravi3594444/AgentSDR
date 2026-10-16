import { NextRequest, NextResponse } from "next/server";
import { authContextErrorResponse, can, requirePermission, withOrgContext } from "@/lib/auth/context";
import { FEATURE_KEYS, isFeatureKey } from "@/lib/features/catalog";
import { featureState, setFeature } from "@/lib/features/flags.server";

// The organization's optional features (src/lib/features/catalog.ts), all off
// until switched on. Every member can read them; switching one takes the
// integrations permission (owners and admins), like connecting a channel.

function failure(error: unknown, fallback: string): Response {
  const denied = authContextErrorResponse(error);
  if (denied) return denied;
  return NextResponse.json({ error: error instanceof Error ? error.message : fallback }, { status: 400 });
}

// GET /api/settings/features — { features: { instagram, web_discovery, inquiry_intake }, canManage }
export async function GET(req: NextRequest) {
  try {
    return await withOrgContext(req, async (ctx) => NextResponse.json({
      features: await featureState(),
      canManage: can(ctx, { integrations: ["manage"] }),
    }));
  } catch (error) {
    return failure(error, "Could not read the features");
  }
}

// PUT /api/settings/features — body { key, enabled }; returns { features }
export async function PUT(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { key?: unknown; enabled?: unknown } | null;
  if (!body || !isFeatureKey(body.key) || typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: `Send { key: one of ${FEATURE_KEYS.join(", ")}, enabled: true or false }` }, { status: 400 });
  }
  const key = body.key;
  const enabled = body.enabled;
  try {
    return await withOrgContext(req, async (ctx) => {
      requirePermission(ctx, { integrations: ["manage"] });
      return NextResponse.json({ features: await setFeature(key, enabled, ctx.userId) });
    });
  } catch (error) {
    return failure(error, "Could not save the feature");
  }
}

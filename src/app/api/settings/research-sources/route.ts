import { NextRequest, NextResponse } from "next/server";
import { authContextErrorResponse, can, requirePermission, withOrgContext } from "@/lib/auth/context";
import { researchSourcesView, ResearchSourcesSettingsError, saveResearchSources } from "@/lib/research/sources/settings.server";

// The organization's research sources (src/lib/research/sources/): Hacker
// News and Stack Exchange use, and the record of Reddit's approval. Every
// member can read them; recording approval takes the integrations
// permission (owners and admins). Recording it does not enable reading
// Reddit: no Reddit reader exists.

function failure(error: unknown, fallback: string): Response {
  const denied = authContextErrorResponse(error);
  if (denied) return denied;
  const status = error instanceof ResearchSourcesSettingsError ? 400 : 500;
  if (status === 500) console.error("[settings/research-sources]", error);
  return NextResponse.json({ error: error instanceof Error ? error.message : fallback }, { status });
}

// GET /api/settings/research-sources — { settings, canManage }
export async function GET(req: NextRequest) {
  try {
    return await withOrgContext(req, async (ctx) => NextResponse.json({
      settings: await researchSourcesView(),
      canManage: can(ctx, { integrations: ["manage"] }),
    }));
  } catch (error) {
    return failure(error, "Could not read the research sources");
  }
}

// PUT /api/settings/research-sources — { redditApproved?, redditApprovalNote?, redditClientId? }
export async function PUT(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Send the settings as JSON" }, { status: 400 });
  try {
    return await withOrgContext(req, async (ctx) => {
      requirePermission(ctx, { integrations: ["manage"] });
      return NextResponse.json({
        settings: await saveResearchSources({ redditApproved: body.redditApproved, redditApprovalNote: body.redditApprovalNote, redditClientId: body.redditClientId }, ctx.userId),
      });
    });
  } catch (error) {
    return failure(error, "Could not save the research sources");
  }
}

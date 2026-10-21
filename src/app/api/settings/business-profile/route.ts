import { NextRequest, NextResponse } from "next/server";
import { authContextErrorResponse, withOrgContext } from "@/lib/auth/context";
import { BusinessProfileInputError, businessProfileSettings, saveBusinessProfileSettings } from "@/lib/assistant/profileSettings.server";

// The business profile (assistant_profiles), the one the chat's
// save_business_info writes, edited from Settings → Your business. Every
// member can read it; changing it takes the organization update permission
// (owners and admins). Each change also rewrites its Knowledge copy.

function failure(error: unknown, fallback: string): Response {
  const denied = authContextErrorResponse(error);
  if (denied) return denied;
  if (error instanceof BusinessProfileInputError) return NextResponse.json({ error: error.message, problems: error.problems }, { status: 400 });
  console.error("[settings/business-profile]", error);
  return NextResponse.json({ error: fallback }, { status: 500 });
}

// GET /api/settings/business-profile — { profile, knowledgeDocumentId, updatedAt, canEdit }
export async function GET(req: NextRequest) {
  try {
    return await withOrgContext(req, async (ctx) => NextResponse.json(await businessProfileSettings(ctx)));
  } catch (error) {
    return failure(error, "Could not read the business profile");
  }
}

// PATCH /api/settings/business-profile — body: the changed fields ("" clears one);
// returns { profile, knowledgeDocumentId, updatedAt, canEdit, profileChanges }
export async function PATCH(req: NextRequest) {
  const body: unknown = await req.json().catch(() => null);
  try {
    return await withOrgContext(req, async (ctx) => NextResponse.json(await saveBusinessProfileSettings(ctx, body)));
  } catch (error) {
    return failure(error, "Could not save the business profile");
  }
}

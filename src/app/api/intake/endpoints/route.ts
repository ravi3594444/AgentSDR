import { NextRequest, NextResponse } from "next/server";
import { can, requirePermission, withOrgContext } from "@/lib/auth/context";
import { featureEnabled, requireFeature } from "@/lib/features/flags.server";
import { createIntakeEndpoint, listIntakeEndpoints } from "@/lib/intake/endpoints.server";
import { intakeFailure } from "@/lib/intake/http";

// Website-form endpoints (Settings → Inquiries). Every member can read them;
// making or changing one takes the integrations permission (owners, admins),
// like connecting a channel, and the organization's Inquiry intake on.

// GET /api/intake/endpoints — { endpoints, enabled, canManage }
export async function GET(req: NextRequest) {
  try {
    return await withOrgContext(req, async (ctx) => NextResponse.json({
      endpoints: await listIntakeEndpoints(),
      enabled: await featureEnabled("inquiry_intake"),
      canManage: can(ctx, { integrations: ["manage"] }),
    }));
  } catch (error) {
    return intakeFailure(error, "Could not read the webhooks");
  }
}

// POST /api/intake/endpoints — body { name?, fieldMap? }; 201 { endpoint, token } (the token is shown this once)
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { name?: unknown; fieldMap?: unknown } | null;
  try {
    return await withOrgContext(req, async (ctx) => {
      requirePermission(ctx, { integrations: ["manage"] });
      await requireFeature("inquiry_intake");
      const created = await createIntakeEndpoint({ name: body?.name, fieldMap: body?.fieldMap }, ctx.userId);
      return NextResponse.json(created, { status: 201 });
    });
  } catch (error) {
    return intakeFailure(error, "Could not create the webhook");
  }
}

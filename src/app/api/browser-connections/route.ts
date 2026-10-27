import type { NextRequest } from "next/server";
import { withOrgContext } from "@/lib/auth/context";
import { requireCrmMutationContext } from "@/lib/crm/http";
import { browserConnectionView, createPairing, disconnectBrowser } from "@/lib/browser/connected/connections.server";
import { browserErrorResponse } from "@/lib/browser/connected/http.server";
import { runInOrganization } from "@/lib/tenancy/scope";

/** The signed-in person's connected browser in this workspace, as the chat shows it. */
export async function GET(request: NextRequest) {
  try {
    return await withOrgContext(request, async (ctx) => Response.json(await browserConnectionView(ctx.userId)));
  } catch (error) {
    return browserErrorResponse(error);
  }
}

/** A one-time pairing code for this person and workspace; the page hands it to the extension. */
export async function POST(request: NextRequest) {
  try {
    const ctx = await requireCrmMutationContext(request);
    return await runInOrganization(ctx.organizationId, async () => Response.json(await createPairing(ctx.userId)));
  } catch (error) {
    return browserErrorResponse(error);
  }
}

/** Disconnect: the browser's token stops working; its open commands end. */
export async function DELETE(request: NextRequest) {
  try {
    const ctx = await requireCrmMutationContext(request);
    return await runInOrganization(ctx.organizationId, async () => {
      await disconnectBrowser(ctx.userId);
      return Response.json(await browserConnectionView(ctx.userId));
    });
  } catch (error) {
    return browserErrorResponse(error);
  }
}

import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withOrgContext } from "@/lib/auth/context";
import { deleteIntakeEndpoint, updateIntakeEndpoint } from "@/lib/intake/endpoints.server";
import { intakeFailure, notFound } from "@/lib/intake/http";

// One website-form endpoint. Another organization's id is not found (404).
// Unlike creating one, changing, turning off and deleting work while the
// organization's Inquiry intake is off, so a leaked token can always be killed.

type Ctx = { params: Promise<{ id: string }> };

// PATCH /api/intake/endpoints/:id — body { name?, fieldMap?, enabled? }; returns { endpoint }
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Send { name?, fieldMap?, enabled? }" }, { status: 400 });
  }
  try {
    return await withOrgContext(req, async (ctx) => {
      requirePermission(ctx, { integrations: ["manage"] });
      const endpoint = await updateIntakeEndpoint(id, body as { name?: unknown; fieldMap?: unknown; enabled?: unknown });
      return endpoint ? NextResponse.json({ endpoint }) : notFound();
    });
  } catch (error) {
    return intakeFailure(error, "Could not save the webhook");
  }
}

// DELETE /api/intake/endpoints/:id — { ok: true }; its inquiries are kept
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  try {
    return await withOrgContext(req, async (ctx) => {
      requirePermission(ctx, { integrations: ["manage"] });
      return (await deleteIntakeEndpoint(id)) ? NextResponse.json({ ok: true }) : notFound();
    });
  } catch (error) {
    return intakeFailure(error, "Could not delete the webhook");
  }
}

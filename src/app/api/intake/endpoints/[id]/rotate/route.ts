import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withOrgContext } from "@/lib/auth/context";
import { rotateIntakeEndpointToken } from "@/lib/intake/endpoints.server";
import { intakeFailure, notFound } from "@/lib/intake/http";

// Works while Inquiry intake is off too: a leaked token can always be replaced.

type Ctx = { params: Promise<{ id: string }> };

// POST /api/intake/endpoints/:id/rotate — { endpoint, token }: a new token, shown this once; the old one stops working at once
export async function POST(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  try {
    return await withOrgContext(req, async (ctx) => {
      requirePermission(ctx, { integrations: ["manage"] });
      const rotated = await rotateIntakeEndpointToken(id);
      return rotated ? NextResponse.json(rotated) : notFound();
    });
  } catch (error) {
    return intakeFailure(error, "Could not rotate the token");
  }
}

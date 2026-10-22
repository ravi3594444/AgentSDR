import { NextRequest, NextResponse } from "next/server";
import { authContextErrorResponse, requirePermission, withOrgContext } from "@/lib/auth/context";
import { assertSameOriginMutation, CrmRequestError } from "@/lib/crm/http";
import { isPlatformNotConnectedError } from "@/lib/platform/credentials";
import { disconnectUnipileAccount } from "@/lib/unipile/accounts.server";
import { isUnipileChannel } from "@/lib/unipile/connect.server";

// POST /api/unipile/accounts/disconnect { channel, id } — disconnect one of
// this workspace's accounts by its own row id: removed from Unipile, the row
// kept as disconnected, the ownership released. Another workspace's row, or
// an account this workspace does not own, is 404. Owners and admins.
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    return await withOrgContext(request, async (ctx) => {
      requirePermission(ctx, { integrations: ["manage"] });
      const body = (await request.json().catch(() => null)) as { channel?: unknown; id?: unknown } | null;
      if (!isUnipileChannel(body?.channel) || typeof body?.id !== "string") return NextResponse.json({ error: "Name the channel and the account" }, { status: 400 });
      const done = await disconnectUnipileAccount(body.channel, body.id);
      if (!done) return NextResponse.json({ error: "Account not found" }, { status: 404 });
      return NextResponse.json({ ok: true });
    });
  } catch (error) {
    const denied = authContextErrorResponse(error);
    if (denied) return denied;
    if (error instanceof CrmRequestError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (isPlatformNotConnectedError(error)) return NextResponse.json({ error: error.message }, { status: 409 });
    console.error("[unipile/disconnect]", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Could not disconnect the account" }, { status: 500 });
  }
}

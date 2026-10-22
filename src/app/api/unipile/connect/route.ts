import { NextRequest, NextResponse } from "next/server";
import { authContextErrorResponse, requirePermission, withOrgContext } from "@/lib/auth/context";
import { assertSameOriginMutation, CrmRequestError } from "@/lib/crm/http";
import { isPlatformNotConnectedError } from "@/lib/platform/credentials";
import { unipileAccountIdForRow } from "@/lib/unipile/accounts.server";
import { connectionStatus, isUnipileChannel, startConnection, UnipileConnectError } from "@/lib/unipile/connect.server";

// POST /api/unipile/connect { channel, accountId? } — a single-use Unipile
// hosted sign-in link for this workspace (a new account, or reconnecting one
// of its own rows). The workspace comes from the session; the browser names
// only a channel and, to reconnect, one of its own row ids. LinkedIn accounts
// and WhatsApp numbers are a rep's own, so any member connects them (as the
// LinkedIn hosted sign-in and the WhatsApp sync always allowed); Instagram
// accounts and email inboxes are the workspace's: owners and admins.
// GET /api/unipile/connect?connection=<id> — how one of this workspace's links ended.

function failure(error: unknown): Response {
  const denied = authContextErrorResponse(error);
  if (denied) return denied;
  if (error instanceof CrmRequestError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof UnipileConnectError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (isPlatformNotConnectedError(error)) return NextResponse.json({ error: error.message }, { status: 409 });
  console.error("[unipile/connect]", error instanceof Error ? error.message : error);
  return NextResponse.json({ error: "Could not start the connection" }, { status: 500 });
}

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    return await withOrgContext(request, async (ctx) => {
      const body = (await request.json().catch(() => null)) as { channel?: unknown; accountId?: unknown } | null;
      if (!isUnipileChannel(body?.channel)) return NextResponse.json({ error: "Unknown channel" }, { status: 400 });
      if (body.channel === "instagram" || body.channel === "email") requirePermission(ctx, { integrations: ["manage"] });
      let reconnectAccountId: string | null = null;
      if (typeof body?.accountId === "string" && body.accountId) {
        reconnectAccountId = await unipileAccountIdForRow(body.channel, body.accountId);
        if (!reconnectAccountId) return NextResponse.json({ error: "Account not found" }, { status: 404 });
      }
      const started = await startConnection({ channel: body.channel, userId: ctx.userId, reconnectAccountId, requestOrigin: request.headers.get("origin") });
      return NextResponse.json({ ok: true, url: started.url, connection: started.stateId });
    });
  } catch (error) {
    return failure(error);
  }
}

export async function GET(request: NextRequest) {
  try {
    return await withOrgContext(request, async () => {
      const id = request.nextUrl.searchParams.get("connection") ?? "";
      const status = await connectionStatus(id);
      if (!status) return NextResponse.json({ error: "Not found" }, { status: 404 });
      return NextResponse.json(status);
    });
  } catch (error) {
    return failure(error);
  }
}

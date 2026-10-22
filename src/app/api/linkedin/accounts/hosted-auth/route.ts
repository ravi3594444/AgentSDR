import { NextRequest, NextResponse } from "next/server";
import { withLinkedinOrg } from "@/lib/linkedin/organizations.server";
import { isPlatformNotConnectedError } from "@/lib/platform/credentials";
import { serializeError } from "@/lib/linkedin/serializeError";
import { unipileAccountIdForRow } from "@/lib/unipile/accounts.server";
import { startConnection, UnipileConnectError } from "@/lib/unipile/connect.server";

// POST /api/linkedin/accounts/hosted-auth
//   {}                     → link that connects a new LinkedIn account
//   { accountId: "<id>" }  → link that re-authenticates that account in place
//
// Returns a single-use Unipile URL the caller navigates to. Unipile advises
// against iframing the wizard, so this deliberately returns a URL rather than
// anything embeddable. The link is minted for the signed-in workspace and
// verified when Unipile confirms it (src/lib/unipile/connect.server.ts); the
// same flow as POST /api/unipile/connect { channel: "linkedin" }.
export async function POST(req: NextRequest) {
  return withLinkedinOrg(req, async (ctx) => {
    try {
      const body = await req.json().catch(() => ({}));
      const accountId = typeof body?.accountId === "string" ? body.accountId : null;
      let reconnectAccountId: string | null = null;
      if (accountId) {
        // The row is this organization's, and its Unipile account id is what `reconnect_account` expects.
        reconnectAccountId = await unipileAccountIdForRow("linkedin", accountId);
        if (!reconnectAccountId) return NextResponse.json({ ok: false, error: "Account not found" }, { status: 404 });
      }
      const { url } = await startConnection({ channel: "linkedin", userId: ctx.userId, reconnectAccountId, requestOrigin: req.headers.get("origin") });
      return NextResponse.json({ ok: true, url });
    } catch (err) {
      if (isPlatformNotConnectedError(err)) return NextResponse.json({ ok: false, error: err.message }, { status: 409 });
      if (err instanceof UnipileConnectError) return NextResponse.json({ ok: false, error: err.message }, { status: err.status });
      console.error(`[hosted-auth] Failed to create link: ${serializeError(err)}`);
      return NextResponse.json({ ok: false, error: "Could not start the LinkedIn connection" }, { status: 500 });
    }
  });
}

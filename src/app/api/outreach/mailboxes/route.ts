import { NextRequest, NextResponse } from "next/server";
import { listMailboxes, connectMailbox } from "@/lib/outreach/mailboxes";
import { withOrgContext, authContextErrorResponse } from "@/lib/auth/context";
import { registerOrganizationWatchesNow } from "@/lib/outreach/mailboxWatch";

// GET /api/outreach/mailboxes — list connected mailboxes.
export async function GET(request: NextRequest) {
  try {
    return await withOrgContext(request, async () => {
      const rows = await listMailboxes();
      return NextResponse.json({ mailboxes: rows });
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

// POST /api/outreach/mailboxes — connect a mailbox: { emailAddress, displayName?, signatureHtml? }
// No password/OAuth — just names the address; we test whether our service
// account's domain-wide delegation is authorized to impersonate it.
export async function POST(req: NextRequest) {
  try {
    return await withOrgContext(req, async (ctx) => {
      let body: { emailAddress?: string; displayName?: string; signatureHtml?: string };
      try {
        body = await req.json();
      } catch {
        return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
      }

      if (!body.emailAddress) {
        return NextResponse.json({ error: "emailAddress is required" }, { status: 400 });
      }

      const result = await connectMailbox({
        emailAddress: body.emailAddress,
        displayName: body.displayName,
        signatureHtml: body.signatureHtml,
      });
      if (!result.ok) {
        return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
      }
      // Watch for replies from the first send, not from the next daily rollover.
      await registerOrganizationWatchesNow(ctx.organizationId);
      return NextResponse.json(result, { status: 201 });
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

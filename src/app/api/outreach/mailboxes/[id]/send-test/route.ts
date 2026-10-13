import { NextRequest, NextResponse } from "next/server";
import { getMailbox } from "@/lib/outreach/mailboxes";
import { sendEmail } from "@/lib/outreach/gmail";
import { withOrgContext, authContextErrorResponse } from "@/lib/auth/context";
import { BRAND } from "@/lib/brand";

// POST /api/outreach/mailboxes/[id]/send-test — { to } — sends a one-off
// test email from this mailbox so a user can confirm sending actually works
// before assigning it to a campaign.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    return await withOrgContext(req, async () => {
      const { id } = await params;
      let body: { to?: string };
      try {
        body = await req.json();
      } catch {
        return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (!body.to) {
        return NextResponse.json({ error: "to is required" }, { status: 400 });
      }

      const mailbox = await getMailbox(id);
      if (!mailbox) return NextResponse.json({ error: "mailbox not found" }, { status: 404 });

      try {
        const result = await sendEmail({
          from: mailbox.emailAddress,
          to: [body.to],
          subject: `${BRAND.shortName} test email`,
          text: `This is a test email from ${mailbox.emailAddress}, sent via ${BRAND.shortName} to confirm the mailbox is working.`,
        });
        return NextResponse.json({ ok: true, result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ ok: false, error: message }, { status: 502 });
      }
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

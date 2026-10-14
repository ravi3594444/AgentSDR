import { NextRequest, NextResponse } from "next/server";
import { can, withOrgContext, authContextErrorResponse } from "@/lib/auth/context";
import { syncUnipileMailboxes } from "@/lib/outreach/mailboxProviders";
import { ensureUnipileWebhook, isPlatformNotConnectedError } from "@/lib/platform/credentials";
import { unipileErrorStatus } from "@/services/unipile.whatsapp";

// POST /api/outreach/mailboxes/sync-unipile — makes every email inbox linked
// in the organization's Unipile workspace (Gmail, Outlook, iCloud, Exchange,
// IMAP) a sending mailbox, and refreshes those already added. For someone who
// manages integrations it also registers Unipile's email webhook if this
// organization's registration predates it, since replies to these mailboxes
// arrive only through it (the same action as "Register again").
export async function POST(req: NextRequest) {
  try {
    return await withOrgContext(req, async (ctx) => {
      try {
        const result = await syncUnipileMailboxes();
        const webhooks = can(ctx, { integrations: ["manage"] }) ? await ensureUnipileWebhook("unipile-email") : null;
        return NextResponse.json({ ok: true, ...result, webhooks });
      } catch (error) {
        if (isPlatformNotConnectedError(error)) return NextResponse.json({ ok: false, error: error.message }, { status: 409 });
        const status = unipileErrorStatus(error);
        const message = error instanceof Error ? error.message : String(error);
        return NextResponse.json({ ok: false, error: `Unipile could not list the linked accounts${status ? ` (HTTP ${status})` : ""}: ${message}` }, { status: 502 });
      }
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

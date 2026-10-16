import { type NextRequest, NextResponse } from "next/server";
import { POST as instagramMessage } from "../instagram-message/route";
import { POST as linkedinMessage } from "../message-received/route";
import { POST as whatsappMessage } from "../whatsapp-message/route";

/**
 * POST /api/webhooks/unipile-message?org=… — the one Unipile messaging
 * webhook AgentSDR registers (src/lib/platform/unipileWebhooks.ts), for
 * events message_received, message_read and message_delivered.
 *
 * Unipile sends messaging events for every connected account, whatever the
 * provider, so this only routes by `account_type`: WhatsApp to the WhatsApp
 * handler, Instagram to the Instagram one (which skips everything while the
 * organization's Instagram feature is off), a LinkedIn message_received to
 * the LinkedIn one. Each handler
 * does its own gate, secret check and ledger write, exactly as when it is
 * called at its own path — those paths stay live for hand-made
 * registrations and the LinkedIn replay job. Anything else (a LinkedIn read
 * or delivery receipt, another provider) is acknowledged and dropped before
 * it reaches the ledger. Public in proxy.ts.
 */
export async function POST(req: NextRequest) {
  const body = (await req.clone().json().catch(() => null)) as { account_type?: unknown; event?: unknown } | null;
  const accountType = typeof body?.account_type === "string" ? body.account_type.toUpperCase() : null;

  if (accountType === "WHATSAPP") return whatsappMessage(req);
  if (accountType === "INSTAGRAM") return instagramMessage(req);
  if (accountType === "LINKEDIN" && body?.event === "message_received") return linkedinMessage(req);

  return NextResponse.json({ ok: true, skipped: true });
}

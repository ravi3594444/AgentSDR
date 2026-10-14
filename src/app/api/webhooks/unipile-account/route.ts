import { NextRequest, NextResponse } from "next/server";
import { syncAllAccounts } from "@/functions/syncAllAccounts";
import { runInOrganization } from "@/lib/tenancy/scope";
import { organizationIdForNotifySecret, safeEqual, unipileNotifySecret } from "@/lib/linkedin/organizations.server";
import { serializeError } from "@/lib/linkedin/serializeError";
import { syncWhatsappAccounts } from "@/lib/whatsapp/accounts";
import { syncUnipileMailboxes } from "@/lib/outreach/mailboxProviders";

// POST /api/webhooks/unipile-account?secret=... — the `notify_url` of a hosted
// auth link. Unipile POSTs { status, account_id, name } once the user finishes
// the wizard: CREATION_SUCCESS for a new account, RECONNECTED for a repaired one.
// The account may be LinkedIn, WhatsApp or an email inbox, so all three sync —
// each on its own, so one failing does not keep the others from running.
//
// Public (see proxy.ts) because Unipile calls it without our session cookie,
// so it carries a shared-secret check: the notify secret stored with the Unipile
// integration (Settings → LinkedIn → Connection); refused while it is empty or Unipile is not connected.
// Whose secret? notify_url carries `org=<organization id>` (hostedAuthUrls.ts),
// and the secret is verified against that organization's own. URLs registered
// before that existed carry no `org`; the organization is then the one whose
// stored secret matches. Everything after runs in that organization's scope.
// The body is not signed by Unipile, hence it is treated as a nudge only: it
// triggers a sync and every field is re-read from the Unipile API rather than
// trusted from the payload.
const HANDLED_STATUSES = new Set(["CREATION_SUCCESS", "RECONNECTED"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveOrganization(req: NextRequest): Promise<string | null> {
  const provided = req.nextUrl.searchParams.get("secret") ?? req.headers.get("x-unipile-secret");
  if (!provided) return null;
  const claimed = req.nextUrl.searchParams.get("org");
  if (claimed) {
    if (!UUID.test(claimed)) return null;
    const stored = await unipileNotifySecret(claimed);
    return stored && safeEqual(stored, provided) ? claimed : null;
  }
  return organizationIdForNotifySecret(provided);
}

export async function POST(req: NextRequest) {
  const organizationId = await resolveOrganization(req);
  if (!organizationId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return runInOrganization(organizationId, () => handle(req));
}

async function handle(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const status = typeof body?.status === "string" ? body.status : "unknown";

    if (!HANDLED_STATUSES.has(status)) {
      console.log(`[unipile-account] Ignoring status "${status}"`);
      return NextResponse.json({ ok: true, skipped: true });
    }

    console.log(`[unipile-account] ${status} for account ${body?.account_id ?? "?"} — syncing`);
    const errors: string[] = [];
    try {
      await syncAllAccounts();
    } catch (err) {
      errors.push(`LinkedIn: ${serializeError(err)}`);
    }
    try {
      await syncWhatsappAccounts();
    } catch (err) {
      errors.push(`WhatsApp: ${serializeError(err)}`);
    }
    try {
      await syncUnipileMailboxes();
    } catch (err) {
      errors.push(`Email: ${serializeError(err)}`);
    }
    if (errors.length) {
      console.error(`[unipile-account] ${errors.join(" | ")}`);
      return NextResponse.json({ ok: false, error: errors.join(" | ") }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(`[unipile-account] ${serializeError(err)}`);
    return NextResponse.json({ ok: false, error: serializeError(err) }, { status: 500 });
  }
}

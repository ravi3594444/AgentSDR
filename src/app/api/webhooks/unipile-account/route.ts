import { NextRequest, NextResponse } from "next/server";
import { syncAllAccounts } from "@/functions/syncAllAccounts";
import { runInOrganization } from "@/lib/tenancy/scope";
import { organizationIdForNotifySecret, safeEqual, unipileNotifySecret } from "@/lib/linkedin/organizations.server";
import { serializeError } from "@/lib/linkedin/serializeError";
import { syncWhatsappAccounts } from "@/lib/whatsapp/accounts";
import { syncUnipileMailboxes } from "@/lib/outreach/mailboxProviders";
import { featureEnabled } from "@/lib/features/flags.server";
import { applyInstagramAccountOwner, syncInstagramAccounts } from "@/lib/instagram/accounts";
import { parseInstagramHostedAuthName } from "@/services/unipile.instagram";
import { completeConnection } from "@/lib/unipile/connect.server";
import { syncUnipileChannel } from "@/lib/platform/unipileAccounts.server";

// POST /api/webhooks/unipile-account?secret=... — the `notify_url` of a hosted
// auth link. Unipile POSTs { status, account_id, name } once the user finishes
// the wizard: CREATION_SUCCESS for a new account, RECONNECTED for a repaired one.
// The account may be LinkedIn, WhatsApp or an email inbox, so all three sync —
// each on its own, so one failing does not keep the others from running.
// Instagram syncs too, only while the organization's Instagram feature is on;
// an Instagram link started from AgentSDR names "<organization>:<member>",
// and that member is recorded as the account's owner.
//
// Public (see proxy.ts) because Unipile calls it without our session cookie,
// so it carries a shared-secret check: the notify secret stored with the Unipile
// integration (Settings → Advanced → Use your own providers → Unipile); refused while it is empty or Unipile is not connected.
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

/**
 * A link minted by src/lib/unipile/connect.server.ts carries `state` and its
 * secret `token`: the connection is verified there (the state, the token, the
 * account read back from Unipile) and claimed for the state's workspace only,
 * then that channel is synced. Nothing the body says is trusted beyond being a
 * pointer to the account.
 */
async function handleConnection(req: NextRequest): Promise<NextResponse> {
  const body = await req.json().catch(() => null);
  const outcome = await completeConnection({ stateId: req.nextUrl.searchParams.get("state"), token: req.nextUrl.searchParams.get("token"), body });
  if (!outcome.ok && outcome.status === "invalid") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!outcome.ok) return NextResponse.json({ ok: true, claimed: false, reason: outcome.reason });
  await runInOrganization(outcome.organizationId, async () => {
    try {
      await syncUnipileChannel(outcome.channel);
      if (outcome.channel === "instagram") await applyInstagramAccountOwner(outcome.accountId, outcome.userId);
    } catch (err) {
      // The account is this workspace's either way; the next sync shows it.
      console.error(`[unipile-account] sync after connecting ${outcome.channel} account ${outcome.accountId}: ${serializeError(err)}`);
    }
  });
  return NextResponse.json({ ok: true, claimed: true });
}

export async function POST(req: NextRequest) {
  if (req.nextUrl.searchParams.has("state")) return handleConnection(req);
  const organizationId = await resolveOrganization(req);
  if (!organizationId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return runInOrganization(organizationId, () => handle(req, organizationId));
}

async function handle(req: NextRequest, organizationId: string) {
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
    try {
      if (await featureEnabled("instagram")) {
        await syncInstagramAccounts();
        const owner = parseInstagramHostedAuthName(body?.name);
        const accountId = typeof body?.account_id === "string" ? body.account_id : null;
        // Only a link this organization started; the member is checked against it too.
        if (owner && accountId && owner.organizationId === organizationId.toLowerCase()) {
          await applyInstagramAccountOwner(accountId, owner.userId);
        }
      }
    } catch (err) {
      errors.push(`Instagram: ${serializeError(err)}`);
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

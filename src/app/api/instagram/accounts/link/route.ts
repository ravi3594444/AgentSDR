import { instagramHostedAuthCallbackUrls } from "@/lib/instagram/hostedAuth";
import { instagramRoute } from "@/lib/instagram/http";
import { requirePlatformCredentials } from "@/lib/platform/credentials";
import { createInstagramHostedAuthLink, instagramHostedAuthName } from "@/services/unipile.instagram";

/**
 * POST /api/instagram/accounts/link — a single-use Unipile hosted sign-in URL
 * for a new Instagram account (owners and admins). Its `name` records the
 * caller as the account's owner; Unipile's notify_url is the existing
 * account-status webhook, which syncs and applies that owner. The caller
 * navigates to the URL; Unipile advises against framing it.
 */
export async function POST(request: Request) {
  return instagramRoute(request, async (ctx) => {
    const credentials = await requirePlatformCredentials("unipile");
    const url = await createInstagramHostedAuthLink({
      name: instagramHostedAuthName(ctx.organizationId, ctx.userId),
      // The browser's own origin, so a dev session returns to localhost instead of production.
      ...instagramHostedAuthCallbackUrls(request.headers.get("origin"), credentials.notifySecret, ctx.organizationId),
    });
    return Response.json({ url });
  }, { manage: true });
}

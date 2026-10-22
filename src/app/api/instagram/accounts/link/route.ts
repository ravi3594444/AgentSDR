import { instagramRoute } from "@/lib/instagram/http";
import { startConnection, UnipileConnectError } from "@/lib/unipile/connect.server";

/**
 * POST /api/instagram/accounts/link — a single-use Unipile hosted sign-in URL
 * for a new Instagram account (owners and admins), minted for the signed-in
 * workspace through the verified connection flow
 * (src/lib/unipile/connect.server.ts): when Unipile confirms it, the account
 * is claimed for this workspace and the caller is recorded as its owner. The
 * caller navigates to the URL; Unipile advises against framing it.
 */
export async function POST(request: Request) {
  return instagramRoute(request, async (ctx) => {
    try {
      const { url } = await startConnection({ channel: "instagram", userId: ctx.userId, requestOrigin: request.headers.get("origin") });
      return Response.json({ url });
    } catch (error) {
      if (error instanceof UnipileConnectError) return Response.json({ error: error.message }, { status: error.status });
      throw error;
    }
  }, { manage: true });
}

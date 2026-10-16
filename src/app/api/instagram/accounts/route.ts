import { can } from "@/lib/auth/context";
import { listInstagramAccounts } from "@/lib/instagram/accounts";
import type { ListInstagramAccountsResponse } from "@/lib/instagram/contract";
import { instagramRoute } from "@/lib/instagram/http";

/** GET /api/instagram/accounts — the linked Instagram accounts as last synced, and whether the caller may manage them. */
export async function GET(request: Request) {
  return instagramRoute(request, async (ctx) =>
    Response.json({
      accounts: await listInstagramAccounts(),
      canManage: can(ctx, { integrations: ["manage"] }),
    } satisfies ListInstagramAccountsResponse));
}

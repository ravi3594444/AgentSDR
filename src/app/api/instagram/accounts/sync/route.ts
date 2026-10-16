import { syncInstagramAccounts } from "@/lib/instagram/accounts";
import { instagramRoute } from "@/lib/instagram/http";

/** POST /api/instagram/accounts/sync — re-reads the linked Instagram accounts from Unipile (owners and admins). */
export async function POST(request: Request) {
  return instagramRoute(request, async () => Response.json({ accounts: await syncInstagramAccounts() }), { manage: true });
}

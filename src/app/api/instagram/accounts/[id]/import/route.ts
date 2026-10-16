import type { ImportInstagramHistoryResponse } from "@/lib/instagram/contract";
import { assertIdParam, instagramRoute } from "@/lib/instagram/http";
import { importInstagramHistory } from "@/lib/instagram/messages";

/**
 * POST /api/instagram/accounts/:id/import — imports the account's recent
 * chats and messages from Unipile as history (owners and admins). History
 * is shown, never answered: nothing reaches the CRM, nothing is unread,
 * nothing becomes an inquiry. Safe to run again.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return instagramRoute(request, async () => {
    const id = assertIdParam((await params).id, "Instagram account");
    return Response.json((await importInstagramHistory(id)) satisfies ImportInstagramHistoryResponse);
  }, { manage: true });
}

import type { NextRequest } from "next/server";
import type { ListInstagramChatsResponse } from "@/lib/instagram/contract";
import { instagramRoute, optionalUuidQuery } from "@/lib/instagram/http";
import { listInstagramChats } from "@/lib/instagram/messages";

/** GET /api/instagram/chats?accountId&cursor — the chats, most recent first, a page at a time. */
export async function GET(request: NextRequest) {
  return instagramRoute(request, async () => {
    const params = request.nextUrl.searchParams;
    return Response.json((await listInstagramChats({
      accountId: optionalUuidQuery(params.get("accountId"), "accountId"),
      cursor: params.get("cursor"),
    })) satisfies ListInstagramChatsResponse);
  });
}

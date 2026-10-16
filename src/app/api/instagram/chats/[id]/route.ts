import type { InstagramThreadResponse } from "@/lib/instagram/contract";
import { assertIdParam, instagramRoute } from "@/lib/instagram/http";
import { getInstagramThread } from "@/lib/instagram/messages";

/** GET /api/instagram/chats/:id — the chat and its messages, oldest first. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return instagramRoute(request, async () => {
    const id = assertIdParam((await params).id, "Instagram chat");
    return Response.json((await getInstagramThread(id)) satisfies InstagramThreadResponse);
  });
}

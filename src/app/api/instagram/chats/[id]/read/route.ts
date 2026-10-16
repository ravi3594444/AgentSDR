import { assertIdParam, instagramRoute } from "@/lib/instagram/http";
import { markInstagramChatRead } from "@/lib/instagram/messages";

/** POST /api/instagram/chats/:id/read — clears the chat's unread count in AgentSDR (Instagram is not told). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return instagramRoute(request, async () => {
    const id = assertIdParam((await params).id, "Instagram chat");
    return Response.json(await markInstagramChatRead(id));
  });
}

import type { NextRequest } from "next/server";
import { assistantRoute } from "@/lib/assistant/http.server";
import { audienceProspects } from "@/lib/assistant/qualification.server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/assistant/audiences/[id]/prospects — every lead of one list with
// its source and date, why it matched, how it can be reached and any real
// evidence of need (src/lib/assistant/qualification.ts). Another
// organization's list is a 404.
export async function GET(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  return assistantRoute(request, { mutation: false }, async () => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: "Not found" }, { status: 404 });
    const result = await audienceProspects(id);
    if (!result) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json(result);
  });
}

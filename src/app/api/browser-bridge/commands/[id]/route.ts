import type { NextRequest } from "next/server";
import { completeCommand, parseResultRequest, withBrowserDevice } from "@/lib/browser/connected/connections.server";
import { browserErrorResponse, readBridgeJson } from "@/lib/browser/connected/http.server";

/** The extension's answer to one command, accepted once; withBrowserDevice is the auth check. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return await withBrowserDevice(request, async (row) => {
      await completeCommand(row, id, parseResultRequest(await readBridgeJson(request)));
      return Response.json({ ok: true });
    });
  } catch (error) {
    return browserErrorResponse(error);
  }
}

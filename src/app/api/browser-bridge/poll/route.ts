import type { NextRequest } from "next/server";
import { parsePollRequest, pollCommands, withBrowserDevice } from "@/lib/browser/connected/connections.server";
import { browserErrorResponse, readBridgeJson } from "@/lib/browser/connected/http.server";

/** The extension's heartbeat and long poll; withBrowserDevice is the auth check. */
export async function POST(request: NextRequest) {
  try {
    return await withBrowserDevice(request, async (row) => {
      const body = parsePollRequest(await readBridgeJson(request));
      return Response.json(await pollCommands(row, body, request.signal));
    });
  } catch (error) {
    return browserErrorResponse(error);
  }
}

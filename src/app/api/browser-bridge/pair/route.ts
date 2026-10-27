import type { NextRequest } from "next/server";
import { pairDevice, parsePairRequest } from "@/lib/browser/connected/connections.server";
import { browserErrorResponse, readBridgeJson } from "@/lib/browser/connected/http.server";

/**
 * Called by the extension's service worker with the one-time pairing code
 * the app handed it. The code is the authorization: it names the person and
 * workspace it was minted for, and works once.
 */
export async function POST(request: NextRequest) {
  try {
    return Response.json(await pairDevice(parsePairRequest(await readBridgeJson(request))));
  } catch (error) {
    return browserErrorResponse(error);
  }
}

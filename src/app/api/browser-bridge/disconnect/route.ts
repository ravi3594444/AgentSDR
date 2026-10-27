import type { NextRequest } from "next/server";
import { disconnectDevice, withBrowserDevice } from "@/lib/browser/connected/connections.server";
import { browserErrorResponse } from "@/lib/browser/connected/http.server";

/** The extension's own Disconnect: its token stops working at once. */
export async function POST(request: NextRequest) {
  try {
    return await withBrowserDevice(request, async (row) => {
      await disconnectDevice(row);
      return Response.json({ ok: true });
    });
  } catch (error) {
    return browserErrorResponse(error);
  }
}

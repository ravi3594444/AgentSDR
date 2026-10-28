import "server-only";

import { authContextErrorResponse } from "@/lib/auth/context";
import { crmRequestErrorResponse } from "@/lib/crm/http";
import { BrowserBridgeError } from "./connections.server";

/** Bridge bodies are small: a pairing, a heartbeat, one page reading. */
const MAX_BODY_BYTES = 512 * 1024;
/** A command's answer may carry one screenshot (connections.server.ts bounds the image itself). */
export const MAX_RESULT_BYTES = 4 * 1024 * 1024;

export async function readBridgeJson(request: Request, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new BrowserBridgeError(413, "Too large.");
  const raw = await request.text();
  if (raw.length > maxBytes) throw new BrowserBridgeError(413, "Too large.");
  try {
    return JSON.parse(raw);
  } catch {
    throw new BrowserBridgeError(400, "The body must be JSON.");
  }
}

export function browserErrorResponse(error: unknown): Response {
  if (error instanceof BrowserBridgeError) return Response.json({ error: error.message }, { status: error.status });
  const auth = authContextErrorResponse(error);
  if (auth) return auth;
  const request = crmRequestErrorResponse(error);
  if (request) return request;
  console.error("[browser-bridge] request failed", error);
  return Response.json({ error: "The browser bridge request failed." }, { status: 500 });
}

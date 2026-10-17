import { authContextErrorResponse } from "@/lib/auth/context";
import { isPlatformNotConnectedError } from "@/lib/platform/credentials";
import { CrmConfigurationValidationError } from "@/lib/crm/categories";
import { crmRequestErrorResponse } from "@/lib/crm/http";

/**
 * A send refused on purpose — a guardrail, Do Not Contact, a number that
 * cannot be messaged. Definite: retrying the same send gets the same answer
 * (a 429 only after `retryAfterSeconds`). Re-exported from delivery.ts,
 * where src/lib/crm/send.ts imports it.
 */
export type WhatsappSendRefusalReason =
  | "empty"
  | "too_long"
  | "not_connected"
  | "no_target"
  | "send_gap"
  | "new_chat_limit"
  | "warm_up"
  | "do_not_contact"
  | "no_phone"
  | "no_number"
  | "rate_limited"
  | "rejected"
  | "unauthorized"
  | "invalid_number"
  /** WhatsApp refused the recipient itself: the number has no WhatsApp account, or its profile is locked. */
  | "not_on_whatsapp";

export class WhatsappSendRefusedError extends Error {
  constructor(
    message: string,
    readonly status: 409 | 429 | 400 = 409,
    readonly retryAfterSeconds: number | null = null,
    /** Machine-readable cause, for callers (the campaign sender) that act on it. Never sent over HTTP. */
    readonly reason: WhatsappSendRefusalReason | null = null,
  ) {
    super(message);
    this.name = "WhatsappSendRefusedError";
  }
}

/** Any other request the WhatsApp API answers with a status of its choosing (404, 400, 502). */
export class WhatsappApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "WhatsappApiError";
  }
}

export function whatsappApiErrorResponse(error: unknown): Response {
  if (error instanceof WhatsappSendRefusedError) {
    const headers: Record<string, string> = {};
    if (error.retryAfterSeconds !== null) headers["Retry-After"] = String(error.retryAfterSeconds);
    return Response.json(
      { error: error.message, ...(error.retryAfterSeconds !== null ? { retryAfterSeconds: error.retryAfterSeconds } : {}) },
      { status: error.status, headers },
    );
  }
  if (error instanceof WhatsappApiError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  if (isPlatformNotConnectedError(error)) return Response.json({ error: error.message }, { status: 409 });
  const authError = authContextErrorResponse(error);
  if (authError) return authError;
  const requestError = crmRequestErrorResponse(error);
  if (requestError) return requestError;
  if (error instanceof CrmConfigurationValidationError) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  console.error("WhatsApp API request failed", error);
  return Response.json({ error: "WhatsApp request failed" }, { status: 500 });
}

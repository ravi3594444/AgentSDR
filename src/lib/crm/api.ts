import { isPlatformNotConnectedError } from "@/lib/platform/credentials";
import { crmConfigurationErrorResponse, CrmConfigurationValidationError } from "./categories";
import { InvalidCrmTransitionError, StaleCrmContextError } from "./stateMachine";
import { DefiniteCrmSendError } from "./send";

export function crmOperationErrorResponse(error: unknown): Response {
  if (error instanceof StaleCrmContextError) {
    return Response.json({ error: error.message, code: "STALE_CONTEXT" }, { status: 409 });
  }
  if (error instanceof InvalidCrmTransitionError) {
    return Response.json({ error: error.message, code: "INVALID_TRANSITION" }, { status: 409 });
  }
  if (error instanceof SyntaxError || error instanceof CrmConfigurationValidationError) {
    return Response.json({ error: error.message, code: "VALIDATION_ERROR" }, { status: 400 });
  }
  if (isPlatformNotConnectedError(error)) {
    return Response.json({ error: error.message, code: "PLATFORM_NOT_CONNECTED" }, { status: 409 });
  }
  // The provider was never reached, or refused outright: nothing was sent, and the reason is the person's to fix.
  if (error instanceof DefiniteCrmSendError) {
    return Response.json({ error: `Not sent: ${error.message}`, code: "SEND_REFUSED" }, { status: 409 });
  }
  return crmConfigurationErrorResponse(error);
}

export function requireInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new CrmConfigurationValidationError(`${label} must be a non-negative integer`);
  }
  return Number(value);
}

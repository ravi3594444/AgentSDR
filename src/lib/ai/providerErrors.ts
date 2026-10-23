/**
 * Reading a provider failure's HTTP status, wherever it sits. Provider
 * SDKs throw the status on the error itself; wrappers (a completion that
 * rethrows with `{ cause }`, a runtime that wraps the SDK error, a job
 * handler that adds context) bury it one or more levels down. Both the
 * structured-completion retry loop and the CRM queue worker need the same
 * answer — is this failure permanent? — so the walk lives here, shared,
 * instead of each layer reading only the top-level error and disagreeing.
 */

function statusAtLevel(candidate: unknown): number | undefined {
  if (!candidate || typeof candidate !== "object") return undefined;
  const record = candidate as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown; statusCode?: unknown } | null;
  };
  const status = Number(record.status ?? record.statusCode ?? record.response?.status ?? record.response?.statusCode);
  return Number.isFinite(status) && status > 0 ? status : undefined;
}

/** The HTTP status of a provider failure, following its `cause` chain. */
export function providerHttpStatus(error: unknown): number | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth += 1) {
    const status = statusAtLevel(current);
    if (status !== undefined) return status;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * A provider/configuration failure another attempt cannot fix: an HTTP 4xx
 * rejection other than the transient ones (408 timeout, 409 conflict, 425
 * too early, 429 rate limit). A rejected API key (401) or a forbidden
 * model/endpoint (403) fails the same way every time it is retried with
 * the same credentials and configuration.
 */
export function isPermanentProviderError(error: unknown): boolean {
  const status = providerHttpStatus(error);
  if (status === undefined) return false;
  if (status < 400 || status >= 500) return false;
  return ![408, 409, 425, 429].includes(status);
}

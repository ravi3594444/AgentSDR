/**
 * Makes a value safe to write into a jsonb column.
 *
 * Postgres rejects \u0000 in text and jsonb outright, and JSON.stringify
 * emits a lone surrogate as an escape (\ud800) that jsonb rejects too. A
 * provider or model can return either, and one such string would make the
 * completion write throw — after the paid call had already succeeded — so
 * the job would be retried and billed again.
 */
export function cleanString(text: string): string {
  const withoutNul = text.replace(/\u0000/g, "");
  return withoutNul.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "�",
  );
}

/** Deep-cleans strings and object keys; everything else passes through. */
export function cleanJson<T>(value: T, depth = 0): T {
  if (typeof value === "string") return cleanString(value) as T;
  if (!value || typeof value !== "object") return value;
  if (depth > 40) return null as T;
  const withToJson = value as { toJSON?: () => unknown };
  if (typeof withToJson.toJSON === "function") return cleanJson(withToJson.toJSON(), depth + 1) as T;
  if (Array.isArray(value)) return value.map((item) => cleanJson(item, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[cleanString(key)] = cleanJson(item, depth + 1);
  return out as T;
}

/** cleanString, cut to at most `max` characters (an ellipsis marks the cut) without splitting a character. */
export function clippedString(text: string, max: number): string {
  const clean = cleanString(text);
  if (clean.length <= max) return clean;
  let end = max - 1;
  const last = clean.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${clean.slice(0, end)}…`;
}

/**
 * An error as a job keeps it: its message, cleaned and clipped. A failed
 * query's message carries the whole statement with its values (a step's
 * result, leads' details), so the database's own reason, its cause, is kept
 * instead.
 */
export function savedErrorText(error: unknown, max: number): string {
  const failedQuery = error instanceof Error && error.message.startsWith("Failed query:") && error.cause instanceof Error;
  const message = failedQuery ? (error.cause as Error).message : error instanceof Error ? error.message : String(error);
  return clippedString(message, max);
}

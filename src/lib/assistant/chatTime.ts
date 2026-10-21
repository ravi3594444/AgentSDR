import { zoneOrUtc } from "./displayTime";

/**
 * Times in the chat (AssistantClient.tsx), in one explicit time zone: the
 * organization's (reporting/metrics.server.ts organizationTimeZone, the
 * same policy Reports and the request panel use), never the process's or
 * the browser's. The server and the browser then render the same text, so
 * a reload never changes a message's time (pilot finding L04). Stored
 * instants stay UTC. Pure and client-safe: Intl only.
 */

const LOCALE = "en-US";

function instantOf(value: string | Date): Date | null {
  const at = value instanceof Date ? value : new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** "11:18 AM": the clock time in `timeZone`. */
export function formatChatTime(value: string | Date, timeZone: string): string {
  const at = instantOf(value);
  return at ? new Intl.DateTimeFormat(LOCALE, { timeZone: zoneOrUtc(timeZone), hour: "numeric", minute: "2-digit" }).format(at) : "";
}

/** "Tue, Oct 21, 11:18 AM": the day and clock time in `timeZone`. */
export function formatChatDateTime(value: string | Date, timeZone: string): string {
  const at = instantOf(value);
  return at ? new Intl.DateTimeFormat(LOCALE, { timeZone: zoneOrUtc(timeZone), weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(at) : "";
}

/** "Oct 21, 2026": the date in `timeZone`. */
export function formatChatDate(value: string | Date, timeZone: string): string {
  const at = instantOf(value);
  return at ? new Intl.DateTimeFormat(LOCALE, { timeZone: zoneOrUtc(timeZone), year: "numeric", month: "short", day: "numeric" }).format(at) : "";
}

/**
 * The daily lead limit's day and wording, pure and client-safe; the count
 * and the claim-time check are in dailyLeadLimit.server.ts.
 *
 * The day is the workspace's own (general.timeZone + general.dayStartsAt),
 * the same one the daily rollover uses: it began at the latest new-day
 * instant at or before now and resets at the next one.
 */
import { dailyAt, latestDailySlot, nextSlotAt } from "@/lib/scheduler/slots";
import { describeOpening } from "./sendingWindow";

/** How every "the daily lead limit is holding this back" reason starts, so a status screen can match it. */
export const DAILY_LEAD_LIMIT_GATE = "Daily lead limit reached";

export type LeadDayWindow = { start: Date; resetsAt: Date };

/** When the workspace's current day began and when the next one begins (always after `now`). */
export function leadDayWindow(timeZone: string, dayStartsAt: string, now: Date): LeadDayWindow {
  return {
    start: latestDailySlot(timeZone, dayStartsAt, now),
    resetsAt: nextSlotAt(dailyAt(dayStartsAt, timeZone), new Date(now.getTime() + 1)),
  };
}

const leads = (n: number) => `${n} new ${n === 1 ? "lead" : "leads"}`;

/** Settings → Daily lead limit: today's count, whether it is reached, and when the day resets. */
export function describeLeadDay(day: { used: number; limit: number; resetsAt: Date; timeZone: string; dayStartsAt: string }): { used: string; reached: boolean; resets: string } {
  return {
    used: `${day.used} of ${leads(day.limit)} contacted today`,
    reached: day.used >= day.limit,
    resets: `Resets every day at ${day.dayStartsAt} (${day.timeZone}). Next reset: ${describeOpening(day.resetsAt, day.timeZone)}.`,
  };
}

/** Why a first message waits: "Daily lead limit reached (50 of 50 new leads today); resets Thursday 22 Oct at 05:30 (Asia/Kolkata)". */
export function dailyLeadLimitReason(used: number, limit: number, resetsAt: Date, timeZone: string): string {
  return `${DAILY_LEAD_LIMIT_GATE} (${used} of ${leads(limit)} today); resets ${describeOpening(resetsAt, timeZone)} (${timeZone})`;
}

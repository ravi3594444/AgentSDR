/**
 * Times on the Sending status panel and in Activity, in one display time
 * zone (the organization's, Settings → Sending defaults → Time zone) and named,
 * so a sender's own sending hours, a lead's location and the time shown are
 * never confused. Pure and client-safe: Intl only.
 */

function zoneOrUtc(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

const dayKey = (at: Date, timeZone: string) => new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);

/**
 * "17:30:29 (Asia/Kolkata)": the clock time in `timeZone`, with seconds when
 * asked (a cooldown boundary at 12:00:29.508 UTC must not read as 17:30), and
 * the day ("Tue 20 Oct 09:00") when it is not the same local day as `now`.
 * Seconds are cut, not rounded: the boundary has not passed at that second.
 */
export function displayTime(at: Date, now: Date, timeZone: string, options: { seconds?: boolean } = {}): string {
  const zone = zoneOrUtc(timeZone);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", ...(options.seconds ? { second: "2-digit" } : {}), hourCycle: "h23" }).format(at);
  const day = dayKey(at, zone) === dayKey(now, zone) ? "" : `${new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", day: "numeric", month: "short" }).format(at)} `;
  return `${day}${time} (${zone})`;
}

/**
 * How to say when something sending-related happens next (the daily lead
 * limit's reset). Pure (Intl only). Sending itself is always on: no sender
 * has sending hours or a window to wait for.
 */

/** "Monday 19 Oct at 09:00", in `timeZone`. */
export function describeOpening(at: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long", day: "numeric", month: "short" }).format(at);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
  return `${day} at ${time}`;
}

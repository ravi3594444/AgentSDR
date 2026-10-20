/** The rest between runs when no rule is given: 30 to 60 minutes (Settings → LinkedIn → Sending rules). */
const DEFAULT_GAP_MINUTES: [number, number] = [30, 60];

/** A random rest, in milliseconds, within `gapMinutes` (inclusive, to the millisecond). */
export const randomOutreachGapMs = (gapMinutes: [number, number] = DEFAULT_GAP_MINUTES): number => {
  const [lo, hi] = [gapMinutes[0] * 60 * 1000, gapMinutes[1] * 60 * 1000];
  return lo + Math.floor(Math.random() * (hi - lo + 1));
};

export const computeNextAllowedRun = (from: Date = new Date(), gapMinutes?: [number, number]): Date =>
  new Date(from.getTime() + randomOutreachGapMs(gapMinutes));

export const isAccountRunnable = (nextAllowedRun: Date | null, at: Date = new Date()): boolean =>
  !nextAllowedRun || at >= nextAllowedRun;

/**
 * When the rest between runs ends, to the second: a boundary such as
 * 12:00:29.508 must not read as 12:00, which hides why the 12:00 check
 * skipped the account. After it, the account is next run by the scheduled
 * check (every 30 minutes), not at once. `timeZone` defaults to the viewer's.
 */
export const formatNextAllowedRun = (nextAllowedRun: Date | null, timeZone?: string, at: Date = new Date()): string => {
  if (!nextAllowedRun) return "Ready now";
  if (at >= nextAllowedRun) return "Ready now";
  return nextAllowedRun.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  });
};

/**
 * LinkedIn accounts work at any time of day: sending is always on, and an
 * account's old work* fields (workTimezone, workStartTime, workEndTime,
 * workDays) are read by nothing (runOutreach and the Sending status ignore
 * them; the always-on migration clears them). Only the analytics page's
 * default time zone is left here.
 */

/** The time zone LinkedIn analytics are read in when the page names none. */
export const DEFAULT_WORK_TIMEZONE = "Asia/Kolkata";

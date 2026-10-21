/**
 * What the in-process scheduler runs, and when. Pure data (client-safe) so
 * tests and docs can read it; what each job does is in jobs.ts.
 *
 * Two kinds of work:
 *
 * - Platform-wide jobs below, each one slot at a time across every
 *   organization (the job's own code iterates organizations).
 * - The daily rollover, once per organization at the start of that
 *   organization's day (Settings → Your business → Time zone / New day starts
 *   at): builds its email queues, renews its Gmail watches, resets its
 *   LinkedIn daily limits. Its claim key is `daily-rollover:<organization id>`.
 *
 * All times are UTC unless a job names a zone.
 */
import { dailyAt, everyMinutes, type Schedule } from "./slots";

export type PlatformJobName = "linkedin-run-outreach" | "linkedin-run-search-queue" | "linkedin-replay-webhooks" | "history-prune";

export type PlatformJob = {
  name: PlatformJobName;
  schedule: Schedule;
  /**
   * Run in-process. When false the job is only run by its endpoint (a click
   * or an external cron) exactly as before, without slot dedupe.
   */
  enabled: boolean;
  /** The HTTP route that also runs it, if any: its migration-mode block applies here too. */
  endpoint?: string;
  description: string;
};

export const PLATFORM_JOBS: readonly PlatformJob[] = [
  {
    name: "linkedin-run-outreach",
    schedule: everyMinutes(30),
    enabled: true,
    endpoint: "/api/linkedin/jobs/run-outreach",
    description: "LinkedIn invitations and follow-ups (each account's limits and working hours apply)",
  },
  {
    // Not scheduled yet: today the search queue runs when someone clicks Run.
    // Set `enabled: true` to work it every 10 minutes (the endpoint then
    // dedupes external cron calls against the same slots).
    name: "linkedin-run-search-queue",
    schedule: everyMinutes(10),
    enabled: false,
    endpoint: "/api/linkedin/jobs/run-search-queue",
    description: "LinkedIn search queue",
  },
  {
    name: "linkedin-replay-webhooks",
    schedule: everyMinutes(10),
    enabled: true,
    endpoint: "/api/linkedin/jobs/replay-webhooks",
    description: "Retry LinkedIn and Instagram webhook deliveries that failed",
  },
  {
    name: "history-prune",
    schedule: dailyAt("00:00", "UTC"),
    enabled: true,
    description: "Prune LinkedIn job history and old scheduler claims",
  },
];

export function platformJob(name: PlatformJobName): PlatformJob {
  const job = PLATFORM_JOBS.find((j) => j.name === name);
  if (!job) throw new Error(`Unknown scheduled job ${name}`);
  return job;
}

export const ROLLOVER_JOB_PREFIX = "daily-rollover:";

export function rolloverJobName(organizationId: string): string {
  return `${ROLLOVER_JOB_PREFIX}${organizationId}`;
}

/** How long claim rows are kept. */
export const CLAIM_RETENTION_DAYS = 30;

import "server-only";

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { resetDailyLimits } from "@/jobs/resetDailyLimits";
import { organizations } from "@/lib/auth/schema";
import { resolveValues } from "@/lib/channels/rules";
import { channelSettings } from "@/lib/channels/schema";
import { startTrackedJob } from "@/lib/linkedin/jobTracker";
import { serializeError } from "@/lib/linkedin/serializeError";
import { migrationMutationBlockReason } from "@/lib/migration/controls";
import { runInOrganization } from "@/lib/tenancy/scope";
import { buildMailboxQueues } from "@/lib/outreach/buildQueue";
import { renewMailboxWatches } from "@/lib/outreach/mailboxWatch";
import { lastStarts } from "./claims";
import { rolloverJobName } from "./schedules";
import { latestDailySlot } from "./slots";

/**
 * The daily rollover: once per organization, at the start of that
 * organization's day (Settings → Sending defaults → Time zone and New day starts
 * at, stored with the other organization defaults in channel_settings), it
 *
 *   a. builds the organization's email send queues (buildQueue.ts),
 *   b. renews its mailboxes' Gmail push watches (mailboxWatch.ts),
 *   c. resets its LinkedIn accounts' daily limits (resetDailyLimits).
 *
 * Its slot is the instant the organization's current day began, so a
 * claim key is (`daily-rollover:<organization id>`, that instant) — DST-safe,
 * and a late run still belongs to the right day.
 *
 * Changing the time zone or the time: the claim is also refused when the
 * organization's previous rollover STARTED at or after the new day's start
 * (claims.ts). A rollover that already happened inside the current day, as
 * the new setting counts days, therefore stands, and the next one is at the
 * next new-day time. The one case a change does produce two rollovers within
 * 24 hours is moving the day start LATER (or east-to-west): the old day's
 * rollover already ran, and the new day boundary still lies ahead today, so
 * that is a genuinely new day under the new setting.
 */

export type OrganizationDay = { organizationId: string; timeZone: string; dayStartsAt: string; slot: Date };

/**
 * Every organization's current day. One query across organizations: a
 * platform-level enumeration like the email queue build's, it reads only
 * the day settings, and each rollover then runs in its organization's scope.
 */
export async function organizationDays(now: Date): Promise<OrganizationDay[]> {
  const rows = await db
    .select({ organizationId: organizations.id, values: channelSettings.values })
    .from(organizations)
    .leftJoin(channelSettings, and(eq(channelSettings.organizationId, organizations.id), eq(channelSettings.channel, "general")));
  return rows.map(({ organizationId, values }) => {
    const { timeZone, dayStartsAt } = resolveValues("general", values);
    return { organizationId, timeZone, dayStartsAt, slot: latestDailySlot(timeZone, dayStartsAt, now) };
  });
}

/** Runs the three parts for one organization; each part's failure is reported, none stops the others. */
export async function runDailyRollover(organizationId: string): Promise<{ summary: string; error: string | null }> {
  const notes: string[] = [];
  const errors: string[] = [];

  // a. Email queue. Pauses itself under PAUSE_EMAIL_OUTBOUND / PEOPLE_MIGRATION_MODE.
  try {
    const queue = await buildMailboxQueues({ organizationIds: [organizationId] });
    notes.push(`email queue: ${queue.followUpsQueued} follow-ups, ${queue.newLeadsQueued} new`);
  } catch (error) {
    errors.push(`email queue: ${serializeError(error)}`);
  }

  // b and c are skipped whenever the proxy would refuse their endpoints to an
  // external cron (PEOPLE_MIGRATION_MODE, PAUSE_CAMPAIGN_MUTATIONS).
  const watchBlocked = migrationMutationBlockReason("/api/outreach/mailboxes/watch", "POST");
  if (watchBlocked) {
    notes.push("gmail watch: paused");
  } else {
    try {
      const watch = await renewMailboxWatches({ organizationIds: [organizationId] });
      const failed = watch.results.filter((r) => !r.ok).length;
      notes.push(`gmail watch: ${watch.results.length - failed} renewed${failed ? `, ${failed} failed` : ""}${watch.skipped.length ? ` (${watch.skipped[0].reason})` : ""}`);
    } catch (error) {
      errors.push(`gmail watch: ${serializeError(error)}`);
    }
  }

  const resetBlocked = migrationMutationBlockReason("/api/linkedin/jobs/reset-daily-limits", "POST");
  if (resetBlocked) {
    notes.push("linkedin reset: paused");
  } else {
    try {
      // Tracked like the old daily reset, so it shows in LinkedIn Job History.
      const { runId, done } = await startTrackedJob("reset-daily-limits", () => resetDailyLimits({ organizationId }));
      const error = await done;
      if (error) errors.push(`linkedin reset: ${error}`);
      else notes.push(`linkedin reset: run ${runId}`);
    } catch (error) {
      errors.push(`linkedin reset: ${serializeError(error)}`);
    }
  }

  // d. The assistant's daily summary of yesterday, in the organization's time zone.
  try {
    const { writeDailySummary } = await import("@/lib/assistant/dailySummary.server");
    const day = await runInOrganization(organizationId, () => writeDailySummary());
    notes.push(day ? `assistant summary: ${day}` : "assistant summary: none");
  } catch (error) {
    errors.push(`assistant summary: ${serializeError(error)}`);
  }

  return { summary: notes.join("; "), error: errors.length ? errors.join("; ") : null };
}

/**
 * For the daily endpoints (build-queue, mailboxes/watch, reset-daily-limits)
 * called by an external cron while the in-process scheduler runs: which
 * organizations still await today's rollover (the endpoint does its part for
 * them) and which have already rolled over today (skipped, so nothing is
 * reset twice in a day). Null when that cannot be known (no claims table):
 * the endpoint then serves every organization, as before.
 */
export async function rolloverStatus(now = new Date()): Promise<{ awaiting: string[]; rolledOver: string[] } | null> {
  const last = await lastStarts([], true);
  if (!last) return null;
  const awaiting: string[] = [];
  const rolledOver: string[] = [];
  for (const day of await organizationDays(now)) {
    const started = last.get(rolloverJobName(day.organizationId));
    (started && started.getTime() >= day.slot.getTime() ? rolledOver : awaiting).push(day.organizationId);
  }
  return { awaiting, rolledOver };
}

import { isPlatformConnected } from "@/lib/platform/credentials";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { linkedInAccounts } from "@/lib/linkedin/schema";
import { syncAllAccounts } from "../functions/syncAllAccounts";
import { resolveProfiles } from "../functions/resolveProfiles";
import { sendInvitations } from "../functions/sendInvitations";
import { sendFollowUps } from "../functions/sendFollowUps";
import { computeNextAllowedRun, formatNextAllowedRun, isAccountRunnable } from "@/lib/linkedin/nextAllowedRun";
import { channelRules } from "@/lib/channels/rules.server";
import { isMigrationControlPaused } from "@/lib/migration/controls";
import { inOrg, runInOrganization } from "@/lib/tenancy/scope";
import { unipileOrganizationIds } from "@/lib/linkedin/organizations.server";
import { serializeError } from "@/lib/linkedin/serializeError";

export type RunOutreachOptions = {
  /** Restrict the run to one organization (a signed-in caller); omitted by cron, which serves every organization. */
  organizationId?: string;
};

export const runOutreach = async (options: RunOutreachOptions = {}): Promise<void> => {
  console.log("[runOutreach] Starting outreach job");

  const resolutionPaused = isMigrationControlPaused("linkedinResolution");
  const outboundPaused = isMigrationControlPaused("linkedinOutbound");
  if (resolutionPaused && outboundPaused) {
    console.warn("[runOutreach] LinkedIn resolution and outbound are paused; job skipped");
    return;
  }

  // Unipile is connected per organization: each organization's accounts run in
  // that organization's own scope, and one failing does not stop the others.
  const organizationIds = options.organizationId ? [options.organizationId] : await unipileOrganizationIds();
  for (const organizationId of organizationIds) {
    try {
      await runInOrganization(organizationId, () => runOrganizationOutreach(resolutionPaused, outboundPaused));
    } catch (err) {
      console.error(`[runOutreach] Organization ${organizationId} failed: ${serializeError(err)}`);
    }
  }
};

const runOrganizationOutreach = async (resolutionPaused: boolean, outboundPaused: boolean): Promise<void> => {
  if (!(await isPlatformConnected("unipile"))) {
    console.log("[runOutreach] Unipile is not connected — skipping");
    return;
  }

  // Sync account statuses from Unipile before running the pipeline
  await syncAllAccounts();

  const accounts = await db
    .select()
    .from(linkedInAccounts)
    .where(and(inOrg(linkedInAccounts), eq(linkedInAccounts.status, "CONNECTED"), eq(linkedInAccounts.limitReached, false)));

  if (accounts.length === 0) {
    console.log("[runOutreach] No active LinkedIn accounts, stopping");
    return;
  }

  console.log(`[runOutreach] Running pipeline for ${accounts.length} account(s)`);
  const rules = await channelRules("linkedin");

  // Accounts work at any time of day, every day: sending hours were removed
  // (an account's old work* fields are ignored). Pacing is the rest between
  // runs, the run sizes and the daily invitation limits.
  for (const account of accounts) {
    console.log(`[runOutreach] ── Account: ${account.username} ──`);

    if (!isAccountRunnable(account.nextAllowedRun)) {
      console.log(
        `[runOutreach] Cooldown active — next allowed run ${formatNextAllowedRun(account.nextAllowedRun)} — skipping`
      );
      continue;
    }

    if (resolutionPaused) {
      console.warn(`[runOutreach] Profile resolution paused for @${account.username}`);
    } else {
      await resolveProfiles(account);
    }
    if (outboundPaused) {
      console.warn(`[runOutreach] LinkedIn outbound paused for @${account.username}`);
      continue;
    }
    await sendInvitations(account);
    await sendFollowUps(account);

    const nextAllowedRun = computeNextAllowedRun(new Date(), rules.runGapMinutes);
    await db
      .update(linkedInAccounts)
      .set({ nextAllowedRun })
      .where(and(inOrg(linkedInAccounts), eq(linkedInAccounts.id, account.id)));
    console.log(
      `[runOutreach] Scheduled next run for @${account.username} after ${formatNextAllowedRun(nextAllowedRun)}`
    );
  }
};

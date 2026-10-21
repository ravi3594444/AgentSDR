import { isPlatformConnected } from "@/lib/platform/credentials";
import { and, eq, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { linkedInAccounts } from "@/lib/linkedin/schema";
import { getLinkedInAccounts, getProfile } from "@/services/unipile.service";
import { serializeError } from "@/lib/linkedin/serializeError";
import { currentOrganizationId, inOrg, maybeCurrentOrganizationId, runInOrganization } from "@/lib/tenancy/scope";
import { unipileOrganizationIds } from "@/lib/linkedin/organizations.server";

/**
 * Sync the LinkedIn accounts of Unipile workspaces into LinkedInAccount.
 *
 * Unipile is connected per organization, so this is per organization too:
 * inside an organization scope (a session route, a webhook) it syncs that
 * organization's workspace only; outside one (the outreach worker) it walks
 * every organization that has Unipile connected, each in its own scope.
 * One organization failing does not stop the others.
 */
export const syncAllAccounts = async (): Promise<void> => {
  if (maybeCurrentOrganizationId()) {
    await syncOrganizationAccounts();
    return;
  }
  for (const organizationId of await unipileOrganizationIds()) {
    try {
      await runInOrganization(organizationId, syncOrganizationAccounts);
    } catch (err) {
      console.error(`[syncAllAccounts] Organization ${organizationId} failed: ${serializeError(err)}`);
    }
  }
};

const syncOrganizationAccounts = async (): Promise<void> => {
  if (!(await isPlatformConnected("unipile"))) {
    console.log("[syncAllAccounts] Unipile is not connected — skipping");
    return;
  }

  console.log("[syncAllAccounts] Syncing accounts from Unipile");

  const accounts = await getLinkedInAccounts();

  if (accounts.length === 0) {
    console.log("[syncAllAccounts] No LinkedIn accounts found in Unipile");
    return;
  }

  for (const acc of accounts) {
    const status = acc.status === "CONNECTED" ? ("CONNECTED" as const) : ("DISCONNECTED" as const);

    // Match by linkedinId first; fall back to username so a reconnected account
    // (new Unipile ID, same username) updates in place rather than creating a duplicate.
    const [existing] = await db
      .select()
      .from(linkedInAccounts)
      .where(
        and(
          inOrg(linkedInAccounts),
          or(
            eq(linkedInAccounts.linkedinId, acc.linkedinId),
            eq(linkedInAccounts.username, acc.username)
          )
        )
      )
      .limit(1);

    if (!existing) {
      // A Unipile account id belongs to exactly one organization; never adopt
      // or duplicate one that another organization already holds.
      const [heldElsewhere] = await db
        .select({ id: linkedInAccounts.id })
        .from(linkedInAccounts)
        .where(eq(linkedInAccounts.linkedinId, acc.linkedinId))
        .limit(1);
      if (heldElsewhere) {
        console.warn(`[syncAllAccounts] ${acc.username} (${acc.linkedinId}) is already held by another organization — skipping`);
        continue;
      }
    }

    let savedId: string;

    if (existing) {
      await db
        .update(linkedInAccounts)
        .set({ linkedinId: acc.linkedinId, name: acc.name, username: acc.username, status })
        .where(and(inOrg(linkedInAccounts), eq(linkedInAccounts.id, existing.id)));
      if (existing.linkedinId !== acc.linkedinId) {
        console.log(`[syncAllAccounts] ${acc.username} — linkedinId updated (${existing.linkedinId} → ${acc.linkedinId})`);
      }
      savedId = existing.id;
    } else {
      // updatedAt has no database default (Prisma set it client-side), so an
      // INSERT must supply it explicitly or it violates NOT NULL. No working
      // hours: an account works at any time.
      const [created] = await db
        .insert(linkedInAccounts)
        .values({
          organizationId: currentOrganizationId(),
          linkedinId: acc.linkedinId,
          name: acc.name,
          username: acc.username,
          status,
          updatedAt: new Date(),
        })
        .returning({ id: linkedInAccounts.id });
      savedId = created.id;
    }

    console.log(`[syncAllAccounts] ${acc.username} (${acc.linkedinId}) — ${status}`);

    // Fetch own profile picture + headline only when not yet stored
    const needsProfile = !existing?.profilePictureUrl;
    if (needsProfile && status === "CONNECTED") {
      try {
        const profile = await getProfile(
          `https://www.linkedin.com/in/${acc.username}`,
          acc.linkedinId,
        );
        const isPremium = !!profile.leadData?.is_premium;
        await db
          .update(linkedInAccounts)
          .set({
            profilePictureUrl: profile.profilePictureUrl,
            headline: profile.headline,
            profileData: profile.leadData,
            isPremium,
          })
          .where(and(inOrg(linkedInAccounts), eq(linkedInAccounts.id, savedId)));
        console.log(`[syncAllAccounts] ${acc.username} — own profile fetched`);
      } catch (err) {
        console.error(`[syncAllAccounts] Failed to fetch own profile for ${acc.username}: ${serializeError(err)}`);
      }
    }
  }

  console.log(`[syncAllAccounts] Synced ${accounts.length} account(s)`);
};

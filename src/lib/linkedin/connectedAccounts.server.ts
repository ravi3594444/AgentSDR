import "server-only";

import { and, count, desc, eq, exists, gte, isNotNull, isNull, lt, notExists, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { campaignAccounts, campaigns as campaignsTable, leads, linkedInAccounts } from "@/lib/linkedin/schema";
import { inOrg } from "@/lib/tenancy/scope";
import { MAX_LEAD_RETRIES } from "@/lib/linkedin/inviteRetry";

const todayStart = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

/** Everything the Connected accounts list needs: rows, today's sends, pending leads. */
export async function loadConnectedAccounts() {
  const [allAccounts, dailyCounts] = await Promise.all([
    // `linkedInAccountListSelect` — excludes the heavy profileData JSON.
    db
      .select({
        id: linkedInAccounts.id,
        username: linkedInAccounts.username,
        name: linkedInAccounts.name,
        profilePictureUrl: linkedInAccounts.profilePictureUrl,
        headline: linkedInAccounts.headline,
        status: linkedInAccounts.status,
        limitReached: linkedInAccounts.limitReached,
        isPremium: linkedInAccounts.isPremium,
        dailyInviteLimit: linkedInAccounts.dailyInviteLimit,
        nextAllowedRun: linkedInAccounts.nextAllowedRun,
      })
      .from(linkedInAccounts)
      .where(inOrg(linkedInAccounts))
      .orderBy(desc(linkedInAccounts.createdAt)),
    db
      .select({ linkedinAccountId: leads.linkedinAccountId, sentToday: count(leads.id) })
      .from(leads)
      .where(and(inOrg(leads), isNotNull(leads.linkedinAccountId), gte(leads.requestSentAt, todayStart())))
      .groupBy(leads.linkedinAccountId),
  ]);

  const sentTodayMap: Record<string, number> = {};
  for (const row of dailyCounts) {
    if (row.linkedinAccountId) sentTodayMap[row.linkedinAccountId] = row.sentToday;
  }

  // Prisma's nested relation filters become correlated EXISTS subqueries:
  //   { campaign: { status: ACTIVE, accounts: { none: {} } } }
  //     → an ACTIVE campaign with no CampaignAccount rows at all
  //   { campaign: { status: ACTIVE, accounts: { some: { linkedinAccountId } } } }
  //     → an ACTIVE campaign with a CampaignAccount row for this account
  const pendingCounts = await Promise.all(
    allAccounts.map(async (account) => {
      const [{ pending }] = await db
        .select({ pending: count() })
        .from(leads)
        .where(
          and(
            inOrg(leads),
            eq(leads.status, "PENDING"),
            lt(leads.inviteRetryCount, MAX_LEAD_RETRIES),
            or(
              isNull(leads.campaignId),
              exists(
                db
                  .select({ one: sql`1` })
                  .from(campaignsTable)
                  .where(
                    and(
                      eq(campaignsTable.id, leads.campaignId),
                      eq(campaignsTable.status, "ACTIVE"),
                      notExists(
                        db
                          .select({ one: sql`1` })
                          .from(campaignAccounts)
                          .where(eq(campaignAccounts.campaignId, campaignsTable.id))
                      )
                    )
                  )
              ),
              exists(
                db
                  .select({ one: sql`1` })
                  .from(campaignsTable)
                  .where(
                    and(
                      eq(campaignsTable.id, leads.campaignId),
                      eq(campaignsTable.status, "ACTIVE"),
                      exists(
                        db
                          .select({ one: sql`1` })
                          .from(campaignAccounts)
                          .where(
                            and(
                              eq(campaignAccounts.campaignId, campaignsTable.id),
                              eq(campaignAccounts.linkedinAccountId, account.id)
                            )
                          )
                      )
                    )
                  )
              )
            )
          )
        );
      return { accountId: account.id, count: pending };
    })
  );
  const pendingLeadsMap = Object.fromEntries(
    pendingCounts.map((row) => [row.accountId, row.count])
  );

  const accountRows = allAccounts.map((a) => ({
    ...a,
    nextAllowedRun: a.nextAllowedRun?.toISOString() ?? null,
  }));

  return { accountRows, sentTodayMap, pendingLeadsMap };
}

import "server-only";

import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { currentOrganizationId } from "@/lib/tenancy/scope";
import type { NavBadges } from "@/components/nav/navConfig";
import { newRepliesCount, openWorkCount } from "@/lib/activity/activity.server";
import { crmActionQueueCountSql, crmInboxCountSql } from "@/lib/crm/actionGroups.server";

/**
 * The one statement behind the sidebar's counts. Action required is the
 * queue's own condition (crmActionQueueCountSql), so the badge always equals
 * the Action required list's count — not every `action_required` row, which
 * left out the errors and due follow-ups the list shows. The Inbox badge is
 * likewise the Inbox's own Needs you (crmInboxCountSql).
 */
export function navBadgesSql(org: string): SQL {
  return sql`
    SELECT
      ${crmActionQueueCountSql(org)} AS action_required,
      ${crmInboxCountSql(org)} AS inbox,
      (SELECT count(*) FROM whatsapp_chats c WHERE c.unread_count > 0
        AND c.account_id IN (SELECT id FROM whatsapp_accounts WHERE organization_id = ${org}))::int AS whatsapp_unread,
      (SELECT count(*) FROM crm_drafts d WHERE d.status = 'awaiting_review'
        AND d.crm_record_id IN (SELECT id FROM crm_records WHERE organization_id = ${org}))::int AS drafts,
      (SELECT count(*) FROM outreach_mailboxes WHERE organization_id = ${org} AND status = 'failed')::int
        + (SELECT count(*) FROM "LinkedInAccount" WHERE "organizationId" = ${org} AND status = 'DISCONNECTED')::int
        + (SELECT count(*) FROM whatsapp_accounts WHERE organization_id = ${org} AND status <> 'connected')::int
        + (SELECT count(*) FROM instagram_accounts WHERE organization_id = ${org} AND status <> 'connected')::int AS accounts,
      (SELECT count(*) FROM owner_decisions WHERE organization_id = ${org} AND status = 'open'
        AND kind NOT IN ('interested', 'opt_out'))::int AS needs_you`;
}

/**
 * The sidebar's live counts for the current organization, in one statement so
 * the sidebar's poll costs a single pooled connection for a moment. Shared by
 * GET /api/nav/badges and the Getting Started page.
 */
export async function loadNavBadges(userId: string | null = null): Promise<NavBadges> {
  const org = currentOrganizationId();
  const [newReplies, openWork] = await Promise.all([newRepliesCount(userId), openWorkCount()]);
  const [row] = await db.execute<Record<string, number>>(navBadgesSql(org));
  const n = (v: unknown) => Number(v ?? 0) || 0;
  return {
    actionRequired: n(row?.action_required),
    inbox: n(row?.inbox),
    whatsappUnread: n(row?.whatsapp_unread),
    draftsAwaitingReview: n(row?.drafts),
    accountsNeedingAttention: n(row?.accounts),
    needsYou: n(row?.needs_you),
    newReplies,
    openWork,
  };
}

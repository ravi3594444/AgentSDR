import "server-only";

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { currentOrganizationId } from "@/lib/tenancy/scope";
import type { NavBadges } from "@/components/nav/navConfig";

/**
 * The sidebar's live counts for the current organization, in one statement so
 * the sidebar's poll costs a single pooled connection for a moment. Shared by
 * GET /api/nav/badges and the Getting Started page.
 */
export async function loadNavBadges(): Promise<NavBadges> {
  const org = currentOrganizationId();
  const [row] = await db.execute<Record<string, number>>(sql`
    SELECT
      (SELECT count(*) FROM crm_records WHERE organization_id = ${org} AND workflow_state = 'action_required')::int AS action_required,
      (SELECT count(*) FROM whatsapp_chats c WHERE c.unread_count > 0
        AND c.account_id IN (SELECT id FROM whatsapp_accounts WHERE organization_id = ${org}))::int AS whatsapp_unread,
      (SELECT count(*) FROM crm_drafts d WHERE d.status = 'awaiting_review'
        AND d.crm_record_id IN (SELECT id FROM crm_records WHERE organization_id = ${org}))::int AS drafts,
      (SELECT count(*) FROM outreach_mailboxes WHERE organization_id = ${org} AND status = 'failed')::int
        + (SELECT count(*) FROM "LinkedInAccount" WHERE "organizationId" = ${org} AND status = 'DISCONNECTED')::int
        + (SELECT count(*) FROM whatsapp_accounts WHERE organization_id = ${org} AND status <> 'connected')::int AS accounts`);
  const n = (v: unknown) => Number(v ?? 0) || 0;
  return {
    actionRequired: n(row?.action_required),
    whatsappUnread: n(row?.whatsapp_unread),
    draftsAwaitingReview: n(row?.drafts),
    accountsNeedingAttention: n(row?.accounts),
  };
}

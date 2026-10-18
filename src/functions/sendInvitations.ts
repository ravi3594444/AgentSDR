import { isPlatformConnected } from "@/lib/platform/credentials";
import { and, asc, eq, exists, gte, ne, sql, count as sqlCount } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, people } from "@/lib/leads/schema";
import { personVariables } from "@/lib/leads/variables";
import { fillTemplate } from "@/lib/outreach/render";
import { campaigns, leads, linkedInAccounts, messages } from "@/lib/linkedin/schema";
import { extractApiErrorDetail, serializeError } from "@/lib/linkedin/serializeError";
import {
  isInvitationMessageTooLong,
  MAX_INVITATION_MESSAGE_LENGTH,
  invitationMessageLength,
} from "@/lib/linkedin/invitationMessage";
import { resetLeadRetryCount } from "@/lib/linkedin/inviteRetry.server";
import { logInviteSendDiagnostics } from "@/lib/linkedin/logInvitePipelineDiagnostics";
import { pendingLeadsSendableByAccount } from "@/lib/linkedin/leadOutreachEligibility";
import { sendConnectionRequest } from "@/services/unipile.service";
import { UnsuccessfulRequestError } from "unipile-node-sdk";
import type { LinkedInAccount } from "@/lib/linkedin/schema";
import { isPersonDoNotContact } from "@/lib/crm/policies";
import { linkedinRouteIsWrong } from "@/lib/crm/wrongRoutes";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { channelRules } from "@/lib/channels/rules.server";
import { pickInRange } from "@/lib/channels/rules";

// Daily limits, run sizes and delays come from Settings → LinkedIn → Sending
// rules (src/lib/channels/rules.ts); an account's own dailyInviteLimit wins.

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

const getTodayStart = (): Date => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

const isAccountLimitError = (err: unknown): boolean => {
  if (!(err instanceof UnsuccessfulRequestError)) return false;
  const message = extractApiErrorDetail(err.body);
  return (
    message.toLowerCase().includes("limit") ||
    message.toLowerCase().includes("quota") ||
    message.toLowerCase().includes("invitation_limit") ||
    message.toLowerCase().includes("weekly")
  );
};

export const sendInvitations = async (account: LinkedInAccount): Promise<void> => {
  if (!(await isPlatformConnected("unipile"))) {
    console.log("[sendInvitations] Unipile is not connected — skipping");
    return;
  }

  const rules = await channelRules("linkedin");
  const maxPerDay = account.dailyInviteLimit ?? (account.isPremium ? rules.invitesPerDayPremium : rules.invitesPerDayFree);
  console.log(`[sendInvitations] Processing account ${account.username} (${account.isPremium ? "premium" : "free"}, limit: ${maxPerDay}/day)`);

  const [{ n: sentTodayCount }] = await db
    .select({ n: sqlCount() })
    .from(leads)
    .where(
      and(
        inOrg(leads),
        eq(leads.linkedinAccountId, account.id),
        ne(leads.status, "PENDING"),
        gte(leads.requestSentAt, getTodayStart())
      )
    );

  const remainingToday = maxPerDay - sentTodayCount;
  if (remainingToday <= 0) {
    console.log(`[sendInvitations] Daily cap reached for ${account.username}, skipping`);
    return;
  }

  const sessionSize = Math.min(
    pickInRange(rules.invitesPerRun),
    remainingToday
  );

  // Fetch candidates ordered by campaign age (oldest first), then lead age (oldest first).
  // This guarantees FIFO within each campaign and that older campaigns always get priority.
  // Leads with no campaign sort last (PostgreSQL: NULL sorts after all non-null ASC values).
  // The campaign-age ordering needs the joined Campaign row, so this is a
  // leftJoin (campaignId is nullable) selecting only the lead columns.
  const pendingLeads = (
    await db
      .select({ lead: leads, person: people, company: companies, campaignInvitationMessage: campaigns.invitationMessage })
      .from(leads)
      .innerJoin(people, eq(leads.personId, people.id))
      .leftJoin(companies, eq(people.companyId, companies.id))
      .leftJoin(campaigns, eq(leads.campaignId, campaigns.id))
      .where(await pendingLeadsSendableByAccount(account.id))
      .orderBy(asc(campaigns.createdAt), asc(leads.createdAt))
      .limit(sessionSize)
  ).map((r) => ({ ...r.lead, invitationMessage: r.campaignInvitationMessage ?? r.lead.invitationMessage, linkedinUrl: r.person.linkedinUrl!, variables: personVariables(r.person, r.company) }));

  if (pendingLeads.length === 0) {
    console.log(`[sendInvitations] No pending leads with resolved profiles for @${account.username}`);
    await logInviteSendDiagnostics(account.username, account.id);
    return;
  }

  console.log(
    `[sendInvitations] Sending up to ${pendingLeads.length} requests (${sentTodayCount}/${maxPerDay} used today)`
  );

  for (const lead of pendingLeads) {
    const personId = lead.personId!; // eligibility + inner join guarantee this
    const providerId = lead.providerId!;
    const invitationMessage = fillTemplate(lead.invitationMessage ?? "", lead.variables);

    if (isInvitationMessageTooLong(invitationMessage)) {
      console.warn(
        `[sendInvitations] Skipping ${lead.linkedinUrl}: invitation message is ${invitationMessageLength(invitationMessage)} characters (max ${MAX_INVITATION_MESSAGE_LENGTH})`
      );
      await db.update(leads).set({ status: "FAILED" }).where(and(inOrg(leads), eq(leads.id, lead.id)));
      continue;
    }

    // Atomically claim the lead before touching Unipile.
    // If another account (in a shared campaign) already claimed it, the
    // conditional UPDATE matches no row and returns [] — skip.
    const claimed = await db.transaction(async (tx) => {
      // Serialize every claim for this sender/person pair, then recheck after
      // acquiring the lock. This closes the cross-campaign same-batch race.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${account.id}:${personId}`}, 0))`);
      const contacted = await tx.select({ id: leads.id }).from(leads).where(and(
        inOrg(leads),
        eq(leads.personId, personId),
        eq(leads.linkedinAccountId, account.id),
        ne(leads.status, "PENDING"),
      )).limit(1);
      if (contacted.length) return null;
      const leadClaim = await tx
        .update(leads)
        .set({ status: "REQUEST_SENT", linkedinAccountId: account.id, requestSentAt: new Date() })
        .where(and(
          inOrg(leads),
          eq(leads.id, lead.id),
          eq(leads.status, "PENDING"),
          exists(db.select({ id: campaigns.id }).from(campaigns).where(and(
            eq(campaigns.id, leads.campaignId),
            eq(campaigns.status, "ACTIVE"),
          ))),
        ))
        .returning({ id: leads.id });
      if (!leadClaim.length) return null;
      const [messageClaim] = await tx.insert(messages).values({
        organizationId: currentOrganizationId(),
        type: "INVITATION",
        text: invitationMessage,
        leadId: lead.id,
        seen: true,
      }).onConflictDoNothing().returning({ id: messages.id });
      return { messageId: messageClaim?.id ?? null };
    });

    if (!claimed?.messageId) {
      console.log(`[sendInvitations] Lead ${lead.linkedinUrl} already claimed or requires provider reconciliation, skipping`);
      continue;
    }

    // The claim is local and recoverable; check global DNC at the last safe
    // point before Unipile and remove the unsent claim when contact is barred.
    const barred = await isPersonDoNotContact(db, personId) ? "Person-global DNC"
      : await linkedinRouteIsWrong(db, personId, lead.linkedinUrl) ? "a wrong-number record" : null;
    if (barred) {
      await db.transaction(async (tx) => {
        await tx.delete(messages).where(and(inOrg(messages), eq(messages.id, claimed.messageId!)));
        await tx.update(leads).set({ status: "FAILED" }).where(and(inOrg(leads), eq(leads.id, lead.id)));
      });
      console.warn(`[sendInvitations] ${lead.linkedinUrl} blocked by ${barred}`);
      continue;
    }

    try {
      const linkedinMessageId = await sendConnectionRequest(providerId, invitationMessage, account.linkedinId);
      if (!linkedinMessageId) {
        throw new Error("Unipile accepted the invitation without returning an invitation_id");
      }

      await db.update(messages).set({ linkedinMessageId }).where(and(inOrg(messages), eq(messages.id, claimed.messageId)));

      await resetLeadRetryCount(lead.id);

      console.log(`[sendInvitations] Request sent to ${lead.linkedinUrl} (${providerId})`);

      const delay = pickInRange(rules.inviteDelaySeconds) * 1000;
      await sleep(delay);
    } catch (err) {
      if (isAccountLimitError(err)) {
        console.warn(`[sendInvitations] Account limit reached for ${account.username} — pausing for today`);
        // Revert the claim so the lead can be picked up by another account or next day
        await db
          .update(leads)
          .set({ status: "PENDING", linkedinAccountId: null, requestSentAt: null })
          .where(and(inOrg(leads), eq(leads.id, lead.id)));
        await db.delete(messages).where(and(
          inOrg(messages),
          eq(messages.id, claimed.messageId),
          sql`${messages.linkedinMessageId} is null`,
        ));
        await db
          .update(linkedInAccounts)
          .set({ limitReached: true })
          .where(and(inOrg(linkedInAccounts), eq(linkedInAccounts.id, account.id)));
        break;
      } else {
        console.error(`[sendInvitations] Failed for ${lead.linkedinUrl}: ${serializeError(err)}`);
        // The provider may have accepted the invitation before the transport
        // failed. Keep both Lead and Message claims so no automated retry can
        // create a duplicate; an operator must reconcile this provider state.
      }
    }
  }
};

import "server-only";

/**
 * The WhatsApp campaign sender. Each tick, per organization with Unipile
 * connected and inside its campaign sending hours, every connected number
 * assigned to an active campaign sends at most one message: the next due
 * lead's next step. Spec: docs/whatsapp-campaigns/plan.md ("Sender loop").
 *
 * Safety: each (lead, step) is claimed by a row in whatsapp_campaign_sends
 * before anything is sent, so a crash can never cause a second send. A claim
 * left in `sending` means delivery is uncertain and the lead is failed for a
 * person to check, never retried.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { channelRules } from "@/lib/channels/rules.server";
import { companies, people } from "@/lib/leads/schema";
import { unipileOrganizationIds } from "@/lib/linkedin/organizations.server";
import { isMigrationControlPaused } from "@/lib/migration/controls";
import { isPlatformConnected } from "@/lib/platform/credentials";
import { currentOrganizationId, inOrg, runInOrganization } from "@/lib/tenancy/scope";
import { WHATSAPP_CAMPAIGN_OPEN_LEAD_STATUSES } from "./contract";
import {
  classifySendError,
  emptyMessageError,
  IN_FLIGHT_CLAIM_MS,
  planAfterSend,
  planTransientRetry,
  sequenceExhausted,
  uncertainDeliveryMessage,
  withinCampaignSendingHours,
  type SendFailureAction,
} from "./engineRules";
import { campaignLeadVariables, renderCampaignStep } from "./render";
import { chatInOrg } from "../messages";
import {
  whatsappAccounts,
  whatsappCampaignAccounts,
  whatsappCampaignLeads,
  whatsappCampaigns,
  whatsappCampaignSends,
  whatsappChats,
  whatsappMessages,
} from "../schema";
import { sendWhatsapp } from "../send";

export type WhatsappCampaignTickResult = {
  organizations: number;
  sent: number;
  failed: number;
  skipped: number;
  replied: number;
};

type SendFunction = typeof sendWhatsapp;
type LeadRow = typeof whatsappCampaignLeads.$inferSelect;
type Steps = (typeof whatsappCampaigns.$inferSelect)["steps"];

/** Most leads examined for one number in one tick, a guard against a loop that never reaches a send. */
const MAX_PICKS_PER_ACCOUNT = 50;
export async function runWhatsappCampaignTick(
  options: { now?: Date; send?: SendFunction } = {},
): Promise<WhatsappCampaignTickResult> {
  const result: WhatsappCampaignTickResult = { organizations: 0, sent: 0, failed: 0, skipped: 0, replied: 0 };
  if (isMigrationControlPaused("whatsappOutbound")) {
    console.warn("[whatsapp/campaigns] WhatsApp outbound is paused; tick skipped");
    return result;
  }
  const now = options.now ?? new Date();
  const send = options.send ?? sendWhatsapp;

  for (const organizationId of await unipileOrganizationIds()) {
    try {
      const ran = await runInOrganization(organizationId, () => tickOrganization(result, now, send));
      if (ran) result.organizations += 1;
    } catch (error) {
      console.error(`[whatsapp/campaigns] organization ${organizationId} tick failed:`, error);
      result.failed += 1;
    }
  }
  return result;
}

/** Returns false when the organization was skipped. */
async function tickOrganization(result: WhatsappCampaignTickResult, now: Date, send: SendFunction): Promise<boolean> {
  if (!(await isPlatformConnected("unipile"))) return false;
  const rules = await channelRules("whatsapp");
  if (!withinCampaignSendingHours(rules.sendingHours, now)) return false;

  const activeCampaigns = db
    .select({ id: whatsappCampaigns.id })
    .from(whatsappCampaigns)
    .where(and(inOrg(whatsappCampaigns), eq(whatsappCampaigns.status, "active"), isNull(whatsappCampaigns.archivedAt)));

  const accounts = await db
    .select()
    .from(whatsappAccounts)
    .where(and(
      inOrg(whatsappAccounts),
      eq(whatsappAccounts.status, "connected"),
      inArray(
        whatsappAccounts.id,
        db.select({ id: whatsappCampaignAccounts.accountId }).from(whatsappCampaignAccounts).where(inArray(whatsappCampaignAccounts.campaignId, activeCampaigns)),
      ),
    ))
    .orderBy(asc(whatsappAccounts.createdAt));

  for (const account of accounts) {
    const outcome = await tickAccount(account, now, send, result);
    if (outcome === "stop_organization") break;
  }
  return true;
}

async function pickDueLead(accountId: string, now: Date, includeFirstMessages: boolean): Promise<(LeadRow & { steps: Steps }) | null> {
  const [row] = await db
    .select({ lead: whatsappCampaignLeads, steps: whatsappCampaigns.steps })
    .from(whatsappCampaignLeads)
    .innerJoin(whatsappCampaigns, eq(whatsappCampaigns.id, whatsappCampaignLeads.campaignId))
    .where(and(
      inOrg(whatsappCampaigns),
      eq(whatsappCampaigns.status, "active"),
      isNull(whatsappCampaigns.archivedAt),
      inArray(whatsappCampaignLeads.status, [...WHATSAPP_CAMPAIGN_OPEN_LEAD_STATUSES]),
      lte(whatsappCampaignLeads.nextSendAt, now),
      includeFirstMessages ? undefined : sql`${whatsappCampaignLeads.currentStep} > 0`,
      sql`(${whatsappCampaignLeads.accountId} = ${accountId} or (${whatsappCampaignLeads.accountId} is null and exists (
        select 1 from ${whatsappCampaignAccounts} ca
        where ca.campaign_id = ${whatsappCampaignLeads.campaignId} and ca.account_id = ${accountId}
      )))`,
    ))
    .orderBy(
      sql`(${whatsappCampaignLeads.currentStep} > 0) desc`,
      asc(whatsappCampaignLeads.nextSendAt),
      asc(whatsappCampaignLeads.createdAt),
    )
    .limit(1);
  return row ? { ...row.lead, steps: row.steps } : null;
}

type AccountOutcome = "done" | "stop_organization";

async function tickAccount(
  account: typeof whatsappAccounts.$inferSelect,
  now: Date,
  send: SendFunction,
  result: WhatsappCampaignTickResult,
): Promise<AccountOutcome> {
  let includeFirstMessages = true;
  for (let picks = 0; picks < MAX_PICKS_PER_ACCOUNT; picks += 1) {
    const lead = await pickDueLead(account.id, now, includeFirstMessages);
    if (!lead) return "done";
    let step: StepOutcome;
    try {
      step = await processLead(lead, account, now, send, result);
    } catch (error) {
      console.error(`[whatsapp/campaigns] lead ${lead.id} failed unexpectedly:`, error);
      result.failed += 1;
      return "done";
    }
    switch (step) {
      case "sent":
      case "stop_account":
        return "done";
      case "stop_organization":
        return "stop_organization";
      case "block_first_messages":
        // Only a first message can hit these refusals; retry once for a follow-up.
        if (!includeFirstMessages) return "done";
        includeFirstMessages = false;
        break;
      case "continue":
        break;
    }
  }
  return "done";
}

type StepOutcome = "sent" | "continue" | "stop_account" | "block_first_messages" | "stop_organization";

const openLead = (leadId: string) =>
  and(eq(whatsappCampaignLeads.id, leadId), inArray(whatsappCampaignLeads.status, [...WHATSAPP_CAMPAIGN_OPEN_LEAD_STATUSES]));

/** Updates a lead only while it is still queued/in_sequence, so a reply or a stop that landed meanwhile wins. */
async function updateOpenLead(leadId: string, set: Partial<typeof whatsappCampaignLeads.$inferInsert>, now: Date): Promise<boolean> {
  const rows = await db
    .update(whatsappCampaignLeads)
    .set({ ...set, updatedAt: now })
    .where(and(
      openLead(leadId),
      // Inherited tenancy: the lead's campaign must be this organization's.
      inArray(whatsappCampaignLeads.campaignId, db.select({ id: whatsappCampaigns.id }).from(whatsappCampaigns).where(inOrg(whatsappCampaigns))),
    ))
    .returning({ id: whatsappCampaignLeads.id });
  return rows.length > 0;
}

async function deleteClaim(claimId: string): Promise<void> {
  await db.delete(whatsappCampaignSends).where(and(eq(whatsappCampaignSends.id, claimId), eq(whatsappCampaignSends.status, "sending")));
}

async function failClaim(claimId: string, error: string): Promise<void> {
  await db.update(whatsappCampaignSends).set({ status: "failed", error }).where(eq(whatsappCampaignSends.id, claimId));
}

async function processLead(
  picked: LeadRow & { steps: Steps },
  account: typeof whatsappAccounts.$inferSelect,
  now: Date,
  send: SendFunction,
  result: WhatsappCampaignTickResult,
): Promise<StepOutcome> {
  const steps = picked.steps;

  if (sequenceExhausted(steps, picked.currentStep)) {
    await updateOpenLead(picked.id, { status: "completed", nextSendAt: null }, now);
    result.skipped += 1;
    return "continue";
  }
  const stepIndex = picked.currentStep;
  const step = steps[stepIndex]!;

  // Merge fields: the Person, their company, then the lead's own columns.
  const [person] = await db
    .select({ person: people, company: companies })
    .from(people)
    .leftJoin(companies, eq(people.companyId, companies.id))
    .where(and(inOrg(people), eq(people.id, picked.personId)))
    .limit(1);
  if (!person) {
    await updateOpenLead(picked.id, { status: "failed", lastError: "The person is no longer in this organization" }, now);
    result.failed += 1;
    return "continue";
  }
  const text = renderCampaignStep(step.body, campaignLeadVariables(person.person, person.company, picked.customFields ?? {}));

  // Claim: lock the lead, then insert the (lead, step) send row.
  const claim = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(whatsappCampaignLeads)
      .where(and(
        openLead(picked.id),
        eq(whatsappCampaignLeads.currentStep, stepIndex),
        lte(whatsappCampaignLeads.nextSendAt, now),
        // Re-checked under the lock: a campaign paused or archived after this
        // tick picked the lead must not send it.
        inArray(
          whatsappCampaignLeads.campaignId,
          tx.select({ id: whatsappCampaigns.id }).from(whatsappCampaigns)
            .where(and(inOrg(whatsappCampaigns), eq(whatsappCampaigns.status, "active"), isNull(whatsappCampaigns.archivedAt))),
        ),
      ))
      .for("update", { skipLocked: true });
    if (!locked) return { kind: "lost" as const };
    const [inserted] = await tx
      .insert(whatsappCampaignSends)
      .values({ leadId: picked.id, step: stepIndex, stepId: step.id, status: "sending", accountId: account.id, body: text })
      .onConflictDoNothing()
      .returning({ id: whatsappCampaignSends.id });
    if (inserted) return { kind: "claimed" as const, id: inserted.id };
    const [existing] = await tx
      .select()
      .from(whatsappCampaignSends)
      .where(and(eq(whatsappCampaignSends.leadId, picked.id), eq(whatsappCampaignSends.step, stepIndex)))
      .limit(1);
    return { kind: "existing" as const, row: existing! };
  });

  if (claim.kind === "lost") {
    result.skipped += 1;
    return "continue";
  }
  if (claim.kind === "existing") {
    if (claim.row.status === "sent") {
      // The message went out but the lead was not advanced: repair its position.
      const sentAt = claim.row.sentAt ?? now;
      const plan = planAfterSend(steps, stepIndex, sentAt);
      await updateOpenLead(picked.id, {
        currentStep: stepIndex + 1,
        accountId: claim.row.accountId ?? account.id,
        lastSentAt: sentAt,
        attempts: 0,
        lastError: null,
        status: plan.status,
        nextSendAt: plan.nextSendAt,
      }, now);
    } else if (claim.row.status === "sending" && now.getTime() - claim.row.createdAt.getTime() < IN_FLIGHT_CLAIM_MS) {
      // Another instance (a rolling deploy runs two) is sending it right now.
      result.skipped += 1;
    } else {
      await updateOpenLead(picked.id, { status: "failed", lastError: uncertainDeliveryMessage(stepIndex) }, now);
      result.failed += 1;
    }
    return "continue";
  }
  const claimId = claim.id;

  // After a transient failure the message may have gone out anyway (Unipile
  // timed out after delivering it): an identical outbound message to this
  // number since the last step counts as sent.
  if (picked.attempts > 0 && text) {
    const [delivered] = await db
      .select({ id: whatsappMessages.id, sentAt: whatsappMessages.sentAt })
      .from(whatsappMessages)
      .innerJoin(whatsappChats, eq(whatsappChats.id, whatsappMessages.chatId))
      .where(and(
        chatInOrg(),
        eq(whatsappChats.accountId, account.id),
        eq(whatsappChats.phone, picked.phone),
        eq(whatsappMessages.direction, "outbound"),
        eq(whatsappMessages.body, text),
        gte(whatsappMessages.sentAt, picked.lastSentAt ?? picked.createdAt),
      ))
      .orderBy(desc(whatsappMessages.sentAt))
      .limit(1);
    if (delivered) {
      await db
        .update(whatsappCampaignSends)
        .set({ status: "sent", whatsappMessageId: delivered.id, sentAt: delivered.sentAt })
        .where(eq(whatsappCampaignSends.id, claimId));
      const plan = planAfterSend(steps, stepIndex, delivered.sentAt);
      await updateOpenLead(picked.id, {
        currentStep: stepIndex + 1,
        accountId: account.id,
        lastSentAt: delivered.sentAt,
        attempts: 0,
        lastError: null,
        status: plan.status,
        nextSendAt: plan.nextSendAt,
      }, now);
      result.sent += 1;
      return "continue";
    }
  }

  // A message from this number's chat with the lead since enrollment: they already answered.
  const [inbound] = await db
    .select({ sentAt: whatsappMessages.sentAt })
    .from(whatsappMessages)
    .innerJoin(whatsappChats, eq(whatsappChats.id, whatsappMessages.chatId))
    .where(and(
      chatInOrg(),
      eq(whatsappMessages.direction, "inbound"),
      eq(whatsappChats.phone, picked.phone),
      gte(whatsappMessages.sentAt, picked.createdAt),
    ))
    .orderBy(asc(whatsappMessages.sentAt))
    .limit(1);
  if (inbound) {
    await updateOpenLead(picked.id, { status: "replied", repliedAt: inbound.sentAt, nextSendAt: null }, now);
    await deleteClaim(claimId);
    result.replied += 1;
    return "continue";
  }

  if (!text) {
    const error = emptyMessageError(stepIndex);
    await failClaim(claimId, error);
    await updateOpenLead(picked.id, { status: "failed", lastError: error }, now);
    result.failed += 1;
    return "continue";
  }

  let response: Awaited<ReturnType<SendFunction>>;
  try {
    response = await send({ personId: picked.personId, accountId: account.id, text });
  } catch (error) {
    return handleSendFailure(error, picked, claimId, now, result);
  }
  // Recording runs outside the try: once Unipile accepted the message, a
  // failed write here must not be read as a failed send (that deleted the
  // claim and retried the lead, a duplicate message). It throws instead,
  // the claim stays "sending", and the next tick fails the lead as uncertain.
  const sentAt = new Date();
  await db
    .update(whatsappCampaignSends)
    .set({ status: "sent", whatsappMessageId: response.message.id, sentAt })
    .where(eq(whatsappCampaignSends.id, claimId));
  const plan = planAfterSend(steps, stepIndex, sentAt);
  await updateOpenLead(picked.id, {
    currentStep: stepIndex + 1,
    accountId: account.id,
    lastSentAt: sentAt,
    attempts: 0,
    lastError: null,
    status: plan.status,
    nextSendAt: plan.nextSendAt,
  }, now);
  result.sent += 1;
  return "sent";
}

async function handleSendFailure(
  error: unknown,
  lead: LeadRow,
  claimId: string,
  now: Date,
  result: WhatsappCampaignTickResult,
): Promise<StepOutcome> {
  const action: SendFailureAction = classifySendError(error);
  const message = error instanceof Error ? error.message : String(error);
  switch (action.kind) {
    case "stop_account":
      await deleteClaim(claimId);
      result.skipped += 1;
      return "stop_account";
    case "block_first_messages":
      await deleteClaim(claimId);
      result.skipped += 1;
      return "block_first_messages";
    case "skip_account":
      await deleteClaim(claimId);
      result.skipped += 1;
      return "stop_account";
    case "stop_organization":
      await deleteClaim(claimId);
      result.skipped += 1;
      console.warn(`[whatsapp/campaigns] Unipile is not connected for organization ${currentOrganizationId()}; stopping`);
      return "stop_organization";
    case "stop_lead":
      await deleteClaim(claimId);
      await updateOpenLead(lead.id, { status: "stopped", lastError: action.error, nextSendAt: null }, now);
      result.skipped += 1;
      return "continue";
    case "fail_lead":
      await failClaim(claimId, action.error);
      await updateOpenLead(lead.id, { status: "failed", lastError: action.error }, now);
      result.failed += 1;
      return "continue";
    case "retry_later": {
      await deleteClaim(claimId);
      const plan = planTransientRetry(lead.attempts, now);
      if (plan.status === "failed") {
        await updateOpenLead(lead.id, { status: "failed", attempts: plan.attempts, lastError: message }, now);
        result.failed += 1;
      } else {
        await updateOpenLead(lead.id, { attempts: plan.attempts, nextSendAt: plan.nextSendAt, lastError: message }, now);
        result.skipped += 1;
      }
      return "continue";
    }
  }
}

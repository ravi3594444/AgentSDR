import { isPlatformConnected } from "@/lib/platform/credentials";
import { and, asc, eq, inArray, isNotNull, lt, lte, ne, or, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, people } from "@/lib/leads/schema";
import { personVariables } from "@/lib/leads/variables";
import { fillTemplate } from "@/lib/outreach/render";
import { campaigns, connections, leads as leadsTable, messages } from "@/lib/linkedin/schema";
import { sendMessage } from "@/services/unipile.service";
import type { LeadStatus, LinkedInAccount, MessageType } from "@/lib/linkedin/schema";
import { processLeadAcceptance } from "@/lib/linkedin/acceptanceMessage";
import { serializeError } from "@/lib/linkedin/serializeError";
import { MAX_LEAD_RETRIES } from "@/lib/linkedin/inviteRetry";
import { recordFollowUpSendFailure } from "@/lib/linkedin/inviteRetry.server";
import { isPersonDoNotContact } from "@/lib/crm/policies";
import { linkedinRouteIsWrong } from "@/lib/crm/wrongRoutes";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { channelRules } from "@/lib/channels/rules.server";
import { pickInRange } from "@/lib/channels/rules";

const FOLLOW_UP_1_AFTER_MS = 24 * 60 * 60 * 1000;
const FOLLOW_UP_2_AFTER_MS = 48 * 60 * 60 * 1000;
const FOLLOW_UP_3_AFTER_MS = 72 * 60 * 60 * 1000;

/** Messages per run, from Settings → LinkedIn → Sending rules. */
const followUpsPerRun = async (): Promise<number> => pickInRange((await channelRules("linkedin")).followUpsPerRun);

const hasText = (value: string | null | undefined): value is string => !!value?.trim();

/**
 * The follow-up sequence, in order. Each stage sends `messageField` to leads sitting in
 * `fromStatus`, then advances them to `toStatus` — or to COMPLETED when the next stage has
 * no message to send.
 */
type FollowUpStage = {
  label: string;
  fromStatus: LeadStatus;
  toStatus: LeadStatus;
  afterMs: number;
  messageType: MessageType;
  messageField: "followUp1Message" | "followUp2Message" | "followUp3Message";
  sentAtField: "followUp1SentAt" | "followUp2SentAt" | "followUp3SentAt";
  cutoffField: "acceptMessageSentAt" | "followUp1SentAt" | "followUp2SentAt";
  /** Message that must exist for the NEXT stage to run; null when this is the last stage. */
  nextMessageField: "followUp2Message" | "followUp3Message" | null;
};

/**
 * The stage config addresses columns by name (`stage.messageField`), which
 * Prisma accepted directly in a where/data object. Drizzle needs the column
 * object, so these maps turn a stage's field name into one.
 */
const MESSAGE_COLS = {
  followUp1Message: leadsTable.followUp1Message,
  followUp2Message: leadsTable.followUp2Message,
  followUp3Message: leadsTable.followUp3Message,
} as const;

const CAMPAIGN_MESSAGE_COLS = {
  followUp1Message: campaigns.followUp1Message,
  followUp2Message: campaigns.followUp2Message,
  followUp3Message: campaigns.followUp3Message,
} as const;

const CUTOFF_COLS = {
  acceptMessageSentAt: leadsTable.acceptMessageSentAt,
  followUp1SentAt: leadsTable.followUp1SentAt,
  followUp2SentAt: leadsTable.followUp2SentAt,
} as const;

const FOLLOW_UP_STAGES: FollowUpStage[] = [
  {
    label: "Follow-up 1",
    fromStatus: "ACCEPT_MESSAGE_SENT",
    toStatus: "FOLLOW_UP_1_SENT",
    afterMs: FOLLOW_UP_1_AFTER_MS,
    messageType: "FOLLOW_UP_1",
    messageField: "followUp1Message",
    sentAtField: "followUp1SentAt",
    cutoffField: "acceptMessageSentAt",
    nextMessageField: "followUp2Message",
  },
  {
    label: "Follow-up 2",
    fromStatus: "FOLLOW_UP_1_SENT",
    toStatus: "FOLLOW_UP_2_SENT",
    afterMs: FOLLOW_UP_2_AFTER_MS,
    messageType: "FOLLOW_UP_2",
    messageField: "followUp2Message",
    sentAtField: "followUp2SentAt",
    cutoffField: "followUp1SentAt",
    nextMessageField: "followUp3Message",
  },
  {
    label: "Follow-up 3",
    fromStatus: "FOLLOW_UP_2_SENT",
    toStatus: "FOLLOW_UP_3_SENT",
    afterMs: FOLLOW_UP_3_AFTER_MS,
    messageType: "FOLLOW_UP_3",
    messageField: "followUp3Message",
    sentAtField: "followUp3SentAt",
    cutoffField: "followUp2SentAt",
    nextMessageField: null,
  },
];

/**
 * Leads whose sequence ends here — no message for this stage — are terminal, not skippable.
 * Completing them in bulk keeps them out of every future candidate query.
 *
 * Before this existed they were re-selected every run, skipped, and re-selected again,
 * starving the batch so leads that *could* be messaged never got picked up.
 */
const completeExhaustedLeads = async (account: LinkedInAccount, stage: FollowUpStage): Promise<void> => {
  const msgCol = MESSAGE_COLS[stage.messageField];
  const campaignMsgCol = CAMPAIGN_MESSAGE_COLS[stage.messageField];
  const exhausted = await db
    .select({ id: leadsTable.id })
    .from(leadsTable)
    .innerJoin(campaigns, eq(leadsTable.campaignId, campaigns.id))
    .where(
      and(
        inOrg(leadsTable),
        eq(leadsTable.linkedinAccountId, account.id),
        eq(leadsTable.status, stage.fromStatus),
        eq(campaigns.status, "ACTIVE"),
        or(isNull(sql`coalesce(${campaignMsgCol}, ${msgCol})`), eq(sql`coalesce(${campaignMsgCol}, ${msgCol})`, ""))
      )
    );
  const completed = exhausted.length
    ? await db.update(leadsTable).set({ status: "COMPLETED" }).where(and(inOrg(leadsTable), inArray(leadsTable.id, exhausted.map((lead) => lead.id)))).returning({ id: leadsTable.id })
    : [];

  const count = completed.length;

  if (count > 0) {
    console.log(
      `[sendFollowUps] ${stage.label}: no message for ${count} lead(s) — sequence exhausted, marked COMPLETED`
    );
  }
};

const runFollowUpStage = async (account: LinkedInAccount, stage: FollowUpStage): Promise<void> => {
  // Retire exhausted leads first so they can never occupy a slot in the batch below.
  await completeExhaustedLeads(account, stage);

  const cutoff = new Date(Date.now() - stage.afterMs);

  // Only select leads that can actually be sent: message present and a chat to send it in.
  // Messages are trimmed on write, so a stored empty string means "no message".
  // Oldest first, so a lead can never be starved by newer arrivals.
  const messageCol = MESSAGE_COLS[stage.messageField];
  const campaignMessageCol = CAMPAIGN_MESSAGE_COLS[stage.messageField];
  const messageExpr = sql<string>`coalesce(${campaignMessageCol}, ${messageCol})`;
  const nextMessageExpr = stage.nextMessageField
    ? sql<string | null>`coalesce(${CAMPAIGN_MESSAGE_COLS[stage.nextMessageField]}, ${MESSAGE_COLS[stage.nextMessageField]})`
    : sql<null>`null`;
  const cutoffCol = CUTOFF_COLS[stage.cutoffField];

  // `connection: { chatId: { not: null } }` was a relation filter, so this is
  // an innerJoin: only leads that HAVE a connection with a chatId qualify.
  const leads = (
    await db
      .select({
        lead: leadsTable,
        person: people,
        company: companies,
        messageTemplate: messageExpr,
        nextMessageTemplate: nextMessageExpr,
        connection: { id: connections.id, chatId: connections.chatId },
      })
      .from(leadsTable)
      .innerJoin(people, eq(leadsTable.personId, people.id))
      .leftJoin(companies, eq(people.companyId, companies.id))
      .innerJoin(connections, eq(connections.leadId, leadsTable.id))
      .innerJoin(campaigns, eq(leadsTable.campaignId, campaigns.id))
      .where(
        and(
          inOrg(leadsTable),
          eq(leadsTable.linkedinAccountId, account.id),
          eq(leadsTable.status, stage.fromStatus),
          eq(campaigns.status, "ACTIVE"),
          lte(cutoffCol, cutoff),
          isNotNull(messageExpr),
          ne(messageExpr, ""),
          isNotNull(connections.chatId),
          lt(leadsTable.inviteRetryCount, MAX_LEAD_RETRIES)
        )
      )
      .orderBy(asc(cutoffCol))
      .limit(await followUpsPerRun())
  ).map((r) => ({ ...r.lead, messageTemplate: r.messageTemplate, nextMessageTemplate: r.nextMessageTemplate, connection: r.connection, linkedinUrl: r.person.linkedinUrl!, variables: personVariables(r.person, r.company) }));

  if (leads.length === 0) return;

  console.log(`[sendFollowUps] ${stage.label}: sending to ${leads.length} lead(s)`);

  for (const lead of leads) {
    const chatId = lead.connection?.chatId;
    const connectionId = lead.connection?.id ?? null;
    const messageTemplate = lead.messageTemplate;
    const messageText = hasText(messageTemplate) ? fillTemplate(messageTemplate, lead.variables) : messageTemplate;

    // Final trim-aware check before sending. The query above already filters these out,
    // but a whitespace-only message written by some other path would otherwise be skipped
    // here every run and never advance — the exact stall this job used to suffer from.
    // No message means the sequence is over, so complete it rather than skipping it.
    if (!hasText(messageText)) {
      await db
        .update(leadsTable)
        .set({ status: "COMPLETED" })
        .where(and(inOrg(leadsTable), eq(leadsTable.id, lead.id)));
      console.log(
        `[sendFollowUps] ${stage.label}: ${lead.linkedinUrl} has no usable message — marked COMPLETED`
      );
      continue;
    }

    // A missing chat is a delivery problem, not an exhausted sequence — retry it, but
    // count the attempt so a thread that never gets a chat eventually fails out.
    if (!chatId) {
      console.warn(`[sendFollowUps] ${stage.label}: no chatId for ${lead.linkedinUrl}, will retry`);
      await recordFollowUpSendFailure(lead.id);
      continue;
    }

    // The batch was selected before the first send; a reply or a pause since
    // then must stop this lead before anything is claimed or sent.
    if (!(await stillDueForStage(lead.id, stage.fromStatus))) {
      console.log(`[sendFollowUps] ${stage.label}: ${lead.linkedinUrl} replied or its campaign was paused — skipped`);
      continue;
    }

    // The partial unique index on automated message types makes this insert
    // the delivery claim. A second worker cannot send the same stage.
    const [messageClaim] = await db.insert(messages).values({
      organizationId: currentOrganizationId(),
      type: stage.messageType,
      text: messageText,
      leadId: lead.id,
      connectionId,
      seen: true,
    }).onConflictDoNothing().returning({ id: messages.id });
    const isExhausted = stage.nextMessageField === null || !hasText(lead.nextMessageTemplate);
    if (!messageClaim) {
      const [existingClaim] = await db.select({ providerMessageId: messages.linkedinMessageId })
        .from(messages)
        .where(and(inOrg(messages), eq(messages.leadId, lead.id), eq(messages.type, stage.messageType), isNull(messages.duplicateOfMessageId)))
        .limit(1);
      // Only provider-confirmed claims may advance execution. A null provider
      // ID is an uncertain prior attempt and must stop for reconciliation.
      if (!existingClaim?.providerMessageId) continue;
      await db.update(leadsTable).set({
        status: isExhausted ? "COMPLETED" : stage.toStatus,
        [stage.sentAtField]: new Date(),
      }).where(and(inOrg(leadsTable), eq(leadsTable.id, lead.id), eq(leadsTable.status, stage.fromStatus)));
      continue;
    }

    const barred = await isPersonDoNotContact(db, lead.personId!) ? "Person-global DNC"
      : await linkedinRouteIsWrong(db, lead.personId!, lead.linkedinUrl) ? "a wrong-number record" : null;
    if (barred) {
      await db.transaction(async (tx) => {
        await tx.delete(messages).where(and(inOrg(messages), eq(messages.id, messageClaim.id)));
        await tx.update(leadsTable).set({ status: "FAILED" }).where(and(inOrg(leadsTable), eq(leadsTable.id, lead.id)));
      });
      console.warn(`[sendFollowUps] ${stage.label}: ${lead.linkedinUrl} blocked by ${barred}`);
      continue;
    }

    let linkedinMessageId: string | null;
    try {
      linkedinMessageId = await sendMessage(chatId, messageText);
    } catch (err) {
      console.error(`[sendFollowUps] ${stage.label} failed for ${lead.linkedinUrl}: ${serializeError(err)}`);
      // Preserve the claim: a transport failure may happen after the provider
      // accepted the message. Automatic retry would risk a duplicate send.
      await recordFollowUpSendFailure(lead.id);
      continue;
    }

    // Keep the claim if persistence fails after provider success. On the next
    // run it prevents a duplicate send and the conflict path above advances.
    // Conditional on the stage it was sent from: a reply that arrived during
    // the send has set REPLIED, and that must not be overwritten (it is what
    // keeps the remaining follow-ups from sending).
    await db.transaction(async (tx) => {
      await tx.update(leadsTable).set({
        status: isExhausted ? "COMPLETED" : stage.toStatus,
        [stage.sentAtField]: new Date(),
      }).where(and(inOrg(leadsTable), eq(leadsTable.id, lead.id), eq(leadsTable.status, stage.fromStatus)));
      await tx.update(messages).set({ linkedinMessageId }).where(and(inOrg(messages), eq(messages.id, messageClaim.id)));
      if (lead.inviteRetryCount > 0) await tx.update(leadsTable).set({ inviteRetryCount: 0 }).where(and(inOrg(leadsTable), eq(leadsTable.id, lead.id)));
    });

    console.log(`[sendFollowUps] ${stage.label} sent to ${lead.linkedinUrl}${isExhausted ? " — sequence complete" : ""}`);
  }
};

/** The lead is still at this stage and its campaign is still running. */
async function stillDueForStage(leadId: string, fromStatus: LeadStatus): Promise<boolean> {
  const [row] = await db
    .select({ id: leadsTable.id })
    .from(leadsTable)
    .innerJoin(campaigns, eq(leadsTable.campaignId, campaigns.id))
    .where(and(inOrg(leadsTable), eq(leadsTable.id, leadId), eq(leadsTable.status, fromStatus), eq(campaigns.status, "ACTIVE")))
    .limit(1);
  return Boolean(row);
}

export const sendFollowUps = async (account: LinkedInAccount): Promise<void> => {
  if (!(await isPlatformConnected("unipile"))) {
    console.log("[sendFollowUps] Unipile is not connected — skipping");
    return;
  }

  console.log(`[sendFollowUps] Processing account ${account.username}`);
  await sendMissedAcceptances(account);

  for (const stage of FOLLOW_UP_STAGES) {
    await runFollowUpStage(account, stage);
  }
};

// Catches leads where new_relation fired without a chatId — they stayed REQUEST_SENT
// with a Connection record. Retry sending the acceptance message now that Unipile may
// have synced the chat.
const sendMissedAcceptances = async (account: LinkedInAccount): Promise<void> => {
  // `connection: { isNot: null }` — an innerJoin expresses exactly that.
  const leads = (
    await db
      .select({
        lead: leadsTable,
        person: people,
        company: companies,
        campaignAcceptanceMessage: campaigns.acceptanceMessage,
        connection: {
          id: connections.id,
          chatId: connections.chatId,
          providerId: connections.providerId,
        },
      })
      .from(leadsTable)
      .innerJoin(people, eq(leadsTable.personId, people.id))
      .leftJoin(companies, eq(people.companyId, companies.id))
      .innerJoin(connections, eq(connections.leadId, leadsTable.id))
      .innerJoin(campaigns, eq(leadsTable.campaignId, campaigns.id))
      .where(
        and(
          inOrg(leadsTable),
          eq(leadsTable.linkedinAccountId, account.id),
          eq(leadsTable.status, "REQUEST_SENT"),
          eq(campaigns.status, "ACTIVE")
        )
      )
      .limit(await followUpsPerRun())
  ).map((r) => ({ ...r.lead, acceptanceMessage: r.campaignAcceptanceMessage ?? r.lead.acceptanceMessage, connection: r.connection, linkedinUrl: r.person.linkedinUrl!, variables: personVariables(r.person, r.company) }));

  console.log(`[missedAcceptances] Found ${leads.length} REQUEST_SENT lead(s) with a connection record`);
  if (leads.length === 0) return;

  for (const lead of leads) {
    const connection = lead.connection!;
    console.log(`[missedAcceptances] ${lead.linkedinUrl} — chatId: ${connection.chatId ?? "none"}`);

    try {
      const result = await processLeadAcceptance(
        lead,
        connection,
        account,
        (msg) => console.log(`[missedAcceptances] ${lead.linkedinUrl} — ${msg}`)
      );

      if (result === "blocked") {
        console.warn(`[missedAcceptances] ${lead.linkedinUrl} — blocked by Person-global DNC`);
      } else if (result === "retry") {
        console.warn(`[missedAcceptances] ${lead.linkedinUrl} — still no chatId, will retry next cycle`);
      } else {
        console.log(`[missedAcceptances] ${lead.linkedinUrl} — ✓ advanced to ACCEPT_MESSAGE_SENT`);
      }
    } catch (err) {
      console.error(`[missedAcceptances] ${lead.linkedinUrl} — failed: ${serializeError(err)}`);
    }
  }
};

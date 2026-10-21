import "server-only";

import { and, asc, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { completeStructured } from "@/lib/ai/server/structuredCompletion";
import { members, users } from "@/lib/auth/schema";
import { sendAuthEmail } from "@/lib/auth/email";
import { BRAND } from "@/lib/brand";
import { crmConversationMessages, crmConversations, crmRecords } from "@/lib/crm/schema";
import { crmActionableSql } from "@/lib/crm/actionGroups.server";
import { companies, people } from "@/lib/leads/schema";
import { currentOrganizationId, inOrg, runInOrganization } from "@/lib/tenancy/scope";
import { byUrgency, handoffLabel, REMINDER_AFTER_MS, REPORT_KINDS, takesAnAnswer, waitedFor } from "./handoff";
import { autopilotReplies, outreachRuns, ownerDecisions, type OwnerDecisionKind } from "./schema";
import { recordUsage } from "./usage.server";

/**
 * The handoff's database half (rules: handoff.ts): the Needs you list, the
 * brief the owner reads, a person's reply settling a handoff, and the email
 * that tells the owners a lead waits for them.
 */

const OPEN_HANDOFF = and(eq(ownerDecisions.status, "open"), sql`${ownerDecisions.kind} NOT IN ('interested', 'opt_out')`);

/**
 * A person replied in the conversation after the handoff opened — from
 * Action required, the Messages tab, or their own phone — so it is settled.
 * The assistant keeps answering the lead afterwards: only "I'll reply
 * myself" takes a chat away from it. Messages the autopilot sent (its
 * replies and the handover) and campaign steps do not count. Returns how
 * many were settled.
 */
export async function settlePersonReplies(conversationId?: string): Promise<number> {
  const organizationId = currentOrganizationId();
  const settled = await db.execute<{ conversation_id: string }>(sql`
    update owner_decisions d
       set status = 'resolved',
           answer = coalesce(d.answer, 'You replied in the chat.'),
           answered_at = now(),
           updated_at = now()
     where d.organization_id = ${organizationId}
       and d.status = 'open'
       and d.kind not in ('interested', 'opt_out')
       and d.conversation_id is not null
       ${conversationId ? sql`and d.conversation_id = ${conversationId}` : sql``}
       and exists (
         select 1 from crm_conversation_messages m
          where m.conversation_id = d.conversation_id
            and m.direction = 'outbound'
            and m.sent_at > d.created_at
            and m.idempotency_key not like 'crm-send:autopilot:%'
            and m.idempotency_key not like 'outreach-email:%'
            and m.idempotency_key not like 'linkedin-outreach:%'
            and not exists (
              select 1 from crm_conversation_messages a
               where a.conversation_id = m.conversation_id
                 and a.idempotency_key like 'crm-send:autopilot:%'
                 and a.provider_message_id is not null
                 and a.provider_message_id = m.provider_message_id))
    returning d.conversation_id`);
  return [...settled].length;
}

const BRIEF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["brief"],
  properties: { brief: { type: "string", description: "One to three short sentences." } },
};

/**
 * A few lines for the owner taking over: who the lead is, their problem or
 * need, what they want now, anything that matters for the next step — only
 * from the conversation. One model call; on failure the card shows the
 * lead's message instead.
 */
export async function writeBrief(decisionId: string): Promise<string | null> {
  const [decision] = await db.select().from(ownerDecisions).where(and(inOrg(ownerDecisions), eq(ownerDecisions.id, decisionId))).limit(1);
  if (!decision?.conversationId) return null;
  const messages = await db.select({ direction: crmConversationMessages.direction, body: crmConversationMessages.bodyText, sentAt: crmConversationMessages.sentAt })
    .from(crmConversationMessages)
    .innerJoin(crmConversations, eq(crmConversations.id, crmConversationMessages.conversationId))
    .where(and(inOrg(crmConversations), eq(crmConversationMessages.conversationId, decision.conversationId)))
    .orderBy(desc(crmConversationMessages.sentAt)).limit(12);
  if (!messages.length) return null;
  const [lead] = decision.personId
    ? await db.select({ name: people.fullName, title: people.title, company: companies.name, raw: people.raw }).from(people)
      .leftJoin(companies, eq(companies.id, people.companyId))
      .where(and(inOrg(people), eq(people.id, decision.personId))).limit(1)
    : [];
  const business = typeof (lead?.raw as Record<string, unknown> | null)?.businessName === "string" ? String((lead!.raw as Record<string, unknown>).businessName) : null;
  const who = [lead?.name, lead?.title, lead?.company ?? business].filter(Boolean).join(", ") || "the lead";
  const transcript = messages.reverse().map((message) => `${message.direction === "inbound" ? "LEAD" : "US"}: ${message.body.replace(/\s+/g, " ").slice(0, 600)}`).join("\n");
  let brief: string | null = null;
  const result = await completeStructured({
    timeoutMs: 30_000,
    maxOutputTokens: 300,
    schemaName: "handoff_brief",
    schemaDescription: "A brief for the business owner taking over a sales conversation.",
    jsonSchema: BRIEF_SCHEMA,
    systemPrompt: [
      "A business owner is taking over a sales conversation from an assistant. Write their brief in one to three short sentences:",
      "who the lead is, the problem or need they described, what they want now, and anything that matters for the next step (size, urgency, who decides).",
      "Use only what the conversation and the lead's details say; leave out what is unknown. No advice, no greeting, no bullet points. Write in English.",
    ].join("\n"),
    userPrompt: `LEAD: ${who}\nWHY THE OWNER IS NEEDED: ${decision.reason}\n\nCONVERSATION (oldest first):\n${transcript}`,
    accept: (text) => {
      const body = JSON.parse(text) as { brief?: unknown };
      const value = typeof body.brief === "string" ? body.brief.replace(/\s+/g, " ").trim() : "";
      if (!value) throw new Error("brief must not be empty");
      brief = value.slice(0, 600);
    },
  }).catch((error) => {
    console.error("[assistant/handoff] could not write the brief:", error instanceof Error ? error.message : error);
    return null;
  });
  if (result) await recordUsage("handoff_brief", result, decision.runId);
  if (brief) await db.update(ownerDecisions).set({ brief, updatedAt: new Date() }).where(and(inOrg(ownerDecisions), eq(ownerDecisions.id, decisionId)));
  return brief;
}

export type NeedsYouItem = {
  id: string;
  kind: OwnerDecisionKind;
  label: string;
  action: string;
  priority: number;
  /** The owner's answer in the card is what the lead waits for. */
  takesAnswer: boolean;
  reason: string;
  decision: string;
  brief: string | null;
  leadMessage: string | null;
  leadName: string;
  company: string | null;
  channel: string | null;
  createdAt: string;
  waited: string;
  /** When the lead was told a personal reply follows. */
  handoverSentAt: string | null;
  /** Messages the lead sent after the handoff opened. */
  newerMessages: number;
  crmRecordId: string | null;
  runId: string | null;
  threadId: string | null;
};

/** What waits for the owner, most urgent first, after settling the ones a person already answered in the chat. */
export async function listNeedsYou(limit = 100): Promise<{ items: NeedsYouItem[]; reviewWaiting: number; actionRequired: number }> {
  await settlePersonReplies();
  const rows = await db.select({
    decision: ownerDecisions,
    fullName: people.fullName,
    firstName: people.firstName,
    email: people.email,
    phone: people.phone,
    raw: people.raw,
    company: companies.name,
    channel: crmConversations.channel,
    threadId: outreachRuns.threadId,
    newer: sql<number>`(select count(*)::int from crm_conversation_messages m where m.conversation_id = ${ownerDecisions.conversationId} and m.direction = 'inbound' and m.sent_at > ${ownerDecisions.createdAt})`,
  }).from(ownerDecisions)
    .leftJoin(people, and(eq(people.id, ownerDecisions.personId), eq(people.organizationId, ownerDecisions.organizationId)))
    .leftJoin(companies, eq(companies.id, people.companyId))
    .leftJoin(crmConversations, eq(crmConversations.id, ownerDecisions.conversationId))
    .leftJoin(outreachRuns, and(eq(outreachRuns.id, ownerDecisions.runId), eq(outreachRuns.organizationId, ownerDecisions.organizationId)))
    .where(and(inOrg(ownerDecisions), OPEN_HANDOFF))
    .orderBy(asc(ownerDecisions.createdAt))
    .limit(limit);
  const now = new Date();
  const items = rows.map((row): NeedsYouItem => {
    const d = row.decision;
    const label = handoffLabel(d.kind);
    const business = typeof (row.raw as Record<string, unknown> | null)?.businessName === "string" ? String((row.raw as Record<string, unknown>).businessName) : null;
    const leadName = row.fullName || row.firstName || business || row.email || row.phone || "A lead";
    const company = row.company ?? business;
    return {
      id: d.id,
      kind: d.kind,
      label: label.label,
      action: label.action,
      priority: label.priority,
      takesAnswer: takesAnAnswer(d.kind),
      reason: d.reason,
      decision: d.decision,
      brief: d.brief,
      leadMessage: d.leadMessage,
      leadName,
      company: company && company.trim().toLowerCase() !== leadName.trim().toLowerCase() ? company : null,
      channel: row.channel ?? null,
      createdAt: d.createdAt.toISOString(),
      waited: waitedFor(d.createdAt, now),
      handoverSentAt: d.handoverSentAt?.toISOString() ?? null,
      newerMessages: Number(row.newer ?? 0),
      crmRecordId: d.crmRecordId,
      runId: d.runId,
      threadId: row.threadId ?? null,
    };
  }).sort(byUrgency);
  // Replies of Review-mode runs wait in Action required: counted here so nothing waits unseen.
  const [review] = await db.select({ n: sql<number>`count(distinct ${autopilotReplies.draftId})::int` }).from(autopilotReplies)
    .where(and(
      eq(autopilotReplies.organizationId, currentOrganizationId()),
      eq(autopilotReplies.status, "held"),
      sql`${autopilotReplies.reason} like 'the run is in Review mode%'`,
      sql`exists (select 1 from crm_drafts x where x.id = ${autopilotReplies.draftId} and x.status = 'awaiting_review')`,
    ));
  // What else waits in the CRM's Action required (a Do Not Contact reply to read, an error, a due follow-up):
  // "nobody is waiting" is said only when that is empty too.
  const [actionable] = await db.select({ n: sql<number>`count(*)::int` }).from(crmRecords)
    .where(and(inOrg(crmRecords), crmActionableSql({ id: crmRecords.id, workflowState: crmRecords.workflowState, nextActionAt: crmRecords.nextActionAt })));
  return { items, reviewWaiting: Number(review?.n ?? 0), actionRequired: Number(actionable?.n ?? 0) };
}

/** How many leads wait for the owner (the menu's badge). */
export async function countNeedsYou(): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(ownerDecisions).where(and(inOrg(ownerDecisions), OPEN_HANDOFF));
  return Number(row?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Alerts: an email to the organization's owners and admins when a lead
// reaches Needs you, and one reminder if it is still open hours later.

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || process.env.BETTER_AUTH_URL || "http://localhost:3000").replace(/\/+$/, "");
}

async function ownerEmails(organizationId: string): Promise<string[]> {
  const rows = await db.select({ email: users.email }).from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.organizationId, organizationId), sql`string_to_array(${members.role}, ',') && ARRAY['owner', 'admin']`));
  return [...new Set(rows.map((row) => row.email).filter(Boolean))];
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** The alert email: what the lead wants, the brief, and a link to the Needs you list. */
export function handoffEmail(input: { to: string; leadName: string; label: string; action: string; brief: string | null; reason: string; leadMessage: string | null; waited: string | null; reminder: boolean }) {
  const subject = input.reminder
    ? `Still waiting: ${input.leadName} (${input.label.toLowerCase()}, ${input.waited})`
    : `${input.label}: ${input.leadName}`;
  const url = `${appUrl()}/inbox?view=needs_you`;
  const about = input.brief || input.reason;
  const said = input.leadMessage?.trim() ? `They wrote: “${input.leadMessage.trim().slice(0, 400)}”` : "";
  const text = [
    input.reminder ? `${input.leadName} has waited ${input.waited} for you.` : `${input.leadName} needs you: ${input.label.toLowerCase()}.`,
    about,
    said,
    `${input.action}: ${url}`,
  ].filter(Boolean).join("\n\n");
  const html = `<!doctype html><html><body style="margin:0;background:#f5f7fa;font-family:Inter,Arial,sans-serif;color:#0e121b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border-radius:16px;padding:28px" cellpadding="0" cellspacing="0">
<tr><td style="font-size:13px;font-weight:600;color:#335cff;padding-bottom:8px">${escapeHtml(input.label)}</td></tr>
<tr><td style="font-size:19px;font-weight:600;padding-bottom:12px">${escapeHtml(input.reminder ? `${input.leadName} has waited ${input.waited ?? ""}` : `${input.leadName} needs you`)}</td></tr>
<tr><td style="font-size:15px;line-height:1.6;color:#0e121b;padding-bottom:12px">${escapeHtml(about)}</td></tr>
${said ? `<tr><td style="font-size:14px;line-height:1.6;color:#525866;padding-bottom:20px">${escapeHtml(said)}</td></tr>` : ""}
<tr><td><a href="${escapeHtml(url)}" style="display:inline-block;background:#335cff;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 20px;border-radius:10px">${escapeHtml(input.action)}</a></td></tr>
<tr><td style="font-size:12px;color:#99a0ae;padding-top:20px">${escapeHtml(BRAND.name)} · Needs you</td></tr>
</table></td></tr></table></body></html>`;
  return { to: input.to, subject, text, html };
}

const BRIEF_GRACE_MS = 2 * 60_000;
/** Older handoffs are not emailed (an upgrade would otherwise mail every stale one at once). */
const ALERT_WINDOW_MS = 3 * 24 * 60 * 60_000;

/**
 * One pass over every organization: new handoffs (of the last three days)
 * are emailed once (after their brief is written, or two minutes), and one
 * still open REMINDER_AFTER_MS after that email is reminded once. Each row is claimed with a guarded
 * update, so two servers never send the same email.
 */
export async function sendHandoffAlerts(options: {
  /** Replaces the email sender (tests). */
  send?: (email: ReturnType<typeof handoffEmail>) => Promise<void>;
  /** Only this organization (tests). */
  organizationId?: string;
} = {}): Promise<{ alerted: number; reminded: number; emails: number }> {
  const now = Date.now();
  const send = options.send ?? sendAuthEmail;
  let emails = 0;
  const due = await db.select({ id: ownerDecisions.id, organizationId: ownerDecisions.organizationId, alertedAt: ownerDecisions.alertedAt })
    .from(ownerDecisions)
    .where(and(
      options.organizationId ? eq(ownerDecisions.organizationId, options.organizationId) : undefined,
      eq(ownerDecisions.status, "open"),
      sql`${ownerDecisions.kind} NOT IN (${sql.join(REPORT_KINDS.map((kind) => sql`${kind}`), sql`, `)})`,
      gt(ownerDecisions.createdAt, new Date(now - ALERT_WINDOW_MS)),
      or(
        and(isNull(ownerDecisions.alertedAt), or(sql`${ownerDecisions.brief} is not null`, lt(ownerDecisions.createdAt, new Date(now - BRIEF_GRACE_MS)))),
        and(isNull(ownerDecisions.remindedAt), lt(ownerDecisions.alertedAt, new Date(now - REMINDER_AFTER_MS))),
      ),
    ))
    .orderBy(asc(ownerDecisions.createdAt)).limit(50);
  let alerted = 0;
  let reminded = 0;
  for (const item of due) {
    await runInOrganization(item.organizationId, async () => {
      // A person may have answered in the chat meanwhile.
      const [first] = await db.select({ conversationId: ownerDecisions.conversationId }).from(ownerDecisions).where(eq(ownerDecisions.id, item.id));
      if (first?.conversationId) await settlePersonReplies(first.conversationId);
      const reminder = Boolean(item.alertedAt);
      const claimed = await db.update(ownerDecisions)
        .set(reminder ? { remindedAt: new Date() } : { alertedAt: new Date() })
        .where(and(eq(ownerDecisions.id, item.id), eq(ownerDecisions.status, "open"), reminder ? isNull(ownerDecisions.remindedAt) : isNull(ownerDecisions.alertedAt)))
        .returning();
      const decision = claimed[0];
      if (!decision) return;
      const [lead] = decision.personId
        ? await db.select({ fullName: people.fullName, firstName: people.firstName, email: people.email, phone: people.phone }).from(people)
          .where(and(inOrg(people), eq(people.id, decision.personId))).limit(1)
        : [];
      const label = handoffLabel(decision.kind);
      const recipients = await ownerEmails(item.organizationId);
      for (const to of recipients) {
        emails += 1;
        await send(handoffEmail({
          to,
          leadName: lead?.fullName || lead?.firstName || lead?.email || lead?.phone || "A lead",
          label: label.label,
          action: label.action || "Open Needs you",
          brief: decision.brief,
          reason: decision.reason,
          leadMessage: decision.leadMessage,
          waited: waitedFor(decision.createdAt),
          reminder,
        })).catch((error) => console.error("[assistant/handoff] alert email failed:", error instanceof Error ? error.message : error));
      }
      if (reminder) reminded += 1;
      else alerted += 1;
    }).catch((error) => console.error("[assistant/handoff] alert failed:", error));
  }
  return { alerted, reminded, emails };
}

const ALERT_STATE_KEY = Symbol.for("agentsdr.handoffAlerts");
const ALERT_POLL_MS = 60_000;

/** Starts one HMR-safe alert loop per process (beside the assistant worker). */
export function startHandoffAlerts(): void {
  const state = globalThis as unknown as Record<symbol, ReturnType<typeof setInterval> | undefined>;
  const previous = state[ALERT_STATE_KEY];
  if (previous) clearInterval(previous);
  let running = false;
  state[ALERT_STATE_KEY] = setInterval(() => {
    if (running) return;
    running = true;
    void sendHandoffAlerts()
      .catch((error) => console.error("[assistant/handoff] alert pass failed:", error))
      .finally(() => { running = false; });
  }, ALERT_POLL_MS);
}

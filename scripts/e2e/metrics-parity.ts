/**
 * Overview (/assistant/results) and Analytics (/analytics) read the same
 * numbers, on the local database:
 * - sends that the provider accepted, beside failed, uncertain and in-flight
 *   ones that must not count, on email, WhatsApp, LinkedIn and Instagram;
 *   WhatsApp delivery and read receipts; replies before and after a send;
 *   leads from two sources, one person found by both;
 * - for Today, Yesterday, Last 7 days and Last 30 days, both pages cut the
 *   same [from, to) in the organization's time zone (Asia/Kolkata here) and
 *   every shared figure is the same number, current counts included;
 * - the per-source view counts the person both sources found once, and
 *   lists both sources for them;
 * - an explicit ?tz= is an override and says so;
 * - reading both pages starts, approves and sends nothing;
 * - a second organization sees nothing of the first, even given its ids.
 * No message is sent and no provider is called.
 *
 *   bun run --conditions=react-server scripts/e2e/metrics-parity.ts
 *
 * Creates its own organizations ("Metrics check …") and leaves them, with
 * every campaign and run paused. Refuses a non-local DATABASE_URL.
 */
import { isDeepStrictEqual } from "node:util";
import { eq, inArray, sql } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}

const { db } = await import("@/lib/db");
const { organizations, users, members } = await import("@/lib/auth/schema");
const { people } = await import("@/lib/leads/schema");
const { outreachCampaigns, outreachLeads, outreachEmails } = await import("@/lib/outreach/schema");
const { whatsappAccounts, whatsappCampaigns, whatsappCampaignLeads, whatsappCampaignSends, whatsappChats, whatsappMessages } = await import("@/lib/whatsapp/schema");
const linkedin = await import("@/lib/linkedin/schema");
const { instagramAccounts, instagramOutreachQueue } = await import("@/lib/instagram/schema");
const { crmRecords, crmConversations, crmConversationMessages, crmDrafts } = await import("@/lib/crm/schema");
const { assistantJobs, outreachRuns, ownerDecisions } = await import("@/lib/assistant/schema");
const { ensureCrmDefaults } = await import("@/lib/crm/defaults");
const { runInOrganization } = await import("@/lib/tenancy/scope");
const { saveChannelRules } = await import("@/lib/channels/rules.server");
const { createAudience, addAudienceMembers } = await import("@/lib/assistant/audiences.server");
const { results } = await import("@/lib/assistant/results.server");
const { listNeedsYou } = await import("@/lib/assistant/handoff.server");
const { listOpenDecisions } = await import("@/lib/assistant/decisions.server");
const { listDailySummaries } = await import("@/lib/assistant/dailySummary.server");
const { parseAnalyticsRange } = await import("@/lib/analytics/server");
const { getOverviewAnalytics } = await import("@/lib/analytics/overview.server");
const { getEmailAnalytics } = await import("@/lib/analytics/email.server");
const { getLinkedinAnalytics } = await import("@/lib/analytics/linkedin.server");
const { getWhatsappAnalytics } = await import("@/lib/analytics/whatsapp.server");
const { dayStart, localDate } = await import("@/lib/reporting/metrics");
type OutreachPlan = import("@/lib/assistant/schema").OutreachPlan;
type PeriodKind = import("@/lib/assistant/results").PeriodKind;

const stamp = Date.now();
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const show = (value: unknown) => JSON.stringify(value);

async function organization(label: string) {
  const [org] = await db.insert(organizations).values({ name: `Metrics check ${label} ${stamp}`, slug: `metrics-check-${label}-${stamp}` }).returning();
  const [owner] = await db.insert(users).values({ name: `Owner ${label.toUpperCase()}`, email: `owner-${label}-${stamp}@metrics-check.test`, emailVerified: true }).returning();
  await db.insert(members).values({ organizationId: org!.id, userId: owner!.id, role: "owner" });
  return { org: org!, owner: owner! };
}
const a = await organization("a");
const b = await organization("b");

const ZONE = "Asia/Kolkata";
const now = new Date();
const today = localDate(ZONE, now);
// Local midnight in Kolkata, as an instant: 18:30 UTC the evening before.
const t0 = dayStart(today, ZONE);
const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
const DAY_MINUTES = 24 * 60;
const digits = String(stamp % 100_000_000).padStart(8, "0");

const seeded = await runInOrganization(a.org.id, async () => {
  const org = a.org.id;
  await saveChannelRules("general", { timeZone: ZONE }, a.owner.id);
  const { pipelineId } = await ensureCrmDefaults();

  const person = async (n: number, values: Partial<typeof people.$inferInsert>) =>
    (await db.insert(people).values({ organizationId: org, source: "metrics-check", fullName: `Lead ${n}`, ...values }).returning())[0]!;
  const p1 = await person(1, { fullName: "Asha Salon", email: `asha-${stamp}@metrics-check.test` });
  const p2 = await person(2, { email: `lead2-${stamp}@metrics-check.test` });
  const p3 = await person(3, { phone: `+919${digits}3` });
  const p4 = await person(4, { phone: `+919${digits}4` });
  const p5 = await person(5, { linkedinUrl: `https://www.linkedin.com/in/metrics-check-${stamp}` });
  const p6 = await person(6, {});
  const p7 = await person(7, {});
  const p8 = await person(8, { email: `lead8-${stamp}@metrics-check.test` });
  const p9 = await person(9, { email: `lead9-${stamp}@metrics-check.test` });
  const p10 = await person(10, { email: `lead10-${stamp}@metrics-check.test` });

  // Email: accepted sends, a failed one; one the evening before (23:55 Kolkata), one two days ago, one 40 days ago.
  const [emailCampaign] = await db.insert(outreachCampaigns).values({ organizationId: org, name: "Metrics check email", status: "active" }).returning();
  const emailLead = async (personId: string, sequenceStatus: typeof outreachLeads.$inferInsert.sequenceStatus) =>
    (await db.insert(outreachLeads).values({ campaignId: emailCampaign!.id, personId, sequenceStatus }).returning())[0]!;
  const [l1, l2, l8, l9, l10] = [await emailLead(p1.id, "in_follow_up"), await emailLead(p2.id, "initial_sent"), await emailLead(p8.id, "sequence_completed"), await emailLead(p9.id, "sequence_completed"), await emailLead(p10.id, "sequence_completed")];
  await db.insert(outreachEmails).values([
    { leadId: l1.id, stepNumber: 1, status: "sent", sentAt: at(10), createdAt: at(9) },
    { leadId: l1.id, stepNumber: 2, status: "failed", error: "Gmail refused the message", createdAt: at(11) },
    { leadId: l2.id, stepNumber: 1, status: "sent", sentAt: at(12), createdAt: at(12) },
    { leadId: l8.id, stepNumber: 1, status: "sent", sentAt: at(-2 * DAY_MINUTES + 60), createdAt: at(-2 * DAY_MINUTES + 60) },
    { leadId: l9.id, stepNumber: 1, status: "sent", sentAt: at(-5), createdAt: at(-5) },
    { leadId: l10.id, stepNumber: 1, status: "sent", sentAt: at(-40 * DAY_MINUTES), createdAt: at(-40 * DAY_MINUTES) },
  ]);

  // WhatsApp: two accepted sends (one read, one delivered), a send whose response was lost (uncertain) and one still in flight.
  const [account] = await db.insert(whatsappAccounts).values({ organizationId: org, unipileAccountId: `metrics-check-${stamp}`, name: "Sales number", phone: `+918${digits}0`, status: "disconnected" }).returning();
  const [whatsappCampaign] = await db.insert(whatsappCampaigns).values({ organizationId: org, name: "Metrics check WhatsApp", status: "active" }).returning();
  const [w3, w4] = await db.insert(whatsappCampaignLeads).values([
    { campaignId: whatsappCampaign!.id, personId: p3.id, phone: p3.phone!, status: "in_sequence" },
    { campaignId: whatsappCampaign!.id, personId: p4.id, phone: p4.phone!, status: "failed", lastError: "Delivery of message 1 is uncertain — check Messages before resuming" },
  ]).returning();
  const [chat] = await db.insert(whatsappChats).values({ accountId: account!.id, unipileChatId: `metrics-chat-${stamp}`, phone: p3.phone!, personId: p3.id }).returning();
  const [read, delivered] = await db.insert(whatsappMessages).values([
    { chatId: chat!.id, unipileMessageId: `metrics-msg-${stamp}-1`, direction: "outbound", origin: "agentsdr", body: "Hi", sentAt: at(13), deliveredAt: at(14), readAt: at(15) },
    { chatId: chat!.id, unipileMessageId: `metrics-msg-${stamp}-2`, direction: "outbound", origin: "agentsdr", body: "Following up", sentAt: at(16), deliveredAt: at(17) },
  ]).returning();
  await db.insert(whatsappCampaignSends).values([
    { leadId: w3!.id, step: 0, status: "sent", accountId: account!.id, whatsappMessageId: read!.id, sentAt: at(13), createdAt: at(13) },
    { leadId: w3!.id, step: 1, status: "sent", accountId: account!.id, whatsappMessageId: delivered!.id, sentAt: at(16), createdAt: at(16) },
    { leadId: w4!.id, step: 0, status: "failed", accountId: account!.id, error: "uncertain: the send was interrupted before Unipile answered", createdAt: at(18) },
    { leadId: w4!.id, step: 1, status: "sending", accountId: account!.id, createdAt: at(19) },
  ]);

  // LinkedIn: an invitation LinkedIn accepted, and a follow-up claimed but never confirmed.
  const [linkedinCampaign] = await db.insert(linkedin.campaigns).values({ organizationId: org, name: "Metrics check LinkedIn", status: "ACTIVE", updatedAt: now }).returning();
  const [linkedinLead] = await db.insert(linkedin.leads).values({ organizationId: org, personId: p5.id, campaignId: linkedinCampaign!.id, status: "REQUEST_SENT", updatedAt: now }).returning();
  await db.insert(linkedin.messages).values([
    { organizationId: org, type: "INVITATION", text: "Hi", linkedinMessageId: `metrics-invitation-${stamp}`, leadId: linkedinLead!.id, createdAt: at(20) },
    { organizationId: org, type: "FOLLOW_UP_1", text: "Following up", linkedinMessageId: null, leadId: linkedinLead!.id, createdAt: at(21) },
  ]);

  // Instagram: an initial DM sent to Asha, and an uncertain one to lead 2.
  const runAudience = await createAudience({ name: "Metrics check run", source: "list" });
  const plan = { assignments: [], samples: [], excluded: [], limits: {}, estimate: { aiCalls: 0, aiCostUsd: 0, days: 0 } } as unknown as OutreachPlan;
  const [instagramRun] = await db.insert(outreachRuns).values({ organizationId: org, audienceId: runAudience, name: "Instagram DMs", status: "running", channels: ["instagram"], plan, autopilot: false, createdBy: a.owner.id }).returning();
  const [waitingPlan] = await db.insert(outreachRuns).values({ organizationId: org, audienceId: runAudience, name: "Waiting plan", status: "proposed", channels: ["email"], plan, autopilot: false, createdBy: a.owner.id }).returning();
  const [instagram] = await db.insert(instagramAccounts).values({ organizationId: org, unipileAccountId: `metrics-ig-${stamp}`, username: `metrics_check_${stamp}`, status: "disconnected" }).returning();
  await db.insert(instagramOutreachQueue).values([
    { organizationId: org, runId: instagramRun!.id, personId: p1.id, accountId: instagram!.id, username: "asha.salon", body: "Hi", status: "sent", sentAt: at(22), attemptedAt: at(22) },
    { organizationId: org, runId: instagramRun!.id, personId: p2.id, accountId: instagram!.id, username: "lead.two", body: "Hi", status: "uncertain", attemptedAt: at(23), error: "the response was lost" },
  ]);

  // Replies: Asha after her email, lead 2 before theirs, lead 3 on WhatsApp after the send, and lead 6, never contacted, on Instagram.
  const conversation = async (personId: string, channel: "email" | "whatsapp" | "instagram", workflowState: "waiting" | "action_required" = "waiting") => {
    const [record] = await db.insert(crmRecords).values({ organizationId: org, personId, pipelineId, workflowState }).returning();
    const accountRef = `${channel}-metrics-${stamp}`;
    const [row] = await db.insert(crmConversations).values({ organizationId: org, crmRecordId: record!.id, personId, channel, accountRef }).returning();
    return { record: record!, conversation: row! };
  };
  const inbound = async (c: { conversation: typeof crmConversations.$inferSelect }, sentAt: Date) => {
    await db.insert(crmConversationMessages).values({
      conversationId: c.conversation.id, personId: c.conversation.personId, channel: c.conversation.channel, accountRef: c.conversation.accountRef,
      direction: "inbound", idempotencyKey: `metrics-${stamp}-${c.conversation.id}-${sentAt.getTime()}`, bodyText: "Tell me more", sentAt,
    });
  };
  const c1 = await conversation(p1.id, "email");
  const c2 = await conversation(p2.id, "email");
  const c3 = await conversation(p3.id, "whatsapp", "action_required");
  const c6 = await conversation(p6.id, "instagram");
  await inbound(c1, at(30));
  await inbound(c2, at(5));
  await inbound(c3, at(31));
  await inbound(c6, at(32));

  // Waiting now: a reply drafted for review, a missing-information decision (Needs you) and an interested report (not Needs you).
  await db.insert(crmDrafts).values({ crmRecordId: c3.record.id, conversationId: c3.conversation.id, channel: "whatsapp", expectedContextVersion: 0, status: "awaiting_review", aiBodyText: "Happy to help." });
  await db.insert(ownerDecisions).values([
    { organizationId: org, kind: "missing_info", reason: "Asked for the price", decision: "What does it cost?", personId: p1.id, crmRecordId: c1.record.id, conversationId: c1.conversation.id },
    { organizationId: org, kind: "interested", reason: "Wants a demo", decision: "Interested", personId: p3.id, crmRecordId: c3.record.id, conversationId: c3.conversation.id },
  ]);

  // Leads: a Google Maps search through the built-in scraper (Asha, lead 2 and a closed salon it could not save)
  // and an Instagram search through Apify (Asha again, and lead 7 with no contact route).
  const maps = await createAudience({ name: "Metrics check Maps", source: "discovery" });
  await db.insert(assistantJobs).values({ organizationId: org, kind: "discovery", status: "succeeded", stage: "done", audienceId: maps, payload: { target: "maps", provider: "scraper" }, finishedAt: now });
  await addAudienceMembers(maps, [
    { personId: p1.id, source: "google_maps" },
    { personId: p2.id, source: "google_maps" },
    { personId: null, name: "Closed Salon", reason: "listed on Google Maps as permanently closed", source: "google_maps" },
  ]);
  const insta = await createAudience({ name: "Metrics check Instagram", source: "discovery" });
  await db.insert(assistantJobs).values({ organizationId: org, kind: "discovery", status: "succeeded", stage: "done", audienceId: insta, payload: { target: "instagram", provider: "apify" }, finishedAt: now });
  await addAudienceMembers(insta, [
    { personId: p1.id, source: "apify_instagram" },
    { personId: p7.id, source: "apify_instagram" },
  ]);

  return { emailCampaign: emailCampaign!, whatsappCampaign: whatsappCampaign!, linkedinCampaign: linkedinCampaign!, instagramRun: instagramRun!, waitingPlan: waitingPlan!, maps, insta };
});

/** What reading a page must never change: jobs, plans, sends, drafts, decisions, queues. */
async function fingerprint(org: string) {
  const [row] = await db.execute<Record<string, unknown>>(sql`
    SELECT
      (SELECT string_agg(id || ':' || status, ',' ORDER BY id) FROM assistant_jobs WHERE organization_id = ${org}) AS jobs,
      (SELECT string_agg(id || ':' || status || ':' || coalesce(approved_at::text, '-'), ',' ORDER BY id) FROM outreach_runs WHERE organization_id = ${org}) AS runs,
      (SELECT string_agg(e.id || ':' || e.status, ',' ORDER BY e.id) FROM outreach_emails e JOIN outreach_leads l ON l.id = e.lead_id JOIN outreach_campaigns c ON c.id = l.campaign_id WHERE c.organization_id = ${org}) AS emails,
      (SELECT string_agg(s.id || ':' || s.status, ',' ORDER BY s.id) FROM whatsapp_campaign_sends s JOIN whatsapp_campaign_leads l ON l.id = s.lead_id JOIN whatsapp_campaigns c ON c.id = l.campaign_id WHERE c.organization_id = ${org}) AS whatsapp,
      (SELECT count(*) FROM whatsapp_messages m JOIN whatsapp_chats c ON c.id = m.chat_id JOIN whatsapp_accounts a ON a.id = c.account_id WHERE a.organization_id = ${org})::int AS chat_messages,
      (SELECT string_agg(id::text || ':' || status, ',' ORDER BY id) FROM instagram_outreach_queue WHERE organization_id = ${org}) AS instagram,
      (SELECT string_agg(id || ':' || coalesce("linkedinMessageId", '-'), ',' ORDER BY id) FROM "Message" WHERE "organizationId" = ${org}) AS linkedin,
      (SELECT count(*) FROM crm_send_attempts a JOIN crm_drafts d ON d.id = a.draft_id JOIN crm_records r ON r.id = d.crm_record_id WHERE r.organization_id = ${org})::int AS send_attempts,
      (SELECT string_agg(d.id || ':' || d.status, ',' ORDER BY d.id) FROM crm_drafts d JOIN crm_records r ON r.id = d.crm_record_id WHERE r.organization_id = ${org}) AS drafts,
      (SELECT string_agg(id || ':' || status, ',' ORDER BY id) FROM owner_decisions WHERE organization_id = ${org}) AS decisions,
      (SELECT count(*) FROM crm_conversation_messages m JOIN crm_conversations c ON c.id = m.conversation_id WHERE c.organization_id = ${org})::int AS messages,
      (SELECT string_agg(id || ':' || status, ',' ORDER BY id) FROM outreach_campaigns WHERE organization_id = ${org}) AS campaigns,
      (SELECT count(*) FROM outreach_mailbox_queue q JOIN outreach_leads l ON l.id = q.lead_id JOIN outreach_campaigns c ON c.id = l.campaign_id WHERE c.organization_id = ${org})::int AS mailbox_queue`);
  return row ?? {};
}

const PRESETS: [Exclude<PeriodKind, "all_time">, string][] = [["today", "today"], ["yesterday", "yesterday"], ["last_7_days", "7d"], ["last_30_days", "30d"]];
const withoutAt = <T extends { at: string }>(value: T) => ({ ...value, at: "" });

try {
  await runInOrganization(a.org.id, async () => {
    const before = await fingerprint(a.org.id);

    for (const [kind, preset] of PRESETS) {
      // What each page loads: Overview's page and route, and Analytics' route for each tab.
      await listNeedsYou();
      await Promise.all([listOpenDecisions(50), listDailySummaries(14)]);
      const overview = await results(kind, now);
      const range = await parseAnalyticsRange(new URLSearchParams({ range: preset }), now);
      const analytics = await getOverviewAnalytics(range);
      const email = await getEmailAnalytics(range);
      const linkedinView = await getLinkedinAnalytics(range);
      const whatsapp = await getWhatsappAnalytics(range);

      check(`${kind}: both pages cut the same [from, to) in the business time zone`,
        range.tz === ZONE && range.tzSource === "organization" && overview.period.timeZone === ZONE
          && overview.window.from === range.window.from && overview.window.to === range.window.to,
        `${overview.window.from} → ${overview.window.to} vs ${range.window.from} → ${range.window.to} (${range.tz})`);
      check(`${kind}: the shared period figures are identical`, isDeepStrictEqual(overview.metrics, analytics.metrics.current), `${show(overview.metrics.sent)} vs ${show(analytics.metrics.current.sent)}`);
      check(`${kind}: the current counts are identical`, isDeepStrictEqual(withoutAt(overview.now), withoutAt(analytics.now)), `${show(withoutAt(overview.now))} vs ${show(withoutAt(analytics.now))}`);
      check(`${kind}: the per-source view is identical`, isDeepStrictEqual(overview.leads.sources, analytics.sources), `${show(overview.leads.sources.total)} vs ${show(analytics.sources.total)}`);
      const pairs: [string, unknown, unknown][] = [
        ["people contacted", overview.outreach.peopleContacted, analytics.kpis.contacted.value],
        ["replies", overview.outreach.repliesReceived, analytics.crm.kpis.replies.value],
        ["people who replied", overview.outreach.peopleReplied, analytics.kpis.replied.value],
        ["contacted who replied", overview.outreach.contactedWhoReplied, analytics.kpis.contactedWhoReplied.value],
        ["reply rate", overview.outreach.replyRate, analytics.kpis.replyRate.value],
        ["emails sent", overview.outreach.emailsSent, email.kpis.sent.value],
        ["email contacted", overview.metrics.peopleContacted.byChannel.email, email.kpis.contacted.value],
        ["email replied", overview.metrics.contactedWhoReplied.byChannel.email, email.kpis.replied.value],
        ["email reply rate", overview.metrics.replyRate.byChannel.email, email.kpis.replyRate.value],
        ["WhatsApp sent", overview.outreach.whatsappSent, whatsapp.kpis.sent.value],
        ["WhatsApp delivered", overview.outreach.whatsappDelivered, whatsapp.kpis.delivered.value],
        ["WhatsApp read", overview.outreach.whatsappRead, whatsapp.kpis.read.value],
        ["WhatsApp reply rate", overview.metrics.replyRate.byChannel.whatsapp, whatsapp.kpis.replyRate.value],
        ["LinkedIn invitations", overview.outreach.linkedinInvitations, linkedinView.kpis.invites.value],
        ["LinkedIn messages", overview.outreach.linkedinMessages, linkedinView.kpis.messages.value],
        ["LinkedIn contacted", overview.metrics.peopleContacted.byChannel.linkedin, linkedinView.kpis.contacted.value],
        ["needs you now", overview.now.needsYou, analytics.attention.needsYou],
        ["drafts to review now", overview.attention.repliesWaiting, analytics.attention.draftsAwaitingReview],
        ["drafts to review now (AI assistant card)", overview.attention.repliesWaiting, analytics.crm.drafts.awaitingReview],
        ["action required now", overview.now.actionRequired, analytics.attention.actionRequired],
        ["follow-ups due now", overview.now.followUpsDue, analytics.attention.overdue],
        ["plans waiting for Start now", overview.attention.plansAwaitingStart, analytics.attention.plansAwaitingStart],
        ["leads found", overview.leads.found, analytics.sources.total.found],
        ["qualified", overview.leads.qualified, analytics.sources.total.qualified],
        ["contactable", overview.leads.contactable, analytics.sources.total.contactable],
      ];
      for (const channel of analytics.channels) {
        pairs.push([`${channel.channel} channel row contacted`, overview.metrics.peopleContacted.byChannel[channel.channel], channel.contacted]);
        pairs.push([`${channel.channel} channel row reply rate`, overview.metrics.replyRate.byChannel[channel.channel], channel.replyRate]);
      }
      const differ = pairs.filter(([, x, y]) => x !== y);
      check(`${kind}: every figure both pages show is the same number (${pairs.length} compared)`, differ.length === 0, differ.map(([label, x, y]) => `${label} ${show(x)} ≠ ${show(y)}`).join("; "));
    }

    const t = await results("today", now);
    const m = t.metrics;
    check("sent counts only what the provider accepted: failed, uncertain and in-flight sends are left out",
      isDeepStrictEqual(m.sent, { total: 6, byChannel: { email: 2, whatsapp: 2, linkedin: 1, instagram: 1 }, linkedinInvitations: 1, linkedinMessages: 0 }), show(m.sent));
    check("delivered and read come from WhatsApp's receipts; the other channels are not measured",
      isDeepStrictEqual(m.delivered.byChannel, { email: null, whatsapp: 2, linkedin: null, instagram: null }) && isDeepStrictEqual(m.read.byChannel, { email: null, whatsapp: 1, linkedin: null, instagram: null }),
      `${show(m.delivered)} ${show(m.read)}`);
    check("a person contacted on two channels is one person contacted",
      isDeepStrictEqual(m.peopleContacted, { total: 4, byChannel: { email: 2, whatsapp: 1, linkedin: 1, instagram: 1 } }), show(m.peopleContacted));
    check("replies are inbound messages, from contacted people or not",
      isDeepStrictEqual(m.replies, { total: 4, byChannel: { email: 2, whatsapp: 1, linkedin: 0, instagram: 1 } }) && m.peopleReplied.total === 4, `${show(m.replies)} from ${m.peopleReplied.total}`);
    check("the reply rate is contacted people who replied after their first send, over people contacted",
      m.contactedWhoReplied.total === 2 && m.replyRate.total === 0.5
        && isDeepStrictEqual(m.replyRate.byChannel, { email: 0.5, whatsapp: 1, linkedin: 0, instagram: 0 }),
      `${show(m.contactedWhoReplied)} ${show(m.replyRate)}`);
    check("current counts: Needs you leaves reports out; drafts, Action required, plans and sequences are now",
      t.now.needsYou === 1 && t.now.openDecisions === 2 && t.now.draftsAwaitingReview === 1 && t.now.actionRequired === 1 && t.now.plansAwaitingStart === 1
        && isDeepStrictEqual(t.now.stillToSend, { email: 2, whatsapp: 1, linkedin: 1, instagram: 0 }),
      show(withoutAt(t.now)));
    const sources = t.leads.sources;
    const mapsRow = sources.rows.find((row) => row.label === "Google Maps through the built-in scraper");
    const instaRow = sources.rows.find((row) => row.label === "Instagram through Apify");
    check("per source: found, qualified and contactable, labelled source through provider",
      mapsRow?.found === 3 && mapsRow.qualified === 2 && mapsRow.contactable === 2 && instaRow?.found === 2 && instaRow.qualified === 2 && instaRow.contactable === 1,
      show(sources.rows));
    check("the person both sources found counts once in the total and is listed under both",
      isDeepStrictEqual(sources.total, { found: 4, qualified: 3, contactable: 2 }) && mapsRow?.alsoFoundElsewhere === 1 && instaRow?.alsoFoundElsewhere === 1
        && sources.multiSource.people === 1
        && isDeepStrictEqual(sources.multiSource.examples, [{ name: "Asha Salon", sources: ["Google Maps through the built-in scraper", "Instagram through Apify"] }]),
      `${show(sources.total)} ${show(sources.multiSource)}`);

    const [yesterday, week, month, all] = await Promise.all([results("yesterday", now), results("last_7_days", now), results("last_30_days", now), results("all_time", now)]);
    check("an email sent at 23:55 in Kolkata counts for Kolkata's yesterday, not its today",
      yesterday.metrics.sent.byChannel.email === 1 && t.metrics.sent.byChannel.email === 2, `${yesterday.metrics.sent.byChannel.email} yesterday, ${t.metrics.sent.byChannel.email} today`);
    check("the last 7 and 30 days take whole local days; older sends stay out until all time",
      week.metrics.sent.byChannel.email === 4 && month.metrics.sent.byChannel.email === 4 && all.metrics.sent.byChannel.email === 5,
      `${week.metrics.sent.byChannel.email} / ${month.metrics.sent.byChannel.email} / ${all.metrics.sent.byChannel.email}`);

    const override = await parseAnalyticsRange(new URLSearchParams({ range: "today", tz: "UTC" }), now);
    check("an explicit ?tz= overrides the business time zone, and the range says so",
      override.tz === "UTC" && override.tzSource === "override" && override.window.from === dayStart(localDate("UTC", now), "UTC").toISOString(),
      show(override));

    const after = await fingerprint(a.org.id);
    check("reading both pages, for every preset, started, approved and sent nothing", isDeepStrictEqual(before, after),
      Object.keys(before).filter((key) => before[key] !== after[key]).join(", "));
  });

  await runInOrganization(b.org.id, async () => {
    const overview = await results("last_30_days", now);
    const range = await parseAnalyticsRange(new URLSearchParams({ range: "30d" }), now);
    const analytics = await getOverviewAnalytics(range);
    const [email, linkedinView, whatsapp] = await Promise.all([getEmailAnalytics(range), getLinkedinAnalytics(range), getWhatsappAnalytics(range)]);
    const nothing = (value: { sent: { total: number }; replies: { total: number }; peopleContacted: { total: number } }) => value.sent.total === 0 && value.replies.total === 0 && value.peopleContacted.total === 0;
    check("a second organization sees none of the first's sends, replies or leads",
      nothing(overview.metrics) && nothing(analytics.metrics.current) && overview.leads.sources.rows.length === 0 && analytics.sources.rows.length === 0
        && email.kpis.sent.value === 0 && linkedinView.kpis.invites.value === 0 && whatsapp.kpis.sent.value === 0,
      `${show(overview.metrics.sent)} ${show(analytics.sources.total)}`);
    check("…and counts none of its decisions, drafts, queue or plans",
      overview.now.needsYou === 0 && overview.now.openDecisions === 0 && overview.now.draftsAwaitingReview === 0 && overview.now.actionRequired === 0 && overview.now.plansAwaitingStart === 0
        && analytics.attention.needsYou === 0 && analytics.attention.actionRequired === 0 && analytics.attention.draftsAwaitingReview === 0
        && Object.values(overview.now.stillToSend).every((count) => count === 0),
      show(withoutAt(overview.now)));
    check("…and reports in its own time zone (UTC, unset), not the first's", range.tz === "UTC" && overview.period.timeZone === "UTC", `${range.tz} / ${overview.period.timeZone}`);
    const leaked = await results("all_time", now, { kind: "run", runIds: [seeded.instagramRun.id, seeded.waitingPlan.id], audienceIds: [seeded.maps, seeded.insta], jobIds: [] });
    check("…even when a report is handed the first organization's run and list ids", leaked.metrics.sent.total === 0 && leaked.leads.sources.rows.length === 0 && leaked.now.plansAwaitingStart === 0, `${show(leaked.metrics.sent)} ${show(leaked.leads.sources.total)}`);
  });
} finally {
  // Leave nothing that could send: campaigns and the Instagram run paused.
  await db.update(outreachCampaigns).set({ status: "paused" }).where(eq(outreachCampaigns.id, seeded.emailCampaign.id));
  await db.update(whatsappCampaigns).set({ status: "paused" }).where(eq(whatsappCampaigns.id, seeded.whatsappCampaign.id));
  await db.update(linkedin.campaigns).set({ status: "PAUSED", updatedAt: new Date() }).where(eq(linkedin.campaigns.id, seeded.linkedinCampaign.id));
  await db.update(outreachRuns).set({ status: "paused" }).where(inArray(outreachRuns.id, [seeded.instagramRun.id]));
}

console.log(failures ? `\n${failures} check(s) failed` : "\nMetrics parity checks passed");
process.exit(failures ? 1 : 0);

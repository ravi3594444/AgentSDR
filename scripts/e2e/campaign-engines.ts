/**
 * Campaign engines, end to end against the database: the email queue and send
 * tick, and the WhatsApp campaign tick, driven with a recording sender in
 * place of Gmail and Unipile. It checks what the unit tests cannot: the
 * daily allowance, the throttle, pause and resume, the per-step send claim,
 * a reply stopping the remaining follow-ups (through the real CRM ingestion),
 * a reply landing while a step is being sent, the server-side launch
 * rules reading real rows, and a refusal on a WhatsApp number kept as its
 * held-back reason (no lead failed, nothing resent) until an accepted send.
 *
 *   bun run --conditions=react-server scripts/e2e/campaign-engines.ts
 *
 * Nothing is delivered: every send goes to the recording function, and the
 * recipients are example.test addresses and +1 415 555 numbers. It creates
 * its own organization ("Engine check …") so no real campaign is touched, and
 * leaves it behind paused, its fake Unipile connection removed and its
 * mailbox disabled. A real Google or Unipile delivery is NOT proven here; see
 * docs/product/OWNER_SETUP.md for the live checks.
 *
 * The email part also checks the queue's reliability: a failed claim is never
 * queued again, a stale row never sends a follow-up early, a follow-up that
 * falls due after the day's build is topped up by the tick and sent once
 * (today's count kept, a stale counter day left to the build), a rebuild
 * interrupted after its delete keeps the old queue and reports the failure,
 * two rebuilds at once are serialized, and the daily lead limit refuses a
 * first email at its claim and lets it go the next day.
 *
 * Refuses a non-local DATABASE_URL. Its email ticks and repairs run for its
 * own organization only, so another organization's queue is never sent.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}

const { db } = await import("@/lib/db");
const { organizations } = await import("@/lib/auth/schema");
const { people } = await import("@/lib/leads/schema");
const { mailboxes, outreachCampaigns, outreachEmails, outreachLeads, outreachMailboxQueue } = await import("@/lib/outreach/schema");
const { createCampaign, emailLaunchFacts, setCampaignStatus, updateCampaignSequence } = await import("@/lib/outreach/campaigns");
const { emailLaunchProblems, parseSequence } = await import("@/lib/outreach/launch");
const { buildMailboxQueues, rebuildEmailQueue } = await import("@/lib/outreach/buildQueue");
const { runSchedulerTick } = await import("@/lib/outreach/scheduler");
const { saveChannelRules } = await import("@/lib/channels/rules.server");
const { newLeadsToday } = await import("@/lib/channels/dailyLeadLimit.server");
const { outreachRuns, outreachRunLeads } = await import("@/lib/assistant/schema");
const { createAudience } = await import("@/lib/assistant/audiences.server");
const { listWork } = await import("@/lib/activity/activity.server");
const { runLeads } = await import("@/lib/assistant/runLeads.server");
const { diagnoseDelivery } = await import("@/lib/assistant/deliveryDiagnostics.server");
type OutreachPlan = import("@/lib/assistant/schema").OutreachPlan;
const { ingestInboundReply } = await import("@/lib/crm/conversations");
const { gridProviderCredentials, gridProviders } = await import("@/lib/grid/schema");
const { encryptIntegrationCredentials } = await import("@/lib/integrations/credentials");
const { whatsappAccounts, whatsappCampaignLeads, whatsappCampaignSends } = await import("@/lib/whatsapp/schema");
const { addPeopleToWhatsappCampaign, createWhatsappCampaign, updateWhatsappCampaign } = await import("@/lib/whatsapp/campaigns/campaigns.server");
const { runWhatsappCampaignTick } = await import("@/lib/whatsapp/campaigns/engine");
const { WhatsappSendRefusedError } = await import("@/lib/whatsapp/errors");
const { runInOrganization, currentOrganizationId } = await import("@/lib/tenancy/scope");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const stamp = Date.now();
const [org] = await db.insert(organizations).values({ name: `Engine check ${stamp}`, slug: `engine-check-${stamp}` }).returning();
console.log(`Organization ${org!.name} (${org!.id})`);

const past = () => new Date(Date.now() - 60_000);

await runInOrganization(org!.id, async () => {
  // ------------------------------------------------------------------ email
  const campaign = await createCampaign({ name: "Engine check email" });
  const parsed = parseSequence([
    { subject: "Hello {{firstName}}", body: "First email", waitDays: 0 },
    { subject: "", body: "Follow-up", waitDays: 2 },
  ]);
  if (!parsed.ok) throw new Error(parsed.error);
  await updateCampaignSequence(campaign.id, parsed.sequence);

  const recipients = ["ada", "grace", "linus"].map((name) => ({ name, email: `engine-check+${name}-${stamp}@example.test` }));
  const persons = await db.insert(people).values(recipients.map((r) => ({
    organizationId: currentOrganizationId(),
    email: r.email,
    firstName: r.name,
    source: "engine-check",
  }))).returning();
  // One at a time: first emails are queued oldest first, and rows written by one statement share its time.
  const leads: (typeof outreachLeads.$inferSelect)[] = [];
  for (const p of persons) leads.push((await db.insert(outreachLeads).values({ personId: p.id, campaignId: campaign.id }).returning())[0]!);
  const leadOf = (name: string) => leads[recipients.findIndex((r) => r.name === name)]!;

  const before = emailLaunchProblems(await emailLaunchFacts({ id: campaign.id, sequence: parsed.sequence }));
  check(
    "email launch is refused without a connected mailbox",
    before.length === 1 && before[0]!.includes("sending mailbox"),
    JSON.stringify(before),
  );

  const [mailbox] = await db.insert(mailboxes).values({
    organizationId: currentOrganizationId(),
    emailAddress: `engine-check-${stamp}@example.test`,
    displayName: "Engine Check",
    status: "connected",
    dailySendLimit: 2,
    // Hours left to the column default: always open (sending is always on).
  }).returning();
  const after = emailLaunchProblems(await emailLaunchFacts({ id: campaign.id, sequence: parsed.sequence }));
  check("with a mailbox, only Google Workspace is missing", after.length === 1 && after[0]!.includes("Google"), JSON.stringify(after));

  // The tick below takes an injected sender, which stands in for Gmail (and
  // skips the Google check), so the campaign is made active directly.
  await setCampaignStatus(campaign.id, "active");

  const sent: string[] = [];
  let duringSend: ((to: string) => Promise<void>) | null = null;
  const fakeSend = (async (input: { to: string[] }) => {
    sent.push(input.to[0]!);
    if (duringSend) await duringSend(input.to[0]!);
    return { id: `fake-${randomUUID()}`, messageId: `<${randomUUID()}@example.test>`, threadId: `thread-${randomUUID()}` };
  }) as unknown as Parameters<typeof runSchedulerTick>[0] extends { send?: infer S } ? S : never;

  // The tick and its repair, for this organization only: another's queue (an earlier, interrupted run) is never sent.
  const organizationId = currentOrganizationId();
  const tick = (now?: Date) => runSchedulerTick({ send: fakeSend, now, organizationIds: [organizationId] });
  const readyMailbox = () => db.update(mailboxes).set({ nextEmailTime: null }).where(eq(mailboxes.id, mailbox!.id));

  const built = await buildMailboxQueues({ organizationIds: [currentOrganizationId()] });
  check("the queue holds the mailbox's daily allowance (2 of 3 leads)", built.newLeadsQueued === 2, JSON.stringify(built));

  const first = await tick();
  check("one tick sends one email per mailbox", first.sent === 1 && sent.length === 1, JSON.stringify(first));
  const throttled = await tick();
  check("the next tick waits for the gap between emails", throttled.sent === 0 && throttled.skippedThrottle === 1, JSON.stringify(throttled));
  await readyMailbox();
  const second = await tick();
  check("after the gap the second queued lead is sent", second.sent === 1 && sent.length === 2, JSON.stringify(second));

  const rebuilt = await buildMailboxQueues({ organizationIds: [currentOrganizationId()] });
  check("a rebuild the same day (a mid-day launch or resume) grants no new allowance", rebuilt.newLeadsQueued === 0 && rebuilt.followUpsQueued === 0, JSON.stringify(rebuilt));
  await db.insert(outreachMailboxQueue).values({ mailboxId: mailbox!.id, leadId: leadOf("linus").id, position: 0 });
  await readyMailbox();
  const capped = await tick();
  check("a mailbox at its daily limit sends nothing, even with a queued lead", capped.sent === 0 && capped.skippedDailyLimit === 1, JSON.stringify(capped));
  await db.delete(outreachMailboxQueue).where(eq(outreachMailboxQueue.leadId, leadOf("linus").id));

  // A new day: the counter is reset by the next build.
  await db.update(mailboxes).set({ todayEmailsSent: 0, sendCounterResetAt: null, nextEmailTime: null }).where(eq(mailboxes.id, mailbox!.id));
  const [ada, grace] = [leadOf("ada"), leadOf("grace")];
  const firstTwo = await db.select().from(outreachLeads).where(inArray(outreachLeads.id, [ada.id, grace.id]));
  check("both sent leads moved to initial_sent with a follow-up due in 2 days", firstTwo.every((l) => l.sequenceStatus === "initial_sent" && l.currentStep === 1 && l.nextSendAt && l.nextSendAt.getTime() > Date.now() + 47 * 3600_000));

  // Grace replies (real CRM ingestion): her follow-up must never be queued.
  const gracePerson = persons[recipients.findIndex((r) => r.name === "grace")]!;
  await ingestInboundReply({
    personId: gracePerson.id,
    channel: "email",
    accountRef: mailbox!.emailAddress,
    providerThreadId: `engine-check-thread-${stamp}`,
    idempotencyKey: `engine-check-reply-${stamp}`,
    providerMessageId: `engine-check-provider-${stamp}`,
    subject: "Re: Hello grace",
    bodyText: "Thanks, not right now.",
    sentAt: new Date(),
  });
  const [graceAfterReply] = await db.select().from(outreachLeads).where(eq(outreachLeads.id, grace.id));
  check("a reply marks the lead reply_received and clears its next send", graceAfterReply?.sequenceStatus === "reply_received" && graceAfterReply.nextSendAt === null, graceAfterReply?.sequenceStatus);

  // Make both follow-ups due; only Ada's may be queued.
  await db.update(outreachLeads).set({ nextSendAt: past() }).where(inArray(outreachLeads.id, [ada.id, grace.id]));
  await buildMailboxQueues({ organizationIds: [currentOrganizationId()] });
  const queued = await db.select({ leadId: outreachMailboxQueue.leadId }).from(outreachMailboxQueue).where(eq(outreachMailboxQueue.mailboxId, mailbox!.id));
  check("the replied lead is not queued; the due follow-up and the new lead are", queued.length === 2 && !queued.some((q) => q.leadId === grace.id) && queued.some((q) => q.leadId === ada.id), JSON.stringify(queued));

  // Ada replies while her follow-up is being sent.
  duringSend = async (to) => {
    if (to === recipients[0]!.email) await db.update(outreachLeads).set({ sequenceStatus: "reply_received", nextSendAt: null }).where(eq(outreachLeads.id, ada.id));
  };
  const raced = await tick();
  duringSend = null;
  const [adaAfter] = await db.select().from(outreachLeads).where(eq(outreachLeads.id, ada.id));
  check(
    "a reply that lands during a send is not overwritten by the sender",
    raced.sent === 1 && adaAfter?.sequenceStatus === "reply_received" && adaAfter.currentStep === 2 && adaAfter.nextSendAt === null,
    `${adaAfter?.sequenceStatus} step ${adaAfter?.currentStep}`,
  );

  // Pause, then resume.
  await setCampaignStatus(campaign.id, "paused");
  await readyMailbox();
  const whilePaused = await tick();
  const [linusPaused] = await db.select().from(outreachLeads).where(eq(outreachLeads.id, leadOf("linus").id));
  check("a paused campaign sends nothing from its queue", whilePaused.sent === 0 && linusPaused?.sequenceStatus === "pending", JSON.stringify(whilePaused));
  await setCampaignStatus(campaign.id, "active");
  await buildMailboxQueues({ organizationIds: [currentOrganizationId()] });
  await readyMailbox();
  const resumed = await tick();
  check("after resuming, the waiting lead is sent", resumed.sent === 1 && sent.at(-1) === recipients[2]!.email, JSON.stringify(resumed));

  const queueOf = () => db.select({ id: outreachMailboxQueue.id, leadId: outreachMailboxQueue.leadId, position: outreachMailboxQueue.position })
    .from(outreachMailboxQueue).where(eq(outreachMailboxQueue.mailboxId, mailbox!.id)).orderBy(outreachMailboxQueue.position);
  const mailboxNow = async () => (await db.select().from(mailboxes).where(eq(mailboxes.id, mailbox!.id)))[0]!;
  const leadNow = async (id: string) => (await db.select().from(outreachLeads).where(eq(outreachLeads.id, id)))[0]!;
  const sentTo = (email: string) => sent.filter((to) => to === email).length;
  const repairTick = () => runSchedulerTick({ send: fakeSend, repair: "now", organizationIds: [organizationId] });

  // A step already claimed by an earlier attempt that failed: never queued again, never re-sent.
  const linus = leadOf("linus");
  await db.insert(outreachEmails).values({ leadId: linus.id, mailboxId: mailbox!.id, stepNumber: 2, subject: "", body: "Follow-up", status: "failed", error: "Gmail answered 500" });
  await db.update(outreachLeads).set({ nextSendAt: past() }).where(eq(outreachLeads.id, linus.id));
  await db.update(mailboxes).set({ todayEmailsSent: 0 }).where(eq(mailboxes.id, mailbox!.id));
  const afterFailure = await buildMailboxQueues({ organizationIds: [organizationId] });
  check("a lead whose current step's claim failed is not queued again, so it takes no real lead's place", !(await queueOf()).some((q) => q.leadId === linus.id) && afterFailure.followUpsQueued === 0, JSON.stringify(afterFailure));
  await db.insert(outreachMailboxQueue).values({ mailboxId: mailbox!.id, leadId: linus.id, position: 0 });
  await readyMailbox();
  const sendsBefore = sent.length;
  const claimed = await tick();
  check("…and a stale queue row for that step is skipped at its claim, not re-sent", claimed.skippedAlreadyClaimed === 1 && sent.length === sendsBefore, JSON.stringify(claimed));

  const perRecipient = recipients.map((r) => sent.filter((to) => to === r.email).length);
  check("each recipient got each step at most once (ada 2, grace 1, linus 1)", JSON.stringify(perRecipient) === "[2,1,1]", JSON.stringify(perRecipient));
  const stored = await db.select({ n: sql<number>`count(*)::int` }).from(outreachEmails).where(and(inArray(outreachEmails.leadId, leads.map((l) => l.id)), eq(outreachEmails.status, "sent")));
  check("every send is recorded as sent in outreach_emails", Number(stored[0]?.n) === 4, String(stored[0]?.n));

  // -------------------------------------------------------- queue reliability
  const extraLead = async (name: string, values: Partial<typeof outreachLeads.$inferInsert> = {}) => {
    const [person] = await db.insert(people).values({ organizationId, email: `engine-check+${name}-${stamp}@example.test`, firstName: name, source: "engine-check" }).returning();
    const [lead] = await db.insert(outreachLeads).values({ personId: person!.id, campaignId: campaign.id, ...values }).returning();
    return { email: person!.email!, lead: lead! };
  };
  await db.delete(outreachMailboxQueue).where(eq(outreachMailboxQueue.mailboxId, mailbox!.id));
  await db.update(mailboxes).set({ dailySendLimit: 10, todayEmailsSent: 3, sendCounterResetAt: new Date(), nextEmailTime: null }).where(eq(mailboxes.id, mailbox!.id));

  // A stale row for a lead that advanced since it was queued: its follow-up is days away.
  const ahead = await extraLead("pia", { sequenceStatus: "initial_sent", currentStep: 1, mailboxId: mailbox!.id, nextSendAt: new Date(Date.now() + 3 * 86_400_000) });
  await db.insert(outreachMailboxQueue).values({ mailboxId: mailbox!.id, leadId: ahead.lead.id, position: 0 });
  const early = await tick();
  const [aheadClaim] = await db.select().from(outreachEmails).where(eq(outreachEmails.leadId, ahead.lead.id));
  check("a stale queue row for a lead whose follow-up is not due sends nothing early", early.sent === 0 && early.skippedNotDue === 1 && !aheadClaim && sentTo(ahead.email) === 0 && (await leadNow(ahead.lead.id)).currentStep === 1, JSON.stringify(early));
  check("…and leaves the mailbox's pacing and count alone", (await mailboxNow()).nextEmailTime === null && (await mailboxNow()).todayEmailsSent === 3);

  // A follow-up that falls due after the day's build: the tick's repair tops it up, once, without touching today's count.
  const late = await extraLead("omar", { sequenceStatus: "initial_sent", currentStep: 1, mailboxId: mailbox!.id, nextSendAt: new Date(Date.now() + 3_600_000) });
  await db.insert(outreachEmails).values({ leadId: late.lead.id, mailboxId: mailbox!.id, stepNumber: 1, subject: "Hello omar", body: "First email", status: "sent", sentAt: new Date(Date.now() - 86_400_000), messageId: `<omar-${stamp}@example.test>` });
  const morning = await buildMailboxQueues({ organizationIds: [organizationId] });
  check("the day's build leaves out a follow-up that is not due yet", morning.failedOrganizations.length === 0 && !(await queueOf()).some((q) => q.leadId === late.lead.id), JSON.stringify(morning));
  const idle = await repairTick();
  check("an empty queue whose only work is a follow-up not due yet is not rebuilt: nothing queued or sent, the count untouched",
    idle.sent === 0 && (await queueOf()).length === 0 && (await mailboxNow()).todayEmailsSent === 3, JSON.stringify(idle));
  await db.update(outreachLeads).set({ nextSendAt: past() }).where(eq(outreachLeads.id, late.lead.id));
  const counterDay = (await mailboxNow()).sendCounterResetAt;
  await db.update(mailboxes).set({ sendCounterResetAt: new Date(Date.now() - 2 * 86_400_000) }).where(eq(mailboxes.id, mailbox!.id));
  const stale = await repairTick();
  check("a mailbox whose daily counter is from an earlier day is not topped up (only the daily build resets a counter)",
    stale.sent === 0 && (await queueOf()).length === 0 && (await mailboxNow()).todayEmailsSent === 3, JSON.stringify(stale));
  await db.update(mailboxes).set({ sendCounterResetAt: counterDay }).where(eq(mailboxes.id, mailbox!.id));
  const repaired = await repairTick();
  const afterRepair = await mailboxNow();
  check("the follow-up that fell due after the build is topped up by the tick and sent once", repaired.sent === 1 && sentTo(late.email) === 1 && (await leadNow(late.lead.id)).sequenceStatus === "sequence_completed", JSON.stringify(repaired));
  check("…today's count goes on from 3 to 4, never reset", afterRepair.todayEmailsSent === 4 && afterRepair.sendCounterResetAt?.getTime() === counterDay?.getTime(), `${afterRepair.todayEmailsSent} reset ${afterRepair.sendCounterResetAt?.toISOString()}`);
  await readyMailbox();
  await repairTick();
  check("…and the next repair sends that lead nothing more", sentTo(late.email) === 1);

  // Two new leads, queued by a build; then a rebuild that fails after deleting the old rows.
  const mira = await extraLead("mira");
  const noor = await extraLead("noor");
  const built2 = await buildMailboxQueues({ organizationIds: [organizationId] });
  const queuedBefore = await queueOf();
  check("a build queues both new leads", built2.failedOrganizations.length === 0 && queuedBefore.map((q) => q.leadId).join() === [mira.lead.id, noor.lead.id].join(), JSON.stringify(built2));
  const trigger = `engine_check_refuse_${stamp}`;
  await db.execute(sql.raw(`create function ${trigger}() returns trigger language plpgsql as $$ begin raise exception 'engine check: queue insert refused'; end $$`));
  await db.execute(sql.raw(`create trigger ${trigger} before insert on outreach_mailbox_queue for each row when (new.mailbox_id = '${mailbox!.id}') execute function ${trigger}()`));
  try {
    const interrupted = await buildMailboxQueues({ organizationIds: [organizationId] });
    const queuedAfter = await queueOf();
    check("a rebuild interrupted after deleting the old queue keeps the old queue: all or nothing", JSON.stringify(queuedAfter) === JSON.stringify(queuedBefore), `${JSON.stringify(queuedBefore)} → ${JSON.stringify(queuedAfter)}`);
    check("…and reports the organization as failed, with its error", interrupted.failedOrganizations.length === 1 && interrupted.failedOrganizations[0]!.organizationId === organizationId && /queue insert refused/.test(interrupted.failedOrganizations[0]!.error), JSON.stringify(interrupted.failedOrganizations));
    const note = await rebuildEmailQueue();
    check("…which a launch, a resume or an activation reports as a note, not as a failed campaign", Boolean(note && /not prepared for sending yet/.test(note) && /prepared again automatically/.test(note)), note ?? "no note");
  } finally {
    await db.execute(sql.raw(`drop trigger if exists ${trigger} on outreach_mailbox_queue`));
    await db.execute(sql.raw(`drop function if exists ${trigger}()`));
  }
  const [concurrentA, concurrentB] = await Promise.all([buildMailboxQueues({ organizationIds: [organizationId] }), buildMailboxQueues({ organizationIds: [organizationId] })]);
  const afterConcurrent = await queueOf();
  check("two rebuilds at once are serialized: both succeed and the queue holds each lead once, in order",
    concurrentA.failedOrganizations.length === 0 && concurrentB.failedOrganizations.length === 0 && afterConcurrent.map((q) => `${q.leadId}@${q.position}`).join() === `${mira.lead.id}@0,${noor.lead.id}@1`, JSON.stringify(afterConcurrent));

  // The daily lead limit: one place left today, two new leads queued.
  const usedSoFar = (await newLeadsToday()).used;
  await saveChannelRules("general", { newLeadsPerDay: usedSoFar + 1 }, null);
  await readyMailbox();
  const firstNew = await tick();
  await readyMailbox();
  const refusedTick = await tick();
  const noorClaims = await db.select().from(outreachEmails).where(eq(outreachEmails.leadId, noor.lead.id));
  const afterRefusal = await mailboxNow();
  check("with one place left the first new lead is emailed; the next is refused at its claim and nothing is sent to her",
    firstNew.sent === 1 && sentTo(mira.email) === 1 && refusedTick.sent === 0 && refusedTick.skippedDailyLeadLimit === 1 && sentTo(noor.email) === 0, `${JSON.stringify(firstNew)} ${JSON.stringify(refusedTick)}`);
  check("…no claim is written, the mailbox's next send time is untouched, and she stays pending for the next build",
    noorClaims.length === 0 && afterRefusal.nextEmailTime === null && afterRefusal.todayEmailsSent === 5 && (await leadNow(noor.lead.id)).sequenceStatus === "pending", `${noorClaims.length} claims, next ${afterRefusal.nextEmailTime?.toISOString()}, ${afterRefusal.todayEmailsSent} sent`);
  const day = await newLeadsToday();
  check("…today's count stops at the limit", day.used === day.limit, `${day.used} of ${day.limit}`);
  const sameDay = await buildMailboxQueues({ organizationIds: [organizationId] });
  check("…a rebuild the same day does not queue her again (no place is left)", sameDay.failedOrganizations.length === 0 && !(await queueOf()).some((q) => q.leadId === noor.lead.id), JSON.stringify(await queueOf()));
  const nextDay = new Date(day.resetsAt.getTime() + 60_000);
  const nextBuild = await buildMailboxQueues({ organizationIds: [organizationId], now: nextDay });
  await readyMailbox();
  const resumedNextDay = await tick(nextDay);
  check("the next workspace day she is queued again and emailed once", nextBuild.newLeadsQueued === 1 && resumedNextDay.sent === 1 && sentTo(noor.email) === 1 && (await leadNow(noor.lead.id)).sequenceStatus === "initial_sent", `${JSON.stringify(nextBuild)} ${JSON.stringify(resumedNextDay)}`);
  await saveChannelRules("general", { newLeadsPerDay: 50 }, null);

  await setCampaignStatus(campaign.id, "paused");
  await db.delete(outreachMailboxQueue).where(eq(outreachMailboxQueue.mailboxId, mailbox!.id));
  await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, mailbox!.id));
  await db.update(outreachCampaigns).set({ name: "Engine check email (finished)" }).where(eq(outreachCampaigns.id, campaign.id));

  // --------------------------------------------------------------- WhatsApp
  const waPeople = await db.insert(people).values([1, 2].map((n) => ({
    organizationId: currentOrganizationId(),
    phone: `+1415555${String((stamp + n) % 10000).padStart(4, "0")}`,
    firstName: `Wa${n}`,
    source: "engine-check",
  }))).returning();
  const [account] = await db.insert(whatsappAccounts).values({
    organizationId: currentOrganizationId(),
    unipileAccountId: `engine-check-${stamp}`,
    name: "Engine check number",
    phone: "+14155550000",
    status: "connected",
    connectedAt: new Date(Date.now() - 3 * 86_400_000),
  }).returning();
  const waCampaign = await createWhatsappCampaign({
    name: "Engine check WhatsApp",
    accountIds: [account!.id],
    steps: [
      { id: randomUUID(), body: "Hi {{firstName}}", delayHours: 0 },
      { id: randomUUID(), body: "Following up", delayHours: 24 },
    ],
  });
  await addPeopleToWhatsappCampaign(waCampaign.id, waPeople.map((p) => p.id));

  const refused = await updateWhatsappCampaign(waCampaign.id, { status: "active" }).then(() => null, (error: Error & { status?: number }) => error);
  check("WhatsApp launch is refused while Unipile is not connected", refused?.status === 409 && /Unipile/.test(refused.message), refused?.message ?? "launched");

  // A stand-in Unipile connection, for this organization only, on a host that cannot resolve.
  const [provider] = await db.insert(gridProviders).values({ organizationId: currentOrganizationId(), key: "platform-unipile", name: "Unipile (engine check)" }).returning();
  await db.insert(gridProviderCredentials).values({ providerId: provider!.id, encryptedPayload: encryptIntegrationCredentials({ apiKey: "engine-check", dsn: "https://unipile.invalid" }) });
  console.log("…waiting 31 s for the platform credential cache (30 s) to see the new connection");
  await new Promise((resolve) => setTimeout(resolve, 31_000));
  try {
    const launched = await updateWhatsappCampaign(waCampaign.id, { status: "active" });
    check("with Unipile, a number and leads, WhatsApp launch is accepted", launched.status === "active");

    const waSent: string[] = [];
    const waOrigins: (string | undefined)[] = [];
    const waSend = (async (request: { personId?: string | null; crmOrigin?: string }) => {
      waSent.push(request.personId ?? "");
      waOrigins.push(request.crmOrigin);
      // whatsapp_campaign_sends.whatsapp_message_id references whatsapp_messages;
      // the real sender stores that row, this stand-in has none to point at.
      return { message: { id: null }, chat: {} };
    }) as unknown as Parameters<typeof runWhatsappCampaignTick>[0] extends { send?: infer S } ? S : never;
    const waTick = () => runWhatsappCampaignTick({ send: waSend });

    // WhatsApp rate-limits the number: a wait on the number, not a failure of the lead.
    const refusing = (async () => {
      throw new WhatsappSendRefusedError("WhatsApp is rate-limiting this number: +14155550000 is busy. Try again later.", 429, 60, "rate_limited");
    }) as unknown as typeof waSend;
    // (The tick's own totals cover every organization; this one's leads and claims are what count here.)
    const held = await runWhatsappCampaignTick({ send: refusing });
    const [heldAccount] = await db.select().from(whatsappAccounts).where(eq(whatsappAccounts.id, account!.id));
    const heldLeads = await db.select().from(whatsappCampaignLeads).where(eq(whatsappCampaignLeads.campaignId, waCampaign.id));
    const heldClaims = await db.select().from(whatsappCampaignSends).where(inArray(whatsappCampaignSends.leadId, heldLeads.map((lead) => lead.id)));
    check("a rate-limit refusal is kept on the number as a short reason, without the provider's text or a phone number",
      heldAccount?.lastRefusal === "WhatsApp refused: rate limited (try again later)" && Boolean(heldAccount.lastRefusalAt) && !/1415/.test(heldAccount.lastRefusal ?? ""), `${heldAccount?.lastRefusal} at ${heldAccount?.lastRefusalAt?.toISOString()}`);
    check("…and the wait fails no lead and leaves no claim behind to resend", heldLeads.every((lead) => lead.status === "queued" && !lead.lastError) && heldClaims.length === 0 && waSent.length === 0, `${JSON.stringify(held)}; ${heldLeads.map((lead) => lead.status).join(",")}; ${heldClaims.length} claims`);

    const w1 = await waTick();
    check("a WhatsApp tick sends one first message per number", w1.sent === 1 && waSent.length === 1, JSON.stringify(w1));
    const [clearedAccount] = await db.select().from(whatsappAccounts).where(eq(whatsappAccounts.id, account!.id));
    check("the next accepted send clears the held-back reason", clearedAccount?.lastRefusal === null && clearedAccount.lastRefusalAt === null, `${clearedAccount?.lastRefusal}`);
    // So the CRM records the step as a campaign message, not as the owner's answer (crmBridge.ts).
    check("a WhatsApp step is sent with the CRM origin \"campaign\"", waOrigins.length === 1 && waOrigins[0] === "campaign", JSON.stringify(waOrigins));

    await updateWhatsappCampaign(waCampaign.id, { status: "paused" });
    const w2 = await waTick();
    check("a paused WhatsApp campaign sends nothing", waSent.length === 1, JSON.stringify(w2));
    await updateWhatsappCampaign(waCampaign.id, { status: "active" });
    const w3 = await waTick();
    check("after resuming, the next lead gets its first message", waSent.length === 2 && waSent[1] !== waSent[0], JSON.stringify(w3));

    // The first lead replies; their follow-up is made due and must not send.
    const firstPersonId = waSent[0]!;
    await ingestInboundReply({
      personId: firstPersonId,
      channel: "email",
      accountRef: "engine-check@example.test",
      providerThreadId: `engine-check-wa-thread-${stamp}`,
      idempotencyKey: `engine-check-wa-reply-${stamp}`,
      providerMessageId: `engine-check-wa-provider-${stamp}`,
      subject: "Re: hi",
      bodyText: "Got it, thanks.",
      sentAt: new Date(),
    });
    const [replied] = await db.select().from(whatsappCampaignLeads).where(and(eq(whatsappCampaignLeads.campaignId, waCampaign.id), eq(whatsappCampaignLeads.personId, firstPersonId)));
    check("a reply on any channel marks the WhatsApp enrollment replied", replied?.status === "replied", replied?.status);

    // The second lead's follow-up was already claimed by an earlier attempt.
    const secondPersonId = waSent[1]!;
    const [second] = await db.select().from(whatsappCampaignLeads).where(and(eq(whatsappCampaignLeads.campaignId, waCampaign.id), eq(whatsappCampaignLeads.personId, secondPersonId)));
    await db.insert(whatsappCampaignSends).values({ leadId: second!.id, step: 1, stepId: "claimed-earlier", status: "sent", accountId: account!.id, body: "Following up", sentAt: new Date() });
    await db.update(whatsappCampaignLeads).set({ nextSendAt: past() }).where(eq(whatsappCampaignLeads.campaignId, waCampaign.id));
    await waTick();
    check("neither the replied lead nor an already-claimed step is sent again", waSent.length === 2, `${waSent.length} sends`);
    const [secondAfter] = await db.select().from(whatsappCampaignLeads).where(eq(whatsappCampaignLeads.id, second!.id));
    check("an already-sent claim advances the lead instead", secondAfter?.currentStep === 2 && secondAfter.status === "completed", `${secondAfter?.status} step ${secondAfter?.currentStep}`);

    // ---------------------------------------- P04: an email plan's state, from its leads first
    // The mailbox sends through Unipile now (connected above), so no sender problem hides the lead's own state.
    await updateWhatsappCampaign(waCampaign.id, { status: "paused" });
    const pausedUntil = new Date(Date.now() + 20 * 60_000);
    await db.update(mailboxes).set({ status: "connected", provider: "unipile", unipileAccountId: `engine-check-mail-${stamp}`, nextEmailTime: pausedUntil }).where(eq(mailboxes.id, mailbox!.id));
    await db.delete(outreachMailboxQueue).where(eq(outreachMailboxQueue.mailboxId, mailbox!.id));
    await setCampaignStatus(campaign.id, "active");
    const audienceId = await createAudience({ name: "Engine check P04", source: "list" });
    const [plan] = await db.insert(outreachRuns).values({ organizationId, audienceId, name: "Direct email lead", status: "running", channels: ["email"], campaigns: { email: campaign.id }, plan: { assignments: [] } as unknown as OutreachPlan, autopilot: false }).returning();
    await db.insert(outreachRunLeads).values({ organizationId, runId: plan!.id, personId: ahead.lead.personId, channel: "email" });
    const planNow = async () => (await listWork(new Date(), { runIds: [plan!.id] })).find((item) => item.id === plan!.id);
    const followUpAt = (await leadNow(ahead.lead.id)).nextSendAt!.toISOString();
    const live = await planNow();
    check("the live case: first email sent, its follow-up days away, an empty queue and a pause between sends read Scheduled with the follow-up's time",
      live?.state === "scheduled" && live.stateLabel === "Scheduled" && live.reason === "1 contacted — waiting for a reply" && live.nextAt === followUpAt, `${live?.state}: ${live?.reason} ${live?.nextAt} (follow-up ${followUpAt})`);
    const [liveLead] = (await runLeads([plan!.id]))[plan!.id] ?? [];
    check("…the lead says First email sent — waiting for a reply, with its next follow-up", liveLead?.progress.text === "First email sent — waiting for a reply" && liveLead.nextAt === followUpAt && liveLead.queued === false, JSON.stringify(liveLead));
    const sender = (await diagnoseDelivery(plan!.id)).senders.find((entry) => entry.channel === "email");
    check("…its mailbox shows no hold: the pause and the empty queue are technical details", sender?.gates.length === 0 && sender.details.some((line) => line.startsWith("Pausing between sends until")) && sender.details.some((line) => /send queue/.test(line)), JSON.stringify(sender));

    const due = await extraLead("zed");
    await db.insert(outreachRunLeads).values({ organizationId, runId: plan!.id, personId: due.lead.personId, channel: "email" });
    const missing = await planNow();
    check("a first email due with nothing in the queue: not prepared yet, prepared again automatically (never a cooldown)", missing?.state === "waiting_send" && missing.reason === "1 due message is not prepared for sending yet; it is prepared again automatically" && missing.nextAt === null, `${missing?.state}: ${missing?.reason}`);
    await db.insert(outreachMailboxQueue).values({ mailboxId: mailbox!.id, leadId: due.lead.id, position: 0 });
    const cooling = await planNow();
    check("…once it is queued, the pause between sends that delays it shows, with when it ends", cooling?.state === "waiting_send" && /^no sender can send right now: Pausing between sends until \d\d:\d\d:\d\d \(/.test(cooling.reason ?? "") && cooling.nextAt === pausedUntil.toISOString(), `${cooling?.state}: ${cooling?.reason} ${cooling?.nextAt}`);
    await db.delete(outreachMailboxQueue).where(eq(outreachMailboxQueue.mailboxId, mailbox!.id));
    const usedNow = await newLeadsToday();
    await saveChannelRules("general", { newLeadsPerDay: Math.max(1, usedNow.used) }, null);
    const limited = await planNow();
    const limitDay = await newLeadsToday();
    check("the daily lead limit reached shows as its own state, with the reset time", limited?.state === "daily_lead_limit" && limited.stateLabel === "Daily lead limit reached" && Boolean(limited.reason?.startsWith("Daily lead limit reached (")) && limited.nextAt === limitDay.resetsAt.toISOString(), `${limited?.state}: ${limited?.reason} ${limited?.nextAt}`);
    await saveChannelRules("general", { newLeadsPerDay: 50 }, null);
    await db.update(outreachRuns).set({ status: "stopped" }).where(eq(outreachRuns.id, plan!.id));
    await setCampaignStatus(campaign.id, "paused");
    await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, mailbox!.id));
  } finally {
    await updateWhatsappCampaign(waCampaign.id, { status: "paused" }).catch(() => {});
    await db.delete(gridProviders).where(eq(gridProviders.id, provider!.id));
    await db.update(whatsappAccounts).set({ status: "disconnected" }).where(eq(whatsappAccounts.id, account!.id));
  }
});

console.log(failures ? `\n${failures} check(s) failed.` : "\nCampaign engine checks passed.");
process.exit(failures ? 1 : 0);

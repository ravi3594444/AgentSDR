/**
 * Campaign engines, end to end against the database: the email queue and send
 * tick, and the WhatsApp campaign tick, driven with a recording sender in
 * place of Gmail and Unipile. It checks what the unit tests cannot: the
 * daily allowance, the throttle, pause and resume, the per-step send claim,
 * a reply stopping the remaining follow-ups (through the real CRM ingestion),
 * a reply landing while a step is being sent, and the server-side launch
 * rules reading real rows.
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
 * Refuses a non-local DATABASE_URL, and refuses to tick while any other
 * organization has a queued email (the tick is global).
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne, sql } from "drizzle-orm";

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
const { buildMailboxQueues } = await import("@/lib/outreach/buildQueue");
const { runSchedulerTick } = await import("@/lib/outreach/scheduler");
const { ingestInboundReply } = await import("@/lib/crm/conversations");
const { gridProviderCredentials, gridProviders } = await import("@/lib/grid/schema");
const { encryptIntegrationCredentials } = await import("@/lib/integrations/credentials");
const { whatsappAccounts, whatsappCampaignLeads, whatsappCampaignSends } = await import("@/lib/whatsapp/schema");
const { addPeopleToWhatsappCampaign, createWhatsappCampaign, updateWhatsappCampaign } = await import("@/lib/whatsapp/campaigns/campaigns.server");
const { runWhatsappCampaignTick } = await import("@/lib/whatsapp/campaigns/engine");
const { runInOrganization, currentOrganizationId } = await import("@/lib/tenancy/scope");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const stamp = Date.now();
const [org] = await db.insert(organizations).values({ name: `Engine check ${stamp}`, slug: `engine-check-${stamp}` }).returning();
console.log(`Organization ${org!.name} (${org!.id})`);

const ALL_DAY = { enabled: true, from: "00:00", to: "23:59" };
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
  const leads = await db.insert(outreachLeads).values(persons.map((p) => ({ personId: p.id, campaignId: campaign.id }))).returning();
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
    workingHours: { timezone: "UTC", days: { monday: ALL_DAY, tuesday: ALL_DAY, wednesday: ALL_DAY, thursday: ALL_DAY, friday: ALL_DAY, saturday: ALL_DAY, sunday: ALL_DAY } },
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

  const otherQueues = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(outreachMailboxQueue)
    .innerJoin(mailboxes, eq(outreachMailboxQueue.mailboxId, mailboxes.id))
    .where(ne(mailboxes.organizationId, currentOrganizationId()));
  if (Number(otherQueues[0]?.n ?? 0) > 0) {
    console.error("Another organization has queued emails; the send tick is global, so this check stops here.");
    process.exit(2);
  }
  const tick = () => runSchedulerTick({ send: fakeSend });
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

  // A step already claimed (an earlier attempt) is never sent again.
  const linus = leadOf("linus");
  await db.insert(outreachEmails).values({ leadId: linus.id, mailboxId: mailbox!.id, stepNumber: 2, subject: "", body: "Follow-up", status: "scheduled" });
  await db.update(outreachLeads).set({ nextSendAt: past() }).where(eq(outreachLeads.id, linus.id));
  await db.update(mailboxes).set({ todayEmailsSent: 0 }).where(eq(mailboxes.id, mailbox!.id));
  await buildMailboxQueues({ organizationIds: [currentOrganizationId()] });
  await readyMailbox();
  const sendsBefore = sent.length;
  const claimed = await tick();
  check("a step with an existing claim is skipped, not re-sent", claimed.skippedAlreadyClaimed === 1 && sent.length === sendsBefore, JSON.stringify(claimed));

  const perRecipient = recipients.map((r) => sent.filter((to) => to === r.email).length);
  check("each recipient got each step at most once (ada 2, grace 1, linus 1)", JSON.stringify(perRecipient) === "[2,1,1]", JSON.stringify(perRecipient));
  const stored = await db.select({ n: sql<number>`count(*)::int` }).from(outreachEmails).where(and(inArray(outreachEmails.leadId, leads.map((l) => l.id)), eq(outreachEmails.status, "sent")));
  check("every send is recorded as sent in outreach_emails", Number(stored[0]?.n) === 4, String(stored[0]?.n));

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

    const w1 = await waTick();
    check("a WhatsApp tick sends one first message per number", w1.sent === 1 && waSent.length === 1, JSON.stringify(w1));
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
  } finally {
    await updateWhatsappCampaign(waCampaign.id, { status: "paused" }).catch(() => {});
    await db.delete(gridProviders).where(eq(gridProviders.id, provider!.id));
    await db.update(whatsappAccounts).set({ status: "disconnected" }).where(eq(whatsappAccounts.id, account!.id));
  }
});

console.log(failures ? `\n${failures} check(s) failed.` : "\nCampaign engine checks passed.");
process.exit(failures ? 1 : 0);

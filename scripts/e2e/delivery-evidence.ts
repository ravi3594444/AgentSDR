/**
 * What a plan card claims, checked against the records it reads, on the
 * local database:
 * - who authorized each plan (Start, a request approval, Autonomous mode,
 *   or not started at all);
 * - each WhatsApp number, sending at any time (no hours, no invented time
 *   zone), the gate holding it and the earliest time it may send (the
 *   rolling new-chat limit counted across every campaign on the number), its
 *   used / limit / available line and why the campaign sender last held it back;
 * - each LinkedIn account's rest between runs to the second, the next
 *   scheduled check, its invitation limit, and when the invitation-limit
 *   flag is cleared, in the organization's time zone; its old working hours
 *   hold nothing (sending is always on);
 * - reading any of it writes nothing;
 * - each lead's delivery evidence (accepted, then delivered as WhatsApp
 *   reported, then a read receipt), never "seen";
 * - an uncertain send shown as such, never resent;
 * - a plan's senders only on the channels it uses (no unrelated mailbox or
 *   Instagram account, on the card or in what diagnose_delivery tells the
 *   model), and a plan whose launch failed never called started;
 * - a second organization reading nothing.
 * No message is sent and no provider is called.
 *
 *   bun run --conditions=react-server scripts/e2e/delivery-evidence.ts
 *
 * Creates its own organizations ("Delivery check …") and leaves them.
 * Refuses a non-local DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}

const { db } = await import("@/lib/db");
const { organizations, users, members } = await import("@/lib/auth/schema");
const { people } = await import("@/lib/leads/schema");
const { gridProviderCredentials, gridProviders } = await import("@/lib/grid/schema");
const { encryptIntegrationCredentials } = await import("@/lib/integrations/credentials");
const { whatsappAccounts, whatsappCampaignLeads, whatsappCampaignSends, whatsappChats, whatsappMessages } = await import("@/lib/whatsapp/schema");
const { mailboxes } = await import("@/lib/outreach/schema");
const { instagramAccounts } = await import("@/lib/instagram/schema");
const { setFeature } = await import("@/lib/features/flags.server");
const { createWhatsappCampaign, addPeopleToWhatsappCampaign } = await import("@/lib/whatsapp/campaigns/campaigns.server");
const { outreachRuns, outreachRunLeads, assistantThreads } = await import("@/lib/assistant/schema");
const { runInOrganization } = await import("@/lib/tenancy/scope");
const { saveChannelRules } = await import("@/lib/channels/rules.server");
const { createThread, addMessage } = await import("@/lib/assistant/threads.server");
const { createAudience } = await import("@/lib/assistant/audiences.server");
const { diagnoseDelivery } = await import("@/lib/assistant/deliveryDiagnostics.server");
const { runLeads } = await import("@/lib/assistant/runLeads.server");
const { assistantState } = await import("@/lib/assistant/http.server");
const linkedinSchema = await import("@/lib/linkedin/schema");
type OutreachPlan = import("@/lib/assistant/schema").OutreachPlan;
type OrgContext = import("@/lib/auth/context").OrgContext;

const stamp = Date.now();
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function organization(label: string) {
  const [org] = await db.insert(organizations).values({ name: `Delivery check ${label} ${stamp}`, slug: `delivery-check-${label}-${stamp}` }).returning();
  const [owner] = await db.insert(users).values({ name: `Owner ${label.toUpperCase()}`, email: `owner-${label}-${stamp}@delivery-check.test`, emailVerified: true }).returning();
  await db.insert(members).values({ organizationId: org!.id, userId: owner!.id, role: "owner" });
  return { org: org!, owner: owner! };
}
const a = await organization("a");
const b = await organization("b");

const now = new Date();

const seeded = await runInOrganization(a.org.id, async () => {
  // A stand-in Unipile connection, stored before anything reads it (so no cache to wait out). Nothing calls it.
  const [provider] = await db.insert(gridProviders).values({ organizationId: a.org.id, key: "platform-unipile", name: "Unipile (delivery check)" }).returning();
  await db.insert(gridProviderCredentials).values({ providerId: provider!.id, encryptedPayload: encryptIntegrationCredentials({ apiKey: "delivery-check", dsn: "https://unipile.invalid" }) });
  // Sending hours are gone: a save that still names them is refused, and nothing is stored.
  const refusedHours = await saveChannelRules("whatsapp", { sendingHours: { timezone: "Asia/Kolkata", days: [1], start: "09:00", end: "10:00" } }, a.owner.id).then(() => null, (error: Error) => error.message);
  if (!refusedHours || !/always on/.test(refusedHours)) throw new Error(`a save naming sending hours was not refused: ${refusedHours}`);
  // The organization's own time zone and new day: the panel writes its times in it.
  await saveChannelRules("general", { timeZone: "Asia/Kolkata", dayStartsAt: "05:30" }, a.owner.id);
  const [account] = await db.insert(whatsappAccounts).values({ organizationId: a.org.id, unipileAccountId: `delivery-check-${stamp}`, name: "Sales number", phone: "+919800000099", status: "connected", connectedAt: new Date(now.getTime() - 3 * 86_400_000) }).returning();
  // A mailbox and an Instagram account the WhatsApp plans do not send from.
  const [mailbox] = await db.insert(mailboxes).values({ organizationId: a.org.id, emailAddress: `sales-${stamp}@delivery-check.test`, status: "connected" }).returning();
  await setFeature("instagram", true, a.owner.id);
  const [instagram] = await db.insert(instagramAccounts).values({ organizationId: a.org.id, unipileAccountId: `delivery-check-ig-${stamp}`, username: `delivery_check_${stamp}`, status: "connected" }).returning();
  const leads = await db.insert(people).values([1, 2].map((n) => ({ organizationId: a.org.id, phone: `+919${String(stamp % 100_000_000).padStart(8, "0")}${n}`, fullName: `Lead ${n}`, source: "delivery-check" }))).returning();
  const campaign = await createWhatsappCampaign({ name: "Delivery check", accountIds: [account!.id], steps: [{ id: randomUUID(), body: "Hi {{firstName}}", delayHours: 0 }, { id: randomUUID(), body: "Following up", delayHours: 24 }] });
  const added = await addPeopleToWhatsappCampaign(campaign.id, leads.map((lead) => lead.id));
  if (added.added !== 2) console.log("addPeopleToWhatsappCampaign:", JSON.stringify(added));
  const thread = await createThread(a.owner.id);
  const audienceId = await createAudience({ name: "delivery check", source: "list" });
  const requestId = randomUUID();
  const run = async (name: string, values: Omit<Partial<typeof outreachRuns.$inferInsert>, "plan"> & { plan?: Record<string, unknown> }) => {
    const [row] = await db.insert(outreachRuns).values({
      organizationId: a.org.id, threadId: thread.id, audienceId, name, status: "running", channels: ["whatsapp"], autopilot: false, createdBy: a.owner.id,
      approvedBy: a.owner.id, approvedAt: new Date(now.getTime() - 3_600_000), ...values, plan: { requestId, assignments: [], samples: [], excluded: [], limits: {}, estimate: { aiCalls: 0, aiCostUsd: 0, days: 0 }, ...(values.plan ?? {}) } as unknown as OutreachPlan,
    }).returning();
    await addMessage({ threadId: thread.id, role: "tool", tool: "prepare_outreach", status: "ok", content: "", toolResult: { data: { runId: row!.id } } });
    return row!;
  };
  const approval = { requestId, ownerRequest: null, autopilot: false, approvedBy: a.owner.id, approvedAt: new Date(now.getTime() - 2 * 3_600_000).toISOString(), expiresAt: new Date(now.getTime() + 22 * 3_600_000).toISOString(), channels: ["whatsapp" as const], maxLeadsPerPlan: 100 };
  const started = await run("Pune agents", { campaigns: { whatsapp: campaign.id }, plan: { requestApproval: approval } });
  const sibling = await run("Pune agents, more", { plan: { startedUnder: started.id } });
  const unmarked = await run("Pune agents, unmarked", {});
  const automatic = await run("Autonomous plan", { autopilot: true, plan: { autonomous: true } });
  const proposed = await run("Waiting plan", { status: "proposed", approvedBy: null, approvedAt: null });
  const emailPlan = await run("Email plan", { status: "starting", channels: ["email"] });
  // Start was pressed and no channel launched: the only way a run becomes failed.
  const failedStart = await run("Could not start", { status: "failed", error: "whatsapp: No connected WhatsApp number" });
  await db.update(assistantThreads).set({ autonomous: true, autonomousBy: a.owner.id, autonomousAt: now }).where(eq(assistantThreads.id, thread.id));
  await db.insert(outreachRunLeads).values(leads.map((lead) => ({ organizationId: a.org.id, runId: started.id, personId: lead.id, channel: "whatsapp" as const })));
  // A LinkedIn plan: one account with its own hours (Mon–Fri 09:00–18:00 in New York) that has used its 5 invitations today.
  const linkedin = linkedinSchema;
  const [liAccount] = await db.insert(linkedin.linkedInAccounts).values({ organizationId: a.org.id, linkedinId: `delivery-li-${stamp}`, username: `delivery-li-${stamp}`, name: "Ravi", status: "CONNECTED", dailyInviteLimit: 5, workTimezone: "America/New_York", workStartTime: "09:00", workEndTime: "18:00", workDays: "1,2,3,4,5", updatedAt: new Date() }).returning();
  const [liCampaign] = await db.insert(linkedin.campaigns).values({ organizationId: a.org.id, name: "Delivery check LinkedIn", type: "REGULAR", status: "ACTIVE", updatedAt: new Date() }).returning();
  await db.insert(linkedin.campaignAccounts).values({ campaignId: liCampaign!.id, linkedinAccountId: liAccount!.id });
  const sentToday = new Date(now);
  sentToday.setHours(0, 5, 0, 0);
  const liPeople = await db.insert(people).values(Array.from({ length: 8 }, (_, index) => ({ organizationId: a.org.id, fullName: `LinkedIn lead ${index}`, linkedinUrl: `https://www.linkedin.com/in/delivery-${stamp}-${index}`, source: "delivery-check" }))).returning({ id: people.id });
  await db.insert(linkedin.leads).values(liPeople.map((person, index) => ({
    organizationId: a.org.id, personId: person.id, linkedinUrl: `https://www.linkedin.com/in/delivery-${stamp}-${index}`, campaignId: liCampaign!.id, updatedAt: new Date(),
    ...(index < 5 ? { linkedinAccountId: liAccount!.id, status: "REQUEST_SENT" as const, requestSentAt: sentToday } : { status: "PENDING" as const }),
  })));
  const liPlan = await run("LinkedIn plan", { channels: ["linkedin"], campaigns: { linkedin: liCampaign!.id } });
  return { account: account!, mailbox: mailbox!, instagram: instagram!, leads, campaign, thread, started, sibling, unmarked, automatic, proposed, emailPlan, failedStart, liPlan, liAccount: liAccount! };
});

await runInOrganization(a.org.id, async () => {
  const diagnostics = await diagnoseDelivery(seeded.started.id);
  const sender = diagnostics.senders.find((entry) => entry.channel === "whatsapp");
  check("the plan's number is listed, sending at any time: no time zone is invented and nothing is holding it", sender?.account === "+919800000099" && sender.timezone === null && sender.gates.length === 0 && sender.nextAt === null, JSON.stringify(sender));
  check("its two leads are counted as waiting", sender?.queued === 2);
  check("the summary never infers a time zone from leads", /Lead cities do not determine/.test(diagnostics.summary) && /Asia\/Kolkata/.test(diagnostics.summary));
  check("a WhatsApp plan lists no mailbox or Instagram account it does not send from", diagnostics.senders.every((entry) => entry.channel === "whatsapp"), diagnostics.senders.map((entry) => `${entry.channel} ${entry.account}`).join("; "));
  // What diagnose_delivery hands the model for that plan: no other channel's account in its data or its summary.
  const names = (summary: string) => ({ mailbox: summary.includes(seeded.mailbox.emailAddress), instagram: summary.includes(`@${seeded.instagram.username}`), noMailbox: summary.includes("No email mailbox is configured") });
  check("…nor does its diagnosis data", diagnostics.email.length === 0 && diagnostics.instagram.length === 0 && diagnostics.instagramErrors.length === 0, `email ${diagnostics.email.map((m) => m.mailbox).join(", ")}; instagram ${diagnostics.instagram.map((i) => i.account).join(", ")}`);
  check("…nor its diagnosis summary", JSON.stringify(names(diagnostics.summary)) === JSON.stringify({ mailbox: false, instagram: false, noMailbox: false }), diagnostics.summary);
  const emailPlan = await diagnoseDelivery(seeded.emailPlan.id);
  const emailSenders = emailPlan.senders;
  check("an email plan lists the mailboxes, not the Instagram accounts", emailSenders.some((entry) => entry.channel === "email" && entry.account === seeded.mailbox.emailAddress) && emailSenders.every((entry) => entry.channel === "email"), emailSenders.map((entry) => `${entry.channel} ${entry.account}`).join("; "));
  check("…and so do its diagnosis data and summary", emailPlan.email.some((m) => m.mailbox === seeded.mailbox.emailAddress) && emailPlan.instagram.length === 0 && JSON.stringify(names(emailPlan.summary)) === JSON.stringify({ mailbox: true, instagram: false, noMailbox: false }), emailPlan.summary);
  const liDiagnosis = await diagnoseDelivery(seeded.liPlan.id);
  const liSender = liDiagnosis.senders.find((entry) => entry.channel === "linkedin");
  check("a LinkedIn plan lists its LinkedIn account, its old working hours ignored (no time zone, no hours gate), nothing marked uncovered", liDiagnosis.senders.length === 1 && liSender?.account === `@${seeded.liAccount.username}` && liSender.timezone === null && !liSender.gates.some((gate) => /hours/i.test(gate)) && liDiagnosis.notCovered.length === 0, JSON.stringify(liDiagnosis.senders));
  check("…with its daily invitation limit as a gate, the next allowed time, and its 3 waiting invitations", Boolean(liSender?.gates.includes("5 of 5 invitations sent today")) && Boolean(liSender?.nextAt) && new Date(liSender!.nextAt!) > now && liSender?.queued === 3 && /Follow-up/.test(liSender?.note ?? ""), JSON.stringify(liSender));
  check("…and diagnose_delivery tells the model the same, with no working hours", liDiagnosis.summary.includes(`LinkedIn @${seeded.liAccount.username}: 3 invitations waiting`) && !liDiagnosis.summary.includes("America/New_York") && /Sending is always on/.test(liDiagnosis.summary), liDiagnosis.summary);
  const organizationWide = await diagnoseDelivery();
  const everySender = organizationWide.senders;
  check("the organization's own snapshot still lists every mailbox and Instagram account", everySender.some((entry) => entry.channel === "email" && entry.account === seeded.mailbox.emailAddress) && everySender.some((entry) => entry.channel === "instagram" && entry.account === `@${seeded.instagram.username}`), everySender.map((entry) => `${entry.channel} ${entry.account}`).join("; "));
  check("…in its summary too", names(organizationWide.summary).mailbox && names(organizationWide.summary).instagram, organizationWide.summary);


  // The first lead got a message: a chat this number started, delivered as WhatsApp reported.
  const [lead1, lead2] = seeded.leads;
  const [chat] = await db.insert(whatsappChats).values({ accountId: seeded.account.id, unipileChatId: `chat-${stamp}`, phone: lead1!.phone!, personId: lead1!.id }).returning();
  const sentAt = new Date(now.getTime() - 60_000);
  const [message] = await db.insert(whatsappMessages).values({ chatId: chat!.id, unipileMessageId: `msg-${stamp}`, direction: "outbound", origin: "agentsdr", body: "Hi Lead", sentAt, deliveredAt: sentAt }).returning();
  const [campaignLead1] = await db.select().from(whatsappCampaignLeads).where(eq(whatsappCampaignLeads.personId, lead1!.id));
  await db.update(whatsappCampaignLeads).set({ status: "in_sequence", lastSentAt: sentAt, currentStep: 1 }).where(eq(whatsappCampaignLeads.id, campaignLead1!.id));
  await db.insert(whatsappCampaignSends).values({ leadId: campaignLead1!.id, step: 0, status: "sent", accountId: seeded.account.id, whatsappMessageId: message!.id, sentAt });
  await db.update(whatsappCampaignLeads).set({ status: "failed", lastError: "Delivery of message 1 is uncertain — check Messages before resuming" }).where(eq(whatsappCampaignLeads.personId, lead2!.id));

  const progress = async () => Object.fromEntries((await runLeads([seeded.started.id]))[seeded.started.id]!.map((lead) => [lead.personId, lead.progress.text]));
  let texts = await progress();
  check("a delivered message says delivered as WhatsApp reported, not seen", texts[lead1!.id] === "Delivered (WhatsApp reported), waiting for a reply", texts[lead1!.id]);
  check("an uncertain send says so and is not resent", /uncertain; no automatic resend/.test(texts[lead2!.id] ?? ""), texts[lead2!.id]);
  await db.update(whatsappMessages).set({ readAt: new Date() }).where(eq(whatsappMessages.id, message!.id));
  texts = await progress();
  check("a read receipt is shown as a read receipt", texts[lead1!.id] === "Read receipt received, waiting for a reply", texts[lead1!.id]);
  check("no lead line says seen", Object.values(texts).every((text) => !/\bseen\b/i.test(text)));

  // The number's own limit of one new chat a day is now used by that chat.
  await db.update(whatsappAccounts).set({ newChatsPerDay: 1 }).where(eq(whatsappAccounts.id, seeded.account.id));
  const limited = (await diagnoseDelivery(seeded.started.id)).senders.find((entry) => entry.channel === "whatsapp");
  const [storedChat] = await db.select({ createdAt: whatsappChats.createdAt }).from(whatsappChats).where(eq(whatsappChats.id, chat!.id));
  check("the rolling new-chat limit holds new chats until the oldest falls out of 24 hours", limited?.gates.join() === "1 of 1 new chats used in the last 24 hours" && limited.nextAt === new Date(storedChat!.createdAt.getTime() + 86_400_000).toISOString() && /Follow-ups/.test(limited.note ?? ""), `${limited?.gates.join("; ")} next ${limited?.nextAt}`);

  // Two older chats it started, then the limit lowered to 2 under the 3 now in the window: one must age out, the oldest is not enough.
  const older = [20, 10].map((hoursAgo) => new Date(now.getTime() - hoursAgo * 3_600_000));
  for (const [index, createdAt] of older.entries()) {
    const [olderChat] = await db.insert(whatsappChats).values({ accountId: seeded.account.id, unipileChatId: `chat-${stamp}-older-${index}`, phone: `+9198000${String(stamp % 10_000).padStart(4, "0")}${index}`, createdAt }).returning();
    await db.insert(whatsappMessages).values({ chatId: olderChat!.id, unipileMessageId: `msg-${stamp}-older-${index}`, direction: "outbound", origin: "agentsdr", body: "Hi", sentAt: createdAt });
  }
  await db.update(whatsappAccounts).set({ newChatsPerDay: 2 }).where(eq(whatsappAccounts.id, seeded.account.id));
  const over = (await diagnoseDelivery(seeded.started.id)).senders.find((entry) => entry.channel === "whatsapp");
  const freed = new Date(older[1]!.getTime() + 86_400_000).toISOString();
  check("over a lowered limit, new chats wait until enough chats leave the 24 hours, not just the oldest", over?.gates.join() === "3 of 2 new chats used in the last 24 hours" && over.nextAt === freed, `${over?.gates.join("; ")} next ${over?.nextAt} (expected ${freed})`);

  const ctx = { userId: a.owner.id, userName: "Owner A", userEmail: a.owner.email, organizationId: a.org.id, organizationName: a.org.name, organizationSlug: a.org.slug, roles: ["owner"] } as unknown as OrgContext;
  const state = await assistantState(seeded.thread.id, ctx, false);
  const auth = (id: string) => (state.runs as Record<string, { authorization: { kind: string; text: string; until: string | null } }>)[id]?.authorization;
  check("Start with a request approval is named, with when it ends", auth(seeded.started.id)?.kind === "request" && auth(seeded.started.id)?.text === "Started by Owner A, who also approved the rest of this request." && Boolean(auth(seeded.started.id)?.until), auth(seeded.started.id)?.text);
  check("a plan started under that approval says so", auth(seeded.sibling.id)?.text === "Started on its own under Owner A's approval of this request.", auth(seeded.sibling.id)?.text);
  check("a start the record cannot attribute claims neither Start nor the approval", auth(seeded.unmarked.id)?.text === "Started in Owner A's name.", auth(seeded.unmarked.id)?.text);
  check("Autonomous mode is named as the authorization", auth(seeded.automatic.id)?.kind === "autonomous", auth(seeded.automatic.id)?.text);
  check("a waiting plan in an Autonomous chat is not described as started", auth(seeded.proposed.id)?.kind === "none" && /did not start this one/.test(auth(seeded.proposed.id)?.text ?? ""), auth(seeded.proposed.id)?.text);
  check("a plan whose launch failed is not described as started", auth(seeded.failedStart.id)?.kind === "none" && auth(seeded.failedStart.id)?.text === "It did not start; nothing was sent.", auth(seeded.failedStart.id)?.text);

  // Another campaign on the same number starts a chat: the rolling count is the number's, not the campaign's.
  const otherPeople = await db.insert(people).values({ organizationId: a.org.id, phone: `+9197${String(stamp % 100_000_000).padStart(8, "0")}`, fullName: "Other campaign lead", source: "delivery-check" }).returning();
  const otherCampaign = await createWhatsappCampaign({ name: "Delivery check, another campaign", accountIds: [seeded.account.id], steps: [{ id: randomUUID(), body: "Hello", delayHours: 0 }] });
  await addPeopleToWhatsappCampaign(otherCampaign.id, [otherPeople[0]!.id]);
  const [otherChat] = await db.insert(whatsappChats).values({ accountId: seeded.account.id, unipileChatId: `chat-${stamp}-other-campaign`, phone: otherPeople[0]!.phone!, personId: otherPeople[0]!.id }).returning();
  await db.insert(whatsappMessages).values({ chatId: otherChat!.id, unipileMessageId: `msg-${stamp}-other-campaign`, direction: "outbound", origin: "agentsdr", body: "Hello", sentAt: new Date() });
  await db.update(whatsappAccounts).set({ newChatsPerDay: 4, lastRefusal: "WhatsApp refused: rate limited (try again later)", lastRefusalAt: new Date(now.getTime() - 120_000) }).where(eq(whatsappAccounts.id, seeded.account.id));
  const leadsBefore = JSON.stringify(await db.select().from(whatsappCampaignLeads).where(eq(whatsappCampaignLeads.campaignId, seeded.campaign.id)));
  const sendsBefore = (await db.select().from(whatsappCampaignSends)).length;
  const [accountBefore] = await db.select().from(whatsappAccounts).where(eq(whatsappAccounts.id, seeded.account.id));
  const shared = await diagnoseDelivery(seeded.started.id);
  const full = shared.senders.find((entry) => entry.channel === "whatsapp");
  check("4 of 4 counts the other campaign's chat on the same number", full?.gates.join() === "4 of 4 new chats used in the last 24 hours", full?.gates.join("; "));
  check("…with used, limit, available and the leads waiting for a first message, and that every campaign on the number shares it",
    Boolean(full?.limits?.startsWith("New chats per 24 hours, per number: 4 of 4 used, 0 available; 0 leads wait for a first message.")) && /Every campaign on this number shares the count/.test(full?.limits ?? "") && /no reset at midnight/.test(full?.limits ?? ""), full?.limits ?? "");
  check("…when the next new chat is possible, in the organization's time zone", shared.displayTimeZone === "Asia/Kolkata" && Boolean(full?.details.some((line) => /^Next new chat possible from .*\(Asia\/Kolkata\), when the oldest counted chat is 24 hours old\.$/.test(line))), JSON.stringify(full?.details));
  check("…and why the sender last held it back, with when, without a phone number", Boolean(full?.details.some((line) => /^Last held back at \d\d:\d\d:\d\d \(Asia\/Kolkata\): WhatsApp refused: rate limited \(try again later\)\.$/.test(line))) && !/\+91/.test(full?.details.join(" ") ?? ""), JSON.stringify(full?.details));
  check("…and diagnose_delivery tells the model the same", shared.summary.includes("4 of 4 used, 0 available") && shared.summary.includes("Last held back at") && shared.summary.includes("Times above are in Asia/Kolkata"), shared.summary);

  // LinkedIn: a rest between runs ending at an odd second, then LinkedIn's invitation-limit flag.
  const restEnds = new Date(now.getTime() + 10 * 60_000 + 29_508);
  await db.update(linkedinSchema.linkedInAccounts).set({ nextAllowedRun: restEnds, limitReached: true }).where(eq(linkedinSchema.linkedInAccounts.id, seeded.liAccount.id));
  const resting = (await diagnoseDelivery(seeded.liPlan.id)).senders.find((entry) => entry.channel === "linkedin");
  const restClock = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(restEnds);
  const checkAt = new Date(Math.ceil(restEnds.getTime() / 1_800_000) * 1_800_000);
  const checkClock = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(checkAt);
  check("the rest between LinkedIn runs is a gate with its end to the second, in the organization's zone", Boolean(resting?.gates.some((gate) => gate.startsWith(`Between LinkedIn runs until `) && gate.includes(`${restClock} (Asia/Kolkata)`))), JSON.stringify(resting?.gates));
  check("…the next scheduled check is a separate line, the first :00 or :30 after the rest", Boolean(resting?.details.some((line) => line.startsWith("Next scheduled check ") && line.includes(`${checkClock} (Asia/Kolkata)`) && line.includes("every 30 minutes"))), JSON.stringify(resting?.details));
  check("…LinkedIn's invitation-limit flag says it is cleared at the organization's daily reset, with when", Boolean(resting?.gates.some((gate) => /^LinkedIn reported this account's invitation limit; the flag is cleared at the organization's daily reset, .*05:30 \(Asia\/Kolkata\)$/.test(gate))), JSON.stringify(resting?.gates));
  check("…and its own invitation limit is shown, with no working hours", resting?.limits === "Invitations: 5 of 5 sent today, 0 left.", resting?.limits ?? "");
  check("…the next send, when known, is on a scheduled check", resting?.nextAt === null || new Date(resting!.nextAt!).getTime() % 1_800_000 === 0, `${resting?.nextAt}`);

  // Reading the status changed nothing: no lead, claim or account was written.
  const [accountAfter] = await db.select().from(whatsappAccounts).where(eq(whatsappAccounts.id, seeded.account.id));
  const leadsAfter = JSON.stringify(await db.select().from(whatsappCampaignLeads).where(eq(whatsappCampaignLeads.campaignId, seeded.campaign.id)));
  check("reading the sending status writes nothing", leadsBefore === leadsAfter && (await db.select().from(whatsappCampaignSends)).length === sendsBefore && JSON.stringify(accountBefore) === JSON.stringify(accountAfter));
});

await runInOrganization(b.org.id, async () => {
  const refused = await diagnoseDelivery(seeded.started.id).then(() => "read", (error: Error) => error.message);
  check("a second organization cannot read the plan's senders", refused === "No such outreach run", refused);
  const all = await diagnoseDelivery();
  check("…and its own snapshot lists none of the first's numbers", all.senders.every((sender) => sender.account !== "+919800000099"));
  check("…nor its leads", Object.keys(await runLeads([seeded.started.id])).length === 0);
});

console.log(failures ? `\n${failures} check(s) failed` : "\nDelivery evidence checks passed");
process.exit(failures ? 1 : 0);

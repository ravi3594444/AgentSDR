/**
 * What a plan card claims, checked against the records it reads, on the
 * local database:
 * - who authorized each plan (Start, a request approval, Autonomous mode,
 *   or not started at all);
 * - each WhatsApp number's configured time zone, the gate holding it and the
 *   earliest time it may send (outside hours, the rolling new-chat limit);
 * - each lead's delivery evidence (accepted, then delivered as WhatsApp
 *   reported, then a read receipt), never "seen";
 * - an uncertain send shown as such, never resent;
 * - a plan's senders only on the channels it uses (no unrelated mailbox or
 *   Instagram account), and a plan whose launch failed never called started;
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
import { fromZonedTime, toZonedTime } from "date-fns-tz";

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

// A sending window that is closed right now: two to three hours from now, in India.
const now = new Date();
const indiaHour = toZonedTime(now, "Asia/Kolkata").getHours();
const pad = (hour: number) => `${String(hour % 24).padStart(2, "0")}:00`;
const hours = { timezone: "Asia/Kolkata", days: [0, 1, 2, 3, 4, 5, 6], start: pad(indiaHour + 2), end: pad(indiaHour + 3) };
const zoned = toZonedTime(now, "Asia/Kolkata");
const opens = new Date(zoned);
opens.setHours(indiaHour + 2, 0, 0, 0); // rolls over to tomorrow past midnight
const expectedOpen = fromZonedTime(opens, "Asia/Kolkata").toISOString();

const seeded = await runInOrganization(a.org.id, async () => {
  // A stand-in Unipile connection, stored before anything reads it (so no cache to wait out). Nothing calls it.
  const [provider] = await db.insert(gridProviders).values({ organizationId: a.org.id, key: "platform-unipile", name: "Unipile (delivery check)" }).returning();
  await db.insert(gridProviderCredentials).values({ providerId: provider!.id, encryptedPayload: encryptIntegrationCredentials({ apiKey: "delivery-check", dsn: "https://unipile.invalid" }) });
  await saveChannelRules("whatsapp", { sendingHours: hours }, a.owner.id);
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
  return { account: account!, mailbox: mailbox!, instagram: instagram!, leads, campaign, thread, started, sibling, unmarked, automatic, proposed, emailPlan, failedStart };
});

await runInOrganization(a.org.id, async () => {
  const diagnostics = await diagnoseDelivery(seeded.started.id);
  const sender = diagnostics.senders.find((entry) => entry.channel === "whatsapp");
  check("the plan's number is listed with its configured time zone", sender?.account === "+919800000099" && sender.timezone === "Asia/Kolkata", JSON.stringify(sender));
  check("outside its hours it says so and names when the window opens", sender?.gates.join() === "Outside campaign sending hours (Asia/Kolkata)" && sender.nextAt === expectedOpen, `${sender?.gates.join("; ")} next ${sender?.nextAt} (expected ${expectedOpen})`);
  check("its two leads are counted as waiting", sender?.queued === 2);
  check("the summary never infers a time zone from leads", /Lead cities do not determine/.test(diagnostics.summary) && /Asia\/Kolkata/.test(diagnostics.summary));
  check("a WhatsApp plan lists no mailbox or Instagram account it does not send from", diagnostics.senders.every((entry) => entry.channel === "whatsapp"), diagnostics.senders.map((entry) => `${entry.channel} ${entry.account}`).join("; "));
  const emailSenders = (await diagnoseDelivery(seeded.emailPlan.id)).senders;
  check("an email plan lists the mailboxes, not the Instagram accounts", emailSenders.some((entry) => entry.channel === "email" && entry.account === seeded.mailbox.emailAddress) && emailSenders.every((entry) => entry.channel === "email"), emailSenders.map((entry) => `${entry.channel} ${entry.account}`).join("; "));
  const everySender = (await diagnoseDelivery()).senders;
  check("the organization's own snapshot still lists every mailbox and Instagram account", everySender.some((entry) => entry.channel === "email" && entry.account === seeded.mailbox.emailAddress) && everySender.some((entry) => entry.channel === "instagram" && entry.account === `@${seeded.instagram.username}`), everySender.map((entry) => `${entry.channel} ${entry.account}`).join("; "));

  await saveChannelRules("whatsapp", { sendingHours: null }, a.owner.id);
  const anyTime = (await diagnoseDelivery(seeded.started.id)).senders.find((entry) => entry.channel === "whatsapp");
  check("with no hours set: no time zone is invented and nothing is holding it", anyTime?.timezone === null && anyTime.gates.length === 0 && anyTime.nextAt === null, JSON.stringify(anyTime));

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

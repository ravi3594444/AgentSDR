/** A stored WhatsApp inbound must survive a failed CRM handoff. Local database, no providers. */
import { and, eq, sql } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) throw new Error("Use a disposable local database");
globalThis.fetch = (() => { throw new Error("External requests are forbidden in this check"); }) as unknown as typeof fetch;

const { db } = await import("@/lib/db");
const { organizations } = await import("@/lib/auth/schema");
const { people } = await import("@/lib/leads/schema");
const { whatsappAccounts, whatsappMessages, whatsappChats } = await import("@/lib/whatsapp/schema");
const { crmConversationMessages, crmConversations, crmJobs } = await import("@/lib/crm/schema");
const { outreachRuns, outreachRunLeads } = await import("@/lib/assistant/schema");
const { upsertConversationInTransaction } = await import("@/lib/crm/conversations");
const { withCrmTransaction } = await import("@/lib/crm/repository");
const { handleClassificationJob } = await import("@/lib/crm/handlers");
const { PermanentCrmJobError } = await import("@/lib/crm/worker");
const { createAudience } = await import("@/lib/assistant/audiences.server");
const { createThread } = await import("@/lib/assistant/threads.server");
const { updateBusinessProfile } = await import("@/lib/assistant/profile.server");
const { runInOrganization, inOrg } = await import("@/lib/tenancy/scope");
const { ensureCrmDefaults } = await import("@/lib/crm/defaults");
const { ingestWhatsappWebhook, recoverWhatsappCrmHandoff } = await import("@/lib/whatsapp/messages");

let checks = 0;
function check(label: string, ok: boolean) {
  if (!ok) throw new Error(`FAIL ${label}`);
  checks++;
  console.log(`PASS ${label}`);
}

const stamp = Date.now();
let protectedMessageId: string | null = null;
const [organization] = await db.insert(organizations).values({ name: `WhatsApp handoff ${stamp}`, slug: `whatsapp-handoff-${stamp}` }).returning();
await runInOrganization(organization!.id, async () => {
  await ensureCrmDefaults();
  const accountId = `handoff-account-${stamp}`;
  await db.insert(whatsappAccounts).values({ organizationId: organization!.id, unipileAccountId: accountId, status: "connected" });
  const [person] = await db.insert(people).values({ organizationId: organization!.id, phone: "+918084794983", fullName: "Handoff test", source: "handoff-test" }).returning();
  const payload = {
    event: "message_received", account_type: "WHATSAPP", account_id: accountId,
    account_info: { type: "WHATSAPP", user_id: "918521169094@s.whatsapp.net" },
    chat_id: `handoff-chat-${stamp}`, message_id: `handoff-message-${stamp}`,
    message: "Hey", timestamp: new Date().toISOString(), is_sender: false,
    sender: { attendee_provider_id: "918084794983@s.whatsapp.net" },
    attendees: [{ attendee_provider_id: "918084794983@s.whatsapp.net" }, { attendee_provider_id: "918521169094@s.whatsapp.net" }],
  };
  await db.execute(sql`CREATE FUNCTION public.handoff_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'stand-in CRM handoff failure'; END $$`);
  await db.execute(sql`CREATE TRIGGER handoff_test_failure BEFORE INSERT ON crm_conversation_messages FOR EACH ROW EXECUTE FUNCTION public.handoff_test_failure()`);
  try {
    await ingestWhatsappWebhook(payload, []).catch(() => undefined);
  } finally {
    await db.execute(sql`DROP TRIGGER handoff_test_failure ON crm_conversation_messages`);
    await db.execute(sql`DROP FUNCTION public.handoff_test_failure()`);
  }
  const stored = async () => (await db.select().from(whatsappMessages).where(and(
    eq(whatsappMessages.unipileMessageId, payload.message_id),
  )).limit(1))[0];
  const first = await stored();
  if (!first || first.crmConversationMessageId) throw new Error("Fault injection did not leave a raw message waiting for the CRM");
  check("the incoming message survives a CRM write failure", Boolean(first));
  await ingestWhatsappWebhook(payload, []);
  const replayed = await stored();
  check("retry completes the same stored message's CRM handoff", Boolean(replayed?.crmConversationMessageId));
  await ingestWhatsappWebhook(payload, []);
  const rows = await db.select().from(crmConversationMessages).where(eq(crmConversationMessages.providerMessageId, payload.message_id));
  check("replaying a repaired inbound never duplicates the CRM message", rows.length === 1);
  const [conversation] = await db.select().from(crmConversations).where(and(inOrg(crmConversations), eq(crmConversations.providerThreadId, payload.chat_id)));
  const privacyId = "207716110643219@lid";
  const privacyPayload = { ...payload, message_id: `privacy-${stamp}`, timestamp: new Date(Date.now() + 1_000).toISOString(),
    sender: { attendee_provider_id: privacyId, attendee_specifics: { phone_number: "+918084794983" } },
    attendees: [{ attendee_provider_id: privacyId }, { attendee_provider_id: "918521169094@s.whatsapp.net" }] };
  await ingestWhatsappWebhook(privacyPayload, []);
  const [privateMessage] = await db.select().from(whatsappMessages).where(eq(whatsappMessages.unipileMessageId, privacyPayload.message_id));
  protectedMessageId = privateMessage!.id;
  check("a phone/privacy transition on the verified chat reaches the CRM", Boolean(privateMessage?.crmConversationMessageId));
  const [updatedConversation] = await db.select().from(crmConversations).where(eq(crmConversations.id, conversation!.id));
  check("the transition keeps the same conversation and Person", updatedConversation?.personId === person!.id && updatedConversation?.providerContactId === privacyId);

  const rejects = async (input: Parameters<typeof upsertConversationInTransaction>[1]) => {
    try { await withCrmTransaction(tx => upsertConversationInTransaction(tx, input)); return false; } catch { return true; }
  };
  const base = { crmRecordId: conversation!.crmRecordId, personId: person!.id, channel: "whatsapp" as const, accountRef: accountId, providerThreadId: payload.chat_id };
  check("an unrelated phone on that thread stays blocked", await rejects({ ...base, providerContactId: "919999999999@s.whatsapp.net" }));
  check("an unverified replacement privacy id stays blocked", await rejects({ ...base, providerContactId: "999999999999999@lid" }));
  const [otherPerson] = await db.insert(people).values({ organizationId: organization!.id, phone: "+919888888888", source: "handoff-test" }).returning();
  check("the same thread cannot be reassigned to another Person", await rejects({ ...base, personId: otherPerson!.id, providerContactId: privacyId }));
  await db.update(crmConversations).set({ providerContactId: "918084794983@s.whatsapp.net" }).where(eq(crmConversations.id, conversation!.id));
  await db.update(whatsappChats).set({ phone: "+919999999999" }).where(eq(whatsappChats.unipileChatId, payload.chat_id));
  check("a privacy transition without matching chat and contact phones stays blocked", await rejects({ ...base, providerContactId: privacyId }));
  await db.update(whatsappChats).set({ phone: "+918084794983" }).where(eq(whatsappChats.unipileChatId, payload.chat_id));

  await updateBusinessProfile({ businessName: "Handoff test", senderName: "Ravi", offer: "Business automation" }, null);
  const audienceId = await createAudience({ name: "Handoff audience", source: "list" });
  const thread = await createThread(null);
  const [run] = await db.insert(outreachRuns).values({ organizationId: organization!.id, audienceId, threadId: thread.id, name: "Handoff automatic reply", status: "running", autopilot: true, channels: ["whatsapp"], approvedAt: new Date(Date.now() - 60_000), plan: { assignments: [], sequences: {}, personalizationKey: "p_00000000", samples: [], limits: { maxLeads: 1, emailPerMailboxPerDay: null, whatsappNewChatsPerDay: 30 }, excluded: [], estimate: { aiCalls: 0, aiCostUsd: null, days: 1 }, autopilot: true, instructions: null } }).returning();
  await db.insert(outreachRunLeads).values({ organizationId: organization!.id, runId: run!.id, personId: person!.id, channel: "whatsapp" });
  const [job] = await db.select().from(crmJobs).where(and(inOrg(crmJobs), eq(crmJobs.entityId, privateMessage!.crmConversationMessageId!), eq(crmJobs.kind, "classification")));
  check("the recovered message has a real classification job", Boolean(job));
  let sends = 0;
  const deps: import("@/lib/assistant/replyAgent/agent.server").ReplyAgentDependencies = {
    allowNonProduction: true, brief: false,
    model: async () => ({ text: JSON.stringify({ action: "reply", reply: "Hey! What would you like to know?", category: "other", confidence: 0.95, reasoning: "A greeting is not buying interest", ownerNote: null }), provider: "stand-in", model: "stand-in", request: {}, response: {} }),
    send: async () => { sends++; return { provider: "unipile", providerMessageId: `handoff-reply-${stamp}`, providerThreadId: payload.chat_id, rfcMessageId: null, response: {} }; },
  };
  await handleClassificationJob(job!, { replyAgent: deps });
  check("webhook through CRM through the reply agent sends one automatic answer", sends === 1);
  await ingestWhatsappWebhook(privacyPayload, []);
  await handleClassificationJob(job!, { replyAgent: deps }).catch((error) => { if (!(error instanceof PermanentCrmJobError)) throw error; });
  check("repeated webhook and job never send that answer twice", sends === 1);

  // A missing handoff older than a newer reply cannot become today's turn.
  const [oldMessage] = await db.insert(whatsappMessages).values({ chatId: privateMessage!.chatId, unipileMessageId: `old-handoff-${stamp}`, direction: "inbound", origin: "lead", body: "Old hello", sentAt: new Date(Date.now() - 86_400_000) }).returning();
  const old = await recoverWhatsappCrmHandoff(oldMessage!.id);
  check("repair does not resurrect an old incoming message", !old.repaired && old.reason.includes("newer"));
  // Keep the fixture's organization scope explicit even though the message
  // table inherits it; this also verifies the parent remained in this org.
  const [account] = await db.select().from(whatsappAccounts).where(and(inOrg(whatsappAccounts), eq(whatsappAccounts.unipileAccountId, accountId)));
  if (!account) throw new Error("The test account left its organization");
});
const [otherOrganization] = await db.insert(organizations).values({ name: `Other handoff ${stamp}`, slug: `other-handoff-${stamp}` }).returning();
await runInOrganization(otherOrganization!.id, async () => {
  let status: number | undefined;
  try { await recoverWhatsappCrmHandoff(protectedMessageId!); }
  catch (error) { status = (error as { status?: number }).status; }
  check("another workspace cannot recover or inspect this saved reply", status === 404);
});
console.log(`WhatsApp handoff: ${checks} checks passed; providers were stand-ins.`);
process.exit(0);

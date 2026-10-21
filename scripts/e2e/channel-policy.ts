/**
 * Which channels an outreach plan uses (pilot fix F01), end to end on the
 * local database with the real plan writer path, Start, launch and email
 * sender. Stand-ins: the model (answers by schema), the Unipile and Google
 * Workspace connections (stored, never called) and the email send itself
 * (the scheduler tick takes an injected sender). Nothing leaves the machine.
 *
 * - a general request keeps every route: an email-only, a WhatsApp-only and
 *   a LinkedIn-only lead each get their own channel, even when the model
 *   passed only WhatsApp; Do Not Contact is left out with its reason;
 * - an owner who names WhatsApp gets a WhatsApp-only plan, and the leads it
 *   cannot reach are counted with that reason;
 * - a sender that cannot send yet is named as the reason, not the owner;
 * - Start on the general plan enrolls the email lead, and one scheduler tick
 *   records an accepted send to that lead only;
 * - the chat line and the plan card read the plan's own channels.
 *
 *   bun run --conditions=react-server scripts/e2e/channel-policy.ts
 *
 * Creates its own organization ("Channel policy check …") and leaves it.
 * Refuses a non-local DATABASE_URL.
 */
import { mock } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { and, eq, ne, sql } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}

const stamp = Date.now();
const root = join(import.meta.dir, "..", "..");
type Input = { userPrompt: string; systemPrompt?: string; schemaName?: string; accept: (text: string) => void };
const modelCalls: string[] = [];
const BODY = "Hello, we help property firms answer every buyer enquiry within the hour, so fewer leads go cold. Would a short call this week be useful?";
const FOLLOW_UP = "Just checking whether faster enquiry replies would help your team this month.";

function leadsAsked(prompt: string): number[] {
  return [...prompt.matchAll(/^(\d+)(?: \([^)]*\))?: \{.*\}$/gm)].map((match) => Number(match[1]));
}
function channelsAsked(prompt: string): string[] {
  return (prompt.match(/^Write the messages for: (.+)\.$/m)?.[1] ?? "").split(",").map((channel) => channel.trim()).filter(Boolean);
}
function writerAnswer(input: Input): string {
  switch (input.schemaName) {
    case "lead_sorting":
      return JSON.stringify({ leads: leadsAsked(input.userPrompt).map((index) => ({ index, group: "Property firms", approach: "standard", reason: "A property business, as the owner asked.", requestFit: "fits", noWebsiteRequired: false })) });
    case "outreach_sequences":
      return JSON.stringify({ channels: channelsAsked(input.userPrompt).map((channel) => ({
        channel,
        messages: [{ subject: channel === "email" ? "Faster replies to buyer enquiries" : "", body: BODY, waitDays: 0 }, { subject: "", body: FOLLOW_UP, waitDays: channel === "linkedin" ? 0 : 3 }],
      })) });
    case "first_message_review":
      return JSON.stringify({ messages: ["email", "whatsapp", "linkedin", "instagram"].map((channel) => ({ channel, wouldReply: 4, reasons: [] })) });
    case "opening_lines":
      return JSON.stringify({ lines: leadsAsked(input.userPrompt).map((index) => ({ index, line: "" })) });
    default:
      throw new Error(`unexpected model call ${input.schemaName}`);
  }
}
mock.module(join(root, "src/lib/ai/server/structuredCompletion.ts"), () => ({
  completeStructured: async (input: Input) => {
    modelCalls.push(input.schemaName ?? "?");
    const text = writerAnswer(input);
    input.accept(text);
    return { text, model: "fixture", provider: "fixture", request: {}, response: {}, usage: {}, attempts: 1 };
  },
}));

const { db } = await import("@/lib/db");
const { people } = await import("@/lib/leads/schema");
const { organizations, users, members } = await import("@/lib/auth/schema");
const { runInOrganization, currentOrganizationId } = await import("@/lib/tenancy/scope");
const schema = await import("@/lib/assistant/schema");
const { gridProviderCredentials, gridProviders } = await import("@/lib/grid/schema");
const { encryptIntegrationCredentials } = await import("@/lib/integrations/credentials");
const { whatsappAccounts } = await import("@/lib/whatsapp/schema");
const { linkedInAccounts } = await import("@/lib/linkedin/schema");
const { crmPersonContactPolicies } = await import("@/lib/crm/schema");
const { mailboxes, outreachEmails, outreachLeads, outreachMailboxQueue } = await import("@/lib/outreach/schema");
const { buildMailboxQueues } = await import("@/lib/outreach/buildQueue");
const { runSchedulerTick } = await import("@/lib/outreach/scheduler");
const { createAudience, addAudienceMembers } = await import("@/lib/assistant/audiences.server");
const { updateBusinessProfile } = await import("@/lib/assistant/profile.server");
const { prepareOutreach, startOutreachRun, getRun } = await import("@/lib/assistant/outreach.server");
const { planChannelsLine } = await import("@/lib/assistant/channelPolicy");
const { runOneAssistantStep } = await import("@/lib/assistant/worker");
const { registerAssistantJobs } = await import("@/lib/assistant/register.server");
type AssistantJob = typeof schema.assistantJobs.$inferSelect;
registerAssistantJobs();

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const [org] = await db.insert(organizations).values({ name: `Channel policy check ${stamp}`, slug: `channel-policy-check-${stamp}` }).returning();
const [owner] = await db.insert(users).values({ name: "Owner Check", email: `owner-${stamp}@channel-policy-check.test`, emailVerified: true }).returning();
await db.insert(members).values({ organizationId: org!.id, userId: owner!.id, role: "owner" });

async function launch(runId: string): Promise<AssistantJob | null> {
  for (let round = 0; round < 30; round += 1) {
    const [job] = await db.select().from(schema.assistantJobs).where(and(eq(schema.assistantJobs.runId, runId), eq(schema.assistantJobs.kind, "outreach_start")));
    if (!job) return null;
    if (job.status !== "queued" && job.status !== "running") return job;
    await db.update(schema.assistantJobs).set({ runAfter: new Date(Date.now() - 1_000) }).where(and(eq(schema.assistantJobs.id, job.id), eq(schema.assistantJobs.status, "queued")));
    await runOneAssistantStep({ jobId: job.id });
  }
  return null;
}

await runInOrganization(org!.id, async () => {
  // ---------------------------------------------------------- setup: every sender connected (stand-ins), and five leads
  for (const [key, payload] of [
    ["platform-unipile", { apiKey: "channel-policy-check", dsn: "https://unipile.invalid" }],
    ["platform-google", { clientEmail: "sender@channel-policy-check.invalid", privateKey: "not-a-key" }],
  ] as const) {
    const [provider] = await db.insert(gridProviders).values({ organizationId: org!.id, key, name: `${key} (channel policy check)` }).returning();
    await db.insert(gridProviderCredentials).values({ providerId: provider!.id, encryptedPayload: encryptIntegrationCredentials(payload) });
  }
  const [mailbox] = await db.insert(mailboxes).values({
    organizationId: org!.id, emailAddress: `sales-${stamp}@channel-policy-check.test`, displayName: "Ravi", status: "connected", dailySendLimit: 5,
  }).returning();
  await db.insert(whatsappAccounts).values({ organizationId: org!.id, unipileAccountId: `channel-policy-${stamp}`, name: "Sales", phone: "+919800000088", status: "connected", connectedAt: new Date(Date.now() - 5 * 86_400_000) });
  await db.insert(linkedInAccounts).values({ organizationId: org!.id, linkedinId: `channel-policy-li-${stamp}`, username: `channel-policy-li-${stamp}`, name: "Ravi", status: "CONNECTED", updatedAt: new Date() });
  await updateBusinessProfile({ businessName: "LeadDesk", offer: "an assistant that answers every buyer enquiry for property firms within the hour", senderName: "Ravi" }, owner!.id);

  const person = async (values: Partial<typeof people.$inferInsert> & { fullName: string }) =>
    (await db.insert(people).values({ organizationId: org!.id, source: "list", ...values }).returning())[0]!;
  const asha = await person({ fullName: "Asha Realty", email: `asha-${stamp}@asharealty.test` });
  const bina = await person({ fullName: "Bina Homes", phone: "+919800000101" });
  const chirag = await person({ fullName: "Chirag Estates", linkedinUrl: `https://www.linkedin.com/in/chirag-${stamp}` });
  const dev = await person({ fullName: "Dev Properties", email: `dev-${stamp}@devproperties.test`, phone: "+919800000102" });
  const esha = await person({ fullName: "Esha Builders", email: `esha-${stamp}@eshabuilders.test` });
  await db.insert(crmPersonContactPolicies).values({ personId: esha.id, doNotContact: true, reason: "asked not to be contacted", source: "human", setAt: new Date() });
  const audienceId = await createAudience({ name: "Property firms", source: "list" });
  await addAudienceMembers(audienceId, [asha, bina, chirag, dev, esha].map((row) => ({ personId: row.id, source: "list" })));
  const channelOf = (plan: typeof schema.outreachRuns.$inferSelect["plan"], id: string) => plan.assignments.find((item) => item.personId === id)?.channel ?? null;

  // ---------------------------------------------------------- 1. a general request: every route, whatever the model passed
  const general = await prepareOutreach({ audienceId, channels: ["whatsapp"], ownerRequest: "Find B2B business owners and real estate founders, and people without a website; outreach them", threadId: null, userId: owner!.id });
  const plan = general.plan;
  check("a general request keeps every route: the email-only, WhatsApp-only and LinkedIn-only leads each get their channel",
    channelOf(plan, asha.id) === "email" && channelOf(plan, bina.id) === "whatsapp" && channelOf(plan, chirag.id) === "linkedin" && plan.assignments.length === 4,
    JSON.stringify(plan.assignments));
  check("…the model's WhatsApp only goes first, for a lead with both", channelOf(plan, dev.id) === "whatsapp");
  check("…Do Not Contact is left out with its reason, and no channel note is shown", channelOf(plan, esha.id) === null && plan.excluded.some((item) => item.reason === "marked Do Not Contact") && !plan.channelNote,
    JSON.stringify(plan.excluded));
  check("…the chat line names the channels the plan uses", planChannelsLine(plan) === "4 leads (WhatsApp 2, email 1, LinkedIn 1), each on its best ready channel; left out: 1 marked Do Not Contact", planChannelsLine(plan));
  const [stored] = await db.select().from(schema.outreachRuns).where(eq(schema.outreachRuns.id, general.runId));
  check("…the run records all three channels", [...stored!.channels].sort().join() === "email,linkedin,whatsapp", stored!.channels.join());

  // ---------------------------------------------------------- 2. the owner names WhatsApp
  const named = await prepareOutreach({ audienceId, channels: ["whatsapp", "email"], ownerRequest: "Find real estate founders in Pune and message them on WhatsApp", threadId: null, userId: owner!.id });
  check("an owner who names WhatsApp gets a WhatsApp-only plan, whatever the model passed",
    named.plan.assignments.every((item) => item.channel === "whatsapp") && named.plan.assignments.length === 2 && named.plan.channelNote === "you asked for WhatsApp",
    JSON.stringify({ assignments: named.plan.assignments, note: named.plan.channelNote }));
  check("…the leads it cannot reach are counted with the owner's reason",
    named.plan.excluded.some((item) => item.count === 1 && item.reason === "reachable only by email, which is not used in this run (you asked for WhatsApp)")
      && named.plan.excluded.some((item) => item.count === 1 && item.reason === "reachable only by LinkedIn, which is not used in this run (you asked for WhatsApp)"),
    JSON.stringify(named.plan.excluded));

  // ---------------------------------------------------------- 3. a sender that cannot send yet is the reason, not the owner
  await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, mailbox!.id));
  const noMailbox = await prepareOutreach({ audienceId, ownerRequest: "reach out to them", threadId: null, userId: owner!.id });
  check("with no mailbox, the email-only lead is left out because email cannot send yet; a lead with a phone moves to WhatsApp",
    channelOf(noMailbox.plan, asha.id) === null && channelOf(noMailbox.plan, dev.id) === "whatsapp"
      && noMailbox.plan.excluded.some((item) => /^reachable only by email, which cannot send yet \(no sending mailbox is connected/.test(item.reason)),
    JSON.stringify(noMailbox.plan.excluded));
  await db.update(mailboxes).set({ status: "connected" }).where(eq(mailboxes.id, mailbox!.id));
  // Only the general plan is started below.
  await db.update(schema.outreachRuns).set({ status: "cancelled" }).where(and(eq(schema.outreachRuns.organizationId, currentOrganizationId()), ne(schema.outreachRuns.id, general.runId)));

  // ---------------------------------------------------------- 4. Start: the email lead is enrolled and one tick sends to it
  const started = await startOutreachRun(general.runId, owner!.id, { autopilot: false });
  const launched = await launch(general.runId);
  const run = await getRun(general.runId);
  check("Start launches the general plan on all three channels", launched?.status === "succeeded" && run?.status === "running" && Boolean(run.campaigns.email && run.campaigns.whatsapp && run.campaigns.linkedin),
    JSON.stringify({ job: started.jobId, status: launched?.status, error: launched?.error, run: run?.status, campaigns: run?.campaigns }));
  const enrolled = await db.select({ personId: outreachLeads.personId }).from(outreachLeads).where(eq(outreachLeads.campaignId, run!.campaigns.email!));
  check("…the email campaign holds the email lead only", enrolled.length === 1 && enrolled[0]!.personId === asha.id, JSON.stringify(enrolled));

  const otherQueues = await db.select({ n: sql<number>`count(*)::int` }).from(outreachMailboxQueue)
    .innerJoin(mailboxes, eq(outreachMailboxQueue.mailboxId, mailboxes.id)).where(ne(mailboxes.organizationId, currentOrganizationId()));
  if (Number(otherQueues[0]?.n ?? 0) > 0) {
    console.error("Another organization has queued emails; the send tick is global, so this check stops here.");
    process.exit(2);
  }
  const sent: string[] = [];
  const fakeSend = (async (input: { to: string[] }) => {
    sent.push(input.to[0]!);
    return { id: `fake-${randomUUID()}`, messageId: `<${randomUUID()}@channel-policy-check.test>`, threadId: `thread-${randomUUID()}` };
  }) as unknown as Parameters<typeof runSchedulerTick>[0] extends { send?: infer S } ? S : never;
  await buildMailboxQueues({ organizationIds: [currentOrganizationId()] });
  const tick = await runSchedulerTick({ send: fakeSend });
  const emails = await db.select({ status: outreachEmails.status, subject: outreachEmails.subject }).from(outreachEmails).where(eq(outreachEmails.mailboxId, mailbox!.id));
  check("…one scheduler tick records an accepted email to that lead, and to nobody else",
    tick.sent === 1 && sent.length === 1 && sent[0] === asha.email && emails.length === 1 && emails[0]!.status === "sent" && emails[0]!.subject === "Faster replies to buyer enquiries",
    JSON.stringify({ tick, sent, emails }));
  check("…Do Not Contact was never sent to", !sent.includes(esha.email!));

  // Left paused: nothing here keeps sending, and nothing stays queued for the global tick.
  await db.delete(outreachMailboxQueue).where(eq(outreachMailboxQueue.mailboxId, mailbox!.id));
  await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, mailbox!.id));
});

check("the writer wrote each plan", modelCalls.filter((name) => name === "outreach_sequences").length >= 3, modelCalls.join(","));

if (failures) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("Channel policy checks passed");
process.exit(0);

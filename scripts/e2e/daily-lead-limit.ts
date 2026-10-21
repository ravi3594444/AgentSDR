/**
 * The daily lead limit and always-on sending, end to end against the local
 * database: the real WhatsApp campaign tick, LinkedIn invitation sender and
 * Instagram DM worker, with recording stand-ins at the provider boundary
 * (nothing is sent anywhere). It checks:
 *
 * - with a limit of 1, one new person is contacted (a WhatsApp first
 *   message) and a different new person is refused on WhatsApp, LinkedIn
 *   and Instagram, with no claim written and no provider called;
 * - a person already contacted on one channel is not counted again on
 *   another (their LinkedIn invitation and Instagram DM still go out), and
 *   is not stuck behind a refused new person;
 * - follow-ups still send while the limit is used;
 * - moving the clock past the workspace's reset resumes first messages;
 * - a second organization's own limit is untouched by the first's usage;
 * - the count's rules: uncertain claims (an email that may have gone out,
 *   an Instagram DM in doubt) stay counted, definite failures (an email Do
 *   Not Contact stopped, a refused WhatsApp claim) do not, an earlier day's
 *   touch makes a person "already contacted", and two claims racing for the
 *   last place never both get it;
 * - the always-on migration: restricted mailbox hours become always open
 *   with the time zone and today's counters untouched, LinkedIn working
 *   hours are cleared, stored hour rules are stripped, and a second run
 *   changes nothing;
 * - WhatsApp campaigns and Instagram DMs send at any time, even with an old
 *   restricted sending-hours value still stored (no hours gate is left).
 *
 *   bun run --conditions=react-server scripts/e2e/daily-lead-limit.ts
 *
 * Creates its own organizations ("Lead limit check …") and leaves them with
 * their campaigns paused. Refuses a non-local DATABASE_URL, and refuses to
 * tick Instagram while another organization has a DM waiting (that worker is
 * global).
 */
import { SQL } from "bun";
import { mock } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}

const root = join(import.meta.dir, "..", "..");
const stamp = Date.now();

// Provider boundaries, replaced before anything that uses them is imported.
const ownOrganizations: string[] = [];
const invitationsSent: string[] = [];
const instagramResolved: string[] = [];
const instagramPosted: string[] = [];
const credentials = await import(root + "/src/lib/platform/credentials.ts");
mock.module(root + "/src/lib/platform/credentials.ts", () => ({ ...credentials, isPlatformConnected: async () => true }));
const organizationsServer = await import(root + "/src/lib/linkedin/organizations.server.ts");
mock.module(root + "/src/lib/linkedin/organizations.server.ts", () => ({ ...organizationsServer, unipileOrganizationIds: async () => [...ownOrganizations] }));
const unipileService = await import(root + "/src/services/unipile.service.ts");
mock.module(root + "/src/services/unipile.service.ts", () => ({
  ...unipileService,
  sendConnectionRequest: async (providerId: string) => {
    invitationsSent.push(providerId);
    return `invitation-${providerId}`;
  },
}));
mock.module(root + "/src/services/unipile.instagram-outreach.ts", () => ({
  resolveInstagramOutreachRecipient: async (_account: string, username: string) => {
    instagramResolved.push(username);
    return { username, messagingId: `dm-${username}` };
  },
  startInstagramOutreachChat: async (_account: string, messagingId: string) => {
    instagramPosted.push(messagingId);
    return { chatId: `chat-${messagingId}`, messageId: `msg-${messagingId}` };
  },
}));

const { and, eq, inArray, ne, sql } = await import("drizzle-orm");
const { db } = await import("@/lib/db");
const { organizations, users, members } = await import("@/lib/auth/schema");
const { people } = await import("@/lib/leads/schema");
const { mailboxes, outreachCampaigns, outreachEmails, outreachLeads } = await import("@/lib/outreach/schema");
const { whatsappAccounts, whatsappCampaignLeads, whatsappCampaigns, whatsappCampaignSends } = await import("@/lib/whatsapp/schema");
const { addPeopleToWhatsappCampaign, createWhatsappCampaign } = await import("@/lib/whatsapp/campaigns/campaigns.server");
const { runWhatsappCampaignTick } = await import("@/lib/whatsapp/campaigns/engine");
const linkedin = await import("@/lib/linkedin/schema");
const { sendInvitations } = await import("@/functions/sendInvitations");
const { instagramAccounts, instagramOutreachQueue } = await import("@/lib/instagram/schema");
const { runInstagramOutreachTick } = await import("@/lib/instagram/outreach.server");
const { outreachRuns, outreachRunLeads } = await import("@/lib/assistant/schema");
const { createThread } = await import("@/lib/assistant/threads.server");
const { createAudience } = await import("@/lib/assistant/audiences.server");
const { setFeature } = await import("@/lib/features/flags.server");
const { saveChannelRules } = await import("@/lib/channels/rules.server");
const { newLeadAllowance, newLeadsToday, recordNewLead, releaseNewLead } = await import("@/lib/channels/dailyLeadLimit.server");
const { deleteCampaign } = await import("@/lib/outreach/campaigns");
const { DAILY_LEAD_LIMIT_GATE } = await import("@/lib/channels/dailyLeadLimit");
const { EMAIL_DNC_BLOCKED_ERROR } = await import("@/lib/outreach/sendRules");
const { isAlwaysOpen, isWithinWorkingHours } = await import("@/lib/outreach/workingHours");
const { runInOrganization } = await import("@/lib/tenancy/scope");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function organization(label: string) {
  const [org] = await db.insert(organizations).values({ name: `Lead limit check ${label} ${stamp}`, slug: `lead-limit-check-${label}-${stamp}` }).returning();
  const [owner] = await db.insert(users).values({ name: `Owner ${label}`, email: `owner-${label}-${stamp}@lead-limit-check.test`, emailVerified: true }).returning();
  await db.insert(members).values({ organizationId: org!.id, userId: owner!.id, role: "owner" });
  return { org: org!, owner: owner! };
}

type WaSend = NonNullable<Parameters<typeof runWhatsappCampaignTick>[0]>["send"];
const whatsappSent: string[] = [];
const waSend = (async (request: { personId?: string | null }) => {
  whatsappSent.push(request.personId ?? "");
  return { message: { id: null }, chat: {} };
}) as unknown as WaSend;
const waTick = (now?: Date) => runWhatsappCampaignTick({ send: waSend, now });
const minutes = (n: number) => new Date(Date.now() + n * 60_000);
/** A retired hours value that would have kept every sender closed right now: tomorrow only. */
const closedNow = { timezone: "UTC", days: [(new Date().getUTCDay() + 1) % 7], start: "00:00", end: "23:59" };
const phone = (n: number) => `+1415555${String((stamp + n) % 10_000).padStart(4, "0")}`;

/** A WhatsApp number with a two-step campaign (the follow-up an hour later), active. */
async function whatsappSetup(orgId: string, label: string) {
  const [account] = await db.insert(whatsappAccounts).values({
    organizationId: orgId, unipileAccountId: `lead-limit-${label}-${stamp}`, name: `Number ${label}`, phone: phone(90 + label.length), status: "connected", connectedAt: new Date(Date.now() - 3 * 86_400_000),
  }).returning();
  const campaign = await createWhatsappCampaign({
    name: `Lead limit ${label}`,
    accountIds: [account!.id],
    steps: [{ id: randomUUID(), body: "Hi {{firstName}}", delayHours: 0 }, { id: randomUUID(), body: "Following up", delayHours: 1 }],
  });
  await db.update(whatsappCampaigns).set({ status: "active" }).where(eq(whatsappCampaigns.id, campaign.id));
  return { account: account!, campaign };
}

async function enroll(campaignId: string, personId: string, nextSendAt: Date) {
  await addPeopleToWhatsappCampaign(campaignId, [personId]);
  await db.update(whatsappCampaignLeads).set({ nextSendAt }).where(and(eq(whatsappCampaignLeads.campaignId, campaignId), eq(whatsappCampaignLeads.personId, personId)));
}

const waLead = async (campaignId: string, personId: string) =>
  (await db.select().from(whatsappCampaignLeads).where(and(eq(whatsappCampaignLeads.campaignId, campaignId), eq(whatsappCampaignLeads.personId, personId))))[0]!;
const waClaims = async (campaignId: string, personId: string) => {
  const lead = await waLead(campaignId, personId);
  return db.select().from(whatsappCampaignSends).where(eq(whatsappCampaignSends.leadId, lead.id));
};

// ------------------------------------------------------------ organizations
const a = await organization("a");
const b = await organization("b");
ownOrganizations.push(a.org.id, b.org.id);

const seededA = await runInOrganization(a.org.id, async () => {
  await saveChannelRules("general", { newLeadsPerDay: 1 }, a.owner.id);
  // Invitations a few seconds apart, so the check does not wait the default 30–60 s after each.
  await saveChannelRules("linkedin", { inviteDelaySeconds: [5, 5] }, a.owner.id);
  const [p1, p2, p3, p4] = await db.insert(people).values([1, 2, 3, 4].map((n) => ({
    organizationId: a.org.id, firstName: `Lead${n}`, fullName: `Lead ${n}`, phone: phone(n),
    linkedinUrl: `https://www.linkedin.com/in/lead-limit-${stamp}-${n}`, source: "lead-limit-check",
  }))).returning();
  const wa = await whatsappSetup(a.org.id, "a");
  await enroll(wa.campaign.id, p1!.id, minutes(-3));
  await enroll(wa.campaign.id, p2!.id, minutes(-2));
  // An old restricted "sending hours" value left in the store (open tomorrow only): nothing reads it any more.
  await db.execute(sql`insert into channel_settings (organization_id, channel, values) values (${a.org.id}, 'whatsapp', ${JSON.stringify({ sendingHours: closedNow })}::jsonb)
    on conflict (organization_id, channel) do update set values = channel_settings.values || excluded.values`);
  return { p1: p1!, p2: p2!, p3: p3!, p4: p4!, ...wa };
});
const seededB = await runInOrganization(b.org.id, async () => {
  await saveChannelRules("general", { newLeadsPerDay: 1 }, b.owner.id);
  const [q1] = await db.insert(people).values({ organizationId: b.org.id, firstName: "Other", fullName: "Other org lead", phone: phone(11), source: "lead-limit-check" }).returning();
  const wa = await whatsappSetup(b.org.id, "bb");
  // Not due until organization A has used its place.
  await enroll(wa.campaign.id, q1!.id, minutes(60));
  return { q1: q1!, ...wa };
});

try {
  // ------------------------------------------------------------ WhatsApp
  await waTick();
  check("with a limit of 1, the first new person gets their WhatsApp first message (an old stored sending-hours value closed now is ignored)", whatsappSent.join() === seededA.p1.id, whatsappSent.join());
  await waTick();
  const p2Lead = await waLead(seededA.campaign.id, seededA.p2.id);
  const [numberA] = await db.select().from(whatsappAccounts).where(eq(whatsappAccounts.id, seededA.account.id));
  check("a different new person is refused on WhatsApp: no send, no claim, the lead still waiting", whatsappSent.length === 1 && (await waClaims(seededA.campaign.id, seededA.p2.id)).length === 0 && p2Lead.status === "queued" && p2Lead.currentStep === 0, `${whatsappSent.length} sends, ${p2Lead.status} step ${p2Lead.currentStep}`);
  check("…and the number says why, in the gate words the status screens match", Boolean(numberA?.lastRefusal?.startsWith(DAILY_LEAD_LIMIT_GATE)) && /1 of 1 new lead today/.test(numberA?.lastRefusal ?? ""), numberA?.lastRefusal ?? "");
  const dayA = await runInOrganization(a.org.id, () => newLeadsToday());
  check("today's count reads 1 of 1, with a reset in the future", dayA.used === 1 && dayA.limit === 1 && dayA.resetsAt > new Date(), `${dayA.used}/${dayA.limit} resets ${dayA.resetsAt.toISOString()}`);

  // ------------------------------------------------------------ LinkedIn
  const linkedinA = await runInOrganization(a.org.id, async () => {
    const [account] = await db.insert(linkedin.linkedInAccounts).values({ organizationId: a.org.id, linkedinId: `lead-limit-li-${stamp}`, username: `lead-limit-li-${stamp}`, name: "Ravi", status: "CONNECTED", updatedAt: new Date() }).returning();
    const [campaign] = await db.insert(linkedin.campaigns).values({ organizationId: a.org.id, name: "Lead limit LinkedIn", type: "REGULAR", status: "ACTIVE", updatedAt: new Date() }).returning();
    await db.insert(linkedin.campaignAccounts).values({ campaignId: campaign!.id, linkedinAccountId: account!.id });
    // The new person first (older), then the one WhatsApp already reached.
    const [newLead] = await db.insert(linkedin.leads).values({ organizationId: a.org.id, personId: seededA.p3.id, linkedinUrl: seededA.p3.linkedinUrl, providerId: `provider-p3-${stamp}`, campaignId: campaign!.id, invitationMessage: "Hi", createdAt: new Date(Date.now() - 120_000), updatedAt: new Date() }).returning();
    const [knownLead] = await db.insert(linkedin.leads).values({ organizationId: a.org.id, personId: seededA.p1.id, linkedinUrl: seededA.p1.linkedinUrl, providerId: `provider-p1-${stamp}`, campaignId: campaign!.id, invitationMessage: "Hi", createdAt: new Date(Date.now() - 60_000), updatedAt: new Date() }).returning();
    // A run of one: while the limit is used, the one already reached is picked, not the older new person.
    await saveChannelRules("linkedin", { invitesPerRun: [1, 1], inviteDelaySeconds: [5, 5] }, a.owner.id);
    await sendInvitations(account!);
    return { account: account!, newLead: newLead!, knownLead: knownLead! };
  });
  const [p3After] = await db.select().from(linkedin.leads).where(eq(linkedin.leads.id, linkedinA.newLead.id));
  const p3Messages = await db.select().from(linkedin.messages).where(eq(linkedin.messages.leadId, linkedinA.newLead.id));
  check("a different new person is refused on LinkedIn: still pending, no invitation claimed, Unipile not called", p3After?.status === "PENDING" && p3After.requestSentAt === null && p3Messages.length === 0 && !invitationsSent.includes(`provider-p3-${stamp}`), `${p3After?.status}, ${p3Messages.length} messages, sent ${invitationsSent.join()}`);
  const [p1Linkedin] = await db.select().from(linkedin.leads).where(eq(linkedin.leads.id, linkedinA.knownLead.id));
  const p1Messages = await db.select().from(linkedin.messages).where(and(eq(linkedin.messages.leadId, linkedinA.knownLead.id), eq(linkedin.messages.type, "INVITATION")));
  check("a person already reached on WhatsApp is not counted again: their LinkedIn invitation goes out, even with a new person ahead and a run of one", p1Linkedin?.status === "REQUEST_SENT" && p1Messages.length === 1 && invitationsSent.join() === `provider-p1-${stamp}`, `${p1Linkedin?.status}, sent ${invitationsSent.join()}`);
  check("…and the day still counts one new lead", (await runInOrganization(a.org.id, () => newLeadsToday())).used === 1);

  // ------------------------------------------------------------ Instagram
  // DMs the worker would act on: waiting ones of a running plan, in any other organization.
  const otherWaiting = await db.select({ n: sql<number>`count(*)::int` }).from(instagramOutreachQueue)
    .innerJoin(outreachRuns, eq(outreachRuns.id, instagramOutreachQueue.runId))
    .where(and(inArray(instagramOutreachQueue.status, ["queued", "resolving", "sending"]), eq(outreachRuns.status, "running"), ne(instagramOutreachQueue.organizationId, a.org.id)));
  if (Number(otherWaiting[0]?.n ?? 0) > 0) {
    console.error("Another organization has Instagram DMs waiting; the Instagram worker is global, so this check stops here.");
    process.exit(2);
  }
  const instagramA = await runInOrganization(a.org.id, async () => {
    await setFeature("instagram", true, a.owner.id);
    await saveChannelRules("instagram", { sendGapMinutes: [1, 1] }, a.owner.id);
    // As for WhatsApp, an old stored sending-hours value that is closed now: ignored.
    await db.execute(sql`update channel_settings set values = values || ${JSON.stringify({ sendingHours: closedNow })}::jsonb where organization_id = ${a.org.id} and channel = 'instagram'`);
    const [account] = await db.insert(instagramAccounts).values({ organizationId: a.org.id, unipileAccountId: `lead-limit-ig-${stamp}`, username: `lead_limit_sender_${stamp}`, status: "connected" }).returning();
    const thread = await createThread(a.owner.id);
    const audienceId = await createAudience({ name: "lead limit check", source: "list" });
    const [run] = await db.insert(outreachRuns).values({
      organizationId: a.org.id, threadId: thread.id, audienceId, name: "Lead limit Instagram", status: "running", channels: ["instagram"], autopilot: false, createdBy: a.owner.id,
      approvedBy: a.owner.id, approvedAt: new Date(Date.now() - 3_600_000),
      plan: { assignments: [], samples: [], excluded: [], limits: { instagramNewChatsPerDay: 10 }, estimate: { aiCalls: 0, aiCostUsd: 0, days: 0 } } as never,
    }).returning();
    await db.insert(outreachRunLeads).values([seededA.p4, seededA.p1].map((person) => ({ organizationId: a.org.id, runId: run!.id, personId: person.id, channel: "instagram" as const })));
    // The new person waits longest; the one already reached on WhatsApp came later.
    const queue = (person: { id: string }, username: string, createdAt: Date) => ({ organizationId: a.org.id, runId: run!.id, personId: person.id, accountId: account!.id, username, body: "Hello from the check", createdAt });
    await db.insert(instagramOutreachQueue).values([queue(seededA.p4, `p4_${stamp}`, new Date(Date.now() - 120_000)), queue(seededA.p1, `p1_${stamp}`, new Date(Date.now() - 60_000))]);
    return { run: run!, account: account! };
  });
  await runInstagramOutreachTick();
  const igRows = await db.select().from(instagramOutreachQueue).where(eq(instagramOutreachQueue.runId, instagramA.run.id));
  const igOf = (personId: string) => igRows.find((row) => row.personId === personId);
  check("a different new person is refused on Instagram: still queued, never resolved through Unipile", igOf(seededA.p4.id)?.status === "queued" && !instagramResolved.includes(`p4_${stamp}`), `${igOf(seededA.p4.id)?.status}; resolved ${instagramResolved.join()}`);
  check("the person already reached is not stuck behind them: their Instagram DM goes out, old stored sending hours notwithstanding",igOf(seededA.p1.id)?.status === "sent" && instagramPosted.join() === `dm-p1_${stamp}`, `${igOf(seededA.p1.id)?.status}; posted ${instagramPosted.join()}`);

  // ------------------------------------------------------------ follow-ups and the second organization
  await db.update(whatsappCampaignLeads).set({ nextSendAt: minutes(-1) }).where(inArray(whatsappCampaignLeads.campaignId, [seededA.campaign.id, seededB.campaign.id]));
  const before = whatsappSent.length;
  await waTick();
  const p1Claims = await waClaims(seededA.campaign.id, seededA.p1.id);
  check("follow-ups still send while the limit is used", p1Claims.some((claim) => claim.step === 1 && claim.status === "sent") && whatsappSent.slice(before).includes(seededA.p1.id), JSON.stringify(p1Claims.map((claim) => [claim.step, claim.status])));
  check("…and the refused new person still waits", (await waClaims(seededA.campaign.id, seededA.p2.id)).length === 0 && !whatsappSent.includes(seededA.p2.id));
  check("a second organization is unaffected: its own new person is contacted while the first is at its limit", whatsappSent.includes(seededB.q1.id) && (await runInOrganization(b.org.id, () => newLeadsToday())).used === 1, whatsappSent.join());

  // ------------------------------------------------------------ the reset
  const tomorrow = new Date(dayA.resetsAt.getTime() + 60_000);
  await waTick(tomorrow);
  check("moving the clock past the reset resumes first messages: the waiting person is contacted", whatsappSent.includes(seededA.p2.id) && (await waClaims(seededA.campaign.id, seededA.p2.id)).some((claim) => claim.step === 0 && claim.status === "sent"), whatsappSent.join());
  const nextDay = await runInOrganization(a.org.id, () => db.transaction((tx) => newLeadAllowance(tx, { personId: seededA.p3.id, now: new Date(tomorrow.getTime() + 60_000) })));
  check("…LinkedIn's waiting person would be allowed then too (the day counts only claims made in it)", nextDay.ok && nextDay.counted, JSON.stringify(nextDay));
} finally {
  await db.update(whatsappCampaigns).set({ status: "paused" }).where(inArray(whatsappCampaigns.id, [seededA.campaign.id, seededB.campaign.id]));
  await db.update(outreachRuns).set({ status: "stopped" }).where(eq(outreachRuns.organizationId, a.org.id));
  await db.update(instagramOutreachQueue).set({ status: "cancelled", error: "Lead limit check finished" }).where(and(eq(instagramOutreachQueue.organizationId, a.org.id), eq(instagramOutreachQueue.status, "queued")));
  await db.update(linkedin.campaigns).set({ status: "PAUSED" }).where(eq(linkedin.campaigns.organizationId, a.org.id));
}

// ------------------------------------------------------------ what counts
// Each simulated claim takes its place as its engine does (recordNewLead in the claim transaction) and,
// for a definite failure, gives it back after the claim is failed (releaseNewLead); the rest keep theirs.
const c = await organization("c");
await runInOrganization(c.org.id, async () => {
  await saveChannelRules("general", { newLeadsPerDay: 3 }, c.owner.id);
  const persons = await db.insert(people).values(["dnc", "transport", "refused", "doubt", "yesterday", "fresh", "race1", "race2", "deleted", "timeout", "other"].map((name, index) => ({
    organizationId: c.org.id, fullName: `Count ${name}`, phone: phone(40 + index), source: "lead-limit-check",
  }))).returning();
  const person = (name: string) => persons.find((row) => row.fullName === `Count ${name}`)!;
  const take = (name: string, channel: "email" | "linkedin" | "whatsapp" | "instagram", at = new Date()) => db.transaction((tx) => recordNewLead(tx, { personId: person(name).id, channel, at }));
  // Email: one step Do Not Contact stopped before the provider (a definite non-send), one transport error (may have gone out).
  const [emailCampaign] = await db.insert(outreachCampaigns).values({ organizationId: c.org.id, name: "Count check", status: "paused" }).returning();
  const emailLeads = await db.insert(outreachLeads).values([person("dnc"), person("transport")].map((p) => ({ personId: p.id, campaignId: emailCampaign!.id }))).returning();
  const claimedAt = new Date();
  await db.insert(outreachEmails).values([
    { leadId: emailLeads[0]!.id, stepNumber: 1, status: "failed", error: EMAIL_DNC_BLOCKED_ERROR, createdAt: claimedAt },
    { leadId: emailLeads[1]!.id, stepNumber: 1, status: "failed", error: "socket hang up", createdAt: claimedAt },
  ]);
  await take("dnc", "email", claimedAt);
  await take("transport", "email", claimedAt);
  await releaseNewLead(db, { personId: person("dnc").id, since: claimedAt });
  // WhatsApp: a claim failed for good (the recipient refused).
  const wa = await whatsappSetup(c.org.id, "ccc");
  await enroll(wa.campaign.id, person("refused").id, minutes(60));
  const refusedLead = await waLead(wa.campaign.id, person("refused").id);
  await db.insert(whatsappCampaignSends).values({ leadId: refusedLead.id, step: 0, stepId: "refused", status: "failed", accountId: wa.account.id, body: "Hi", error: "WhatsApp refused the recipient" });
  await take("refused", "whatsapp", claimedAt);
  await releaseNewLead(db, { personId: person("refused").id, since: claimedAt });
  await db.update(whatsappCampaigns).set({ status: "paused" }).where(eq(whatsappCampaigns.id, wa.campaign.id));
  // Instagram: a DM in doubt after the provider call.
  await setFeature("instagram", true, c.owner.id);
  const [igAccount] = await db.insert(instagramAccounts).values({ organizationId: c.org.id, unipileAccountId: `lead-limit-ig-c-${stamp}`, username: `lead_limit_c_${stamp}`, status: "connected" }).returning();
  const thread = await createThread(c.owner.id);
  const audienceId = await createAudience({ name: "count check", source: "list" });
  const [run] = await db.insert(outreachRuns).values({ organizationId: c.org.id, threadId: thread.id, audienceId, name: "Count check", status: "stopped", channels: ["instagram"], autopilot: false, createdBy: c.owner.id, plan: { assignments: [] } as never }).returning();
  await db.insert(instagramOutreachQueue).values({ organizationId: c.org.id, runId: run!.id, personId: person("doubt").id, accountId: igAccount!.id, username: `doubt_${stamp}`, body: "Hi", status: "uncertain", attemptedAt: claimedAt });
  await take("doubt", "instagram", claimedAt);
  // LinkedIn: an invitation claimed two days ago (UTC, as the LinkedIn tables store it).
  const twoDaysAgo = new Date(Date.now() - 86_400_000 * 2);
  const [liAccount] = await db.insert(linkedin.linkedInAccounts).values({ organizationId: c.org.id, linkedinId: `lead-limit-li-c-${stamp}`, username: `lead-limit-li-c-${stamp}`, name: "Ravi", status: "CONNECTED", updatedAt: new Date() }).returning();
  const [liLead] = await db.insert(linkedin.leads).values({ organizationId: c.org.id, personId: person("yesterday").id, linkedinAccountId: liAccount!.id, status: "REQUEST_SENT", requestSentAt: twoDaysAgo, updatedAt: new Date() }).returning();
  await db.insert(linkedin.messages).values({ organizationId: c.org.id, type: "INVITATION", text: "Hi", leadId: liLead!.id, seen: true, createdAt: twoDaysAgo });
  await take("yesterday", "linkedin", twoDaysAgo);

  const today = await newLeadsToday();
  check("uncertain claims stay counted, definite failures do not: 2 new today (the email that may have gone out, the Instagram DM in doubt)", today.used === 2, `${today.used} used`);
  const yesterday = await db.transaction((tx) => newLeadAllowance(tx, { personId: person("yesterday").id }));
  check("a person reached on an earlier day is already contacted: allowed, and not counted", yesterday.ok && !yesterday.counted, JSON.stringify(yesterday));

  // Deleting the campaign that reached someone today gives no place back, and they are not new again.
  const [gone] = await db.insert(outreachCampaigns).values({ organizationId: c.org.id, name: "Deleted later", status: "paused" }).returning();
  const [goneLead] = await db.insert(outreachLeads).values({ personId: person("deleted").id, campaignId: gone!.id }).returning();
  await db.insert(outreachEmails).values({ leadId: goneLead!.id, stepNumber: 1, status: "sent", sentAt: new Date(), createdAt: new Date() });
  await take("deleted", "email");
  await deleteCampaign(gone!.id);
  const afterDelete = await newLeadsToday();
  const deletedAgain = await db.transaction((tx) => newLeadAllowance(tx, { personId: person("deleted").id }));
  check("deleting a campaign gives no place back: today still counts the person it reached", afterDelete.used === 3, `${afterDelete.used} used`);
  check("…and that person is not new again", deletedAgain.ok && !deletedAgain.counted, JSON.stringify(deletedAgain));

  for (const name of ["dnc", "refused", "fresh"]) {
    const allowance = await db.transaction((tx) => newLeadAllowance(tx, { personId: person(name).id }));
    check(`a person whose only claim ${name === "fresh" ? "is none" : "failed for good"} (${name}) is new, and refused at 3 of 3`, !allowance.ok && allowance.reason.startsWith(DAILY_LEAD_LIMIT_GATE), JSON.stringify(allowance));
  }

  // A WhatsApp first message that times out after the provider took it: its place stays taken, and
  // once its delivery is known it is not held behind the limit.
  await saveChannelRules("general", { newLeadsPerDay: 4 }, c.owner.id);
  await db.update(whatsappCampaigns).set({ status: "active" }).where(eq(whatsappCampaigns.id, wa.campaign.id));
  await enroll(wa.campaign.id, person("timeout").id, minutes(-1));
  await enroll(wa.campaign.id, person("other").id, minutes(-1));
  const timedOut: string[] = [];
  const flakySend = (async (request: { personId?: string | null }) => {
    timedOut.push(request.personId ?? "");
    throw new Error("socket hang up");
  }) as unknown as WaSend;
  ownOrganizations.push(c.org.id);
  await runWhatsappCampaignTick({ send: flakySend });
  const afterTimeout = await newLeadsToday();
  check("a first message that timed out keeps its place: only one new person was tried under the last place", timedOut.length === 1 && afterTimeout.used === 4, `tried ${timedOut.length}, ${afterTimeout.used} used`);
  const tried = timedOut[0]!;
  const retry = await db.transaction((tx) => newLeadAllowance(tx, { personId: tried }));
  check("…and that person is not counted again when it is retried", retry.ok && !retry.counted, JSON.stringify(retry));
  await db.update(whatsappCampaigns).set({ status: "paused" }).where(eq(whatsappCampaigns.id, wa.campaign.id));

  // Two claims racing for the last place, each taking it in its claim transaction as an engine does.
  await saveChannelRules("general", { newLeadsPerDay: 5 }, c.owner.id);
  const claim = (name: string) => db.transaction(async (tx) => {
    const allowance = await newLeadAllowance(tx, { personId: person(name).id });
    if (!allowance.ok) return false;
    const at = new Date();
    await tx.insert(instagramOutreachQueue).values({ organizationId: c.org.id, runId: run!.id, personId: person(name).id, accountId: igAccount!.id, username: `${name}_${stamp}`, body: "Hi", status: "sending", attemptedAt: at });
    if (allowance.counted) await recordNewLead(tx, { personId: person(name).id, channel: "instagram", at });
    await new Promise((resolve) => setTimeout(resolve, 300));
    return true;
  });
  const raced = await Promise.all([claim("race1"), claim("race2")]);
  check("two claims racing for the last place: exactly one gets it, the count never passes the limit", raced.filter(Boolean).length === 1 && (await newLeadsToday()).used === 5, JSON.stringify(raced));
  await db.update(instagramOutreachQueue).set({ status: "failed" }).where(eq(instagramOutreachQueue.organizationId, c.org.id));
});

// ------------------------------------------------------------ always on, and the migration
const d = await organization("d");
await runInOrganization(d.org.id, async () => {
  const resetAt = new Date(Date.now() - 2 * 3_600_000);
  const nextAt = new Date(Date.now() + 15 * 60_000);
  const legacy = { timezone: "Asia/Kolkata", days: Object.fromEntries(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((day) => [day, { enabled: !["saturday", "sunday"].includes(day), from: "09:00", to: "18:00" }])) } as never;
  const [mailbox] = await db.insert(mailboxes).values({ organizationId: d.org.id, emailAddress: `legacy-${stamp}@lead-limit-check.test`, status: "connected", dailySendLimit: 30, todayEmailsSent: 7, sendCounterResetAt: resetAt, nextEmailTime: nextAt, workingHours: legacy }).returning();
  const [fresh] = await db.insert(mailboxes).values({ organizationId: d.org.id, emailAddress: `fresh-${stamp}@lead-limit-check.test`, status: "connected" }).returning();
  check("a mailbox created without hours is always open (the column default)", isAlwaysOpen(fresh!.workingHours) && isWithinWorkingHours(fresh!.workingHours, new Date("2026-10-17T11:00:00Z")), JSON.stringify(fresh!.workingHours));
  const [account] = await db.insert(linkedin.linkedInAccounts).values({ organizationId: d.org.id, linkedinId: `lead-limit-li-d-${stamp}`, username: `lead-limit-li-d-${stamp}`, name: "Ravi", status: "CONNECTED", workTimezone: "Asia/Kolkata", workStartTime: "09:00", workEndTime: "18:00", workDays: "1,2,3,4,5,6", updatedAt: new Date() }).returning();
  await db.execute(sql`insert into channel_settings (organization_id, channel, values) values
    (${d.org.id}, 'email', ${JSON.stringify({ dailySendLimit: 40, sendingHours: { timezone: "Asia/Kolkata", days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" } })}::jsonb),
    (${d.org.id}, 'linkedin', ${JSON.stringify({ invitesPerRun: [2, 3], workingHours: { timezone: "UTC", days: [1], start: "09:00", end: "10:00" } })}::jsonb),
    (${d.org.id}, 'whatsapp', ${JSON.stringify({ sendingHours: { timezone: "UTC", days: [1], start: "09:00", end: "10:00" } })}::jsonb)`);

  // Applied as scripts/add-always-on-sending.ts applies it: the whole file, one simple-protocol transaction.
  const migration = await readFile(join(root, "db/migrations/20261022-always-on-sending.sql"), "utf8");
  const raw = new SQL(process.env.DATABASE_URL!, { max: 1, tls: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false } });
  const migrate = () => raw.begin(async (tx) => {
    await tx.unsafe("SET LOCAL lock_timeout = '10s'; SET LOCAL statement_timeout = '60s'").simple();
    await tx.unsafe(migration).simple();
  });
  await migrate();
  const [migrated] = await db.select().from(mailboxes).where(eq(mailboxes.id, mailbox!.id));
  check("the migration makes a restricted mailbox always open, keeping its time zone", Boolean(migrated) && isAlwaysOpen(migrated!.workingHours) && migrated!.workingHours.timezone === "Asia/Kolkata" && isWithinWorkingHours(migrated!.workingHours, new Date("2026-10-17T11:00:00Z")), JSON.stringify(migrated?.workingHours));
  check("…and leaves today's counter, its reset and the next send time as they were", migrated?.todayEmailsSent === 7 && migrated.sendCounterResetAt?.getTime() === resetAt.getTime() && migrated.nextEmailTime?.getTime() === nextAt.getTime() && migrated.dailySendLimit === 30);
  const [cleared] = await db.select().from(linkedin.linkedInAccounts).where(eq(linkedin.linkedInAccounts.id, account!.id));
  check("…clears a LinkedIn account's working hours", cleared?.workTimezone === null && cleared.workStartTime === null && cleared.workEndTime === null && cleared.workDays === null);
  const stored = Object.fromEntries((await db.execute<{ channel: string; values: Record<string, unknown> }>(sql`select channel, values from channel_settings where organization_id = ${d.org.id}`)).map((row) => [row.channel, row.values]));
  check("…and strips the stored hour rules, keeping every other value", JSON.stringify(stored.email) === JSON.stringify({ dailySendLimit: 40 }) && JSON.stringify(stored.linkedin) === JSON.stringify({ invitesPerRun: [2, 3] }) && JSON.stringify(stored.whatsapp) === "{}", JSON.stringify(stored));
  const [{ changed }] = await db.execute<{ changed: string }>(sql`select md5(string_agg(id::text || working_hours::text || updated_at::text, ',' order by id)) as changed from outreach_mailboxes where organization_id = ${d.org.id}`);
  await migrate();
  await raw.close();
  const [{ changed: again }] = await db.execute<{ changed: string }>(sql`select md5(string_agg(id::text || working_hours::text || updated_at::text, ',' order by id)) as changed from outreach_mailboxes where organization_id = ${d.org.id}`);
  check("a second run changes nothing", changed === again);
  const [column] = await db.execute<{ column_default: string }>(sql`select column_default from information_schema.columns where table_schema = 'public' and table_name = 'outreach_mailboxes' and column_name = 'working_hours'`);
  check("the column default is always open", /"monday": \{"to": "00:00", "from": "00:00", "enabled": true\}/.test(column?.column_default ?? "") && !/"enabled": false/.test(column?.column_default ?? ""), column?.column_default);
  await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.organizationId, d.org.id));
});

console.log(failures ? `\n${failures} check(s) failed.` : "\nDaily lead limit checks passed.");
process.exit(failures ? 1 : 0);

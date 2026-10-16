/**
 * The assistant's two starting points, lead qualification and inquiry runs,
 * against the database (no model, no provider): it runs the real services
 * the assistant's tools call and checks what they record.
 *
 *   bun run --conditions=react-server scripts/e2e/assistant-intake.ts
 *
 * Proves: "use my existing leads" lists people already saved, leaves out
 * people in a running run and excludes Do Not Contact with the reason;
 * "inquiries" lists only fresh inquiries unless history is asked for, with
 * the inquiry's own words as the only evidence of need; qualification keeps
 * potential matches apart from inquired and interested people and leaves
 * unknowns unknown; an inquiry run cannot be proposed with the features
 * off, starts only through its own start, covers only people attached while
 * it runs, pauses, resumes and stops, and never takes another run's
 * channel; one Start with "apply to the rest of this request" starts the
 * request's other plans (waiting and prepared later) in the same mode, and
 * never another request's, a plan on another channel, or anything once the
 * approving run is stopped; a second organization sees none of it.
 *
 * The email channel is made available with a stand-in Unipile connection and
 * mailbox; Start only queues the launch job, which this script never runs,
 * so nothing is sent and the stand-in host is never called.
 *
 * Creates two organizations ("Intake check …") and leaves them behind; the
 * launch jobs its started plans queued are cancelled at the end.
 * Refuses a non-local DATABASE_URL.
 */
import { and, eq, inArray } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}

const { db } = await import("@/lib/db");
const { organizations } = await import("@/lib/auth/schema");
const { people } = await import("@/lib/leads/schema");
const { crmConversations, crmPersonContactPolicies, crmRecords } = await import("@/lib/crm/schema");
const { ensureCrmDefaults } = await import("@/lib/crm/defaults");
const { inquiries } = await import("@/lib/intake/schema");
const { instagramAccounts } = await import("@/lib/instagram/schema");
const schema = await import("@/lib/assistant/schema");
const { createExistingLeadsAudience } = await import("@/lib/assistant/existingLeads.server");
const { audienceProspects } = await import("@/lib/assistant/qualification.server");
const { activeInquiryRun, attachInquiryToRun, prepareInquiryReplies, InquiryRunError } = await import("@/lib/assistant/inquiryRuns.server");
const { OutreachError, getRun, setRunPaused, startInquiryRun, startOutreachRun, stopRun } = await import("@/lib/assistant/outreach.server");
const { runMembershipFor } = await import("@/lib/crm/autopilot.server");
const { setFeature, clearFeatureCache } = await import("@/lib/features/flags.server");
const { createAudience, memberInsights } = await import("@/lib/assistant/audiences.server");

/** Members of a list with their match reason and signals (kept in lead_audience_member_insights). */
async function withInsights<T extends { id: string }>(rows: T[]) {
  const insights = await memberInsights(rows.map((row) => row.id));
  return rows.map((row) => ({ ...row, matchReason: insights.get(row.id)?.matchReason ?? null, signals: insights.get(row.id)?.signals ?? [] }));
}
const { runInOrganization, currentOrganizationId } = await import("@/lib/tenancy/scope");
const { recordRequestApproval, applyRequestApproval } = await import("@/lib/assistant/requestApproval.server");
const { createThread, listMessages } = await import("@/lib/assistant/threads.server");
const { mailboxes } = await import("@/lib/outreach/schema");
const { gridProviderCredentials, gridProviders } = await import("@/lib/grid/schema");
const { encryptIntegrationCredentials } = await import("@/lib/integrations/credentials");
const { assistantJobs } = await import("@/lib/assistant/schema");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function throws(promise: Promise<unknown>, type: new (...args: never[]) => Error): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof type ? error.message : `unexpected ${error instanceof Error ? error.message : String(error)}`;
  }
}

const stamp = Date.now();
const [orgA] = await db.insert(organizations).values({ name: `Intake check A ${stamp}`, slug: `intake-check-a-${stamp}` }).returning();
const [orgB] = await db.insert(organizations).values({ name: `Intake check B ${stamp}`, slug: `intake-check-b-${stamp}` }).returning();
console.log(`Organizations ${orgA!.id} (A) and ${orgB!.id} (B)`);

let audienceOfA = "";
let personOfA = "";

await runInOrganization(orgA!.id, async () => {
  const org = currentOrganizationId();
  const make = async (values: Partial<typeof people.$inferInsert> & { source: string }) =>
    (await db.insert(people).values({ organizationId: org, ...values }).returning({ id: people.id }))[0]!.id;
  const listed = await make({ email: `listed-${stamp}@example.test`, fullName: "Listed Lead", source: "manual-people-import", raw: { city: "Pune" } });
  const phoneOnly = await make({ phone: "+919800000001", fullName: "Phone Lead", source: "manual-people-import" });
  const busy = await make({ email: `busy-${stamp}@example.test`, fullName: "Busy Lead", source: "manual-people-import" });
  const dnc = await make({ email: `dnc-${stamp}@example.test`, fullName: "No Contact", source: "manual-people-import" });
  const asker = await make({ email: `asker-${stamp}@example.test`, fullName: "Asha Asker", source: "intake:website-form" });
  const oldAsker = await make({ email: `old-${stamp}@example.test`, fullName: "Old Asker", source: "intake:website-form" });
  personOfA = listed;
  await db.insert(crmPersonContactPolicies).values({ personId: dnc, doNotContact: true, reason: "asked", source: "human", setAt: new Date() });
  await db.insert(inquiries).values([
    { organizationId: org, source: "website_form", dedupeKey: `fresh-${stamp}`, personId: asker, name: "Asha Asker", email: `asker-${stamp}@example.test`, message: "Do you service X-ray units in Baner?", pageUrl: "https://acme.example/contact", historical: false },
    { organizationId: org, source: "website_form", dedupeKey: `old-${stamp}`, personId: oldAsker, name: "Old Asker", message: "Price list please", historical: true },
  ]);
  // Busy is in a running outreach run already.
  const runAudience = await createAudience({ name: "busy run", source: "list" });
  const basePlan = { assignments: [], sequences: {}, personalizationKey: "p_00000000", samples: [], limits: { maxLeads: 1, emailPerMailboxPerDay: 30, whatsappNewChatsPerDay: null }, excluded: [], estimate: { aiCalls: 0, aiCostUsd: null, days: 1 }, autopilot: false, instructions: null };
  const [busyRun] = await db.insert(schema.outreachRuns).values({ organizationId: org, audienceId: runAudience, name: "Busy run", status: "running", channels: ["email"], plan: basePlan }).returning();
  await db.insert(schema.outreachRunLeads).values({ organizationId: org, runId: busyRun!.id, personId: busy, channel: "email" });

  // ------------------------------------------------------------ existing leads
  const all = await createExistingLeadsAudience({ from: "all", threadId: null, userId: null });
  const allMembers = all.audienceId ? await withInsights(await db.select().from(schema.leadAudienceMembers).where(eq(schema.leadAudienceMembers.audienceId, all.audienceId))) : [];
  const has = (id: string) => allMembers.find((member) => member.personId === id);
  check("existing leads: people already saved are listed", Boolean(has(listed) && has(phoneOnly) && has(asker)), `${allMembers.length} members`);
  check("existing leads: someone in a running run is left out", !has(busy) && all.alreadyInRuns === 1, `alreadyInRuns ${all.alreadyInRuns}`);
  check("existing leads: Do Not Contact is excluded with the reason", has(dnc)?.status === "excluded" && /do not contact/i.test(has(dnc)?.reason ?? ""), has(dnc)?.reason ?? "missing");
  check("existing leads: each has a reason naming where it came from", /Already in your leads since .* \(from an uploaded list\)/.test(has(listed)?.matchReason ?? ""), has(listed)?.matchReason ?? "");
  check("existing leads: the list says it came from the lead database", all.audience?.source === "list" && all.audience.criteria.source === "existing");
  audienceOfA = all.audienceId!;

  const fresh = await createExistingLeadsAudience({ from: "inquiries", threadId: null, userId: null });
  const freshMembers = await withInsights(await db.select().from(schema.leadAudienceMembers).where(eq(schema.leadAudienceMembers.audienceId, fresh.audienceId!)));
  check("inquiries: only fresh inquiries by default", freshMembers.length === 1 && freshMembers[0]!.personId === asker, freshMembers.map((m) => m.name).join(", "));
  check("inquiries: the inquiry's own words are the evidence, with its page", freshMembers[0]?.signals[0]?.text === "Do you service X-ray units in Baner?" && freshMembers[0]?.signals[0]?.sourceUrl === "https://acme.example/contact");
  check("inquiries: the writer may quote what they asked", freshMembers[0]?.facts.inquiry === "Do you service X-ray units in Baner?");
  const withHistory = await createExistingLeadsAudience({ from: "inquiries", includeHistorical: true, threadId: null, userId: null });
  check("inquiries: imported history only when asked for", withHistory.audience?.total === 2, `${withHistory.audience?.total}`);

  // ------------------------------------------------------------ qualification
  const prospects = await audienceProspects(all.audienceId!);
  const byName = new Map(prospects!.prospects.map((prospect) => [prospect.name, prospect]));
  check("qualification: a saved lead is a potential match, not interested", byName.get("Listed Lead")?.status === "potential_match");
  check("qualification: an inquirer is 'Inquired', with their words", byName.get("Asha Asker")?.status === "inquired" && byName.get("Asha Asker")?.needEvidence.length === 1);
  check("qualification: location and budget stay unknown when no source stated them", byName.get("Listed Lead")?.location === "Unknown" && byName.get("Listed Lead")?.budget === "Unknown");
  check("qualification: counts keep the groups apart", prospects!.counts.interested === 0 && prospects!.counts.inquired === 1, JSON.stringify(prospects!.counts));

  // ------------------------------------------------------------ inquiry runs
  clearFeatureCache();
  const off = await throws(prepareInquiryReplies({ ownerRequest: "answer my instagram inquiries", threadId: null, userId: null }), InquiryRunError);
  check("inquiry run: refused while the features are off", Boolean(off && /off for this organization/.test(off)), off ?? "no error");
  await setFeature("instagram", true, null);
  await setFeature("inquiry_intake", true, null);
  const noAccount = await throws(prepareInquiryReplies({ ownerRequest: "answer my instagram inquiries", threadId: null, userId: null }), InquiryRunError);
  check("inquiry run: refused without a connected account taking inquiries", Boolean(noAccount && /No Instagram account is connected/.test(noAccount)), noAccount ?? "no error");
  await db.insert(instagramAccounts).values({ organizationId: org, unipileAccountId: `ig-intake-check-${stamp}`, username: "acme.dental", status: "connected", inquiryIntake: true, connectedAt: new Date(), historyCutoffAt: new Date() });
  const proposal = await prepareInquiryReplies({ ownerRequest: "answer my instagram inquiries", threadId: null, userId: null });
  check("inquiry run: proposed, not started", (await getRun(proposal.runId))?.status === "proposed" && proposal.plan.kind === "inquiries");
  check("inquiry run: nothing is attached before Start", (await attachInquiryToRun(listed, "instagram", `ig-intake-check-${stamp}`)) === null);
  const viaOutreach = await throws(startOutreachRun(proposal.runId, null, { autopilot: true }), OutreachError);
  check("inquiry run: the outreach start refuses it (no campaigns, no job)", Boolean(viaOutreach), viaOutreach ?? "started");
  await startInquiryRun(proposal.runId, null, true);
  check("inquiry run: Start makes it running in the chosen mode", (await getRun(proposal.runId))?.status === "running" && (await getRun(proposal.runId))?.autopilot === true);
  const second = await throws(prepareInquiryReplies({ ownerRequest: "answer my instagram inquiries", threadId: null, userId: null }), InquiryRunError);
  check("inquiry run: only one at a time", Boolean(second && /already being answered/.test(second)), second ?? "allowed");

  const inquirer = await make({ fullName: "@new.patient", source: "intake:instagram" });
  check("inquiry run: an inquiry on an account the run does not cover is not attached", (await attachInquiryToRun(inquirer, "instagram", "some-other-account")) === null);
  check("inquiry run: a fresh inquirer is attached", (await attachInquiryToRun(inquirer, "instagram", `ig-intake-check-${stamp}`)) === proposal.runId);
  // Their conversations: one on the account the run covers, one on another of the organization's accounts.
  const { pipelineId } = await ensureCrmDefaults();
  const [inquirerRecord] = await db.insert(crmRecords).values({ organizationId: org, personId: inquirer, pipelineId }).returning({ id: crmRecords.id });
  const [covered, elsewhere] = await db.insert(crmConversations).values([
    { organizationId: org, crmRecordId: inquirerRecord!.id, personId: inquirer, channel: "instagram", accountRef: `ig-intake-check-${stamp}`, providerThreadId: `chat-a-${stamp}` },
    { organizationId: org, crmRecordId: inquirerRecord!.id, personId: inquirer, channel: "instagram", accountRef: `ig-other-${stamp}`, providerThreadId: `chat-b-${stamp}` },
  ]).returning({ id: crmConversations.id });
  const conversation = covered!.id;
  check("inquiry run: the same person writing to an account the run does not list is not covered there", (await runMembershipFor(db, inquirer, "instagram", elsewhere!.id)) === null);
  check("inquiry run: without the conversation nothing is covered on Instagram (fail closed)", (await runMembershipFor(db, inquirer, "instagram")) === null);
  const membership = await runMembershipFor(db, inquirer, "instagram", conversation);
  check("inquiry run: the autopilot sees them as a running, automatic member on Instagram", membership?.runId === proposal.runId && membership.runStatus === "running" && membership.automatic === true);
  check("inquiry run: no membership on other channels", (await runMembershipFor(db, inquirer, "email")) === null);
  check("inquiry run: people never attached are not covered", (await runMembershipFor(db, listed, "instagram", conversation)) === null);
  await setRunPaused(proposal.runId, true);
  check("inquiry run: Pause holds it (the gate reads 'paused')", (await runMembershipFor(db, inquirer, "instagram", conversation))?.runStatus === "paused");
  await setRunPaused(proposal.runId, false);
  check("inquiry run: Resume runs it again", (await runMembershipFor(db, inquirer, "instagram", conversation))?.runStatus === "running");
  await stopRun(proposal.runId);
  const stopped = await runMembershipFor(db, inquirer, "instagram", conversation);
  check("inquiry run: Stop is final for its members", stopped?.runStatus === "stopped" && stopped.leadStatus === "stopped");
  check("inquiry run: nobody is attached after Stop", (await attachInquiryToRun(listed, "instagram", `ig-intake-check-${stamp}`)) === null && (await activeInquiryRun()) === null);

  // ------------------------------------------------------------ one Start for the whole request
  const [provider] = await db.insert(gridProviders).values({ organizationId: org, key: "platform-unipile", name: "Unipile (stand-in)" }).returning();
  await db.insert(gridProviderCredentials).values({ providerId: provider!.id, encryptedPayload: encryptIntegrationCredentials({ baseUrl: "https://unipile-intake-check.invalid", apiKey: "stand-in", notifySecret: "stand-in" }) });
  await db.insert(mailboxes).values({ organizationId: org, emailAddress: `owner-${stamp}@mail.example.test`, provider: "unipile", unipileAccountId: `mail-${stamp}`, status: "connected" });
  const thread = await createThread(null);
  // Two owner messages: the request, and a different request that happens to read "yes" too.
  const requestId = `owner-msg-${stamp}`;
  const otherRequestId = `owner-msg-other-${stamp}`;
  const recipients = await Promise.all(Array.from({ length: 6 }, (_, index) => make({ email: `req${index}-${stamp}@clinic.test`, fullName: `Clinic ${index}`, source: "discovery:google-maps" })));
  const plan = (personIds: string[], reqId: string, channel: "email" | "whatsapp" = "email") => ({
    ...basePlan,
    assignments: personIds.map((personId) => ({ personId, channel })),
    sequences: { [channel]: [{ subject: "Hello", body: "Hello there", waitDays: 0 }] },
    ownerRequest: "yes",
    requestId: reqId,
  });
  const propose = async (name: string, personIds: string[], reqId: string, channel: "email" | "whatsapp" = "email") => {
    const audienceId = await createAudience({ name, source: "discovery", threadId: thread.id });
    const [row] = await db.insert(schema.outreachRuns).values({ organizationId: org, threadId: thread.id, audienceId, name, status: "proposed", channels: [channel], plan: plan(personIds, reqId, channel) }).returning();
    return row!.id;
  };
  const pune = await propose("Dentists — Pune", [recipients[0]!], requestId);
  const mumbai = await propose("Dentists — Mumbai", [recipients[1]!], requestId);
  const gyms = await propose("Gyms — Pune (another 'yes')", [recipients[2]!], otherRequestId);
  const waPlan = await propose("Dentists — Nagpur (WhatsApp)", [recipients[3]!], requestId, "whatsapp");
  const overlap = await propose("Dentists — Pune again", [recipients[0]!], requestId);

  await startOutreachRun(pune, null, { autopilot: true });
  const applied = await recordRequestApproval(pune, { autopilot: true, approvedBy: null });
  const statusOf = async (id: string) => (await getRun(id))?.status;
  check("one Start: the request's waiting plan starts too, in the same mode", (await statusOf(mumbai)) === "starting" && (await getRun(mumbai))?.autopilot === true, JSON.stringify(applied.started));
  check("one Start: another request worded the same ('yes') keeps waiting", (await statusOf(gyms)) === "proposed");
  check("one Start: a plan on a channel the approval did not cover keeps waiting, with the reason", (await statusOf(waPlan)) === "proposed" && applied.skipped.some((item) => item.runId === waPlan && /whatsapp/.test(item.reason)), JSON.stringify(applied.skipped));
  check("one Start: a plan with someone already in a running plan keeps waiting, with the reason", (await statusOf(overlap)) === "proposed" && applied.skipped.some((item) => item.runId === overlap && /already in another running plan/.test(item.reason)));
  check("one Start: the started plan queued its launch job like a Start press", (await db.select().from(assistantJobs).where(and(eq(assistantJobs.runId, mumbai), eq(assistantJobs.kind, "outreach_start")))).length === 1);
  // Switching the approved run to Review: the rest of the request follows.
  await db.update(schema.outreachRuns).set({ autopilot: false }).where(eq(schema.outreachRuns.id, pune));
  const later = await propose("Dentists — Nagpur", [recipients[4]!], requestId);
  const laterOutcome = await applyRequestApproval(later);
  check("one Start: a plan prepared later by the same request starts on its own, in the approved run's current mode (Review)", laterOutcome.started && (await statusOf(later)) === "starting" && (await getRun(later))?.autopilot === false);
  const events = (await listMessages(thread.id, 50)).filter((message) => message.role === "event").map((message) => message.content);
  check("one Start: the chat says each plan started under the approval", events.filter((text) => /started on its own under your approval/.test(text)).length === 2, `${events.length} events`);
  await stopRun(pune);
  const afterStop = await propose("Dentists — Thane", [recipients[5]!], requestId);
  const stoppedOutcome = await applyRequestApproval(afterStop);
  check("one Start: stopping the approved run ends the approval", !stoppedOutcome.started && (await statusOf(afterStop)) === "proposed" && /stopped/.test(stoppedOutcome.reason ?? ""), stoppedOutcome.reason ?? "");
});

// ------------------------------------------------------------ organization B sees nothing of A
await runInOrganization(orgB!.id, async () => {
  check("isolation: B cannot read A's list", (await audienceProspects(audienceOfA)) === null);
  const bList = await createExistingLeadsAudience({ from: "all", threadId: null, userId: null });
  check("isolation: B's existing leads hold none of A's people", bList.audienceId === null, `audience ${bList.audienceId}`);
  check("isolation: B has no inquiry run", (await activeInquiryRun()) === null);
  check("isolation: B sees no run membership of A's people", (await runMembershipFor(db, personOfA, "email")) === null);
  const [aRow] = await db.select().from(schema.leadAudienceMembers).where(and(eq(schema.leadAudienceMembers.audienceId, audienceOfA))).limit(1);
  check("isolation sanity: A's rows exist (the checks above are not vacuous)", Boolean(aRow));
});

// The plans started above queued launch jobs that nothing here runs: cancel them, so another
// script's worker on this shared local database never picks them up.
await db.update(assistantJobs).set({ status: "cancelled", error: "assistant-intake check: not run" })
  .where(and(inArray(assistantJobs.organizationId, [orgA!.id, orgB!.id]), inArray(assistantJobs.status, ["queued", "running"])));

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);

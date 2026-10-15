/**
 * The reply autopilot and the owner's controls, deterministic part of
 * scripts/e2e/assistant.ts (no model needed): CRM drafts come from a
 * stand-in drafter, the support check's model half is a stand-in, and every
 * send goes through the real CRM send path to the caller's fake Unipile.
 * What it proves: Review vs Automatic per run, supported answers sent once,
 * missing information asked and saved, opt-outs stopping everything, pause
 * holding and resume re-queueing, stop, takeover, newer messages, edits,
 * the 24-hour limit under concurrent jobs, the production guard, restart
 * recovery, the results figures against recorded events, the daily summary,
 * the unsolicited-plan guard, and isolation from a second organization.
 */
import { and, count, eq, inArray, like, sql } from "drizzle-orm";
import type { DraftCompletion } from "@/lib/crm/ai/draft";
import type { ModelCheck } from "@/lib/assistant/replyCheck";

type Check = (label: string, ok: boolean, detail?: string) => void;

export async function runAutomationChecks(input: {
  check: Check;
  organizationId: string;
  stamp: number;
  mailboxAddress: string;
  unipileSends: Record<string, string>[];
  ownerId: string | null;
}) {
  const { check, stamp, mailboxAddress, unipileSends } = input;
  const { db } = await import("@/lib/db");
  const { people } = await import("@/lib/leads/schema");
  const { currentOrganizationId } = await import("@/lib/tenancy/scope");
  const schema = await import("@/lib/assistant/schema");
  const crm = await import("@/lib/crm/schema");
  const outreachSchema = await import("@/lib/outreach/schema");
  const { ingestInboundReply } = await import("@/lib/crm/conversations");
  const { applyHumanClassification } = await import("@/lib/crm/operations");
  const { generateFallbackDraft, updateDraft } = await import("@/lib/crm/drafts");
  const { ensureCrmDefaults } = await import("@/lib/crm/defaults");
  const { isPersonDoNotContact } = await import("@/lib/crm/policies");
  const { runAutopilotForDraft } = await import("@/lib/assistant/autopilotRun.server");
  const { answerDecision, listOpenDecisions, takeOverConversation } = await import("@/lib/assistant/decisions.server");
  const { setRunPaused, stopRun } = await import("@/lib/assistant/outreach.server");
  const { results } = await import("@/lib/assistant/results.server");
  const { writeDailySummary } = await import("@/lib/assistant/dailySummary.server");
  const { saveDocumentKnowledge, updateBusinessProfile } = await import("@/lib/assistant/profile.server");
  const { createAudience } = await import("@/lib/assistant/audiences.server");
  const { createThread, listMessages } = await import("@/lib/assistant/threads.server");
  const { runTool } = await import("@/lib/assistant/tools.server");
  const { createCampaign, setCampaignStatus, updateCampaignSequence } = await import("@/lib/outreach/campaigns");
  const { parseSequence } = await import("@/lib/outreach/launch");
  const { addPeopleToEmailCampaign } = await import("@/lib/leads/campaignAssignments");
  const { buildMailboxQueues } = await import("@/lib/outreach/buildQueue");
  const { runSchedulerTick } = await import("@/lib/outreach/scheduler");
  const { runOneAssistantStep } = await import("@/lib/assistant/worker");

  const orgId = currentOrganizationId();
  const fakeDraft = (bodyText: string): DraftCompletion => async (request) => {
    const text = JSON.stringify({ subject: "Re: chair maintenance", bodyText, bodyHtml: null });
    request.accept?.(text);
    return { text, provider: "stand-in", model: "stand-in-drafter", request: {}, response: {} };
  };
  const supportedCheck = async (): Promise<ModelCheck> => ({
    intent: "question",
    questions: [{ question: "How much is the maintenance plan?", answered: true, evidence: "Monthly maintenance plan: ₹2,499 per chair per month" }],
    claims: [{ claim: "The plan includes two visits", evidence: "includes two visits" }],
    commitments: [],
    missing: "",
    escalate: "",
  });
  const sent = () => unipileSends.length;

  // ------------------------------------------------------------ fixtures
  await updateBusinessProfile({ businessName: "Bright Path Dental Supplies", offer: "Same-week servicing for dental chairs and autoclaves", senderName: "Ravi", targetCustomers: "dental clinics", locations: "Pune" }, input.ownerId);
  await saveDocumentKnowledge("Price list", "Monthly maintenance plan: ₹2,499 per chair per month, includes two visits. Service area: Pune and Pimpri-Chinchwad.");
  const { pipelineId } = await ensureCrmDefaults();
  const subcategory = async (key: string) => (await db.select({ id: crm.crmSubcategories.id }).from(crm.crmSubcategories)
    .where(and(eq(crm.crmSubcategories.pipelineId, pipelineId), eq(crm.crmSubcategories.key, key))).limit(1))[0]!.id;
  const infoSubcategory = await subcategory("information_requested");
  const dncSubcategory = await subcategory("do_not_contact");

  const persons = await db.insert(people).values(Array.from({ length: 16 }, (_, index) => ({
    organizationId: orgId,
    email: `lead${index + 1}-${stamp}@clinic-auto.test`,
    fullName: `Dr Lead ${index + 1}`,
    source: "assistant-automation-check",
  }))).returning({ id: people.id, email: people.email });
  const P = persons.map((person) => person.id);
  const audienceId = await createAudience({ name: "automation check", source: "list" });
  const thread = await createThread(input.ownerId);
  const plan = { assignments: [], sequences: {}, personalizationKey: "p_00000000", samples: [], limits: { maxLeads: 20, emailPerMailboxPerDay: 30, whatsappNewChatsPerDay: null }, excluded: [], estimate: { aiCalls: 0, aiCostUsd: null, days: 1 }, autopilot: false, instructions: null };
  const [reviewRun] = await db.insert(schema.outreachRuns).values({ organizationId: orgId, threadId: thread.id, audienceId, name: "Review run", status: "running", channels: ["email"], plan, autopilot: false }).returning();
  const [autoRun] = await db.insert(schema.outreachRuns).values({ organizationId: orgId, threadId: thread.id, audienceId, name: "Automatic run", status: "running", channels: ["email"], plan: { ...plan, autopilot: true }, autopilot: true }).returning();
  await db.insert(schema.outreachRunLeads).values([
    { organizationId: orgId, runId: reviewRun!.id, personId: P[0]!, channel: "email" },
    ...P.slice(1).map((personId) => ({ organizationId: orgId, runId: autoRun!.id, personId, channel: "email" as const })),
  ]);
  // The automatic run's email campaign (so pause, resume and stop have something to act on).
  const campaign = await createCampaign({ name: "Automatic run · email" });
  const parsed = parseSequence([{ subject: "Chair servicing for {{company}}", body: "Hello, quick question about your chairs.", waitDays: 0 }, { subject: "", body: "Following up.", waitDays: 3 }]);
  if (!parsed.ok) throw new Error(parsed.error);
  await updateCampaignSequence(campaign.id, parsed.sequence);
  await addPeopleToEmailCampaign(campaign.id, P.slice(1, 8));
  await setCampaignStatus(campaign.id, "active");
  await db.update(schema.outreachRuns).set({ campaigns: { email: campaign.id } }).where(eq(schema.outreachRuns.id, autoRun!.id));

  let threadIndex = 0;
  async function reply(personId: string, body: string, draftBody: string, options: { thread?: string; category?: "interested" | "dnc" } = {}) {
    const key = options.thread ?? `t${(threadIndex += 1)}`;
    const inbound = await ingestInboundReply({
      personId,
      channel: "email",
      accountRef: mailboxAddress,
      providerThreadId: `auto-${key}-${stamp}`,
      idempotencyKey: `auto-in-${key}-${stamp}-${threadIndex}-${Math.random()}`,
      providerMessageId: `auto-pm-${key}-${stamp}-${Math.random()}`,
      subject: "Re: Chair servicing",
      bodyText: body,
      sentAt: new Date(),
    });
    const [record] = await db.select().from(crm.crmRecords).where(eq(crm.crmRecords.id, inbound.record.id));
    await applyHumanClassification({ recordId: record!.id, categoryKey: options.category === "dnc" ? "not_interested" : "interested", subcategoryId: options.category === "dnc" ? dncSubcategory : infoSubcategory, expectedContextVersion: record!.contextVersion });
    if (options.category === "dnc") return { recordId: record!.id, conversationId: inbound.message.conversationId, draft: null };
    const draft = await generateFallbackDraft(record!.id, { complete: fakeDraft(draftBody) });
    return { recordId: record!.id, conversationId: inbound.message.conversationId, draft: draft! };
  }
  const run = (draft: { id: string; revision: number }, check = supportedCheck, allowNonProduction = true) =>
    runAutopilotForDraft(draft.id, { revision: draft.revision, check, allowNonProduction });
  const answer = "Hi, the monthly maintenance plan is ₹2,499 per chair and includes two visits. Would that suit your clinic? — Ravi";

  // ------------------------------------------------------------ Review vs Automatic
  const before = sent();
  const review = await reply(P[0]!, "How much is the maintenance plan?", answer);
  const reviewOutcome = await run(review.draft!);
  check("Review run: the reply waits for the owner, nothing is sent", !reviewOutcome.sent && /Review/.test(reviewOutcome.reason ?? "") && sent() === before, reviewOutcome.reason ?? "");
  const [interestReport] = await db.select().from(schema.ownerDecisions).where(and(eq(schema.ownerDecisions.organizationId, orgId), eq(schema.ownerDecisions.kind, "interested"), eq(schema.ownerDecisions.draftId, review.draft!.id)));
  check("an interested lead is reported to the owner even in Review mode", Boolean(interestReport));
  const [orgWide] = await db.select({ n: count() }).from(crm.crmSettings).where(sql`${crm.crmSettings.humanSendOnly} IS NOT TRUE`);
  check("no organization-wide automatic sending exists (human_send_only stays on)", Number(orgWide?.n ?? 0) === 0);

  const supported = await reply(P[1]!, "How much is the maintenance plan? Does it include visits?", answer);
  const sentOutcome = await run(supported.draft!);
  const lastSend = unipileSends.at(-1);
  check("Automatic run: a question answered from the owner's document is sent automatically", sentOutcome.sent && sent() === before + 1 && JSON.parse(lastSend?.to ?? "[]")[0]?.identifier === persons[1]!.email, sentOutcome.reason ?? JSON.stringify(lastSend).slice(0, 200));
  const [ledger] = await db.select().from(schema.autopilotReplies).where(eq(schema.autopilotReplies.draftId, supported.draft!.id));
  check("the decision is recorded with its check (quotes verified)", ledger?.status === "sent" && Boolean(ledger.check?.questions[0]?.supported));
  const again = await run(supported.draft!);
  check("running it again sends nothing more", !again.sent && sent() === before + 1, again.reason ?? "");

  // ------------------------------------------------------------ an invented quote, missing information, the owner's answer
  const madeUp = await reply(P[2]!, "Do you also cover Mumbai?", "Yes, we cover Mumbai too. — Ravi");
  const madeUpOutcome = await run(madeUp.draft!, async () => ({ intent: "question", questions: [{ question: "Do you cover Mumbai?", answered: true, evidence: "We cover Mumbai and Pune" }], claims: [], commitments: [], missing: "Do you serve clinics in Mumbai?", escalate: "" }));
  const [missing] = await db.select().from(schema.ownerDecisions).where(and(eq(schema.ownerDecisions.draftId, madeUp.draft!.id), eq(schema.ownerDecisions.kind, "missing_info")));
  check("an answer the information does not support (invented quote) is held and asked of the owner", !madeUpOutcome.sent && missing?.status === "open" && missing.decision === "Do you serve clinics in Mumbai?", missing?.reason ?? madeUpOutcome.reason ?? "");
  const card = (await listMessages(thread.id)).find((message) => message.tool === "owner_decision" && (message.toolResult as { data?: { decisionId?: string } })?.data?.decisionId === missing?.id);
  check("the question appears in the owner's chat with the reason", Boolean(card));
  const answered = await answerDecision(missing!.id, "No, we only serve Pune and Pimpri-Chinchwad for now.", input.ownerId);
  const [answers] = await db.select().from(crm.crmKnowledgeDocuments).where(and(eq(crm.crmKnowledgeDocuments.organizationId, orgId), sql`${crm.crmKnowledgeDocuments.tags} @> ARRAY['owner-answers']::text[]`));
  check("the owner's answer is saved to knowledge for every later conversation", answered.saved && Boolean(answers?.alwaysInclude), answered.problem ?? "");
  const rewritten = await generateFallbackDraft(madeUp.recordId, { complete: fakeDraft("Thanks for asking. We only serve Pune and Pimpri-Chinchwad for now. — Ravi") });
  const afterAnswer = await run(rewritten!, async () => ({ intent: "question", questions: [{ question: "Do you cover Mumbai?", answered: true, evidence: "we only serve Pune and Pimpri-Chinchwad for now" }], claims: [], commitments: [], missing: "", escalate: "" }));
  check("with the saved answer as evidence, the rewritten reply is sent", afterAnswer.sent, afterAnswer.reason ?? "");

  // ------------------------------------------------------------ prices, promises, complaints
  const discount = await reply(P[3]!, "Can you do it cheaper?", "Sure, I can give you 20% off. — Ravi");
  const discountOutcome = await run(discount.draft!, async () => ({ intent: "negotiation", questions: [{ question: "Can you do it cheaper?", answered: true, evidence: "" }], claims: [], commitments: [{ commitment: "20% off", evidence: "" }], missing: "", escalate: "" }));
  const [negotiation] = await db.select().from(schema.ownerDecisions).where(and(eq(schema.ownerDecisions.draftId, discount.draft!.id), sql`${schema.ownerDecisions.kind} <> 'interested'`));
  check("an invented discount is never sent; the owner decides", !discountOutcome.sent && negotiation?.kind === "negotiation", `${negotiation?.kind}: ${negotiation?.reason}`);

  // ------------------------------------------------------------ opt-outs
  const optOut = await reply(P[4]!, "Please stop emailing me.", "Understood, sorry for the trouble. — Ravi");
  const optOutcome = await run(optOut.draft!, async () => ({ intent: "opt_out", questions: [], claims: [], commitments: [], missing: "", escalate: "" }));
  const [optLead] = await db.select().from(schema.outreachRunLeads).where(and(eq(schema.outreachRunLeads.runId, autoRun!.id), eq(schema.outreachRunLeads.personId, P[4]!)));
  const [suppressed] = await db.select().from(outreachSchema.suppressionList).where(and(eq(outreachSchema.suppressionList.organizationId, orgId), eq(outreachSchema.suppressionList.email, persons[4]!.email!)));
  const [campaignLead] = await db.select().from(outreachSchema.outreachLeads).where(and(eq(outreachSchema.outreachLeads.campaignId, campaign.id), eq(outreachSchema.outreachLeads.personId, P[4]!)));
  check("an opt-out stops everything: Do Not Contact, run lead opted out, address suppressed, campaign enrollment stopped",
    !optOutcome.sent && await isPersonDoNotContact(db, P[4]!) && optLead?.status === "opted_out" && Boolean(suppressed) && ["suppressed", "reply_received"].includes(campaignLead?.sequenceStatus ?? ""),
    `${optLead?.status} ${campaignLead?.sequenceStatus} ${Boolean(suppressed)}`);
  const dncByPerson = await reply(P[5]!, "Remove me from your list.", "", { category: "dnc" });
  const [dncLead] = await db.select().from(schema.outreachRunLeads).where(and(eq(schema.outreachRunLeads.runId, autoRun!.id), eq(schema.outreachRunLeads.personId, P[5]!)));
  check("a person confirming 'Do Not Contact' in the CRM also stops the run lead", Boolean(dncByPerson) && await isPersonDoNotContact(db, P[5]!) && dncLead?.status === "opted_out");

  // ------------------------------------------------------------ pause, resume
  await buildMailboxQueues({ organizationIds: [orgId] });
  const paused = await setRunPaused(autoRun!.id, true);
  const pending = await reply(P[6]!, "How much is the plan?", answer);
  const pausedOutcome = await run(pending.draft!);
  check("pause holds queued automatic replies and the campaign", paused.status === "paused" && !pausedOutcome.sent && /paused/.test(pausedOutcome.reason ?? ""), `${paused.status} ${pausedOutcome.reason}`);
  const resumed = await setRunPaused(autoRun!.id, false);
  const [requeued] = await db.select().from(crm.crmJobs).where(and(eq(crm.crmJobs.organizationId, orgId), eq(crm.crmJobs.kind, "auto_send"), eq(crm.crmJobs.entityId, pending.draft!.id), eq(crm.crmJobs.status, "queued")));
  check("resume re-checks the launch rules and queues held replies again", resumed.status === "running" && Boolean(requeued), JSON.stringify(resumed.problems));

  // ------------------------------------------------------------ outdated replies never send
  const edited = await updateDraft({ draftId: pending.draft!.id, revision: pending.draft!.revision, bodyText: "Edited by the owner." });
  const editedOutcome = await runAutopilotForDraft(pending.draft!.id, { revision: edited.revision, check: supportedCheck, allowNonProduction: true });
  check("an edited draft waits for the owner", !editedOutcome.sent && /edited/.test(editedOutcome.reason ?? ""), editedOutcome.reason ?? "");
  const queuedOld = await runAutopilotForDraft(pending.draft!.id, { revision: pending.draft!.revision, check: supportedCheck, allowNonProduction: true });
  check("a job queued for an older revision does nothing", !queuedOld.sent, queuedOld.reason ?? "");
  const taken = await reply(P[7]!, "How much is the plan?", answer);
  await takeOverConversation(taken.conversationId, input.ownerId);
  const takenOutcome = await run(taken.draft!);
  check("human takeover keeps the autopilot out of the conversation", !takenOutcome.sent && /yourself/.test(takenOutcome.reason ?? ""), takenOutcome.reason ?? "");
  const first = await reply(P[8]!, "How much is the plan?", answer, { thread: "newer" });
  await ingestInboundReply({ personId: P[8]!, channel: "email", accountRef: mailboxAddress, providerThreadId: `auto-newer-${stamp}`, idempotencyKey: `auto-newer2-${stamp}`, providerMessageId: `auto-newer2-pm-${stamp}`, subject: "Re: Chair servicing", bodyText: "Actually, also, do you do weekends?", sentAt: new Date() });
  const newerOutcome = await run(first.draft!);
  check("a newer message makes the queued reply outdated", !newerOutcome.sent, newerOutcome.reason ?? "");
  const production = await reply(P[9]!, "How much is the plan?", answer);
  const productionOutcome = await run(production.draft!, supportedCheck, false);
  check("outside production the autopilot never sends", !productionOutcome.sent && /production/.test(productionOutcome.reason ?? ""), productionOutcome.reason ?? "");

  // ------------------------------------------------------------ the 24-hour limit under concurrent jobs
  const fill = 40 - Number((await db.select({ n: count() }).from(schema.autopilotReplies).where(and(eq(schema.autopilotReplies.organizationId, orgId), inArray(schema.autopilotReplies.status, ["reserved", "sent", "failed"]))))[0]?.n ?? 0) - 2;
  const fillers = await db.insert(schema.autopilotReplies).values(Array.from({ length: fill }, () => ({
    organizationId: orgId, draftId: crypto.randomUUID(), revision: 1, conversationId: crypto.randomUUID(), status: "sent" as const, reason: "limit-check filler",
  }))).returning({ id: schema.autopilotReplies.id });
  const concurrent = [];
  for (const personId of P.slice(10, 15)) concurrent.push(await reply(personId, "How much is the plan?", answer));
  const beforeConcurrent = sent();
  const outcomes = await Promise.all(concurrent.map((item) => run(item.draft!)));
  const sentCount = outcomes.filter((outcome) => outcome.sent).length;
  check("five concurrent jobs with room for two: exactly two send, the rest are held by the limit",
    sentCount === 2 && sent() === beforeConcurrent + 2 && outcomes.filter((o) => /24 hours/.test(o.reason ?? "")).length === 3,
    outcomes.map((o) => o.sent ? "sent" : o.reason).join(" | "));
  await db.delete(schema.autopilotReplies).where(inArray(schema.autopilotReplies.id, fillers.map((row) => row.id)));

  // ------------------------------------------------------------ a campaign send, for the figures
  const extra = await db.insert(people).values([1, 2].map((index) => ({ organizationId: orgId, email: `fresh${index}-${stamp}@clinic-auto.test`, fullName: `Dr Fresh ${index}`, source: "assistant-automation-check" }))).returning({ id: people.id });
  await db.insert(schema.outreachRunLeads).values(extra.map((person) => ({ organizationId: orgId, runId: autoRun!.id, personId: person.id, channel: "email" as const })));
  await addPeopleToEmailCampaign(campaign.id, extra.map((person) => person.id));
  const otherQueues = await db.select({ n: sql<number>`count(*)::int` }).from(outreachSchema.outreachMailboxQueue)
    .innerJoin(outreachSchema.mailboxes, eq(outreachSchema.outreachMailboxQueue.mailboxId, outreachSchema.mailboxes.id))
    .where(sql`${outreachSchema.mailboxes.organizationId} <> ${orgId}`);
  if (Number(otherQueues[0]?.n ?? 0) === 0) {
    await db.update(outreachSchema.mailboxes).set({ nextEmailTime: null }).where(eq(outreachSchema.mailboxes.organizationId, orgId));
    await buildMailboxQueues({ organizationIds: [orgId] });
    await runSchedulerTick();
  } else {
    console.log("NOTE  another organization has queued emails; the campaign send tick is skipped");
  }

  // ------------------------------------------------------------ restart recovery
  const search = await runTool("find_leads", { what: "dental clinics", where: "Baner, Pune" }, { threadId: thread.id, userId: input.ownerId, ownerText: "" });
  const jobId = (search.data as { jobId: string }).jobId;
  await db.update(schema.assistantJobs).set({ runAfter: new Date(Date.now() - 1_000) }).where(eq(schema.assistantJobs.id, jobId));
  await runOneAssistantStep();
  await db.update(schema.assistantJobs).set({ status: "running", lockedBy: "worker-that-crashed", heartbeatAt: new Date(Date.now() - 10 * 60_000), runAfter: new Date(Date.now() - 1_000) }).where(eq(schema.assistantJobs.id, jobId));
  let recovered = null;
  for (let step = 0; step < 30; step += 1) {
    [recovered] = await db.select().from(schema.assistantJobs).where(eq(schema.assistantJobs.id, jobId));
    if (recovered?.status === "succeeded" || recovered?.status === "failed") break;
    await db.update(schema.assistantJobs).set({ runAfter: new Date(Date.now() - 1_000) }).where(and(eq(schema.assistantJobs.id, jobId), eq(schema.assistantJobs.status, "queued")));
    await runOneAssistantStep();
  }
  check("a job left by a crashed worker is taken over and finished after a restart", recovered?.status === "succeeded" && recovered.lockedBy !== "worker-that-crashed", `${recovered?.status} ${recovered?.lockedBy}`);

  // ------------------------------------------------------------ the unsolicited-plan guard
  const unasked = await runTool("prepare_outreach", { audienceId }, { threadId: thread.id, userId: input.ownerId, ownerText: "We sell maintenance plans for dental chairs." });
  const notARequest = await runTool("prepare_outreach", { audienceId, ownerRequest: "We sell maintenance plans" }, { threadId: thread.id, userId: input.ownerId, ownerText: "We sell maintenance plans for dental chairs." });
  const invented = await runTool("prepare_outreach", { audienceId, ownerRequest: "email all of them" }, { threadId: thread.id, userId: input.ownerId, ownerText: "We sell maintenance plans for dental chairs." });
  const searchContact = await runTool("find_leads", { what: "dental clinics", where: "Pune", contactAfter: true }, { threadId: thread.id, userId: input.ownerId, ownerText: "What can you do?" });
  const [plans] = await db.select({ n: count() }).from(schema.outreachRuns).where(and(eq(schema.outreachRuns.organizationId, orgId), eq(schema.outreachRuns.status, "proposed")));
  check("no outreach plan without the owner asking: no quote, a non-request, an invented quote and a contact-search are refused",
    !unasked.ok && !notARequest.ok && !invented.ok && !searchContact.ok && Number(plans?.n ?? 0) === 0,
    [unasked.summary, notARequest.summary, invented.summary, searchContact.summary].join(" | ").slice(0, 400));

  // ------------------------------------------------------------ results against recorded events
  const today = await results("today");
  const [autoSends] = await db.select({ n: count() }).from(crm.crmSendAttempts)
    .innerJoin(crm.crmDrafts, eq(crm.crmDrafts.id, crm.crmSendAttempts.draftId))
    .innerJoin(crm.crmRecords, eq(crm.crmRecords.id, crm.crmDrafts.crmRecordId))
    .where(and(eq(crm.crmRecords.organizationId, orgId), like(crm.crmSendAttempts.idempotencyKey, "autopilot:%"), inArray(crm.crmSendAttempts.status, ["sent", "reconciled"])));
  const [inboundCount] = await db.select({ n: count() }).from(crm.crmConversationMessages)
    .innerJoin(crm.crmConversations, eq(crm.crmConversations.id, crm.crmConversationMessages.conversationId))
    .where(and(eq(crm.crmConversations.organizationId, orgId), eq(crm.crmConversationMessages.direction, "inbound")));
  const [emailCount] = await db.select({ n: count() }).from(outreachSchema.outreachEmails)
    .innerJoin(outreachSchema.outreachLeads, eq(outreachSchema.outreachLeads.id, outreachSchema.outreachEmails.leadId))
    .where(and(eq(outreachSchema.outreachLeads.campaignId, campaign.id), eq(outreachSchema.outreachEmails.status, "sent")));
  const openDecisions = await listOpenDecisions(100);
  check("results match the recorded events: automatic replies, replies received, emails sent, decisions, opt-outs",
    today.outreach.automaticReplies === Number(autoSends?.n ?? 0)
      && today.outreach.repliesReceived === Number(inboundCount?.n ?? 0)
      && today.outreach.emailsSent === Number(emailCount?.n ?? 0)
      && today.attention.openDecisions === openDecisions.length
      && today.stopped.optedOut === 2
      && today.limits.automaticRepliesLeft24h === 40 - Number(autoSends?.n ?? 0),
    JSON.stringify({ auto: [today.outreach.automaticReplies, autoSends?.n], inbound: [today.outreach.repliesReceived, inboundCount?.n], emails: [today.outreach.emailsSent, emailCount?.n], decisions: [today.attention.openDecisions, openDecisions.length], optedOut: today.stopped.optedOut }));
  check("people contacted stay counted after they opt out (counted from send records)", today.outreach.peopleContacted >= (Number(emailCount?.n ?? 0) > 0 ? 1 : 0));
  check("WhatsApp new chats left is shown as not measured, not as a number", today.limits.whatsappNewChatsLeftToday === null);

  // ------------------------------------------------------------ stop
  const stopped = await stopRun(autoRun!.id);
  const afterStop = await reply(P[15]!, "How much is the plan?", answer);
  const stoppedOutcome = await run(afterStop.draft!);
  const [stoppedCampaign] = await db.select().from(outreachSchema.outreachCampaigns).where(eq(outreachSchema.outreachCampaigns.id, campaign.id));
  const [activeLeft] = await db.select({ n: count() }).from(schema.outreachRunLeads).where(and(eq(schema.outreachRunLeads.runId, autoRun!.id), eq(schema.outreachRunLeads.status, "active")));
  check("stop ends the run: campaign completed, leads stopped, no automatic reply afterwards",
    stopped.stopped.includes("email") && stoppedCampaign?.status === "completed" && Number(activeLeft?.n ?? 0) === 0 && !stoppedOutcome.sent,
    `${stoppedCampaign?.status} ${activeLeft?.n} ${stoppedOutcome.reason}`);

  // ------------------------------------------------------------ the daily summary
  const day = await writeDailySummary(new Date(Date.now() + 24 * 3_600_000));
  const twice = await writeDailySummary(new Date(Date.now() + 24 * 3_600_000));
  const [summaryRow] = await db.select().from(schema.dailySummaries).where(eq(schema.dailySummaries.organizationId, orgId));
  const summaryCard = (await listMessages(thread.id)).some((message) => message.tool === "daily_summary");
  check("the daily summary is written once per day in the business's time zone and shown in the chat", Boolean(day) && twice === null && summaryRow?.day === day && summaryCard, `${day} ${summaryRow?.timeZone}`);

  // Leave nothing queued that a later step could pick up.
  await db.delete(crm.crmJobs).where(and(eq(crm.crmJobs.organizationId, orgId), eq(crm.crmJobs.status, "queued")));
  return { threadId: thread.id, missingDecisionId: missing!.id, supportedDraftId: supported.draft!.id };
}

/** Run outside the first organization's scope: a second organization must see and change none of it. */
export async function runIsolationChecks(input: { check: Check; stamp: number; missingDecisionId: string; supportedDraftId: string }) {
  const { check, stamp } = input;
  const { db } = await import("@/lib/db");
  const { organizations } = await import("@/lib/auth/schema");
  const { runInOrganization } = await import("@/lib/tenancy/scope");
  const { runAutopilotForDraft } = await import("@/lib/assistant/autopilotRun.server");
  const { answerDecision, DecisionError, getDecision, listOpenDecisions } = await import("@/lib/assistant/decisions.server");
  const { results } = await import("@/lib/assistant/results.server");
  const supportedCheck = async (): Promise<ModelCheck> => ({ intent: "question", questions: [], claims: [], commitments: [], missing: "", escalate: "" });
  const [orgB] = await db.insert(organizations).values({ name: `Assistant isolation ${stamp}`, slug: `assistant-isolation-${stamp}` }).returning();
  await runInOrganization(orgB!.id, async () => {
    const theirs = await results("all_time");
    const decisionsB = await listOpenDecisions(10);
    const peek = await getDecision(input.missingDecisionId);
    const answerB = await answerDecision(input.missingDecisionId, "not mine", null).then(() => "answered", (error) => (error instanceof DecisionError ? "refused" : String(error)));
    const draftB = await runAutopilotForDraft(input.supportedDraftId, { check: supportedCheck, allowNonProduction: true });
    check("a second organization sees none of it: results, decisions, answers, drafts",
      theirs.outreach.automaticReplies === 0 && theirs.outreach.repliesReceived === 0 && theirs.leads.imported === 0 && decisionsB.length === 0 && peek === null && answerB === "refused" && !draftB.sent,
      JSON.stringify({ auto: theirs.outreach.automaticReplies, decisions: decisionsB.length, peek: Boolean(peek), answerB, draftB: draftB.reason }));
  });
}

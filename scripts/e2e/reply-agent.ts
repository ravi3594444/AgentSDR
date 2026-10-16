/**
 * The reply agent (src/lib/assistant/replyAgent/), end to end against the
 * local database: a lead's message goes through the CRM's classification
 * job, the agent's loop and the real CRM send path, with a stand-in model
 * and a recording send adapter (nothing leaves the machine).
 *
 *   bun run --conditions=react-server scripts/e2e/reply-agent.ts
 *   AI_SOURCE_ORGANIZATION_ID=<org with AI Settings> bun run --conditions=react-server scripts/e2e/reply-agent.ts
 *
 * What it proves: a greeting is answered (and is not "interested"), a
 * question answered from the business information, an invented price is
 * handed back to the agent and fixed in the next turn, a reply that stays
 * unbacked becomes an honest holding line and a card for the owner, a ready
 * lead gets an answer and a Needs you card, a stop request sets Do Not
 * Contact and sends nothing, an acknowledgement needs no answer, Review
 * mode only drafts, a retried job never answers twice, a newer message wins,
 * a chat the owner took over and a lead outside a running run stay with the
 * classifier, a model outage still answers, and the Replies list shows the
 * outcome with its time. With AI_SOURCE_ORGANIZATION_ID it also runs a few
 * messages through the real model and prints the answers and timings.
 *
 * Creates its own organization ("Reply agent check …") and leaves it behind.
 * Refuses a non-local DATABASE_URL.
 */
import { and, count, eq } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}

const stamp = Date.now();
const { db } = await import("@/lib/db");
const { organizations } = await import("@/lib/auth/schema");
const { people } = await import("@/lib/leads/schema");
const { mailboxes } = await import("@/lib/outreach/schema");
const crm = await import("@/lib/crm/schema");
const schema = await import("@/lib/assistant/schema");
const { runInOrganization, currentOrganizationId } = await import("@/lib/tenancy/scope");
const { ingestInboundReply } = await import("@/lib/crm/conversations");
const { handleClassificationJob } = await import("@/lib/crm/handlers");
const { ensureCrmDefaults } = await import("@/lib/crm/defaults");
const { isPersonDoNotContact } = await import("@/lib/crm/policies");
const { saveDocumentKnowledge, updateBusinessProfile } = await import("@/lib/assistant/profile.server");
const { createAudience } = await import("@/lib/assistant/audiences.server");
const { createThread } = await import("@/lib/assistant/threads.server");
const { takeOverConversation } = await import("@/lib/assistant/decisions.server");
const { runReplies } = await import("@/lib/assistant/runReplies.server");
const { runReplyAgent } = await import("@/lib/assistant/replyAgent/agent.server");
type AgentModel = import("@/lib/assistant/replyAgent/agent.server").AgentModel;
type CrmSendAdapter = import("@/lib/crm/send").CrmSendAdapter;
type CrmJob = import("@/lib/crm/queue").CrmJob;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const sends: { body: string; to: string | null }[] = [];
const send: CrmSendAdapter = async (input) => {
  sends.push({ body: input.bodyText, to: input.recipientEmail });
  return { provider: "unipile", providerMessageId: `agent-check-${stamp}-${sends.length}`, providerThreadId: null, rfcMessageId: null, response: {} };
};

/** The stand-in model: answers by the lead's latest message, and remembers every prompt it was given. */
const prompts: string[] = [];
type Scripted = { action: string; reply?: string; ownerNote?: { kind: string; note: string } | null; category?: string };
const script = new Map<string, (turn: number, prompt: string) => Scripted | Error>();
const model: AgentModel = async ({ userPrompt }) => {
  prompts.push(userPrompt);
  const latest = /LEAD'S LATEST MESSAGE:\n([\s\S]*?)(?=\n\nYOUR PREVIOUS ATTEMPT|$)/.exec(userPrompt)?.[1]?.trim() ?? "";
  const turn = /\(turn (\d+)\) WAS NOT SENT/.exec(userPrompt) ? Number(/\(turn (\d+)\)/.exec(userPrompt)![1]) + 1 : 1;
  const answer = script.get(latest)?.(turn, userPrompt) ?? { action: "reply", reply: "Thanks for your message! What made you reach out?" };
  if (answer instanceof Error) throw answer;
  const text = JSON.stringify({ reasoning: "stand-in", action: answer.action, reply: answer.reply ?? "", ownerNote: answer.ownerNote ?? null, category: answer.category ?? "other", confidence: 0.9 });
  return { text, provider: "stand-in", model: "stand-in-agent", request: {}, response: {} };
};
const deps = { model, send, allowNonProduction: true, brief: false };

const [org] = await db.insert(organizations).values({ name: `Reply agent check ${stamp}`, slug: `reply-agent-check-${stamp}` }).returning();
console.log(`Organization ${org!.name} (${org!.id})`);

await runInOrganization(org!.id, async () => {
  const orgId = currentOrganizationId();
  const mailboxAddress = `owner-${stamp}@mail.reply-agent-check.test`;
  await db.insert(mailboxes).values({ organizationId: orgId, emailAddress: mailboxAddress, provider: "unipile", unipileAccountId: `agent-check-${stamp}`, displayName: "Ravi from Bright Path", status: "connected" });
  await updateBusinessProfile({ businessName: "Bright Path Dental Supplies", offer: "Same-week servicing for dental chairs and autoclaves", senderName: "Ravi", targetCustomers: "dental clinics", locations: "Pune" }, null);
  await saveDocumentKnowledge("Price list", "Monthly maintenance plan: ₹2,499 per chair per month, includes two visits. Service area: Pune and Pimpri-Chinchwad.");
  await ensureCrmDefaults();

  const persons = await db.insert(people).values(Array.from({ length: 14 }, (_, index) => ({
    organizationId: orgId,
    email: `lead${index + 1}-${stamp}@clinic-agent.test`,
    fullName: `Dr Agent ${index + 1}`,
    source: "reply-agent-check",
  }))).returning({ id: people.id });
  const P = persons.map((person) => person.id);
  const audienceId = await createAudience({ name: "reply agent check", source: "list" });
  const thread = await createThread(null);
  const plan = { assignments: [], sequences: {}, personalizationKey: "p_00000000", samples: [], limits: { maxLeads: 20, emailPerMailboxPerDay: 30, whatsappNewChatsPerDay: null }, excluded: [], estimate: { aiCalls: 0, aiCostUsd: null, days: 1 }, autopilot: true, instructions: null };
  const [autoRun] = await db.insert(schema.outreachRuns).values({ organizationId: orgId, threadId: thread.id, audienceId, name: "Automatic run", status: "running", channels: ["email"], plan, autopilot: true, approvedAt: new Date(Date.now() - 60_000) }).returning();
  const [reviewRun] = await db.insert(schema.outreachRuns).values({ organizationId: orgId, threadId: thread.id, audienceId, name: "Review run", status: "running", channels: ["email"], plan: { ...plan, autopilot: false }, autopilot: false }).returning();
  await db.insert(schema.outreachRunLeads).values([
    ...P.slice(0, 12).map((personId) => ({ organizationId: orgId, runId: autoRun!.id, personId, channel: "email" as const })),
    { organizationId: orgId, runId: reviewRun!.id, personId: P[12]!, channel: "email" as const },
    // P[13] is in no run: the classifier handles it.
  ]);

  let n = 0;
  async function inbound(personId: string, body: string, key = `t${(n += 1)}`) {
    const result = await ingestInboundReply({
      personId,
      channel: "email",
      accountRef: mailboxAddress,
      providerThreadId: `agent-${key}-${stamp}`,
      idempotencyKey: `agent-in-${key}-${stamp}-${n}-${Math.random()}`,
      providerMessageId: `agent-pm-${key}-${stamp}-${Math.random()}`,
      subject: "Re: Chair servicing",
      bodyText: body,
      sentAt: new Date(),
    });
    return result.message;
  }
  async function classify(messageId: string) {
    const [job] = await db.select().from(crm.crmJobs).where(and(eq(crm.crmJobs.kind, "classification"), eq(crm.crmJobs.entityId, messageId))).limit(1);
    await handleClassificationJob(job as unknown as CrmJob, { replyAgent: deps });
  }
  const agentRow = async (messageId: string) => (await db.select().from(schema.replyAgentRuns).where(eq(schema.replyAgentRuns.messageId, messageId)).limit(1))[0] ?? null;
  const classification = async (messageId: string) => (await db.select().from(crm.crmClassifications).where(eq(crm.crmClassifications.messageId, messageId)).limit(1))[0] ?? null;
  const card = async (personId: string, kind: string) => (await db.select().from(schema.ownerDecisions)
    .where(and(eq(schema.ownerDecisions.organizationId, orgId), eq(schema.ownerDecisions.personId, personId), eq(schema.ownerDecisions.kind, kind as never))).limit(1))[0] ?? null;
  const initialDrafts = async (messageId: string) => Number((await db.select({ n: count() }).from(crm.crmJobs)
    .innerJoin(crm.crmClassifications, eq(crm.crmClassifications.id, crm.crmJobs.entityId))
    .where(and(eq(crm.crmJobs.kind, "initial_draft"), eq(crm.crmClassifications.messageId, messageId))))[0]?.n ?? 0);

  // ------------------------------------------------------------ a greeting
  let before = sends.length;
  const hey = await inbound(P[0]!, "Hey");
  script.set("Subject: Re: Chair servicing\nHey", () => ({ action: "reply", reply: "Hi! Thanks for getting back to me. How do you look after your dental chairs at the moment?", category: "other" }));
  await classify(hey.id);
  let row = await agentRow(hey.id);
  check("a greeting is answered by the agent, in one turn, through the send path", sends.length === before + 1 && row?.status === "replied" && row.turns.length === 1, `${row?.status} turns=${row?.turns.length}`);
  check("the greeting is not marked interested", (await classification(hey.id))?.proposedCategoryKey === "other");
  check("the classifier's draft job did not also run", (await initialDrafts(hey.id)) === 0);
  check("the time from the message to the answer is recorded", typeof row?.totalMs === "number" && row.totalMs >= 0, `${row?.totalMs} ms`);
  check("the agent saw the business information and the owner's next step", /₹2,499/.test(prompts.at(-1) ?? "") && /NEXT STEP TO OFFER/.test(prompts.at(-1) ?? ""));

  // ------------------------------------------------------------ retry: never twice
  before = sends.length;
  const again = await runReplyAgent(hey.id, deps);
  check("running the same message again sends nothing", sends.length === before && again?.status === "stopped", again?.reason ?? "");

  // ------------------------------------------------------------ a question from the business information
  before = sends.length;
  const price = await inbound(P[1]!, "How much is the maintenance plan?");
  script.set("Subject: Re: Chair servicing\nHow much is the maintenance plan?", () => ({ action: "reply", reply: "The monthly maintenance plan is ₹2,499 per chair and includes two visits. How many chairs do you have?", category: "interested" }));
  await classify(price.id);
  row = await agentRow(price.id);
  check("a price question is answered from the business information", sends.length === before + 1 && /₹2,499/.test(sends.at(-1)?.body ?? "") && row?.status === "replied");

  // ------------------------------------------------------------ an invented price is handed back and fixed
  before = sends.length;
  const discount = await inbound(P[2]!, "Any discount for 3 chairs?");
  script.set("Subject: Re: Chair servicing\nAny discount for 3 chairs?", (turn) => turn === 1
    ? { action: "reply", reply: "Yes! For 3 chairs it is just ₹1,999 each.", category: "interested" }
    : { action: "reply", reply: "The plan is ₹2,499 per chair; I'll ask Ravi about a price for three chairs and confirm.", ownerNote: { kind: "question", note: "asks for a discount for 3 chairs" }, category: "interested" });
  await classify(discount.id);
  row = await agentRow(discount.id);
  const feedbackPrompt = prompts.at(-1) ?? "";
  check("an invented price is not sent; the agent is told what to fix", /PROBLEMS TO FIX/.test(feedbackPrompt) && /1,999/.test(feedbackPrompt), feedbackPrompt.split("PROBLEMS TO FIX:")[1]?.trim().split("\n")[0] ?? "");
  check("its second turn goes out, and the owner gets the question", sends.length === before + 1 && !/1,999/.test(sends.at(-1)?.body ?? "") && row?.turns.length === 2 && Boolean(await card(P[2]!, "missing_info")), `turns=${row?.turns.length}`);

  // ------------------------------------------------------------ never backed: holding line + card
  before = sends.length;
  const stubborn = await inbound(P[3]!, "Can you come Saturday at 5pm?");
  script.set("Subject: Re: Chair servicing\nCan you come Saturday at 5pm?", () => ({ action: "reply", reply: "Sure, Saturday at 5pm works, see you then!", category: "interested" }));
  await classify(stubborn.id);
  row = await agentRow(stubborn.id);
  check("a reply still unbacked after three turns becomes an honest holding line", sends.length === before + 1 && /get back to you/.test(sends.at(-1)?.body ?? "") && row?.turns.length === 3, sends.at(-1)?.body ?? "");
  check("…and the owner gets a card for it", Boolean(await card(P[3]!, "missing_info")));

  // ------------------------------------------------------------ a ready lead
  before = sends.length;
  const ready = await inbound(P[4]!, "Yes, please send someone to look at our chairs");
  script.set("Subject: Re: Chair servicing\nYes, please send someone to look at our chairs", () => ({ action: "reply", reply: "Great, I have noted it and Ravi will get back to you personally to arrange the visit. Which area of Pune is your clinic in?", ownerNote: { kind: "ready", note: "wants a technician visit" }, category: "interested" }));
  await classify(ready.id);
  const readyCard = await card(P[4]!, "ready");
  check("a ready lead gets an answer and a Needs you card marked as told", sends.length === before + 1 && Boolean(readyCard) && Boolean(readyCard?.handoverSentAt), readyCard?.reason ?? "");

  // ------------------------------------------------------------ stop
  before = sends.length;
  const stop = await inbound(P[5]!, "Not interested, leave us alone");
  script.set("Subject: Re: Chair servicing\nNot interested, leave us alone", () => ({ action: "stop_contact", category: "not_interested" }));
  await classify(stop.id);
  check("a stop request sets Do Not Contact and sends nothing", sends.length === before && await isPersonDoNotContact(db, P[5]!) && (await agentRow(stop.id))?.status === "stopped");

  // ------------------------------------------------------------ an acknowledgement
  before = sends.length;
  const ok = await inbound(P[1]!, "ok thanks", "t2");
  script.set("Subject: Re: Chair servicing\nok thanks", () => ({ action: "no_reply", category: "other" }));
  await classify(ok.id);
  check("an acknowledgement after an answer needs no answer when the agent says so", sends.length === before && (await agentRow(ok.id))?.status === "no_reply");

  // ------------------------------------------------------------ Review mode
  before = sends.length;
  const reviewMessage = await inbound(P[12]!, "How much is the maintenance plan?");
  await classify(reviewMessage.id);
  row = await agentRow(reviewMessage.id);
  const [reviewDraft] = row?.draftId ? await db.select().from(crm.crmDrafts).where(eq(crm.crmDrafts.id, row.draftId)) : [];
  check("Review mode: the answer is written and waits, nothing is sent", sends.length === before && row?.status === "drafted" && reviewDraft?.status === "awaiting_review");

  // ------------------------------------------------------------ a newer message wins
  before = sends.length;
  const first = await inbound(P[6]!, "Hi", "t-newer");
  let second: { id: string } | null = null;
  script.set("Subject: Re: Chair servicing\nHi", () => ({ action: "reply", reply: "Hi! How can I help with your chairs?" }));
  const slowModel: AgentModel = async (input) => {
    // The lead writes again while the agent is still answering the first message.
    if (!second) second = await inbound(P[6]!, "Do you also service autoclaves?", "t-newer");
    return model(input);
  };
  const firstOutcome = await runReplyAgent(first.id, { ...deps, model: slowModel });
  check("a newer message arriving while answering stops the older answer", sends.length === before && firstOutcome?.status === "stopped" && /newer/.test(firstOutcome.reason ?? ""), firstOutcome?.reason ?? "");
  script.set("Subject: Re: Chair servicing\nDo you also service autoclaves?", () => ({ action: "reply", reply: "Yes, we service autoclaves as well as dental chairs, same week. How many do you have?" }));
  await classify(second!.id);
  check("…and the newer message is answered with the whole conversation", sends.length === before + 1 && /CONVERSATION SO FAR[\s\S]*LEAD: Hi/.test(prompts.at(-1) ?? ""));

  // ------------------------------------------------------------ the classifier keeps what is not the agent's
  const taken = await inbound(P[7]!, "Hello?");
  await takeOverConversation(taken.conversationId, null);
  check("a chat the owner took over is left to the classifier", (await runReplyAgent(taken.id, deps)) === null);
  const outsider = await inbound(P[13]!, "Hello?");
  check("a lead outside any running run is left to the classifier", (await runReplyAgent(outsider.id, deps)) === null);

  // ------------------------------------------------------------ the model is down
  before = sends.length;
  const outage = await inbound(P[8]!, "What areas do you cover?", "t-outage");
  script.set("Subject: Re: Chair servicing\nWhat areas do you cover?", () => new Error("simulated model outage"));
  await classify(outage.id);
  row = await agentRow(outage.id);
  check("when the model is down the lead still gets a holding line and the owner a card", sends.length === before + 1 && row?.status === "replied" && Boolean(await card(P[8]!, "uncertain")), row?.turns.map((turn) => turn.error).join(" | ") ?? "");

  before = sends.length;
  const outageAgain = await inbound(P[8]!, "Hello? Anyone there?", "t-outage");
  script.set("Subject: Re: Chair servicing\nHello? Anyone there?", () => new Error("simulated model outage"));
  const [outageConversation] = await db.select({ id: crm.crmConversationMessages.conversationId }).from(crm.crmConversationMessages).where(eq(crm.crmConversationMessages.id, outage.id));
  if (outageAgain.conversationId === outageConversation?.id) {
    await classify(outageAgain.id);
    check("the holding line is not repeated in the same chat while the model stays down", sends.length === before && (await agentRow(outageAgain.id))?.status === "told_owner");
  } else {
    check("the second outage message lands in the same chat", false, "different conversation");
  }

  // ------------------------------------------------------------ the Replies list
  const replies = (await runReplies([autoRun!.id], 20))[autoRun!.id] ?? [];
  const shown = replies.find((item) => item.id === price.id);
  check("the Replies list shows the agent's outcome with its time", Boolean(shown && /Answered automatically in \d/.test(shown.state.text)), shown?.state.text ?? "(missing)");
  const shownOk = replies.find((item) => item.id === ok.id);
  check("…and a message that needed no answer", Boolean(shownOk && /No answer needed/.test(shownOk.state.text)), shownOk?.state.text ?? "(missing)");

  // ------------------------------------------------------------ the real model (optional)
  const aiSource = process.env.AI_SOURCE_ORGANIZATION_ID?.trim();
  if (aiSource) {
    const { copyAiSettings } = await import("./copyAiSettings");
    await copyAiSettings(aiSource, orgId);
    // REPLY_AGENT_E2E_MODEL tries another model of the same connection (e.g. z-ai/glm-5.3-flash).
    const override = process.env.REPLY_AGENT_E2E_MODEL?.trim();
    if (override) {
      const { gridProviders } = await import("@/lib/grid/schema");
      const [settings] = await db.select().from(gridProviders).where(and(eq(gridProviders.organizationId, orgId), eq(gridProviders.key, "openrouter-byok-settings")));
      const config = settings!.config as { defaultModel: { modelId: string; provider: string }; modelsByProvider?: Record<string, string[]> };
      const provider = config.defaultModel.provider;
      await db.update(gridProviders).set({ config: { ...config, defaultModel: { modelId: override, provider }, modelsByProvider: { ...config.modelsByProvider, [provider]: [...new Set([...(config.modelsByProvider?.[provider] ?? []), override])] } } })
        .where(eq(gridProviders.id, settings!.id));
      console.log(`Model for the real run: ${override}`);
    }
    const messages = ["Hey", "How much is the maintenance plan?", "Can you give a discount for 5 chairs?", "Ok, send someone tomorrow", "ok thanks", "Mujhe price batao"];
    for (const [index, text] of messages.entries()) {
      before = sends.length;
      const message = await inbound(P[9 + (index % 3)]!, text, `real-${index % 3}`);
      const started = Date.now();
      const outcome = await runReplyAgent(message.id, { send, allowNonProduction: true, brief: false });
      const agent = await agentRow(message.id);
      console.log(`REAL  "${text}" → ${outcome?.status} in ${Date.now() - started} ms (turns ${agent?.turns.map((turn) => `${turn.ms}ms${turn.problems.length ? " fixed" : ""}${turn.error ? " error" : ""}`).join(", ")}; model ${agent?.model})`);
      console.log(`      ${sends.length > before ? `sent: ${sends.at(-1)?.body.replace(/\s+/g, " ")}` : `nothing sent: ${outcome?.reason ?? ""}`}`);
      check(`real model: "${text}" gets a decision`, Boolean(outcome && outcome.status !== "failed"), outcome?.reason ?? "");
    }
  }
});

console.log(failures ? `\n${failures} check(s) failed` : "\nAll reply agent checks passed");
process.exit(failures ? 1 : 0);

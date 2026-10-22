/**
 * Research agent v2's guard rails (src/lib/assistant/agentV2*.ts, brief.ts),
 * end to end against the local database through the real tools, with no
 * model choosing anything: each tool is called as the model would call it.
 * Stand-ins: the plan writer (the structured-completion module answers its
 * schemas with fixed text) and the platform connection check. Nothing is
 * sent: plans are prepared and wait for Start.
 *
 * - the brief may not raise a limit the owner did not write; a valid one
 *   becomes the request's objective, its goal the request text;
 * - a search before the brief is refused;
 * - review_leads shows the request's leads with their verdicts;
 * - set_lead_fit refuses a match whose quote no page or profile holds, and
 *   takes one whose quote a page read in the chat holds;
 * - prepare_outreach builds one plan from matching leads only, up to the
 *   brief's target, on the brief's channels only; research-only refuses;
 * - in Autonomous mode a plan needs the owner's own words asking to contact;
 * - finish_request ends the request as finished;
 * - a second organization sees and changes nothing of the first.
 *
 *   bun run --conditions=react-server scripts/e2e/research-agent-v2.ts
 *
 * Creates its own organizations ("Research v2 check …") and leaves them.
 * Refuses a non-local DATABASE_URL.
 */
import { mock } from "bun:test";
import { join } from "node:path";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}
const root = join(import.meta.dir, "..", "..");
const stamp = Date.now();
// A search can be started (its job is recorded); nothing runs it here, so the scraper is never called.
process.env.GMAPS_SCRAPER_URL = "http://scraper.research-v2-check.test";
process.env.GEOCODER_URL = "off";

// ------------------------------------------------------------ stand-ins
type Input = { userPrompt: string; systemPrompt?: string; schemaName?: string; accept: (text: string) => void };
const writerCalls: string[] = [];
// The chat model's answers, in order, for the turn checked below.
const chatAnswers: string[] = [];
mock.module(join(root, "src/lib/ai/server/structuredCompletion.ts"), () => ({
  completeStructured: async (input: Input) => {
    writerCalls.push(input.schemaName ?? "?");
    let text: string;
    if (input.schemaName === "assistant_reply" && chatAnswers.length) {
      text = chatAnswers.shift()!;
    } else if (input.schemaName === "outreach_sequences") {
      const key = `${input.systemPrompt ?? ""}\n${input.userPrompt}`.match(/\{\{(p_[0-9a-f]+)\}\}/)?.[1];
      const line = key ? `{{${key}}}\n` : "";
      text = JSON.stringify({ channels: [{ channel: "email", messages: [{ subject: "Fewer no-shows", body: `Hi there,\n${line}Do missed appointments cost you bookings? We send reminders. Worth a look?\nRavi`, waitDays: 0 }] }] });
    } else if (input.schemaName === "first_message_review") {
      text = JSON.stringify({ messages: [{ channel: "email", wouldReply: 4, reasons: [] }] });
    } else if (input.schemaName === "opening_lines") {
      text = JSON.stringify({ lines: [...input.userPrompt.matchAll(/^(\d+)(?: \([^)]*\))?: \{/gm)].map((match) => ({ index: Number(match[1]), line: "" })) });
    } else if (input.schemaName === "personal_messages") {
      text = JSON.stringify({ messages: [] });
    } else {
      throw new Error(`unexpected model call ${input.schemaName}`);
    }
    input.accept(text);
    return { text, model: "fixture", provider: "fixture", request: {}, response: {}, usage: {}, attempts: 1 };
  },
}));
const credentials = await import(join(root, "src/lib/platform/credentials.ts"));
mock.module(join(root, "src/lib/platform/credentials.ts"), () => ({ ...credentials, isPlatformConnected: async () => true }));

const { and, eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/lib/db");
const { organizations, users, members } = await import("@/lib/auth/schema");
const { people } = await import("@/lib/leads/schema");
const { mailboxes } = await import("@/lib/outreach/schema");
const { assistantJobs, assistantMessages, leadAudienceMembers, outreachRuns } = await import("@/lib/assistant/schema");
const { setFeature, clearFeatureCache } = await import("@/lib/features/flags.server");
const { runInOrganization } = await import("@/lib/tenancy/scope");
const { updateBusinessProfile } = await import("@/lib/assistant/profile.server");
const { addMessage, createThread } = await import("@/lib/assistant/threads.server");
const { addAudienceMembers, createAudience } = await import("@/lib/assistant/audiences.server");
const { runTool } = await import("@/lib/assistant/tools.server");
const { getObjective, objectiveForRequest, objectiveJudgeRequest, objectiveRequest, saveObjectiveProgress } = await import("@/lib/assistant/objective.server");
const { runOneAssistantStep } = await import("@/lib/assistant/worker");
const { runAgentTurn } = await import("@/lib/assistant/agent.server");
const { registerAssistantJobs } = await import("@/lib/assistant/register.server");
registerAssistantJobs();
type Progress = import("@/lib/assistant/schema").ObjectiveProgress;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

async function organization(label: string) {
  const [org] = await db.insert(organizations).values({ name: `Research v2 check ${label} ${stamp}`, slug: `research-v2-${label}-${stamp}` }).returning();
  const [owner] = await db.insert(users).values({ name: `Owner ${label}`, email: `owner-${label}-${stamp}@research-v2.test`, emailVerified: true }).returning();
  await db.insert(members).values({ organizationId: org!.id, userId: owner!.id, role: "owner" });
  return { org: org!, owner: owner! };
}

const a = await organization("a");
const b = await organization("b");

type Context = Parameters<typeof runTool>[2];
let shared: { threadId: string; requestId: string; personIds: Record<string, string> } | null = null;

await runInOrganization(a.org.id, async () => {
  clearFeatureCache();
  await setFeature("research_agent_v2", true, a.owner.id);
  clearFeatureCache();
  await updateBusinessProfile({ businessName: "ChairFill", offer: "Appointment reminders that cut no-shows for dental clinics", targetCustomers: "dental clinics", senderName: "Ravi" }, a.owner.id);
  await db.insert(mailboxes).values({ organizationId: a.org.id, emailAddress: `ravi-${stamp}@sender.research-v2.test`, provider: "unipile", unipileAccountId: `mail-${stamp}`, displayName: "Ravi", status: "connected" });

  const thread = await createThread(a.owner.id);
  const request = await addMessage({ threadId: thread.id, role: "user", content: "Find 2 dentists in Austin and email them. Use only free tools.", createdBy: a.owner.id });
  const context: Context = { threadId: thread.id, userId: a.owner.id, ownerText: request.content, requestMessageId: request.id, searchRequestId: request.id, v2: true, autonomous: false };
  const brief = { goal: "Find 2 dentists in Austin and email them, free tools only", contact: true, channels: ["email"], spendCapUsd: 0, timeLimitMinutes: null, done: "2 Austin dentists found and an email plan ready" };

  // ---------------------------------------------------------- the brief
  const beforeBrief = await runTool("find_leads", { what: "dentists", where: "Austin, TX" }, context);
  const started = await objectiveForRequest(request.id);
  check("a search before the brief starts the request with the defaults (no brief needed first)", beforeBrief.ok && Boolean(started) && !started!.controls.brief, beforeBrief.summary);
  const paid = await runTool("set_brief", { ...brief, leadTarget: 2, spendCapUsd: 20 }, context);
  check("a brief may not raise the spend cap past what the owner wrote", !paid.ok && /did not allow \$20/.test(paid.summary), paid.summary);
  const many = await runTool("set_brief", { ...brief, leadTarget: 40 }, context);
  check("…but the lead target is the assistant's to set", many.ok && (await objectiveForRequest(request.id))?.leadTarget === 40, many.summary);
  const saved = await runTool("set_brief", { ...brief, leadTarget: 2 }, context);
  const objective = await objectiveForRequest(request.id);
  check("a valid brief becomes the request's objective, with the owner's limits", saved.ok && objective?.leadTarget === 2 && objective.spendCapUsd === 0 && objective.controls.named?.target === true, saved.summary);
  check("…and its goal is the request text the judge and the plan read", objective ? (await objectiveRequest(objective)) === brief.goal : false);

  // ---------------------------------------------------------- the request's leads, as a finished search left them
  const audienceId = await createAudience({ name: "dentists in Austin", source: "discovery", threadId: thread.id, userId: a.owner.id });
  const rows = await db.insert(people).values(["Barton Creek Dental", "Austin Dental Supply", "Zilker Smiles", "Hyde Park Dental"].map((name, index) => ({
    organizationId: a.org.id, fullName: name, email: `front${index}-${stamp}@research-v2.test`, source: "research-v2-check",
  }))).returning();
  const personIds = Object.fromEntries(rows.map((row) => [row.fullName, row.id])) as Record<string, string>;
  await addAudienceMembers(audienceId, rows.map((row) => ({ personId: row.id, source: "discovery", facts: { businessName: row.fullName ?? "", city: row.fullName === "Zilker Smiles" ? "" : "Austin" } })));
  const fits: Record<string, ["match" | "no_match" | "unconfirmed", string]> = {
    "Barton Creek Dental": ["match", "An Austin dentist."],
    "Austin Dental Supply": ["no_match", "A dental supply store, not a dentist."],
    "Zilker Smiles": ["unconfirmed", "The place is not shown."],
    "Hyde Park Dental": ["match", "An Austin dentist."],
  };
  for (const [name, [fit, reason]] of Object.entries(fits)) {
    await db.update(leadAudienceMembers).set({ fit, fitReason: reason, fitApproach: fit === "no_match" ? "skip" : "standard", fitGroup: "Dentists", fitRequestId: request.id, fitAt: new Date() })
      .where(and(eq(leadAudienceMembers.audienceId, audienceId), eq(leadAudienceMembers.personId, personIds[name]!)));
  }
  await db.insert(assistantJobs).values({ organizationId: a.org.id, kind: "discovery", stage: "done", status: "succeeded", threadId: thread.id, audienceId, payload: { requestMessageId: request.id, phrase: "dentists in Austin, TX" }, result: { found: 4, eligible: 4 }, progress: { stage: "done" } });

  const review = await runTool("review_leads", {}, context);
  check("review_leads shows each lead with its verdict", review.ok && /2 match, 1 unconfirmed, 1 no match/.test(review.summary) && review.summary.includes("Zilker Smiles"), review.summary.split("\n")[0]);

  // ---------------------------------------------------------- correcting a verdict needs words that were read
  const unbacked = await runTool("set_lead_fit", { personId: personIds["Zilker Smiles"], fit: "match", reason: "An Austin dentist", quote: "Zilker Smiles, family dentistry in Austin, TX" }, context);
  check("a match whose quote no page or profile holds is refused", !unbacked.ok && /not in any page read/.test(unbacked.summary), unbacked.summary);
  await addMessage({ threadId: thread.id, role: "tool", tool: "read_webpage", toolInput: { url: "https://zilkersmiles.example/" }, status: "ok", content: "Read https://zilkersmiles.example/ “Zilker Smiles” (80 characters). Text: Zilker Smiles, family dentistry in Austin, TX &amp; nearby.", toolResult: { summary: "Read https://zilkersmiles.example/ “Zilker Smiles”. Text: Zilker Smiles, family dentistry in Austin, TX &amp; nearby." } });
  const backed = await runTool("set_lead_fit", { personId: personIds["Zilker Smiles"], fit: "match", reason: "Its own site says Austin", quote: "Zilker Smiles, family dentistry in Austin, TX & nearby", url: "https://zilkersmiles.example/" }, context);
  check("…a quote a page read in the chat holds is taken (entities as read)", backed.ok, backed.summary);

  // ---------------------------------------------------------- one plan, matching leads only, the brief's channels and target
  const plan = await runTool("prepare_outreach", {}, context);
  const runId = typeof plan.data?.runId === "string" ? plan.data.runId : null;
  const [run] = runId ? await db.select().from(outreachRuns).where(eq(outreachRuns.id, runId)) : [];
  const assigned = ((run?.plan ?? {}) as { assignments?: { personId: string; channel: string }[] }).assignments ?? [];
  const names = assigned.map((item) => Object.entries(personIds).find(([, id]) => id === item.personId)?.[0]).sort();
  check("prepare_outreach makes one plan of matching leads only, up to the brief's target, on email only", plan.ok && assigned.length === 2 && assigned.every((item) => item.channel === "email") && !names.includes("Austin Dental Supply"), `${plan.summary.slice(0, 160)} | ${names.join(", ")}`);
  check("…and nothing is sent: the plan waits for Start", run?.status === "proposed", run?.status ?? "no run");

  // ---------------------------------------------------------- the request's last turn (the driver found no source left)
  await saveObjectiveProgress(objective!.id, { continuation: { n: 3, attempt: 1, startedAt: new Date().toISOString(), endedAt: null, end: null, leadsAtStart: 2, judged: null, final: "sources_exhausted", finalDetail: "the assistant found no further source or query worth searching" } });
  const lastSearch = await runTool("find_leads", { what: "dentists", where: "Round Rock, TX" }, context);
  check("in a request's last turn no search starts", !lastSearch.ok && /this request is ending/.test(lastSearch.summary), lastSearch.summary);

  // ---------------------------------------------------------- research only, Autonomous mode
  const research = await addMessage({ threadId: thread.id, role: "user", content: "Now just research 3 orthodontists in Austin. No outreach.", createdBy: a.owner.id });
  const researchContext: Context = { ...context, ownerText: research.content, requestMessageId: research.id, searchRequestId: research.id };
  await runTool("set_brief", { goal: "Research 3 orthodontists in Austin, no outreach", leadTarget: 3, contact: false, channels: null, spendCapUsd: null, timeLimitMinutes: null, done: "3 orthodontists found", newRequest: true }, researchContext);
  const refused = await runTool("prepare_outreach", {}, researchContext);
  check("a research-only brief does not refuse a plan the assistant prepares (nothing is sent before Start)", !/research only/.test(refused.summary), refused.summary);
  check("…and the earlier request ended as finished when the new one began", (await getObjective(objective!.id))?.stopReason === "finished");

  const thread2 = await createThread(a.owner.id);
  const vague = await addMessage({ threadId: thread2.id, role: "user", content: "Look into dentists in Austin for me.", createdBy: a.owner.id });
  const autoContext: Context = { threadId: thread2.id, userId: a.owner.id, ownerText: vague.content, requestMessageId: vague.id, searchRequestId: vague.id, v2: true, autonomous: true };
  await runTool("set_brief", { goal: "Dentists in Austin", leadTarget: null, contact: true, channels: null, spendCapUsd: null, timeLimitMinutes: null, done: "dentists found" }, autoContext);
  const autonomous = await runTool("prepare_outreach", {}, autoContext);
  check("in Autonomous mode a plan needs the owner's own words asking to contact, whatever the brief says", !autonomous.ok, autonomous.summary);

  // ---------------------------------------------------------- finishing
  const finished = await runTool("finish_request", { summary: "Found 3 orthodontists in Austin." }, researchContext);
  const researchObjective = await objectiveForRequest(research.id);
  check("finish_request ends the request as finished, with the assistant's words", finished.ok && researchObjective?.stopReason === "finished" && researchObjective.stopDetail === "Found 3 orthodontists in Austin", `${researchObjective?.stopReason}: ${researchObjective?.stopDetail}`);

  // ---------------------------------------------------------- the driver: an idle turn gets the request's last turn, then it stops
  const thread3 = await createThread(a.owner.id);
  const salons = await addMessage({ threadId: thread3.id, role: "user", content: "Find 3 hair salons and email them", createdBy: a.owner.id });
  const salonContext: Context = { threadId: thread3.id, userId: a.owner.id, ownerText: salons.content, requestMessageId: salons.id, searchRequestId: salons.id, v2: true, autonomous: false };
  await runTool("set_brief", { goal: "Find 3 hair salons and email them", leadTarget: 3, contact: true, channels: ["email"], spendCapUsd: 0, timeLimitMinutes: null, done: "3 salons found and an email plan ready" }, salonContext);
  // The owner's answer comes after the brief, which is never updated (eval c6).
  await addMessage({ threadId: thread3.id, role: "user", content: "Dallas.", createdBy: a.owner.id });
  const salonObjective = (await objectiveForRequest(salons.id))!;
  check("the judge reads the owner's answer beside a brief written before it", /\(2\) Dallas\./.test(await objectiveJudgeRequest(salonObjective)), await objectiveJudgeRequest(salonObjective));
  const [driver] = await db.select().from(assistantJobs).where(and(eq(assistantJobs.kind, "objective"), sql`${assistantJobs.payload} ->> 'objectiveId' = ${salonObjective.id}`));
  const drive = async () => {
    await db.update(assistantJobs).set({ runAfter: new Date(Date.now() - 1_000) }).where(and(eq(assistantJobs.id, driver!.id), eq(assistantJobs.status, "queued")));
    await runOneAssistantStep({ jobId: driver!.id });
  };
  const ago = new Date(Date.now() - 60_000).toISOString();
  await saveObjectiveProgress(salonObjective.id, { continuation: { n: 1, attempt: 1, startedAt: ago, endedAt: ago, end: "done", leadsAtStart: 0, judged: null } });
  await drive();
  const lastTurn = ((await getObjective(salonObjective.id))!.progress as Progress).continuation;
  const [lastNote] = await db.select({ content: assistantMessages.content }).from(assistantMessages).where(and(eq(assistantMessages.threadId, thread3.id), eq(assistantMessages.role, "event"))).orderBy(sql`${assistantMessages.createdAt} desc`).limit(1);
  check("an idle turn does not end the request: the driver starts its last turn, with the reason", lastTurn?.n === 2 && lastTurn.final === "sources_exhausted" && lastTurn.finalDetail === "the assistant found no further source or query worth searching" && (await getObjective(salonObjective.id))?.status === "active", JSON.stringify(lastTurn));
  check("…and the note asks for the plan from what matched", /has no further source to search .* prepare outreach from the leads that match/.test(lastNote?.content ?? ""), lastNote?.content.slice(0, 160));
  // That turn ran on the stand-in model (which answers no chat turn); once it has ended, the request stops with its reason.
  for (let waited = 0; waited < 20_000 && !((await getObjective(salonObjective.id))!.progress as Progress).continuation?.endedAt; waited += 250) await new Promise((resolve) => setTimeout(resolve, 250));
  const ended = ((await getObjective(salonObjective.id))!.progress as Progress).continuation!;
  await saveObjectiveProgress(salonObjective.id, { continuation: { ...ended, endedAt: ended.endedAt ?? new Date().toISOString(), end: "done" } });
  await drive();
  const stopped = await getObjective(salonObjective.id);
  check("…then the request stops as sources exhausted, with that reason's detail", stopped?.status === "stopped" && stopped.stopReason === "sources_exhausted" && stopped.stopDetail === "the assistant found no further source or query worth searching", `${stopped?.status} ${stopped?.stopReason}: ${stopped?.stopDetail}`);

  // ---------------------------------------------------------- a step that only starts searches ends the turn
  const thread4 = await createThread(a.owner.id);
  const florists = "Research 3 florists in Austin. No outreach.";
  const florBrief = { goal: "Research 3 florists in Austin, no outreach", leadTarget: 3, contact: false, channels: null, spendCapUsd: 0, timeLimitMinutes: null, done: "3 Austin florists found" };
  chatAnswers.length = 0;
  chatAnswers.push(
    JSON.stringify({ message: "I started a free Google Maps search for florists in Austin. I'll tell you what it finds.", actions: [{ tool: "set_brief", arguments: JSON.stringify(florBrief) }, { tool: "find_leads", arguments: JSON.stringify({ what: "florists", where: "Austin, TX" }) }], suggestions: [] }),
    JSON.stringify({ message: "The search is still running. Nothing has been found yet.", actions: [], suggestions: [] }),
  );
  const chatCallsBefore = writerCalls.filter((name) => name === "assistant_reply").length;
  await runAgentTurn({ threadId: thread4.id, userId: a.owner.id, text: florists });
  const chatCalls = writerCalls.filter((name) => name === "assistant_reply").length - chatCallsBefore;
  const said = await db.select({ content: assistantMessages.content }).from(assistantMessages).where(and(eq(assistantMessages.threadId, thread4.id), eq(assistantMessages.role, "assistant")));
  const [florJob] = await db.select({ id: assistantJobs.id }).from(assistantJobs).where(and(eq(assistantJobs.threadId, thread4.id), eq(assistantJobs.kind, "discovery")));
  check("a step that only writes the brief and starts searches ends the turn: one model call, one message", chatCalls === 1 && said.length === 1 && Boolean(florJob) && chatAnswers.length === 1, `${chatCalls} call(s); ${said.map((row) => row.content).join(" | ")}`);
  chatAnswers.length = 0;

  // ---------------------------------------------------------- "outreach them all" after a research-only request ended (live, 22 Oct)
  const thread5 = await createThread(a.owner.id);
  const scout = await addMessage({ threadId: thread5.id, role: "user", content: "Find leads for my AI automation offer, any niche, anywhere.", createdBy: a.owner.id });
  const scoutContext: Context = { threadId: thread5.id, userId: a.owner.id, ownerText: scout.content, requestMessageId: scout.id, searchRequestId: scout.id, v2: true, autonomous: false };
  await runTool("set_brief", { goal: "Find leads for AI automation: cleaning companies in Houston", leadTarget: null, contact: false, channels: null, spendCapUsd: null, timeLimitMinutes: null, done: "leads found and reported" }, scoutContext);
  const scoutList = await createAudience({ name: "cleaning companies in Houston", source: "discovery", threadId: thread5.id, userId: a.owner.id });
  const cleaners = await db.insert(people).values(["Bayou Cleaning", "Spotless Houston", "Heights Maids", "Dallas Janitorial"].map((name, index) => ({
    organizationId: a.org.id, fullName: name, email: `office${index}-${stamp}@cleaning.research-v2.test`, source: "research-v2-check",
  }))).returning();
  await addAudienceMembers(scoutList, cleaners.map((row) => ({ personId: row.id, source: "discovery", facts: { businessName: row.fullName ?? "", city: row.fullName === "Dallas Janitorial" ? "Dallas" : "Houston" } })));
  for (const row of cleaners) {
    const fit = row.fullName === "Dallas Janitorial" ? "no_match" : "match";
    await db.update(leadAudienceMembers).set({ fit, fitReason: fit === "match" ? "A Houston cleaning company." : "In Dallas.", fitApproach: fit === "match" ? "standard" : "skip", fitGroup: "Cleaning", fitRequestId: scout.id, fitAt: new Date() })
      .where(and(eq(leadAudienceMembers.audienceId, scoutList), eq(leadAudienceMembers.personId, row.id)));
  }
  await db.insert(assistantJobs).values({ organizationId: a.org.id, kind: "discovery", stage: "done", status: "succeeded", threadId: thread5.id, audienceId: scoutList, payload: { requestMessageId: scout.id, phrase: "cleaning companies in Houston, TX" }, result: { found: 4, eligible: 4 } });
  await runTool("finish_request", { summary: "Found Houston cleaning companies." }, scoutContext);
  check("(setup) the research-only request has ended", (await objectiveForRequest(scout.id))?.status === "stopped");
  const followBrief = { goal: "Contact the matching leads already found: cleaning companies in Houston", leadTarget: null, contact: true, channels: null, spendCapUsd: null, timeLimitMinutes: null, done: "an outreach plan for the matching leads" };
  chatAnswers.length = 0;
  chatAnswers.push(
    JSON.stringify({ message: "I'm preparing the outreach plan for the matching Houston cleaning companies.", actions: [{ tool: "set_brief", arguments: JSON.stringify(followBrief) }, { tool: "prepare_outreach", arguments: JSON.stringify({ forRequest: true }) }], suggestions: [] }),
    JSON.stringify({ message: "", actions: [], suggestions: [] }),
  );
  await runAgentTurn({ threadId: thread5.id, userId: a.owner.id, text: "outreach them all" });
  const followTools = await db.select({ tool: assistantMessages.tool, status: assistantMessages.status, content: assistantMessages.content, toolResult: assistantMessages.toolResult }).from(assistantMessages)
    .where(and(eq(assistantMessages.threadId, thread5.id), eq(assistantMessages.role, "tool"))).orderBy(sql`${assistantMessages.createdAt} asc`);
  const briefRow = followTools.filter((row) => row.tool === "set_brief").at(-1);
  const planRow = followTools.filter((row) => row.tool === "prepare_outreach").at(-1);
  const followRequestId = (briefRow?.toolResult as { data?: { requestId?: string } } | null)?.data?.requestId ?? null;
  const followObjective = followRequestId ? await objectiveForRequest(followRequestId) : null;
  check("\"outreach them all\" after a research-only request ended continues it: a new request that carries its leads", Boolean(followObjective) && followObjective!.requestMessageId !== scout.id && followObjective!.controls.continues === scout.id && followObjective!.status === "active", JSON.stringify(followObjective?.controls ?? null));
  const [followRun] = await db.select().from(outreachRuns).where(eq(outreachRuns.threadId, thread5.id));
  const followAssigned = ((followRun?.plan ?? {}) as { assignments?: { personId: string }[] }).assignments ?? [];
  const dallas = cleaners.find((row) => row.fullName === "Dallas Janitorial")!.id;
  check("…and the plan prepared in the same turn reads that request: the 3 matching leads, not the one that does not match", planRow?.status === "ok" && followAssigned.length === 3 && !followAssigned.some((item) => item.personId === dallas), `${planRow?.status}: ${planRow?.content.slice(0, 200)}`);
  check("…with the brief written once (no refusal loop)", followTools.filter((row) => row.tool === "set_brief").length === 1 && chatAnswers.length === 0, `${followTools.filter((row) => row.tool === "set_brief").length} briefs`);
  const reviewFollow = await runTool("review_leads", {}, { ...scoutContext, requestMessageId: followRequestId, searchRequestId: followRequestId });
  check("…and review_leads on the new request shows the leads it continued", reviewFollow.ok && /3 match/.test(reviewFollow.summary), reviewFollow.summary.split("\n")[0]);
  const followContext: Context = { ...scoutContext, requestMessageId: followRequestId, searchRequestId: followRequestId };
  const planOf = async (result: Awaited<ReturnType<typeof runTool>>) => {
    const id = typeof result.data?.runId === "string" ? result.data.runId : null;
    const [row] = id ? await db.select().from(outreachRuns).where(eq(outreachRuns.id, id)) : [];
    return (((row?.plan ?? {}) as { assignments?: { personId: string }[] }).assignments ?? []).map((item) => item.personId);
  };
  const everyone = await runTool("prepare_outreach", { leads: "all" }, followContext);
  const everyoneIds = await planOf(everyone);
  check("prepare_outreach with leads all puts in every contactable lead, the one the judge said no to included", everyone.ok && everyoneIds.length === 4 && everyoneIds.includes(dallas), `${everyone.summary.slice(0, 160)} | ${everyoneIds.length}`);
  const picked = await runTool("prepare_outreach", { personIds: [dallas] }, followContext);
  const pickedIds = await planOf(picked);
  check("…and with personIds exactly the people the assistant picked", picked.ok && pickedIds.length === 1 && pickedIds[0] === dallas, `${picked.summary.slice(0, 160)} | ${pickedIds.join(",")}`);
  const stranger = await runTool("prepare_outreach", { personIds: [personIds["Barton Creek Dental"]] }, followContext);
  check("…but not someone who is not a lead of this request", !stranger.ok && /none of the 1 people named/.test(stranger.summary), stranger.summary);
  chatAnswers.length = 0;

  shared = { threadId: thread.id, requestId: request.id, personIds };
});

// ------------------------------------------------------------ the second organization sees nothing
await runInOrganization(b.org.id, async () => {
  const seen = await runTool("review_leads", {}, { threadId: shared!.threadId, userId: b.owner.id, ownerText: "", requestMessageId: shared!.requestId, searchRequestId: shared!.requestId, v2: true });
  check("another organization cannot read this request's leads", !seen.ok || !seen.summary.includes("Barton Creek"), seen.summary.slice(0, 120));
  const other = await runTool("set_lead_fit", { personId: shared!.personIds["Barton Creek Dental"], fit: "no_match", reason: "x" }, { threadId: shared!.threadId, userId: b.owner.id, ownerText: "", requestMessageId: shared!.requestId, searchRequestId: shared!.requestId, v2: true });
  check("another organization cannot change a verdict of this one", !other.ok, other.summary);
  const leaked = await db.select({ id: leadAudienceMembers.id }).from(leadAudienceMembers).where(and(eq(leadAudienceMembers.organizationId, b.org.id), inArray(leadAudienceMembers.personId, Object.values(shared!.personIds))));
  check("…and holds none of its people", leaked.length === 0);
});

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll research agent v2 checks passed.");
process.exit(failures ? 1 : 0);

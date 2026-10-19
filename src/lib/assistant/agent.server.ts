import "server-only";

import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { completeStructured } from "@/lib/ai/server/structuredCompletion";
import { crmKnowledgeDocuments, crmKnowledgeDocumentVersions } from "@/lib/crm/schema";
import { BRAND } from "@/lib/brand";
import { inOrg } from "@/lib/tenancy/scope";
import type { FeatureState } from "@/lib/features/catalog";
import { TREG_LIMITS } from "@/lib/treg/catalog";
import { featureState } from "@/lib/features/flags.server";
import { actionsProblem, agentReplySchema, groundingCorpus, searchRequestFor, inquiryRepliesRequested, isSmallTalk, MAX_ACTIONS_PER_STEP, MAX_STEPS, DIRECT_CONTACT_TOOLS, nextAgentBatch, parseAgentReply, pendingOutreachRequestIndex, sameMessage, standingOutreachRequestIndex, transcriptText, unbackedClaim, type AgentReply } from "./agent";
import { AUTONOMOUS_MAX_STEPS, autonomousRules, SEARCH_TOOLS, searchCapProblem, type AutonomyCaps } from "./autonomy";
import { autonomousSearchesToday, autonomyCaps, autoStartPlan, threadAutonomy } from "./autonomy.server";
import { listAudiences } from "./audiences.server";
import { listOpenDecisions } from "./decisions.server";
import { listRuns } from "./outreach.server";
import { localDate } from "./results";
import { organizationTimeZone } from "./results.server";
import type { TurnEnd } from "./objective";
import { objectiveForRequest } from "./objective.server";
import { assistantJobs, assistantMessages, type AssistantAttachment, type BusinessProfile } from "./schema";
import { addMessage, claimThread, listMessages, releaseThread, touchThread, updateMessage } from "./threads.server";
import { recordUsage } from "./usage.server";
import { researchContextForTool, runTool, searchRequestId, setupSnapshot, toolCatalog, toolNamesFor, type ToolContext, type ToolResult } from "./tools.server";
import { observationKey } from "./observation";
import { closeBrowser } from "@/lib/browser/browser.server";
import { instagramCapabilityProblem } from "./instagramContacts";

/**
 * One turn of the owner's assistant. The model answers with a message and
 * the tools to run; the server runs them, records each result in the chat,
 * and asks again with the results, until the model has nothing more to do
 * (at most MAX_STEPS). Every reply passes `accept`: unknown tools, bad
 * arguments and claims of actions no tool performed are rejected and the
 * model is asked again with the reason, so the chat never says something
 * happened that did not.
 */

function systemPrompt(features: FeatureState, autonomy: AutonomyCaps | null = null): string {
  return [
    `You are the outreach assistant inside ${BRAND.name}. You work for the owner of a business: you learn about the business, find leads, prepare outreach and report on it, by calling tools. You are honest and brief.`,
    'Your structured answer always has these three fields: {"message":"...","actions":[],"suggestions":[]}. actions is an array even for one tool, e.g. {"message":"","actions":[{"tool":"report","arguments":"{}"}],"suggestions":[]}. Each arguments value is a JSON object written as a string. Never omit actions or put prose in it. Use [] when asking a question or finished.',
    "",
    "RULES",
    "1. Act with tools. A tool's result is the only proof something happened. Never say something was saved, searched, found, prepared, started, sent or paused unless a TOOL line in the conversation shows it succeeded. If a tool failed, say so plainly with its reason.",
    "2. You cannot start outreach. After prepare_outreach succeeds, ask the owner to review the plan card (audience, sample messages, limits, cost), choose Automatic or Review replies, and press Start. Outreach runs only after that, and only within that plan's leads, channels and limits. To contact more people, change channels or raise limits, prepare a new plan (basedOnRunId reuses a run's messages): the owner approves it again. One Start can cover a whole request: when one request makes several plans (for example one search per city with contactAfter), the plan card offers \"apply to the rest of this request\"; with it, the request's other plans start on their own as they are ready, in the same reply mode and within the same channels and limits, so the owner does not approve each one. Tell the owner this once when you start several searches for one request.",
    "3. Ask only for what the next step needs, one or two questions at a time. Read the BUSINESS PROFILE, ALREADY KNOWN ELSEWHERE and SETUP first and never ask for what is already there: a price list document answers price questions, a sender name the accounts already use is the sender, saved reply instructions already apply. Ask only for what STILL MISSING lists. A website URL is optional: a plain request uses the saved business details and connected channels; never require a URL to find leads or prepare outreach. For a lead search you need the kind of customers and where; for outreach, the business name, the offer and the sender's name. If the owner describes a different business from the BUSINESS PROFILE, save the new details and ask before relying on older ones that may belong to the previous business (places, website, prices, booking details).",
    "4. When the owner tells you anything about the business, customers, places, offer, the problems it solves, prices, service area, sender, tone, preferences or what an interested lead should be offered next (a call, a visit, a quote), call save_business_info in the same response, so it is remembered and automatic replies can use it. Replies to leads sell from problemsSolved and lead to nextStep (a short call with the sender when not set): before the first outreach, if problemsSolved is empty, ask once which problems the offer solves for customers; never block outreach on it. Attached documents are already saved to knowledge; contact lists are already imported (see the attachment TOOL lines).",
    "5. Prepare outreach only when the owner's latest message asks to contact, email, message or pitch people, or says yes to your offer of it. If they only gave information or asked a question, answer or save it and offer outreach in one sentence. 'Find leads and contact them': call find_leads with contactAfter true; the plan is then prepared automatically when the search ends. 'Use this list': call prepare_outreach for the audience the import created. Do not check a search's progress right after starting it; its result is announced.",
    "5b. There are two starting points, and both end in the same lead lists, plan card, Start button, replies and decisions. (1) The owner's existing leads or inquiries: use_existing_leads makes a list from people already saved (everyone, the latest import, a word to match, or the people who sent inquiries), or they attach a list or type contacts. Prefer this when they say they already have leads, contacts, customers or inquiries. (2) Finding potential customers for them: the lead sources in rule 6. Lead finding is optional: never push it on an owner who has contacts. A found lead is a potential match, not an interested customer: say so, and never call anyone interested unless a reply was classified interested. A follow, like or generic comment is not interest. Unknown location, budget, contact details and prices stay unknown. Never invent pricing such as project-based or contact for a quote as a business fact; leave pricing unset unless the owner or a saved source supplied it.",
    `6. Lead sources: (a) find_leads — businesses with a public Google Maps listing, then each business's own website (home and contact pages) for the emails, phones and LinkedIn pages it publishes; (b) find_linkedin_leads — people on LinkedIn by keywords, when a LinkedIn account is connected (profiles only, contacted on LinkedIn); (c) contact lists the owner attaches; (d) contacts the owner types in the chat — call add_contacts with exactly what they wrote (contactAfter true when they asked to contact, message or pitch them; the plan then follows by itself); read back the saved numbers. A phone number without + and a country code is refused when no Default phone country is set: ask which country, never guess. (e) web_search searches the web (TinyFish; Tavily when only it is connected) for websites, directories, lists, public profiles and discussions matching keywords you choose, and read_webpage opens a link the owner gave, a web_search result or a link on a page already read, returning its text, contacts and links. Use them for buyers no other source covers well (decision makers, niche businesses, wholesalers' customers): search, read the promising pages, follow their links, and keep only leads whose fit, place and contact route a page you read shows. A search result alone is a candidate, and a person asking a question online is not a buyer. When web_search says it is not connected or is waiting, say so and use the other sources. Hacker News and Stack Exchange threads that web_search finds can be read with read_webpage (through their public APIs) as evidence of a stated need or problem, never of buying intent; their authors are pseudonymous and are not leads to contact or to match to anyone elsewhere. Reddit cannot be read: never say Reddit was searched or read. ${features.web_discovery ? `(f) find_customers_on_web — a real web search (through Tavily when a Tavily key is saved, else the organization's web-searching AI provider) for businesses' own websites and directories matching the owner's customer description in a place, then their published contacts, each with the page it came from; when Instagram is connected it also reads public Instagram profiles and post comments the search found, and Instagram profiles may receive one approved initial DM through a connected Instagram account. ${features.apify_discovery ? "Facebook, LinkedIn and Instagram are searched only through find_social_leads (rule 6b); TikTok and X cannot be searched" : "You cannot search Instagram, Facebook or TikTok by keyword or hashtag"}, and you cannot read pages behind a login; say so plainly when asked.` : features.apify_discovery ? "You cannot read pages behind a login; Facebook, LinkedIn and Instagram are searched only through find_social_leads (rule 6b)." : "You cannot read Instagram, Facebook, X, TikTok or LinkedIn pages (they need a login), and cannot search those networks by keyword; say so plainly when asked, and offer what you can do instead."} One find_leads call covers one kind of business in one city or district (about 20 businesses per area it searches); you can run up to 4 at once, one per city or kind. For a country or large region, or when the owner leaves the place to you ('any city', 'wherever there are most'), choose yourself: the 3 largest cities for that kind of business in that country (or near the owner's locations), name them, and start one search per city in the same response. Ask about the place only when you know neither the country nor the owner's area. Never invent contacts, emails, phones, profiles, prices or results.`,
    ...(features.apify_discovery
      ? ["6b. Apify (paid, the owner's own account): find_leads searches Google Maps with the built-in scraper; pass provider 'apify' only when the owner asks for Apify. Apify also takes over Maps as the approved fallback when the built-in scraper is missing or fails — say which source and provider the TOOL line reports, and any limitation it gives. A search queued for a free Apify run slot starts by itself: say it is queued, never that it found nothing. find_instagram_prospects finds Instagram accounts by hashtag, and find_social_leads finds businesses by keyword and place on Facebook (business pages), LinkedIn (companies, contacts from their websites) or Instagram (Instagram's own account search), through approved Apify Actors. When the owner asks where most of their customers are, use the platforms that fit them alongside find_leads. Always keep apart finding a page or account and being able to contact it: Facebook outreach requires a published email or phone. Instagram profiles can receive one initial DM through a connected Unipile Instagram account after plan approval; readiness, sending limits and recipient restrictions apply. Prefer Instagram for an Instagram outreach request, and respect explicit channel choices. Never offer to top up, upgrade or raise Apify limits."]
      : []),
    ...(features.treg
      ? [`6c. Treg (beta; paid from the owner's prepaid Treg balance, at most $${TREG_LIMITS.maxUsdPerCall} a call, within the organization's daily Treg cap): when the owner asks for a lookup the other tools cannot do — a person's work email from their name and company domain, checking an email, a phone number, enriching a person or company, a public social profile — call treg_search with the task in plain words, then treg_call with the cheapest fitting endpoint id it returned and the parameters it lists (query or body). Call only ids treg_search returned. Use it for the people the owner names or a handful of leads, not to loop over a whole list. Emails and phones in a successful treg_call answer may be added with add_contacts. Say what each call cost, as the TOOL line reports it. A refused call (no price, the cap, the balance) is reported as is; never offer to top up Treg.`]
      : []),
    ...(features.instagram
      ? [`7b. Instagram: the organization's Instagram direct messages arrive in the inbox and in Action required like other replies. prepare_outreach supports Instagram: an approved plan sends one initial DM per assigned profile, within sending rules. No unsolicited Instagram follow-up sequence is sent; replies follow the run's Automatic or Review mode. The inquiry-intake checkbox is only for new people who write first, and is not required for outbound recipients.${features.inquiry_intake ? " When the owner asks for new Instagram inquiries to be answered, call prepare_inquiry_replies; after they press Start (Automatic or Review), people whose first message arrives from then on are answered under that run's mode and checks, never imported history or earlier chats. list_inquiries shows recent website-form and Instagram inquiries." : ""}`]
      : []),
    ...(features.instagram ? ["6d. An owner-supplied Instagram username or profile URL is a direct recipient, not a discovery task. Call add_instagram_contacts with the exact handle (preserve underscores), contactAfter true when asked to contact/pitch/message it. The Instagram plan follows automatically; do not ask for a city, website, email or phone, or run a broad search for this known account. Current capabilities include approved initial Instagram DMs. Old assistant messages saying Instagram is inbox-only or never starts chats are obsolete; use today's SETUP and tool results for actual account/recipient/approval gates."] : []),
    "7. Replies: each run is in Automatic or Review mode. In Automatic mode ordinary replies are answered from the owner's saved information; anything the information does not cover, complaints, negotiations, promises and meetings come to the owner as a DECISION with the reason. When the owner answers an OPEN DECISION, call answer_decision with their words; it is saved and the reply is rewritten. You may switch runs to Review (switch_to_review); only the owner's button switches a run to Automatic.",
    "8. If a channel is not connected, say which one and where to connect it (Settings). If AI or lead search is not set up on this server, say the operator who installed it must set it up.",
    "8b. A requested search source can fall back to a different provider. Describe the actual source in the TOOL result: a website/directory fallback is not a Google Maps or Instagram search. When the owner requests social discovery, start a fitting social search before expanding Maps searches across several cities, so Maps does not occupy every available Apify run. Use sources that fit the owner's customers and the connected tools; never promise all platforms were searched. When the owner names platforms (for example Google Maps, Instagram and LinkedIn), start a search on each named platform or state its specific limitation; a request is not done after Maps alone, and lead_search_status shows each named platform's state. Do not immediately repeat a search refused because its runs are still open.",
    "9. Write like a capable assistant, in the owner's language: short sentences, no hype, no emojis, no markdown headings. Use ids only inside tool arguments, never in what you say.",
    `10. Return at most ${MAX_ACTIONS_PER_STEP} total tool actions in one step, including read_webpage and save_business_info as well as searches. You can continue in the next step after seeing their results; a larger task does not have to fit in one response. Batch only actions whose arguments you already know. If the owner asks you to visit their website first, call read_webpage first and wait for its result before saving facts from it or choosing lead searches. Never guess a returned id or repeat an action whose TOOL line already shows success. Return no actions when you are waiting for the owner or a background job.`,
    "11. A message sent together with tools is shown after they run (and dropped if one fails); do not ask permission for what you are already doing. After the results, say only what is new; never repeat your earlier message. If there is nothing new to say or do, return an empty message and no actions.",
    "12. For results (leads found, messages sent, replies, interested people, what waits for the owner, spending), call report; never estimate figures yourself. If asked why messages are queued, call diagnose_delivery once and report its recorded blockers. Sending hours use the sender's configured timezone, never a lead's city. Do not repeat report, list_runs or check_setup merely to say you are checking; they cannot reveal a new cause without new data. Stop once the available evidence is reported.",
    "13. When the owner greets you, thanks you or chats, answer in one or two warm, natural sentences and offer the one next step that fits them: with an empty BUSINESS PROFILE, ask what the business sells and to whom (or to attach a brochure or a contact list); with a complete one, offer to find customers or show results. Run no tools for small talk, and never save information the owner did not give.",
    "14. suggestions: up to three short replies the owner might send next, in their own words and language (e.g. \"We sell dental equipment servicing in Pune\", \"Find dental clinics in Pune and contact them\", \"Show today's results\"). Suggest only what you could act on; none while a plan card waits for Start or a decision card waits for an answer.",
    "15. A request that finds leads is pursued to an end: it keeps going by itself until it has its lead target, its time limit or spend cap is reached, nothing else fits, or the owner pauses or cancels it (control_research), and it ends with one report. The owner can name the limits in the request (\"find 50…\", \"within 2 hours\", \"spend up to $10\"); otherwise Settings → Organization has the defaults. The first search's TOOL line says which apply: tell the owner once. When an EVENT says the request is continuing on its own, pick the next source or a different query by the yields it lists, start it (with contactAfter when the request asked to contact people), and say in one sentence what you started; never repeat a search that already ran. When nothing else fits the request, start nothing and say so in one sentence. The spend cap counts Apify runs, Treg calls, browser minutes and AI web research; a $0 cap means free sources only (TinyFish, the built-in Google Maps scraper, LinkedIn search, Hacker News and Stack Exchange), so paid tools are refused for it; Tavily is shown in credits under its own daily cap, and your own model use is not counted. When the owner's new message adds to a request whose research is still running in this chat (\"use Instagram too\", \"add Mumbai as well\"), pass sameRequest true on that search so it counts toward the same request and its limits; a request whose research has stopped takes no more searches, and a new message then starts a new request.",
    ...(autonomy ? ["", ...autonomousRules(autonomy), "These autonomous rules override rules 2, 5, 10, 11 and 14 where they differ: plans start on their own, you do not offer and wait, and you keep going."] : []),
    "",
    "TOOLS",
    toolCatalog(features),
  ].join("\n");
}

async function contextBlock(): Promise<{ text: string; outreachStarted: boolean; profile: BusinessProfile }> {
  const setup = await setupSnapshot();
  const [audiences, runs, jobs, decisions, timeZone] = await Promise.all([
    listAudiences(8),
    listRuns(8),
    db.select({ id: assistantJobs.id, kind: assistantJobs.kind, status: assistantJobs.status, stage: assistantJobs.stage, audienceId: assistantJobs.audienceId, runId: assistantJobs.runId })
      .from(assistantJobs).where(and(inOrg(assistantJobs), inArray(assistantJobs.status, ["queued", "running"]), ne(assistantJobs.kind, "objective"))).orderBy(desc(assistantJobs.createdAt)).limit(5),
    listOpenDecisions(8),
    organizationTimeZone(),
  ]);
  const channels = Object.entries(setup.channels)
    .map(([name, status]) => `${name} ${status.available ? `ready (${status.senders})` : `not ready: ${status.reason}`}`).join("; ");
  const text = [
    // The business's own day (Settings → Organization time zone), the one report's "today" counts.
    `TODAY: ${localDate(timeZone)} (${timeZone})`,
    `BUSINESS PROFILE: ${JSON.stringify(setup.profile)}`,
    `SETUP: channels — ${channels}. Lead search — ${setup.leadDiscovery.available ? "ready (Google Maps)" : setup.leadDiscovery.reason}. AI — ${setup.ai.connected ? "connected" : "not set up on this server"}. Runs answering replies automatically — ${setup.automaticRuns}.`,
    `ALREADY KNOWN ELSEWHERE: ${setup.knownElsewhere}.`,
    `STILL MISSING: for a lead search ${setup.missingForDiscovery.join(", ") || "nothing"}; for outreach ${setup.missingForOutreach.join(", ") || "nothing"}${setup.optionalToAsk.length ? `; worth asking once (never blocking): ${setup.optionalToAsk.join(", ")}` : ""}.`,
    `LEAD LISTS: ${audiences.map((a) => `${a.id} “${a.name}” ${a.eligible}/${a.total} contactable`).join("; ") || "none"}`,
    `OUTREACH RUNS: ${runs.map((r) => `${r.id} “${r.name}” ${r.status}, ${r.autopilot ? "Automatic" : "Review"} replies`).join("; ") || "none"}`,
    `OPEN DECISIONS: ${decisions.map((d) => `${d.id} [${d.kind}] ${d.reason} — asks: ${d.decision}`).join("; ") || "none"}`,
    `BACKGROUND JOBS: ${jobs.map((j) => `${j.kind} ${j.id} ${j.status} (${j.stage})`).join("; ") || "none"}`,
  ].join("\n");
  return { text, outreachStarted: runs.some((run) => ["running", "paused", "completed", "starting"].includes(run.status)), profile: setup.profile };
}

/** The text of the owner's saved documents (newest first, capped): information they gave, so it may be saved to the profile. */
async function ownerDocumentsText(maxChars = 60_000): Promise<string> {
  const rows = await db.select({ content: crmKnowledgeDocumentVersions.content })
    .from(crmKnowledgeDocuments)
    .innerJoin(crmKnowledgeDocumentVersions, and(eq(crmKnowledgeDocumentVersions.documentId, crmKnowledgeDocuments.id), eq(crmKnowledgeDocumentVersions.version, crmKnowledgeDocuments.latestVersion)))
    .where(and(inOrg(crmKnowledgeDocuments), eq(crmKnowledgeDocuments.active, true)))
    .orderBy(desc(crmKnowledgeDocuments.createdAt))
    .limit(30);
  return rows.map((row) => row.content).join("\n").slice(0, maxChars);
}

/** Runs one tool and records it in the thread: a "running" card first, then its result. */
export async function runToolInThread(context: ToolContext, tool: string, args: Record<string, unknown>): Promise<ToolResult> {
  const prepared = await researchContextForTool(tool, context);
  context = prepared.context;
  const row = await addMessage({ threadId: context.threadId, role: "tool", tool, toolInput: args, status: "running", content: "" });
  let result = await runTool(tool, args, context);
  if (prepared.controls && result.ok) result = { ...result, summary: `${result.summary} ${prepared.controls}` };
  // Persist the canonical request id with the tool result; direct web tools do
  // not create jobs that could otherwise associate the operation to a request.
  const requestId = searchRequestId(context);
  await updateMessage(row.id, {
    status: result.ok ? "ok" : "error",
    content: result.summary,
    toolResult: { summary: result.summary, ...(result.display ? { display: result.display } : {}), ...(result.data ? { data: result.data } : {}), ...(result.refused ? { hidden: true } : {}), ...(requestId ? { requestId } : {}) },
  });
  return result;
}

export class AssistantBusyError extends Error {
  constructor() {
    super("The assistant is still working on the previous message.");
    this.name = "AssistantBusyError";
  }
}

/** Records an owner message (with its attachment results) and runs the assistant's turn. */
export async function runAgentTurn(input: {
  threadId: string;
  userId: string | null;
  /** The owner's message; null for a turn the system starts (a background job finished). */
  text: string | null;
  attachments?: AssistantAttachment[];
  /** Results of the attached files, recorded before the model is asked. */
  attachmentResults?: { tool: string; input: Record<string, unknown>; result: { ok: boolean; summary: string; data?: Record<string, unknown> } }[];
  /**
   * A turn an objective's driver starts (objectiveDriver.server.ts) to continue
   * the owner's request: the driver already holds the chat for it, its
   * searches serve that request (its outreach too, when the request asked
   * for it), and onEnd records how it ended before the chat is let go.
   */
  continuation?: { requestMessageId: string; request: string; outreach: boolean; onEnd: (end: TurnEnd) => Promise<void> };
  /**
   * A turn a finished job started (continueAfterEvent): the owner request
   * that job served. Its searches and paid work serve that request, and its
   * words are the owner's text, whatever the owner wrote since. Not a
   * driver continuation: nothing about the chat's claim or its end changes.
   */
  eventRequestId?: string | null;
}): Promise<TurnEnd> {
  if (!input.continuation && !(await claimThread(input.threadId))) throw new AssistantBusyError();
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  // How the turn ended; an error that escapes it leaves "failed".
  let end: TurnEnd = "failed";
  try {
    // Autonomous mode (autonomy.ts): plans start on their own, no permission questions, longer turns.
    const autonomy = await threadAutonomy(input.threadId);
    const caps = autonomy.on ? await autonomyCaps() : null;
    if (input.text !== null || input.attachments?.length) {
      await addMessage({ threadId: input.threadId, role: "user", content: input.text ?? "", attachments: input.attachments ?? [], createdBy: input.userId });
    }
    for (const attachment of input.attachmentResults ?? []) {
      await addMessage({
        threadId: input.threadId,
        role: "tool",
        tool: attachment.tool,
        toolInput: attachment.input,
        toolResult: { summary: attachment.result.summary, ...(attachment.result.data ? { data: attachment.result.data } : {}) },
        status: attachment.result.ok ? "ok" : "error",
        content: attachment.result.summary,
      });
    }

    // What the owner asked, for tools that need their words (outreach must be asked for).
    const history = await listMessages(input.threadId, 40);
    const lastOwnerIndex = history.map((message) => message.role).lastIndexOf("user");
    const continuation = input.continuation ?? null;
    // A turn a finished job started serves that job's request (an owner message of this chat), like a continuation does.
    const eventRequest = !continuation && input.text === null && input.eventRequestId ? await ownerMessageInThread(input.threadId, input.eventRequestId) : null;
    // A continuation serves its own request, whatever the owner wrote since.
    const ownerText = continuation?.request ?? input.text ?? eventRequest?.content ?? history[lastOwnerIndex]?.content ?? "";
    // The assistant's last words before the owner's message: a "yes" to an offer of outreach is a request for it.
    const lastAssistantText = [...history.slice(0, Math.max(0, lastOwnerIndex))].reverse().find((message) => message.role === "assistant")?.content ?? null;
    // In Autonomous mode the owner's request to contact people stands for the work that follows it.
    const pendingIndex = continuation ? null : pendingOutreachRequestIndex(history);
    const requestIndex = continuation ? null : pendingIndex ?? (autonomy.on ? standingOutreachRequestIndex(history) : null);
    const outreachRequest = continuation ? (continuation.outreach ? continuation.request : null) : requestIndex === null ? null : history[requestIndex]!.content;
    // The owner's message that asked, by id: one Start may cover the plans of exactly this request.
    const outreachRequestId = continuation ? (continuation.outreach ? continuation.requestMessageId : null) : requestIndex === null ? null : history[requestIndex]!.id;
    const requestMessageId = continuation?.requestMessageId ?? eventRequest?.id ?? (lastOwnerIndex >= 0 ? history[lastOwnerIndex]!.id : null);
    const outreachResearch = outreachRequestId && !continuation ? await objectiveForRequest(outreachRequestId).catch(() => null) : null;
    const searchRequestId = searchRequestFor({
      continuationRequestId: continuation?.requestMessageId ?? eventRequest?.id ?? null,
      latestOwnerId: lastOwnerIndex >= 0 ? history[lastOwnerIndex]!.id : null,
      outreachRequestId,
      outreachPending: requestIndex !== null && requestIndex === pendingIndex,
      outreachResearchStopped: outreachResearch?.status === "stopped",
    });
    const context: ToolContext = { threadId: input.threadId, userId: input.userId, ownerText, lastAssistantText, outreachRequest, outreachRequestId, autonomous: autonomy.on, requestMessageId, searchRequestId };
    const askedForOutreach = outreachRequest !== null;
    const askedForInquiryReplies = inquiryRepliesRequested(ownerText, lastAssistantText);
    const said: string[] = [];
    // A greeting or thanks runs no tools (see actionsProblem).
    const smallTalk = input.text !== null && !input.attachments?.length && isSmallTalk(input.text);
    const documentsText = smallTalk ? "" : await ownerDocumentsText();
    const succeeded: string[] = [];
    const features = await featureState();
    const toolNames = toolNamesFor(features);
    const maxSteps = autonomy.on ? AUTONOMOUS_MAX_STEPS : MAX_STEPS;
    let pendingReply: AgentReply | null = null;
    // A "Retrying" note this turn posted while the model was asked again (updated, then hidden or turned into the failure summary).
    let retryNoteId: string | null = null;
    const turnStartedAt = Date.now() - 1_000;
    let replanReason: string | null = null;
    const observations = new Map<string, ToolResult>();
    // A long turn keeps the thread claimed: one step (writing a plan) can take minutes.
    heartbeat = setInterval(() => void touchThread(input.threadId).catch(() => undefined), 60_000);
    for (let step = 0; step < maxSteps; step += 1) {
      const { text: setupText, outreachStarted, profile } = await contextBlock();
      const messages = await listMessages(input.threadId, 80);
      // What the owner wrote or attached: business information is saved only from it.
      const ownerCorpus = groundingCorpus(messages, documentsText);
      let reply: AgentReply | null = null;
      const validateBatch = (parsed: AgentReply) => {
        const capabilityProblem = features.instagram ? instagramCapabilityProblem(parsed.message) : null;
        if (capabilityProblem) throw new Error(capabilityProblem);
        const refused = actionsProblem(parsed.actions, { smallTalk, profile, ownerCorpus, outreachRequested: askedForOutreach, inquiryRepliesRequested: askedForInquiryReplies });
        if (refused) throw new Error(refused);
        // Completion messages stay held until the last batch. Re-check them
        // and every queued batch against the latest results and profile.
        const startsNow = autonomy.on && parsed.actions.some((action) => action.tool === "prepare_outreach");
        const problem = unbackedClaim(parsed.message, parsed.actions.length ? ["(pending)"] : succeeded, outreachStarted || startsNow);
        if (problem) throw new Error(problem);
      };
      try {
        if (pendingReply) {
          try {
            validateBatch(nextAgentBatch(pendingReply).batch);
            reply = pendingReply;
          } catch (error) {
            // Earlier results may make the old plan invalid. Ask for a new
            // plan instead of running it unchecked or failing the chat.
            pendingReply = null;
            replanReason = error instanceof Error ? error.message : String(error);
          }
        }
        if (!reply) {
          const completion = await completeStructured({
            onRetry: async ({ attempt, maxAttempts }) => {
              const content = `Retrying: the AI model's answer was incomplete, so I asked it again (attempt ${attempt} of ${maxAttempts}).`;
              if (retryNoteId) await updateMessage(retryNoteId, { content });
              else retryNoteId = (await addMessage({ threadId: input.threadId, role: "event", content, toolResult: { transient: true } })).id;
            },
            timeoutMs: 90_000,
            maxOutputTokens: 1_500,
            schemaName: "assistant_reply",
            schemaDescription: "Your message to the owner and the tools to run now.",
            jsonSchema: agentReplySchema(toolNames),
            systemPrompt: systemPrompt(features, caps),
            userPrompt: `${setupText}\n\nCONVERSATION (newest last):\n${transcriptText(messages)}${replanReason ? `\n\nRe-plan the remaining work: ${replanReason.slice(0, 600)}. Use the latest TOOL results and do not repeat successful actions.` : ""}\n\nYour turn.`,
            accept: (text) => {
              const parsed = parseAgentReply(text, toolNames, { allowEmpty: step > 0 });
              validateBatch(nextAgentBatch(parsed).batch);
              reply = parsed;
            },
          });
          await recordUsage("assistant", completion);
          // Recovered: the "Retrying" note has done its job.
          if (retryNoteId) await updateMessage(retryNoteId, { toolResult: { transient: true, hidden: true } });
          retryNoteId = null;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/AI provider|AI Settings|default model|Connect an AI/i.test(message)) {
          await addMessage({ threadId: input.threadId, role: "event", content: `The assistant needs an AI provider: ${message}` });
          end = "no_ai";
          return end;
        }
        // The model's raw answer and the schema's wording stay in the server log (structuredCompletion.ts).
        console.warn(`[assistant] turn stopped: ${message.slice(0, 500)}`);
        const done = (await listMessages(input.threadId, 80))
          .filter((row) => row.role === "tool" && row.status === "ok" && row.createdAt.getTime() >= turnStartedAt)
          .map((row) => String((row.toolResult as { display?: unknown } | null)?.display ?? row.content).split("\n")[0]!.slice(0, 120));
        const content = [
          /failed after \d+ attempts/.test(message)
            ? "The AI model did not give a usable answer after several tries, so I stopped here."
            : "The AI model could not be reached just now, so I stopped here.",
          done.length ? `Done so far: ${done.slice(0, 6).join("; ")}.` : "Nothing was started or changed in this step.",
          "Press Retry to continue the same request: what is done is kept and will not be repeated.",
        ].join(" ");
        const toolResult = { data: { retry: true } };
        if (retryNoteId) await updateMessage(retryNoteId, { content, toolResult });
        else await addMessage({ threadId: input.threadId, role: "event", content, toolResult });
        end = "failed";
        return end;
      }
      const staged = nextAgentBatch(reply as unknown as AgentReply);
      pendingReply = staged.pending;
      const { message, actions, suggestions } = staged.batch;
      if (!actions.length) {
        // The suggested replies ride on the turn's last message (shown as buttons).
        if (message && !said.some((earlier) => sameMessage(earlier, message))) {
          await addMessage({ threadId: input.threadId, role: "assistant", content: message, toolResult: suggestions.length ? { suggestions } : null });
        }
        end = "done";
        return end;
      }
      // Repeated status reads cannot advance work. End with the existing
      // concrete result, rather than spending another turn saying "checking".
      if (actions.every((action) => {
        const key = observationKey(action.tool, action.args);
        return key !== null && observations.has(key);
      })) {
        const previous = actions.map((action) => observations.get(observationKey(action.tool, action.args)!)!);
        await addMessage({ threadId: input.threadId, role: "assistant", content: previous.map((result) => result.display ?? result.summary).join("\n") });
        end = "done";
        return end;
      }
      // The tools run first and the message is shown after their cards; a
      // message that says something was done is dropped when a tool failed,
      // and the next step explains what happened instead.
      let allOk = true;
      for (const action of actions) {
        // Autonomous mode: searches it starts are capped per day (Settings → Organization).
        const capped = autonomy.on && caps && SEARCH_TOOLS.has(action.tool) ? searchCapProblem(await autonomousSearchesToday(), caps) : null;
        if (capped) {
          await addMessage({ threadId: input.threadId, role: "tool", tool: action.tool, toolInput: action.args, status: "error", content: `Not run: ${capped}.`, toolResult: { summary: `Not run: ${capped}.` } });
          allOk = false;
          continue;
        }
        const key = observationKey(action.tool, action.args);
        if (key && observations.has(key)) continue;
        const result = await runToolInThread(context, action.tool, action.args);
        if (key) observations.set(key, result);
        else observations.clear();
        if (result.ok) succeeded.push(action.tool);
        else allOk = false;
        // Autonomous: the plan starts now; when a cap stops it the message is held and the next step explains.
        if (action.tool === "prepare_outreach" && result.ok && !(await startedOnItsOwn(input.threadId, autonomy.on, result.data))) allOk = false;
        // Contacts the owner asked to reach get their plan straight away, as a "find and contact" search does.
        const audienceId = typeof result.data?.audienceId === "string" ? result.data.audienceId : null;
        if (DIRECT_CONTACT_TOOLS.has(action.tool) && result.ok && action.args.contactAfter === true && askedForOutreach && audienceId && !actions.some((other) => other.tool === "prepare_outreach")) {
          const channels = action.tool === "add_instagram_contacts" ? { channels: ["instagram"] } : Array.isArray(action.args.channels) ? { channels: action.args.channels } : {};
          const plan = await runToolInThread(context, "prepare_outreach", { audienceId, ...channels });
          if (plan.ok) succeeded.push("prepare_outreach");
          else allOk = false;
          if (plan.ok && !(await startedOnItsOwn(input.threadId, autonomy.on, plan.data))) allOk = false;
        }
      }
      if (!allOk) {
        pendingReply = null;
        replanReason = "A tool in the previous batch failed or was refused. Its result explains why; reconsider the remaining actions before continuing";
      } else if (staged.replanAfterRead) {
        replanReason = "The webpage has now been read. Actions proposed after that read were held; use its actual contents to decide what to save and which searches to start";
      } else {
        replanReason = null;
      }
      // Shown only when every tool in this step worked: after a failure the
      // next step says what happened instead of what was hoped for.
      if (message && allOk && !said.some((earlier) => sameMessage(earlier, message))) {
        said.push(message);
        await addMessage({ threadId: input.threadId, role: "assistant", content: message });
        // A question to the owner ends the turn: their answer decides what happens next.
        // In Autonomous mode it does not: a real question comes with no actions and ends the turn anyway.
        if (!autonomy.on && message.trim().endsWith("?")) {
          end = "done";
          return end;
        }
      }
    }
    await addMessage({
      threadId: input.threadId,
      role: "event",
      content: autonomy.on
        ? `I paused after ${maxSteps} steps so I don't go round in circles. I continue when a search finishes, or tell me what to do next.`
        : "I stopped here so I don't go round in circles. Tell me how you'd like to continue.",
    });
    end = "max_steps";
    return end;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    // A browser the turn opened stops billing when the turn ends.
    await closeBrowser(input.threadId).catch((error: unknown) => console.warn("[assistant] closing the browser failed:", error));
    // A continuation records how it ended while it still holds the chat: a free chat without that record means its process stopped.
    if (input.continuation) await input.continuation.onEnd(end).catch((error: unknown) => console.error("[assistant] recording a continuation's end failed:", error));
    await releaseThread(input.threadId);
  }
}

/** An owner message of this chat, by id (the request a finished job served), or null. */
async function ownerMessageInThread(threadId: string, messageId: string): Promise<{ id: string; content: string } | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(messageId)) return null;
  const [row] = await db.select({ id: assistantMessages.id, content: assistantMessages.content }).from(assistantMessages)
    .where(and(inOrg(assistantMessages), eq(assistantMessages.id, messageId), eq(assistantMessages.threadId, threadId), eq(assistantMessages.role, "user"))).limit(1);
  return row ?? null;
}

/** In Autonomous mode, starts the plan a tool just prepared; true when it started (or the chat is not autonomous). */
async function startedOnItsOwn(threadId: string, autonomous: boolean, data: Record<string, unknown> | undefined): Promise<boolean> {
  if (!autonomous) return true;
  const runId = typeof data?.runId === "string" ? data.runId : null;
  if (!runId) return false;
  const outcome = await autoStartPlan(threadId, runId);
  // Switched off while this turn ran: the plan waits for Start, as without Autonomous mode.
  if (outcome.off) {
    await addMessage({ threadId, role: "event", content: "Autonomous mode is off now, so this plan was not started on its own. Check it below and press Start." });
  }
  return outcome.started;
}

/**
 * Lets the assistant continue on its own after a background job reported
 * into the thread (a search finished), the way it would after an owner
 * message. Skipped when a turn is already running: that turn sees the event.
 */
export async function continueAfterEvent(threadId: string, requestId: string | null = null): Promise<void> {
  try {
    await runAgentTurn({ threadId, userId: null, text: null, eventRequestId: requestId });
  } catch (error) {
    if (!(error instanceof AssistantBusyError)) console.error("[assistant] continuing after an event failed:", error);
  }
}


/** The system prompt a chat turn sends, for the live model checks (scripts/e2e/aiml-live.ts). */
export { systemPrompt as assistantSystemPrompt };

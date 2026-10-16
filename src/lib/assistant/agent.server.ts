import "server-only";

import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { completeStructured } from "@/lib/ai/server/structuredCompletion";
import { crmKnowledgeDocuments, crmKnowledgeDocumentVersions } from "@/lib/crm/schema";
import { BRAND } from "@/lib/brand";
import { inOrg } from "@/lib/tenancy/scope";
import type { FeatureState } from "@/lib/features/catalog";
import { featureState } from "@/lib/features/flags.server";
import { actionsProblem, agentReplySchema, inquiryRepliesRequested, isSmallTalk, MAX_STEPS, parseAgentReply, pendingOutreachRequestIndex, sameMessage, standingOutreachRequestIndex, transcriptText, unbackedClaim, type AgentReply } from "./agent";
import { AUTONOMOUS_MAX_STEPS, autonomousRules, SEARCH_TOOLS, searchCapProblem, type AutonomyCaps } from "./autonomy";
import { autonomousSearchesToday, autonomyCaps, autoStartPlan, threadAutonomy } from "./autonomy.server";
import { listAudiences } from "./audiences.server";
import { listOpenDecisions } from "./decisions.server";
import { listRuns } from "./outreach.server";
import { assistantJobs, type AssistantAttachment, type BusinessProfile } from "./schema";
import { addMessage, claimThread, listMessages, releaseThread, touchThread, updateMessage } from "./threads.server";
import { recordUsage } from "./usage.server";
import { runTool, setupSnapshot, toolCatalog, toolNamesFor, type ToolContext, type ToolResult } from "./tools.server";

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
    "",
    "RULES",
    "1. Act with tools. A tool's result is the only proof something happened. Never say something was saved, searched, found, prepared, started, sent or paused unless a TOOL line in the conversation shows it succeeded. If a tool failed, say so plainly with its reason.",
    "2. You cannot start outreach. After prepare_outreach succeeds, ask the owner to review the plan card (audience, sample messages, limits, cost), choose Automatic or Review replies, and press Start. Outreach runs only after that, and only within that plan's leads, channels and limits. To contact more people, change channels or raise limits, prepare a new plan (basedOnRunId reuses a run's messages): the owner approves it again. One Start can cover a whole request: when one request makes several plans (for example one search per city with contactAfter), the plan card offers \"apply to the rest of this request\"; with it, the request's other plans start on their own as they are ready, in the same reply mode and within the same channels and limits, so the owner does not approve each one. Tell the owner this once when you start several searches for one request.",
    "3. Ask only for what the next step needs, one or two questions at a time. Read the BUSINESS PROFILE, ALREADY KNOWN ELSEWHERE and SETUP first and never ask for what is already there: a price list document answers price questions, a sender name the accounts already use is the sender, saved reply instructions already apply. Ask only for what STILL MISSING lists. For a lead search you need the kind of customers and where; for outreach, the business name, the offer and the sender's name. If the owner describes a different business from the BUSINESS PROFILE, save the new details and ask before relying on older ones that may belong to the previous business (places, website, prices, booking details).",
    "4. When the owner tells you anything about the business, customers, places, offer, the problems it solves, prices, service area, sender, tone, preferences or what an interested lead should be offered next (a call, a visit, a quote), call save_business_info in the same response, so it is remembered and automatic replies can use it. Replies to leads sell from problemsSolved and lead to nextStep (a short call with the sender when not set): before the first outreach, if problemsSolved is empty, ask once which problems the offer solves for customers; never block outreach on it. Attached documents are already saved to knowledge; contact lists are already imported (see the attachment TOOL lines).",
    "5. Prepare outreach only when the owner's latest message asks to contact, email, message or pitch people, or says yes to your offer of it. If they only gave information or asked a question, answer or save it and offer outreach in one sentence. 'Find leads and contact them': call find_leads with contactAfter true; the plan is then prepared automatically when the search ends. 'Use this list': call prepare_outreach for the audience the import created. Do not check a search's progress right after starting it; its result is announced.",
    "5b. There are two starting points, and both end in the same lead lists, plan card, Start button, replies and decisions. (1) The owner's existing leads or inquiries: use_existing_leads makes a list from people already saved (everyone, the latest import, a word to match, or the people who sent inquiries), or they attach a list or type contacts. Prefer this when they say they already have leads, contacts, customers or inquiries. (2) Finding potential customers for them: the lead sources in rule 6. Lead finding is optional: never push it on an owner who has contacts. A found lead is a potential match, not an interested customer: say so, and never call anyone interested unless a reply was classified interested. A follow, like or generic comment is not interest. Unknown location, budget or contact details stay unknown.",
    `6. Lead sources: (a) find_leads — businesses with a public Google Maps listing, then each business's own website (home and contact pages) for the emails, phones and LinkedIn pages it publishes; (b) find_linkedin_leads — people on LinkedIn by keywords, when a LinkedIn account is connected (profiles only, contacted on LinkedIn); (c) contact lists the owner attaches; (d) contacts the owner types in the chat — call add_contacts with exactly what they wrote (contactAfter true when they asked to contact, message or pitch them; the plan then follows by itself); read back the saved numbers. A phone number without + and a country code is refused when no Default phone country is set: ask which country, never guess. (e) read_webpage opens a link the owner gives (their website, a page listing people) and reads its text and contacts. ${features.web_discovery ? "(f) find_customers_on_web — a real web search (through the organization's web-searching AI provider) for businesses' own websites and directories matching the owner's customer description in a place, then their published contacts, each with the page it came from; when Instagram is connected it also reads public Instagram profiles and post comments the search found, but Instagram-only people cannot be messaged first. You cannot search Instagram, Facebook or TikTok by keyword or hashtag, and you cannot read pages behind a login; say so plainly when asked." : "You cannot search the web and cannot read Instagram, Facebook, X, TikTok or LinkedIn pages (they need a login); say so plainly when asked, and offer what you can do instead."} One find_leads call covers one kind of business in one city or district (about 20 businesses per area it searches); you can run up to 4 at once, one per city or kind. For a country or large region, or when the owner leaves the place to you ('any city', 'wherever there are most'), choose yourself: the 3 largest cities for that kind of business in that country (or near the owner's locations), name them, and start one search per city in the same response. Ask about the place only when you know neither the country nor the owner's area. Never invent contacts, emails, phones, profiles, prices or results.`,
    ...(features.apify_discovery
      ? ["6b. Apify (paid, the owner's own account): find_leads uses Apify's Google Maps Scraper when it is set up and within budget, else the other searches — say which the TOOL line reports, and any limitation it gives. find_instagram_prospects finds Instagram accounts through approved Apify Actors. Always keep apart finding an Instagram account and being able to contact it: AgentSDR cannot start Instagram chats, so only accounts that publish an email or phone can be contacted; never promise Instagram outreach. Never offer to top up, upgrade or raise Apify limits."]
      : []),
    ...(features.instagram
      ? [`7b. Instagram: the organization's Instagram direct messages arrive in the inbox and in Action required like other replies. You never start Instagram conversations.${features.inquiry_intake ? " When the owner asks for new Instagram inquiries to be answered, call prepare_inquiry_replies; after they press Start (Automatic or Review), people whose first message arrives from then on are answered under that run's mode and checks, never imported history or earlier chats. list_inquiries shows recent website-form and Instagram inquiries." : ""}`]
      : []),
    "7. Replies: each run is in Automatic or Review mode. In Automatic mode ordinary replies are answered from the owner's saved information; anything the information does not cover, complaints, negotiations, promises and meetings come to the owner as a DECISION with the reason. When the owner answers an OPEN DECISION, call answer_decision with their words; it is saved and the reply is rewritten. You may switch runs to Review (switch_to_review); only the owner's button switches a run to Automatic.",
    "8. If a channel is not connected, say which one and where to connect it (Settings). If AI or lead search is not set up on this server, say the operator who installed it must set it up.",
    "9. Write like a capable assistant, in the owner's language: short sentences, no hype, no emojis, no markdown headings. Use ids only inside tool arguments, never in what you say.",
    "10. You may run several tools at once; you will then see their results and can continue. Return no actions when you are waiting for the owner or for a background job.",
    "11. A message sent together with tools is shown after they run (and dropped if one fails); do not ask permission for what you are already doing. After the results, say only what is new; never repeat your earlier message. If there is nothing new to say or do, return an empty message and no actions.",
    "12. For results (leads found, messages sent, replies, interested people, what waits for the owner, spending), call report; never estimate figures yourself.",
    "13. When the owner greets you, thanks you or chats, answer in one or two warm, natural sentences and offer the one next step that fits them: with an empty BUSINESS PROFILE, ask what the business sells and to whom (or to attach a brochure or a contact list); with a complete one, offer to find customers or show results. Run no tools for small talk, and never save information the owner did not give.",
    "14. suggestions: up to three short replies the owner might send next, in their own words and language (e.g. \"We sell dental equipment servicing in Pune\", \"Find dental clinics in Pune and contact them\", \"Show today's results\"). Suggest only what you could act on; none while a plan card waits for Start or a decision card waits for an answer.",
    ...(autonomy ? ["", ...autonomousRules(autonomy), "These autonomous rules override rules 2, 5, 10, 11 and 14 where they differ: plans start on their own, you do not offer and wait, and you keep going."] : []),
    "",
    "TOOLS",
    toolCatalog(features),
  ].join("\n");
}

async function contextBlock(): Promise<{ text: string; outreachStarted: boolean; profile: BusinessProfile }> {
  const setup = await setupSnapshot();
  const [audiences, runs, jobs, decisions] = await Promise.all([
    listAudiences(8),
    listRuns(8),
    db.select({ id: assistantJobs.id, kind: assistantJobs.kind, status: assistantJobs.status, stage: assistantJobs.stage, audienceId: assistantJobs.audienceId, runId: assistantJobs.runId })
      .from(assistantJobs).where(and(inOrg(assistantJobs), inArray(assistantJobs.status, ["queued", "running"]))).orderBy(desc(assistantJobs.createdAt)).limit(5),
    listOpenDecisions(8),
  ]);
  const channels = Object.entries(setup.channels)
    .map(([name, status]) => `${name} ${status.available ? `ready (${status.senders})` : `not ready: ${status.reason}`}`).join("; ");
  const text = [
    `TODAY: ${new Date().toISOString().slice(0, 10)}`,
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
  const row = await addMessage({ threadId: context.threadId, role: "tool", tool, toolInput: args, status: "running", content: "" });
  const result = await runTool(tool, args, context);
  await updateMessage(row.id, {
    status: result.ok ? "ok" : "error",
    content: result.summary,
    toolResult: { summary: result.summary, ...(result.display ? { display: result.display } : {}), ...(result.data ? { data: result.data } : {}), ...(result.refused ? { hidden: true } : {}) },
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
}): Promise<void> {
  if (!(await claimThread(input.threadId))) throw new AssistantBusyError();
  let heartbeat: ReturnType<typeof setInterval> | null = null;
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
    const ownerText = input.text ?? history[lastOwnerIndex]?.content ?? "";
    // The assistant's last words before the owner's message: a "yes" to an offer of outreach is a request for it.
    const lastAssistantText = [...history.slice(0, Math.max(0, lastOwnerIndex))].reverse().find((message) => message.role === "assistant")?.content ?? null;
    // In Autonomous mode the owner's request to contact people stands for the work that follows it.
    const requestIndex = pendingOutreachRequestIndex(history) ?? (autonomy.on ? standingOutreachRequestIndex(history) : null);
    const outreachRequest = requestIndex === null ? null : history[requestIndex]!.content;
    // The owner's message that asked, by id: one Start may cover the plans of exactly this request.
    const outreachRequestId = requestIndex === null ? null : history[requestIndex]!.id;
    const context: ToolContext = { threadId: input.threadId, userId: input.userId, ownerText, lastAssistantText, outreachRequest, outreachRequestId, autonomous: autonomy.on };
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
    // A long turn keeps the thread claimed: one step (writing a plan) can take minutes.
    heartbeat = setInterval(() => void touchThread(input.threadId).catch(() => undefined), 60_000);
    for (let step = 0; step < maxSteps; step += 1) {
      const { text: setupText, outreachStarted, profile } = await contextBlock();
      const messages = await listMessages(input.threadId, 80);
      // What the owner wrote or attached: business information is saved only from it.
      const ownerCorpus = messages
        .filter((message) => message.role === "user" || (message.role === "tool" && (message.tool === "read_document" || message.tool === "import_contacts" || (message.tool === "read_webpage" && message.status === "ok"))))
        .map((message) => `${message.content} ${typeof message.toolResult?.summary === "string" ? message.toolResult.summary : ""}`)
        .join("\n") + `\n${documentsText}`;
      let reply: AgentReply | null = null;
      try {
        const completion = await completeStructured({
          timeoutMs: 90_000,
          maxOutputTokens: 1_500,
          schemaName: "assistant_reply",
          schemaDescription: "Your message to the owner and the tools to run now.",
          jsonSchema: agentReplySchema(toolNames),
          systemPrompt: systemPrompt(features, caps),
          userPrompt: `${setupText}\n\nCONVERSATION (newest last):\n${transcriptText(messages)}\n\nYour turn.`,
          accept: (text) => {
            const parsed = parseAgentReply(text, toolNames, { allowEmpty: step > 0 });
            const refused = actionsProblem(parsed.actions, { smallTalk, profile, ownerCorpus, outreachRequested: askedForOutreach, inquiryRepliesRequested: askedForInquiryReplies });
            if (refused) throw new Error(refused);
            // A message sent with tools is checked against their results below.
            // In Autonomous mode a plan prepared in this step starts on its own; if it does not, the message is not shown (below).
            const startsNow = autonomy.on && parsed.actions.some((action) => action.tool === "prepare_outreach");
            const problem = unbackedClaim(parsed.message, parsed.actions.length ? ["(pending)"] : succeeded, outreachStarted || startsNow);
            if (problem) throw new Error(problem);
            reply = parsed;
          },
        });
        await recordUsage("assistant", completion);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await addMessage({
          threadId: input.threadId,
          role: "event",
          content: /AI provider|AI Settings|default model|Connect an AI/i.test(message)
            ? `The assistant needs an AI provider: ${message}`
            : `The assistant could not answer (${message.slice(0, 300)}). Try again in a moment.`,
        });
        return;
      }
      const { message, actions, suggestions } = reply as unknown as AgentReply;
      if (!actions.length) {
        // The suggested replies ride on the turn's last message (shown as buttons).
        if (message && !said.some((earlier) => sameMessage(earlier, message))) {
          await addMessage({ threadId: input.threadId, role: "assistant", content: message, toolResult: suggestions.length ? { suggestions } : null });
        }
        return;
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
        const result = await runToolInThread(context, action.tool, action.args);
        if (result.ok) succeeded.push(action.tool);
        else allOk = false;
        // Autonomous: the plan starts now; when a cap stops it the message is held and the next step explains.
        if (action.tool === "prepare_outreach" && result.ok && !(await startedOnItsOwn(input.threadId, autonomy.on, result.data))) allOk = false;
        // Contacts the owner asked to reach get their plan straight away, as a "find and contact" search does.
        const audienceId = typeof result.data?.audienceId === "string" ? result.data.audienceId : null;
        if (action.tool === "add_contacts" && result.ok && action.args.contactAfter === true && askedForOutreach && audienceId && !actions.some((other) => other.tool === "prepare_outreach")) {
          const channels = Array.isArray(action.args.channels) ? { channels: action.args.channels } : {};
          const plan = await runToolInThread(context, "prepare_outreach", { audienceId, ...channels });
          if (plan.ok) succeeded.push("prepare_outreach");
          else allOk = false;
          if (plan.ok && !(await startedOnItsOwn(input.threadId, autonomy.on, plan.data))) allOk = false;
        }
      }
      // Shown only when every tool in this step worked: after a failure the
      // next step says what happened instead of what was hoped for.
      if (message && allOk && !said.some((earlier) => sameMessage(earlier, message))) {
        said.push(message);
        await addMessage({ threadId: input.threadId, role: "assistant", content: message });
        // A question to the owner ends the turn: their answer decides what happens next.
        // In Autonomous mode it does not: a real question comes with no actions and ends the turn anyway.
        if (!autonomy.on && message.trim().endsWith("?")) return;
      }
    }
    await addMessage({
      threadId: input.threadId,
      role: "event",
      content: autonomy.on
        ? `I paused after ${maxSteps} steps so I don't go round in circles. I continue when a search finishes, or tell me what to do next.`
        : "I stopped here so I don't go round in circles. Tell me how you'd like to continue.",
    });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await releaseThread(input.threadId);
  }
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
export async function continueAfterEvent(threadId: string): Promise<void> {
  try {
    await runAgentTurn({ threadId, userId: null, text: null });
  } catch (error) {
    if (!(error instanceof AssistantBusyError)) console.error("[assistant] continuing after an event failed:", error);
  }
}


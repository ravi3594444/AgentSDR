import "server-only";

import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { completeStructured } from "@/lib/ai/server/structuredCompletion";
import { crmKnowledgeDocuments, crmKnowledgeDocumentVersions } from "@/lib/crm/schema";
import { BRAND } from "@/lib/brand";
import { inOrg } from "@/lib/tenancy/scope";
import { actionsProblem, agentReplySchema, isSmallTalk, MAX_STEPS, parseAgentReply, pendingOutreachRequest, sameMessage, transcriptText, unbackedClaim, type AgentReply } from "./agent";
import { listAudiences } from "./audiences.server";
import { listOpenDecisions } from "./decisions.server";
import { listRuns } from "./outreach.server";
import { assistantJobs, type AssistantAttachment, type BusinessProfile } from "./schema";
import { addMessage, claimThread, listMessages, releaseThread, updateMessage } from "./threads.server";
import { recordUsage } from "./usage.server";
import { runTool, setupSnapshot, TOOL_NAMES, toolCatalog, type ToolContext, type ToolResult } from "./tools.server";

/**
 * One turn of the owner's assistant. The model answers with a message and
 * the tools to run; the server runs them, records each result in the chat,
 * and asks again with the results, until the model has nothing more to do
 * (at most MAX_STEPS). Every reply passes `accept`: unknown tools, bad
 * arguments and claims of actions no tool performed are rejected and the
 * model is asked again with the reason, so the chat never says something
 * happened that did not.
 */

function systemPrompt(): string {
  return [
    `You are the outreach assistant inside ${BRAND.name}. You work for the owner of a business: you learn about the business, find leads, prepare outreach and report on it, by calling tools. You are honest and brief.`,
    "",
    "RULES",
    "1. Act with tools. A tool's result is the only proof something happened. Never say something was saved, searched, found, prepared, started, sent or paused unless a TOOL line in the conversation shows it succeeded. If a tool failed, say so plainly with its reason.",
    "2. You cannot start outreach. After prepare_outreach succeeds, ask the owner to review the plan card (audience, sample messages, limits, cost), choose Automatic or Review replies, and press Start. Outreach runs only after that, and only within that plan's leads, channels and limits. To contact more people, change channels or raise limits, prepare a new plan (basedOnRunId reuses a run's messages): the owner approves it again.",
    "3. Ask only for what the next step needs, one or two questions at a time. Read the BUSINESS PROFILE and SETUP first and never ask for what is already there. For a lead search you need the kind of customers and where; for outreach, the business name, the offer and the sender's name. If the owner describes a different business from the BUSINESS PROFILE, save the new details and ask before relying on older ones that may belong to the previous business (places, website, prices, booking details).",
    "4. When the owner tells you anything about the business, customers, places, offer, prices, service area, sender, tone or preferences, call save_business_info in the same response, so it is remembered and automatic replies can use it. Attached documents are already saved to knowledge; contact lists are already imported (see the attachment TOOL lines).",
    "5. Prepare outreach only when the owner's latest message asks to contact, email, message or pitch people, or says yes to your offer of it. If they only gave information or asked a question, answer or save it and offer outreach in one sentence. 'Find leads and contact them': call find_leads with contactAfter true; the plan is then prepared automatically when the search ends. 'Use this list': call prepare_outreach for the audience the import created. Do not check a search's progress right after starting it; its result is announced.",
    "6. Lead search reads public Google Maps listings and each business's own website. It finds businesses, not private individuals, and only those with a public listing. One search covers one kind of business in a city or district (about 20 businesses per area searched): for two kinds of business run two searches; for a country or a large region, ask which cities to search and run one search per city. Say so when results are few, and suggest other words or nearby places. Never invent contacts, emails, phones, profiles, prices or results.",
    "7. Replies: each run is in Automatic or Review mode. In Automatic mode ordinary replies are answered from the owner's saved information; anything the information does not cover, complaints, negotiations, promises and meetings come to the owner as a DECISION with the reason. When the owner answers an OPEN DECISION, call answer_decision with their words; it is saved and the reply is rewritten. You may switch runs to Review (switch_to_review); only the owner's button switches a run to Automatic.",
    "8. If a channel is not connected, say which one and where to connect it (Settings). If AI or lead search is not set up on this server, say the operator who installed it must set it up.",
    "9. Write like a capable assistant, in the owner's language: short sentences, no hype, no emojis, no markdown headings. Use ids only inside tool arguments, never in what you say.",
    "10. You may run several tools at once; you will then see their results and can continue. Return no actions when you are waiting for the owner or for a background job.",
    "11. A message sent together with tools is shown after they run (and dropped if one fails); do not ask permission for what you are already doing. After the results, say only what is new; never repeat your earlier message. If there is nothing new to say or do, return an empty message and no actions.",
    "12. For results (leads found, messages sent, replies, interested people, what waits for the owner, spending), call report; never estimate figures yourself.",
    "13. When the owner greets you, thanks you or chats, answer in one or two warm, natural sentences and offer the one next step that fits them: with an empty BUSINESS PROFILE, ask what the business sells and to whom (or to attach a brochure or a contact list); with a complete one, offer to find customers or show results. Run no tools for small talk, and never save information the owner did not give.",
    "14. suggestions: up to three short replies the owner might send next, in their own words and language (e.g. \"We sell dental equipment servicing in Pune\", \"Find dental clinics in Pune and contact them\", \"Show today's results\"). Suggest only what you could act on; none while a plan card waits for Start or a decision card waits for an answer.",
    "",
    "TOOLS",
    toolCatalog(),
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
    `STILL MISSING: for a lead search ${setup.missingForDiscovery.join(", ") || "nothing"}; for outreach ${setup.missingForOutreach.join(", ") || "nothing"}.`,
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
  try {
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
    const outreachRequest = pendingOutreachRequest(history);
    const context: ToolContext = { threadId: input.threadId, userId: input.userId, ownerText, lastAssistantText, outreachRequest };
    const askedForOutreach = outreachRequest !== null;
    const said: string[] = [];
    // A greeting or thanks runs no tools (see actionsProblem).
    const smallTalk = input.text !== null && !input.attachments?.length && isSmallTalk(input.text);
    const documentsText = smallTalk ? "" : await ownerDocumentsText();
    const succeeded: string[] = [];
    for (let step = 0; step < MAX_STEPS; step += 1) {
      const { text: setupText, outreachStarted, profile } = await contextBlock();
      const messages = await listMessages(input.threadId, 80);
      // What the owner wrote or attached: business information is saved only from it.
      const ownerCorpus = messages
        .filter((message) => message.role === "user" || (message.role === "tool" && (message.tool === "read_document" || message.tool === "import_contacts")))
        .map((message) => `${message.content} ${typeof message.toolResult?.summary === "string" ? message.toolResult.summary : ""}`)
        .join("\n") + `\n${documentsText}`;
      let reply: AgentReply | null = null;
      try {
        const completion = await completeStructured({
          timeoutMs: 90_000,
          maxOutputTokens: 1_500,
          schemaName: "assistant_reply",
          schemaDescription: "Your message to the owner and the tools to run now.",
          jsonSchema: agentReplySchema(TOOL_NAMES),
          systemPrompt: systemPrompt(),
          userPrompt: `${setupText}\n\nCONVERSATION (newest last):\n${transcriptText(messages)}\n\nYour turn.`,
          accept: (text) => {
            const parsed = parseAgentReply(text, TOOL_NAMES, { allowEmpty: step > 0 });
            const refused = actionsProblem(parsed.actions, { smallTalk, profile, ownerCorpus, outreachRequested: askedForOutreach });
            if (refused) throw new Error(refused);
            // A message sent with tools is checked against their results below.
            const problem = unbackedClaim(parsed.message, parsed.actions.length ? ["(pending)"] : succeeded, outreachStarted);
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
        const result = await runToolInThread(context, action.tool, action.args);
        if (result.ok) succeeded.push(action.tool);
        else allOk = false;
      }
      // Shown only when every tool in this step worked: after a failure the
      // next step says what happened instead of what was hoped for.
      if (message && allOk && !said.some((earlier) => sameMessage(earlier, message))) {
        said.push(message);
        await addMessage({ threadId: input.threadId, role: "assistant", content: message });
        // A question to the owner ends the turn: their answer decides what happens next.
        if (message.trim().endsWith("?")) return;
      }
    }
    await addMessage({ threadId: input.threadId, role: "event", content: "I stopped here so I don't go round in circles. Tell me how you'd like to continue." });
  } finally {
    await releaseThread(input.threadId);
  }
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


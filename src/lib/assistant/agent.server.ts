import "server-only";

import { and, desc, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { completeStructured } from "@/lib/ai/server/structuredCompletion";
import { BRAND } from "@/lib/brand";
import { inOrg } from "@/lib/tenancy/scope";
import { agentReplySchema, MAX_STEPS, parseAgentReply, transcriptText, unbackedClaim, type AgentReply } from "./agent";
import { listAudiences } from "./audiences.server";
import { listRuns } from "./outreach.server";
import { assistantJobs, type AssistantAttachment } from "./schema";
import { addMessage, claimThread, listMessages, releaseThread, updateMessage } from "./threads.server";
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
    "2. You cannot start outreach. After prepare_outreach succeeds, ask the owner to review the plan card (audience, sample messages, limits, cost) and press Start. Outreach runs only after that.",
    "3. Ask only for what the next step needs, one or two questions at a time. Read the BUSINESS PROFILE and SETUP first and never ask for what is already there. For a lead search you need the kind of customers and where; for outreach, the business name, the offer and the sender's name.",
    "4. When the owner tells you anything about the business, customers, places, offer, sender, tone or preferences, call save_business_info in the same response, so it is remembered. Attached documents are already saved to knowledge; contact lists are already imported (see the attachment TOOL lines).",
    "5. 'Find leads and contact them': if customers and place are known, call find_leads; it runs in the background and its result appears as an EVENT. When an EVENT shows a search finished with contactable leads and the owner asked for outreach, call prepare_outreach for that audience. 'Use this list': call prepare_outreach for the audience the import created. Prepare outreach only when the owner asked for outreach or to contact leads; otherwise offer it. When the owner asks to find AND contact leads, call find_leads with contactAfter true: the plan is then prepared automatically when the search ends. Do not check a search's progress right after starting it; its result is announced.",
    "6. Lead search reads public Google Maps listings and each business's own website. It finds businesses, not private individuals, and only those with a public listing. Say so when results are few, and suggest other words or a wider area. Never invent contacts, emails, phones, profiles, prices or results.",
    "7. If a channel is not connected, say which one and where to connect it (Settings). If AI or lead search is unavailable, say so.",
    "8. Write like a capable assistant, in the owner's language: short sentences, no hype, no emojis, no markdown headings. Use ids only inside tool arguments, never in what you say.",
    "9. You may run several tools at once; you will then see their results and can continue. Return no actions when you are waiting for the owner or for a background job.",
    "10. A message sent together with tools is shown after they run (and dropped if one fails); do not ask permission for what you are already doing. After the results, say only what is new; never repeat your earlier message. If there is nothing new to say or do, return an empty message and no actions.",
    "",
    "TOOLS",
    toolCatalog(),
  ].join("\n");
}

async function contextBlock(): Promise<{ text: string; outreachStarted: boolean }> {
  const setup = await setupSnapshot();
  const [audiences, runs, jobs] = await Promise.all([
    listAudiences(8),
    listRuns(8),
    db.select({ id: assistantJobs.id, kind: assistantJobs.kind, status: assistantJobs.status, stage: assistantJobs.stage, audienceId: assistantJobs.audienceId, runId: assistantJobs.runId })
      .from(assistantJobs).where(and(inOrg(assistantJobs), inArray(assistantJobs.status, ["queued", "running"]))).orderBy(desc(assistantJobs.createdAt)).limit(5),
  ]);
  const channels = Object.entries(setup.channels)
    .map(([name, status]) => `${name} ${status.available ? `ready (${status.senders})` : `not ready: ${status.reason}`}`).join("; ");
  const text = [
    `TODAY: ${new Date().toISOString().slice(0, 10)}`,
    `BUSINESS PROFILE: ${JSON.stringify(setup.profile)}`,
    `SETUP: channels — ${channels}. Lead search — ${setup.leadDiscovery.available ? "ready (Google Maps)" : setup.leadDiscovery.reason}. AI — ${setup.ai.connected ? "connected" : "not connected"}. Reply autopilot — ${setup.autopilot ? "on" : "off"}.`,
    `STILL MISSING: for a lead search ${setup.missingForDiscovery.join(", ") || "nothing"}; for outreach ${setup.missingForOutreach.join(", ") || "nothing"}.`,
    `LEAD LISTS: ${audiences.map((a) => `${a.id} “${a.name}” ${a.eligible}/${a.total} contactable`).join("; ") || "none"}`,
    `OUTREACH RUNS: ${runs.map((r) => `${r.id} “${r.name}” ${r.status}`).join("; ") || "none"}`,
    `BACKGROUND JOBS: ${jobs.map((j) => `${j.kind} ${j.id} ${j.status} (${j.stage})`).join("; ") || "none"}`,
  ].join("\n");
  return { text, outreachStarted: runs.some((run) => ["running", "paused", "completed", "starting"].includes(run.status)) };
}

/** Runs one tool and records it in the thread: a "running" card first, then its result. */
export async function runToolInThread(context: ToolContext, tool: string, args: Record<string, unknown>): Promise<ToolResult> {
  const row = await addMessage({ threadId: context.threadId, role: "tool", tool, toolInput: args, status: "running", content: "" });
  const result = await runTool(tool, args, context);
  await updateMessage(row.id, {
    status: result.ok ? "ok" : "error",
    content: result.summary,
    toolResult: { summary: result.summary, ...(result.display ? { display: result.display } : {}), ...(result.data ? { data: result.data } : {}) },
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

    const context: ToolContext = { threadId: input.threadId, userId: input.userId };
    const succeeded: string[] = [];
    for (let step = 0; step < MAX_STEPS; step += 1) {
      const { text: setupText, outreachStarted } = await contextBlock();
      const messages = await listMessages(input.threadId, 80);
      let reply: AgentReply | null = null;
      try {
        await completeStructured({
          timeoutMs: 90_000,
          maxOutputTokens: 1_500,
          schemaName: "assistant_reply",
          schemaDescription: "Your message to the owner and the tools to run now.",
          jsonSchema: agentReplySchema(TOOL_NAMES),
          systemPrompt: systemPrompt(),
          userPrompt: `${setupText}\n\nCONVERSATION (newest last):\n${transcriptText(messages)}\n\nYour turn.`,
          accept: (text) => {
            const parsed = parseAgentReply(text, TOOL_NAMES, { allowEmpty: step > 0 });
            // A message sent with tools is checked against their results below.
            const problem = unbackedClaim(parsed.message, parsed.actions.length ? ["(pending)"] : succeeded, outreachStarted);
            if (problem) throw new Error(problem);
            reply = parsed;
          },
        });
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
      const { message, actions } = reply as unknown as AgentReply;
      if (!actions.length) {
        if (message) await addMessage({ threadId: input.threadId, role: "assistant", content: message });
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
      if (message && (allOk || !unbackedClaim(message, [], true))) {
        await addMessage({ threadId: input.threadId, role: "assistant", content: message });
        // A question to the owner ends the turn: their answer decides what happens next.
        if (message.trim().endsWith("?")) return;
      }
    }
    await addMessage({ threadId: input.threadId, role: "event", content: "The assistant stopped after several steps in one turn; tell it how to continue." });
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


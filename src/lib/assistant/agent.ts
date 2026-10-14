import type { AssistantRole } from "./schema";

/**
 * The assistant's turn, pure parts: the reply schema the model fills, how
 * its actions are parsed and checked, how the conversation is shown to it,
 * and the guard against a reply that claims an action no tool performed.
 */

export const MAX_STEPS = 6;
export const MAX_ACTIONS_PER_STEP = 4;

export function agentReplySchema(toolNames: readonly string[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["message", "actions"],
    properties: {
      message: { type: "string", description: "What you say to the owner now. Empty only when you are about to act and have nothing to add." },
      actions: {
        type: "array",
        description: "Tools to run now, in order. Empty when there is nothing to do until the owner answers.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["tool", "arguments"],
          properties: {
            tool: { type: "string", enum: [...toolNames] },
            arguments: { type: "string", description: "The tool's arguments as a JSON object, e.g. {\"what\":\"dental clinics\",\"where\":\"Pune, India\"}; {} for none." },
          },
        },
      },
    },
  };
}

export type AgentAction = { tool: string; args: Record<string, unknown> };
export type AgentReply = { message: string; actions: AgentAction[] };

/**
 * The model's reply, or an error saying exactly what to fix (fed back on
 * retry). `allowEmpty`: after tool results, an empty reply means the turn is
 * over with nothing new to say.
 */
export function parseAgentReply(text: string, toolNames: readonly string[], options: { allowEmpty?: boolean } = {}): AgentReply {
  let body: { message?: unknown; actions?: unknown };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new Error("Answer with the JSON object only.");
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!Array.isArray(body.actions)) throw new Error("actions must be an array (empty for none).");
  if (body.actions.length > MAX_ACTIONS_PER_STEP) throw new Error(`Run at most ${MAX_ACTIONS_PER_STEP} tools at once.`);
  const actions: AgentAction[] = body.actions.map((raw, index) => {
    const item = (raw ?? {}) as { tool?: unknown; arguments?: unknown };
    const tool = typeof item.tool === "string" ? item.tool : "";
    if (!toolNames.includes(tool)) throw new Error(`actions[${index}].tool "${tool}" does not exist; use one of ${toolNames.join(", ")}.`);
    let args: unknown = {};
    if (typeof item.arguments === "string" && item.arguments.trim()) {
      try {
        args = JSON.parse(item.arguments);
      } catch {
        throw new Error(`actions[${index}].arguments must be a JSON object written as a string, e.g. "{\\"audienceId\\":\\"…\\"}".`);
      }
    } else if (item.arguments && typeof item.arguments === "object") {
      args = item.arguments;
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error(`actions[${index}].arguments must be a JSON object.`);
    return { tool, args: args as Record<string, unknown> };
  });
  if (!message && !actions.length && !options.allowEmpty) throw new Error("Say something to the owner or run a tool.");
  return { message, actions };
}

const CLAIMS_DONE = /\b(?:i|we)(?:'ve|’ve| have)?\s+(?:just\s+|now\s+|already\s+|successfully\s+)?(?:saved|stored|noted down|recorded|searched|started|launched|sent|scheduled|paused|resumed|imported|uploaded|created|prepared|found|added|turned (?:on|off)|set up)\b/i;
const OUTREACH_LIVE = /\b(?:outreach|campaign|emails?|messages?)\s+(?:is|are|has been|have been)\s+(?:now\s+)?(?:live|running|started|launched|sent|on (?:its|their) way)\b/i;

/**
 * A reply that says something was done although no tool succeeded in this
 * turn, or says outreach is running although the conversation holds no
 * record of it starting. Returns the reason, or null. (A message sent with
 * tools is shown only after they ran; agent.server.ts drops it when one failed.)
 */
export function unbackedClaim(message: string, succeededThisTurn: readonly string[], outreachStartedOnRecord: boolean): string | null {
  if (!succeededThisTurn.length && CLAIMS_DONE.test(message)) {
    return "Your message says something was done, but no tool has succeeded in this turn. Put the tool in actions, or say what you will do instead.";
  }
  if (!outreachStartedOnRecord && OUTREACH_LIVE.test(message)) {
    return "Your message says outreach is running or sent, but nothing in this conversation shows it started. Only the owner's Start button starts outreach.";
  }
  return null;
}

export type TranscriptMessage = {
  role: AssistantRole;
  content: string;
  tool: string | null;
  toolInput: Record<string, unknown> | null;
  toolResult: Record<string, unknown> | null;
  status: string | null;
  attachments: { name: string }[];
};

/** The conversation as the model reads it: newest last, tool results by their summary. */
export function transcriptText(messages: readonly TranscriptMessage[], maxChars = 24_000): string {
  const lines = messages.map((message) => {
    if (message.role === "user") {
      const files = message.attachments.length ? ` [attached: ${message.attachments.map((file) => file.name).join(", ")}]` : "";
      return `OWNER: ${message.content}${files}`;
    }
    if (message.role === "assistant") return `ASSISTANT: ${message.content}`;
    if (message.role === "event") return `EVENT: ${message.content}`;
    const summary = typeof message.toolResult?.summary === "string" ? message.toolResult.summary : message.content;
    const args = message.toolInput && Object.keys(message.toolInput).length ? JSON.stringify(message.toolInput).slice(0, 300) : "";
    return `TOOL ${message.tool}(${args}) → ${message.status ?? "?"}: ${summary.slice(0, 1_500)}`;
  });
  let text = lines.join("\n");
  while (text.length > maxChars && lines.length > 4) {
    lines.splice(0, 1);
    text = `(earlier conversation omitted)\n${lines.join("\n")}`;
  }
  return text;
}

/** Shared by the reply worker and its send-free provider diagnostic. */
export const AGENT_ACTIONS = ["reply", "tell_owner", "stop_contact", "no_reply", "wrong_number"] as const;
export const OWNER_NOTE_KINDS = ["ready", "person", "complaint", "question", "other"] as const;
export const AGENT_CATEGORIES = ["interested", "not_interested", "other"] as const;

export const DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reasoning", "action", "reply", "ownerNote", "category", "confidence"],
  properties: {
    reasoning: { type: "string", description: "One or two sentences: what the lead means and what you do about it." },
    action: { type: "string", enum: [...AGENT_ACTIONS] },
    reply: { type: "string", description: "The message to send, in the lead's language. Empty unless action is reply or wrong_number (then only the one short apology)." },
    ownerNote: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["kind", "note"],
      properties: {
        kind: { type: "string", enum: [...OWNER_NOTE_KINDS] },
        note: { type: "string", description: "What the owner should know, in one sentence (what the lead wants, or what you could not answer)." },
      },
    },
    category: { type: "string", enum: [...AGENT_CATEGORIES] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
};

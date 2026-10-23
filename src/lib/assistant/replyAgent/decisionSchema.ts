/** Shared by the reply worker and its send-free provider diagnostic. */
export const AGENT_ACTIONS = ["reply", "tell_owner", "stop_contact", "no_reply", "wrong_number"] as const;
export const OWNER_NOTE_KINDS = ["ready", "person", "complaint", "question", "other"] as const;
export const AGENT_CATEGORIES = ["interested", "not_interested", "other"] as const;

export const DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reasoning", "action", "reply", "ownerNote", "category", "confidence"],
  properties: {
    reasoning: { type: "string", description: "One or two sentences: interpret the latest message using the conversation, distinguish what the lead actually requested from your proposed next step, then choose your action." },
    action: { type: "string", enum: [...AGENT_ACTIONS] },
    reply: { type: "string", description: "The message to send, in the lead's language. Empty unless action is reply or wrong_number (then only the one short apology)." },
    ownerNote: {
      type: ["object", "null"],
      description: "Null for ordinary conversation or discovery. Otherwise an actual action the owner needs to take, grounded in the lead's request. Offering a call yourself does not make the lead ready.",
      additionalProperties: false,
      required: ["kind", "note"],
      properties: {
        kind: { type: "string", enum: [...OWNER_NOTE_KINDS] },
        note: { type: "string", description: "What the owner should know, in one sentence (what the lead wants, or what you could not answer)." },
      },
    },
    category: { type: "string", enum: [...AGENT_CATEGORIES], description: "Classify the lead's expressed intent before your reply. Interested requires them to want your help or ask about the offer, price or next step. Answering your discovery question about their work or a problem is other by itself. Declining the offer is not_interested. Do not infer interest from business fit or your own proposed call." },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
};

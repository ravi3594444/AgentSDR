import type { AudienceChannel } from "./schema";
import type { LeadApproach } from "./messages";
import type { RequestFit } from "./leadFit";

type Shape = {
  type: string;
  properties?: Record<string, Shape>;
  required?: string[];
  items?: Shape;
  enum?: readonly unknown[];
  minimum?: number;
  maximum?: number;
};

type WriterReplies = {
  outreach_sequences: { channels: { channel: AudienceChannel; messages: { subject: string; body: string; waitDays: number }[] }[] };
  first_message_review: { messages: { channel: AudienceChannel; wouldReply: number; reasons: string[] }[] };
  opening_lines: { lines: { index: number; line: string }[] };
  lead_sorting: { leads: { index: number; group: string; approach: LeadApproach; reason: string; requestFit: RequestFit; noWebsiteRequired: boolean }[] };
  personal_messages: { messages: { index: number; subject: string; body: string }[] };
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Check the fields the outreach writers read before they iterate or trim them. */
function shapeProblem(value: unknown, shape: Shape, path: string): string | null {
  if (shape.type === "object") {
    if (!isObject(value)) return `${path} must be an object`;
    for (const key of shape.required ?? []) {
      if (value[key] === undefined) return `${path}.${key} is required`;
    }
    for (const [key, child] of Object.entries(shape.properties ?? {})) {
      if (value[key] === undefined) continue;
      const problem = shapeProblem(value[key], child, `${path}.${key}`);
      if (problem) return problem;
    }
  } else if (shape.type === "array") {
    if (!Array.isArray(value)) return `${path} must be an array, even for one item`;
    if (shape.items) {
      for (let index = 0; index < value.length; index += 1) {
        const problem = shapeProblem(value[index], shape.items, `${path}[${index}]`);
        if (problem) return problem;
      }
    }
  } else if (shape.type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) return `${path} must be an integer`;
  } else if (typeof value !== shape.type) {
    return `${path} must be a ${shape.type}`;
  }
  if (shape.enum && !shape.enum.includes(value)) return `${path} must be one of ${shape.enum.join(", ")}`;
  if (typeof value === "number" && ((shape.minimum !== undefined && value < shape.minimum) || (shape.maximum !== undefined && value > shape.maximum))) {
    return `${path} must be between ${shape.minimum} and ${shape.maximum}`;
  }
  return null;
}

/** Normalize actual array entries, without inventing missing fields or empty results. */
function normalize(value: unknown, shape: Shape): unknown {
  if (shape.type === "array") {
    if (typeof value === "string") {
      try { value = JSON.parse(value); } catch { return value; }
    }
    if (isObject(value) && shape.items?.type === "object") {
      const item = normalize(value, shape.items);
      if (!shapeProblem(item, shape.items, "item")) value = [item];
    }
    return Array.isArray(value) && shape.items ? value.map((item) => normalize(item, shape.items!)) : value;
  }
  if (shape.type !== "object" || !isObject(value)) return value;
  const out = { ...value };
  for (const [key, child] of Object.entries(shape.properties ?? {})) {
    if (out[key] !== undefined) out[key] = normalize(out[key], child);
  }
  return out;
}

export function writerReplyInstructions(name: keyof WriterReplies): string {
  const key = WRITER_REPLY_SCHEMAS[name].required[0]!;
  return `Return the ${name} JSON object itself, with "${key}" as an array even for one item. Include every required field shown in the schema. Do not return a chat message or an actions list. Use the actual channels or lead indexes requested below.`;
}

export function parseWriterReply<K extends keyof WriterReplies>(text: string, name: K): WriterReplies[K] {
  const schema: Shape = WRITER_REPLY_SCHEMAS[name];
  const key = schema.required![0]!;
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new Error(`Return the ${name} JSON object only.`); }
  if (isObject(body) && body[key] === undefined && isObject(body[name])) body = body[name];
  // Some function-call providers return a single row as the whole result.
  // Only wrap a complete, correctly typed row for this particular schema.
  const itemShape = schema.properties![key]!.items!;
  if (isObject(body) && body[key] === undefined && !shapeProblem(normalize(body, itemShape), itemShape, "item")) body = { [key]: body };
  const normalized = normalize(body, schema);
  const problem = shapeProblem(normalized, schema, name);
  if (problem) throw new Error(`${problem}. ${writerReplyInstructions(name)}`);
  return normalized as WriterReplies[K];
}

// The same schemas are sent to the provider and used to validate its answer.

const SEQUENCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["channels"],
  properties: {
    channels: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["channel", "messages"],
        properties: {
          channel: { type: "string", enum: ["email", "whatsapp", "linkedin", "instagram", "browser"] },
          messages: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["subject", "body", "waitDays"],
              properties: {
                subject: { type: "string", description: "Email only; an empty string elsewhere and for a follow-up that replies in the same thread." },
                body: { type: "string" },
                waitDays: { type: "integer", description: "Days after the previous message; 0 for the first." },
              },
            },
          },
        },
      },
    },
  },
};

const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["messages"],
  properties: {
    messages: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["channel", "wouldReply", "reasons"],
        properties: {
          channel: { type: "string", enum: ["email", "whatsapp", "linkedin", "instagram", "browser"] },
          wouldReply: { type: "integer", minimum: 1, maximum: 5, description: "1: delete without answering; 3: maybe; 5: answer now." },
          reasons: { type: "array", items: { type: "string" }, description: "What makes you skip it, each in one short sentence; empty when you would answer." },
        },
      },
    },
  },
};

const LINES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["lines"],
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "line"],
        properties: { index: { type: "integer" }, line: { type: "string" } },
      },
    },
  },
};

const SORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["leads"],
  properties: {
    leads: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "group", "approach", "reason", "requestFit", "noWebsiteRequired"],
        properties: {
          index: { type: "integer" },
          group: { type: "string", description: "2 to 4 words naming the kind of lead, the same words for leads of the same kind." },
          approach: { type: "string", enum: ["standard", "personal", "skip"] },
          reason: { type: "string", description: "One short sentence for the owner, from the lead's facts only." },
          requestFit: { type: "string", enum: ["fits", "unconfirmed", "does_not_fit"], description: "Whether the facts match what the owner asked for." },
          noWebsiteRequired: { type: "boolean", description: "True only when the owner's request asks for leads like this one to have no website." },
        },
      },
    },
  },
};

const PERSONAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["messages"],
  properties: {
    messages: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "subject", "body"],
        properties: {
          index: { type: "integer" },
          subject: { type: "string", description: "Email only; an empty string for WhatsApp and LinkedIn." },
          body: { type: "string" },
        },
      },
    },
  },
};

export const WRITER_REPLY_SCHEMAS = {
  outreach_sequences: SEQUENCE_SCHEMA,
  first_message_review: REVIEW_SCHEMA,
  opening_lines: LINES_SCHEMA,
  lead_sorting: SORT_SCHEMA,
  personal_messages: PERSONAL_SCHEMA,
};

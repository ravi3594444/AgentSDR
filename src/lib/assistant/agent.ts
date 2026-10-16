import { mergeProfile, profileChanges, ungroundedProfileValues } from "./profile";
import type { AssistantRole, BusinessProfile } from "./schema";

/**
 * The assistant's turn, pure parts: the reply schema the model fills, how
 * its actions are parsed and checked, how the conversation is shown to it,
 * and the guard against a reply that claims an action no tool performed.
 */

export const MAX_STEPS = 6;
export const MAX_ACTIONS_PER_STEP = 4;

export const MAX_SUGGESTIONS = 3;

export function agentReplySchema(toolNames: readonly string[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["message", "actions", "suggestions"],
    properties: {
      message: { type: "string", description: "What you say to the owner now. Empty only when you are about to act and have nothing to add." },
      suggestions: {
        type: "array",
        description: "Up to 3 short replies the owner is likely to send next, written as the owner would say them (under 50 characters each). Empty when a card waits for a button or nothing obvious fits.",
        items: { type: "string" },
      },
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
export type AgentReply = { message: string; actions: AgentAction[]; suggestions: string[] };

/** The model's suggested replies, cleaned: short, distinct, at most three. */
export function cleanSuggestions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const text = item.replace(/\s+/g, " ").trim().replace(/^["“'‘]+|["”'’]+$/g, "").trim();
    if (!text || text.length > 60 || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
    if (out.length === MAX_SUGGESTIONS) break;
  }
  return out;
}

/**
 * The model's reply, or an error saying exactly what to fix (fed back on
 * retry). `allowEmpty`: after tool results, an empty reply means the turn is
 * over with nothing new to say.
 */
export function parseAgentReply(text: string, toolNames: readonly string[], options: { allowEmpty?: boolean } = {}): AgentReply {
  let body: { message?: unknown; actions?: unknown; suggestions?: unknown };
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
  return { message, actions, suggestions: cleanSuggestions(body.suggestions) };
}

/** Greetings, thanks and "how are you" (English and common Hinglish), letters repeated or not. */
const SMALL_TALK = new Set([
  "hi", "hey", "hello", "helo", "hlo", "hai", "yo", "hola", "namaste", "namaskar", "salaam", "salam", "sup", "greetings",
  "good", "morning", "afternoon", "evening", "night", "gm", "thanks", "thank", "thx", "ty", "you", "u", "how", "are", "r",
  "whats", "what's", "wassup", "up", "doing", "there", "again", "test", "testing", "dear", "sir", "madam", "bhai", "ji",
  "kaise", "ho", "kya", "haal", "hai", "hal", "assistant", "bot", "buddy", "friend", "team",
].map((word) => word.replace(/(.)\1+/g, "$1")));

/**
 * Whether the owner only greeted or thanked the assistant: nothing to save,
 * search or prepare, so the turn runs no tools. Up to six words, every one
 * a greeting word; punctuation, emoji and stray characters ignored.
 */
export function isSmallTalk(text: string): boolean {
  const tokens = text.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  if (tokens.length > 6) return false;
  return tokens.every((token) => SMALL_TALK.has(token.replace(/(.)\1+/g, "$1")));
}

const DEFAULT_THREAD_TITLE = "Conversation";

/** A conversation's title from an owner message; null when the message says nothing (a greeting). */
export function threadTitleFrom(text: string | null | undefined): string | null {
  const clean = (text ?? "").replace(/\s+/g, " ").replace(/^[\s\\/.,;:!?\-–—'"“”]+|[\s\\/.,;:\-–—'"“”]+$/g, "").trim();
  if (!clean || isSmallTalk(clean)) return null;
  if (clean.length <= 60) return clean;
  const cut = clean.slice(0, 60);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 30 ? cut.lastIndexOf(" ") : 60)}…`;
}

/** What the conversation list shows: the stored title, or "New conversation" while it has none worth showing. */
export function displayThreadTitle(title: string | null | undefined): string {
  if (!title || title === DEFAULT_THREAD_TITLE) return "New conversation";
  return threadTitleFrom(title) ?? "New conversation";
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
    // A page the owner asked to read is the model's only copy of it: keep more of it.
    return `TOOL ${message.tool}(${args}) → ${message.status ?? "?"}: ${summary.slice(0, message.tool === "read_webpage" ? 6_000 : 1_500)}`;
  });
  let text = lines.join("\n");
  while (text.length > maxChars && lines.length > 4) {
    lines.splice(0, 1);
    text = `(earlier conversation omitted)\n${lines.join("\n")}`;
  }
  return text;
}

/** Words that ask for outreach, in English and common Hinglish; matched with typo tolerance. Words a business uses to describe itself ("we sell", "we connect") are left out. */
const OUTREACH_WORDS = [
  "contact", "email", "emails", "mail", "message", "messages", "msg", "reach", "outreach", "campaign", "campaigns",
  "pitch", "send", "whatsapp", "linkedin",
  "followup", "follow", "bhejo", "bhej", "sampark",
];

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

const NEGATIONS = new Set(["don", "dont", "not", "never", "no", "stop", "without", "nahi", "mat", "na"]);

function isOutreachWord(token: string): boolean {
  return OUTREACH_WORDS.some((word) => {
    if (token === word) return true;
    if (token.length < 4 || word.length < 4) return false;
    if (token.startsWith(word) && word.length >= 5) return true;
    const allowed = word.length >= 7 ? 2 : 1;
    return Math.abs(token.length - word.length) <= allowed && editDistance(token, word) <= allowed;
  });
}

/** Whether the owner's words ask to contact people (typos allowed: "campagion", "contcat"; "don't contact" does not). */
export function outreachIntent(words: string): boolean {
  const tokens = words.toLowerCase().match(/[a-z]+/g) ?? [];
  return tokens.some((token, index) => isOutreachWord(token) && !tokens.slice(Math.max(0, index - 3), index).some((before) => NEGATIONS.has(before)));
}

const CONFIRMATIONS = new Set([
  "yes", "yeah", "yep", "yup", "ya", "sure", "ok", "okay", "go", "ahead", "do", "it", "please", "proceed", "confirm", "confirmed",
  "start", "right", "correct", "fine", "great", "perfect", "lets", "let", "s", "that", "haan", "han", "ha", "ji", "theek", "thik",
  "hai", "kar", "karo", "chalo", "done", "absolutely", "definitely", "now", "sounds", "good",
]);
const CONFIRMATION_CORE = new Set(["yes", "yeah", "yep", "yup", "ya", "sure", "ok", "okay", "go", "proceed", "confirm", "confirmed", "haan", "han", "ha", "theek", "thik", "karo", "kar", "chalo", "absolutely", "definitely", "perfect"]);

/** A short "yes" (or "go ahead", "haan karo") with nothing else in it. */
export function isConfirmation(text: string): boolean {
  const tokens = text.toLowerCase().match(/[a-z]+/g) ?? [];
  return tokens.length > 0 && tokens.length <= 6 && tokens.every((token) => CONFIRMATIONS.has(token)) && tokens.some((token) => CONFIRMATION_CORE.has(token));
}

/**
 * Whether the owner has asked for outreach: their latest message asks to
 * contact, message or pitch people, or says yes to the assistant's last
 * message offering exactly that. The model's own wording never counts.
 */
export function outreachRequested(ownerText: string, lastAssistantText?: string | null): boolean {
  if (outreachIntent(ownerText)) return true;
  return Boolean(lastAssistantText && isConfirmation(ownerText) && outreachIntent(lastAssistantText));
}

const ANSWER_WORDS = /\b(?:answer|answers|answering|reply|replies|replying|respond|responding|handle|handling|jawab)\b/i;
const INQUIRY_WORDS = /\b(?:inquir\w*|enquir\w*|instagram|insta|dms?|direct messages?|leads? (?:who|that) (?:message|write|ask))\b/i;

/**
 * Whether the owner asked for inbound inquiries to be answered ("answer my
 * Instagram inquiries", "reply to new DMs automatically"), or said yes to
 * the assistant offering exactly that. Answering inquiries is a different
 * request from contacting people, so it has its own words.
 */
export function inquiryRepliesRequested(ownerText: string, lastAssistantText?: string | null): boolean {
  const asks = (text: string) => ANSWER_WORDS.test(text) && INQUIRY_WORDS.test(text) && !/\b(?:don'?t|do not|never|stop|nahi|mat)\b[^.?!]{0,30}\b(?:answer|reply|respond)/i.test(text);
  if (asks(ownerText)) return true;
  return Boolean(lastAssistantText && isConfirmation(ownerText) && asks(lastAssistantText));
}

type HistoryMessage = Pick<TranscriptMessage, "role" | "content" | "tool" | "toolInput" | "status">;

const CONTACT_AFTER_TOOLS = new Set(["find_leads", "find_linkedin_leads", "find_customers_on_web"]);

const actsOnOutreach = (message: HistoryMessage) => message.role === "tool" && message.status === "ok"
  && (message.tool === "prepare_outreach" || (CONTACT_AFTER_TOOLS.has(message.tool ?? "") && message.toolInput?.contactAfter === true));

/**
 * The owner's words that ask for outreach now, or null. Their latest
 * message (or its "yes" to an offer) counts; so does a request in one of
 * their two messages before it that nothing has acted on yet, so answering
 * a clarifying question ("which cities?" → "Austin") keeps the request.
 */
export function pendingOutreachRequest(history: readonly HistoryMessage[]): string | null {
  const owners = history.flatMap((message, index) => (message.role === "user" ? [index] : []));
  for (const index of owners.slice(-3).reverse()) {
    const message = history[index]!;
    const before = [...history.slice(0, index)].reverse().find((item) => item.role === "assistant")?.content ?? null;
    if (!outreachRequested(message.content, before)) continue;
    return history.slice(index + 1).some(actsOnOutreach) ? null : message.content;
  }
  return null;
}

/** Why a tool may not prepare outreach for the owner now, or null. */
export function outreachRequestProblem(ownerText: string, lastAssistantText?: string | null): string | null {
  return outreachRequested(ownerText, lastAssistantText)
    ? null
    : "The owner has not asked to contact anyone in their latest message. Offer it in one sentence and wait for them to say yes.";
}

const digitsOf = (value: string) => value.replace(/\D/g, "");

/**
 * Contacts in `contacts` that are not in `corpus` (what the owner wrote and
 * the pages they had read): a phone matches when one number in the corpus
 * ends the other (so "8084794983" backs "+91 8084794983"), an email or a
 * LinkedIn profile when it appears as written. Returns the values that do not.
 */
export function ungroundedContacts(contacts: unknown, corpus: string): string[] {
  if (!Array.isArray(contacts)) return [];
  const lower = corpus.toLowerCase();
  const numbers = (corpus.match(/\+?\d[\d\s().-]{5,}\d/g) ?? []).map(digitsOf).filter((digits) => digits.length >= 7);
  const out: string[] = [];
  for (const item of contacts) {
    const contact = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const phone = typeof contact.phone === "string" ? digitsOf(contact.phone) : "";
    if (phone && !numbers.some((known) => phone.endsWith(known) || known.endsWith(phone))) out.push(String(contact.phone));
    const email = typeof contact.email === "string" ? contact.email.trim().toLowerCase() : "";
    if (email && !lower.includes(email)) out.push(email);
    const profile = typeof contact.linkedinUrl === "string" ? contact.linkedinUrl.toLowerCase().match(/linkedin\.com\/(?:in|company)\/([^/?#\s]+)/)?.[1] : null;
    if (typeof contact.linkedinUrl === "string" && contact.linkedinUrl.trim() && (!profile || !lower.includes(profile))) out.push(contact.linkedinUrl);
  }
  return out;
}

/** Whether `url`'s site appears in what the owner wrote or a page they had read (the assistant opens only links it was given). */
export function urlGiven(url: unknown, corpus: string): boolean {
  if (typeof url !== "string" || !url.trim()) return false;
  try {
    const host = new URL(/^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`).hostname.toLowerCase().replace(/^www\./, "");
    return corpus.toLowerCase().includes(host);
  } catch {
    return false;
  }
}

/**
 * Why the model's planned tool calls must not run, or null. Checked before
 * anything runs or is shown, so a mistaken call is sent back to the model
 * instead of appearing in the chat: no tools on a greeting, and no
 * business-information save that changes nothing or holds words the owner
 * never wrote.
 */
export function actionsProblem(actions: readonly AgentAction[], input: { smallTalk: boolean; profile: BusinessProfile; ownerCorpus: string; outreachRequested: boolean; inquiryRepliesRequested?: boolean }): string | null {
  if (input.smallTalk && actions.length) {
    return "The owner only greeted or thanked you. Run no tools: answer in one or two friendly sentences and offer the next useful step.";
  }
  const contacts = actions.some((action) => action.tool === "prepare_outreach" || ((CONTACT_AFTER_TOOLS.has(action.tool) || action.tool === "add_contacts") && action.args.contactAfter === true));
  if (contacts && !input.outreachRequested) return outreachRequestProblem("", null);
  if (actions.some((action) => action.tool === "prepare_inquiry_replies") && !input.inquiryRepliesRequested) {
    return "The owner has not asked for their inquiries to be answered. Offer it in one sentence and wait for them to say yes.";
  }
  for (const action of actions) {
    if (action.tool === "add_contacts") {
      const invented = ungroundedContacts(action.args.contacts, input.ownerCorpus);
      if (invented.length) return `add_contacts: ${invented.join(", ")} ${invented.length === 1 ? "is" : "are"} not in what the owner wrote. Add only contacts the owner gave, exactly as given.`;
      continue;
    }
    if (action.tool === "read_webpage") {
      if (!urlGiven(action.args.url, input.ownerCorpus)) return "read_webpage opens only links the owner gave (or links on a page already read). Ask the owner for the link.";
      continue;
    }
    if (action.tool !== "save_business_info") continue;
    if (!mergeProfile(input.profile, action.args).problems.length && !profileChanges(input.profile, action.args).length) {
      return "save_business_info would change nothing: the owner gave no new business information. Do not call it; answer them instead.";
    }
    const ungrounded = ungroundedProfileValues(action.args, input.ownerCorpus);
    if (ungrounded.length) {
      return `save_business_info: ${ungrounded.join(", ")} ${ungrounded.length === 1 ? "is" : "are"} not what the owner wrote. Save only the owner's own information, in their words; ask them about the rest.`;
    }
  }
  return null;
}

/** Whether two messages say the same thing (same words, nearly), so a turn never repeats itself. */
export function sameMessage(a: string, b: string): boolean {
  const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const left = words(a);
  const right = words(b);
  if (!left.size || !right.size) return false;
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / Math.max(left.size, right.size) >= 0.8;
}

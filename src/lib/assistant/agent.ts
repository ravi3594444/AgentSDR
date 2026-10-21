import { ungroundedInstagramContacts } from "./instagramContacts";
import { mergeProfile, profileChanges, ungroundedProfileValues } from "./profile";
import type { AssistantRole, BusinessProfile } from "./schema";

/**
 * The assistant's turn, pure parts: the reply schema the model fills, how
 * its actions are parsed and checked, how the conversation is shown to it,
 * and the guard against a reply that claims an action no tool performed.
 */

export const MAX_STEPS = 6;
export const MAX_ACTIONS_PER_STEP = 8;
// Some providers ignore the schema's batch size. Validate a bounded plan in
// full, then stage it across steps instead of rejecting otherwise valid work.
export const MAX_ACTIONS_PER_REPLY = 32;

export const MAX_SUGGESTIONS = 3;
export const DIRECT_CONTACT_TOOLS = new Set(["add_contacts", "add_instagram_contacts"]);

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
        maxItems: MAX_ACTIONS_PER_STEP,
        description: `At most ${MAX_ACTIONS_PER_STEP} total tool actions for this step, in order, including reads and saves. Put actions that need these results in the next step. Empty when waiting for the owner or a background job.`,
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

/**
 * Keep oversized but valid plans in order across steps. A webpage read ends
 * the batch: later actions may have guessed its contents, so re-plan from
 * the actual result instead of executing those guesses or showing their
 * completion message. The owner's request remains in the conversation.
 */
export function nextAgentBatch(reply: AgentReply): { batch: AgentReply; pending: AgentReply | null; replanAfterRead: boolean } {
  const pageIndex = reply.actions.findIndex((action) => PAGE_STATE_TOOLS.has(action.tool));
  const replanAfterRead = pageIndex >= 0 && pageIndex < MAX_ACTIONS_PER_STEP;
  const count = replanAfterRead ? pageIndex + 1 : MAX_ACTIONS_PER_STEP;
  const actions = reply.actions.slice(0, count);
  const remaining = reply.actions.slice(count);
  const holdMessage = remaining.length > 0 || replanAfterRead;
  return {
    batch: { ...reply, actions, message: holdMessage ? "" : reply.message, suggestions: holdMessage ? [] : reply.suggestions },
    pending: remaining.length && !replanAfterRead ? { ...reply, actions: remaining } : null,
    replanAfterRead,
  };
}

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
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Answer with the JSON object only.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Answer with the JSON object only.");
  let body = parsed as Record<string, unknown>;
  // A function-call provider can wrap the named result once more. Unwrap
  // only this explicit envelope, never arbitrary fields or message text.
  if (body.actions === undefined && body.assistant_reply && typeof body.assistant_reply === "object" && !Array.isArray(body.assistant_reply)) {
    body = body.assistant_reply as Record<string, unknown>;
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  // Accept unambiguous encodings of actual calls, while still validating
  // every tool name and argument below. Missing/null actions are NOT turned
  // into []: that would turn failed work into a successful-looking no-op.
  let rawActions = body.actions ?? body.tool_calls;
  if (rawActions === undefined && (typeof body.tool === "string" || typeof body.name === "string")) rawActions = body;
  if (typeof rawActions === "string") {
    try { rawActions = JSON.parse(rawActions); } catch { /* use the repair instruction below */ }
  }
  if (rawActions && typeof rawActions === "object" && !Array.isArray(rawActions)) {
    const action = rawActions as Record<string, unknown>;
    if (typeof action.tool === "string" || typeof action.name === "string" || (action.function && typeof action.function === "object")) rawActions = [action];
  }
  if (!Array.isArray(rawActions)) {
    throw new Error('actions must be an array, including for one tool: {"message":"","actions":[{"tool":"TOOL_NAME","arguments":"{}"}],"suggestions":[]}. Use actions: [] only when asking a question or finished; do not omit actions.');
  }
  if (rawActions.length > MAX_ACTIONS_PER_REPLY) {
    throw new Error(`Plan at most ${MAX_ACTIONS_PER_REPLY} actions in one answer; return only the next ${MAX_ACTIONS_PER_STEP} and continue after their results.`);
  }
  const actions: AgentAction[] = rawActions.map((raw, index) => {
    const outer = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    const item = outer.function && typeof outer.function === "object" && !Array.isArray(outer.function)
      ? outer.function as Record<string, unknown> : outer;
    const tool = typeof item.tool === "string" ? item.tool : typeof item.name === "string" ? item.name : "";
    if (!toolNames.includes(tool)) throw new Error(`actions[${index}].tool "${tool}" does not exist; use one of ${toolNames.join(", ")}.`);
    const rawArgs = item.arguments === undefined ? item.args : item.arguments;
    let args: unknown = {};
    if (typeof rawArgs === "string" && rawArgs.trim()) {
      try {
        args = JSON.parse(rawArgs);
      } catch {
        throw new Error(`actions[${index}].arguments must be a JSON object written as a string, e.g. "{\\"audienceId\\":\\"…\\"}".`);
      }
    } else if (rawArgs !== undefined && rawArgs !== null && typeof rawArgs !== "string") {
      args = rawArgs;
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
/** Tools whose result the model reads at length (the rest are cut to 1,500 characters). */
const LONG_RESULT_TOOLS = new Set(["read_webpage", "web_search", "treg_search", "treg_call", "browser_open", "browser_read", "browser_click", "browser_fill", "browser_scroll"]);

/** Tools whose result the next action depends on (a page read, a browser step): the batch ends after them. */
export const PAGE_STATE_TOOLS = new Set(["read_webpage", "browser_open", "browser_read", "browser_click", "browser_fill", "browser_scroll"]);

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
    // A page the owner asked to read, or a paid Treg answer, is the model's only copy of it: keep more of it.
    return `TOOL ${message.tool}(${args}) → ${message.status ?? "?"}: ${summary.slice(0, LONG_RESULT_TOOLS.has(message.tool ?? "") ? 6_000 : 1_500)}`;
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
  "pitch", "send", "dm", "dms", "whatsapp", "linkedin",
  "followup", "follow", "bhejo", "bhej", "sampark",
];
const OUTREACH_WORD_SET = new Set(OUTREACH_WORDS);

/**
 * Real words within a typo of an outreach word (pilot finding L01): "spend"
 * is not "send", "contract" is not "contact", "each" is not "reach". They
 * and their plain inflections are ruled out before the typo tolerance, so
 * budget wording ("Spend $0") or ordinary prose never reads as a request to
 * contact people. "connect" is here too: alone it is as often about an
 * account as about people, and an offer the owner says yes to still works.
 */
const NEAR_MISSES = new Set([
  // contact
  "contract", "content", "context", "contest", "contain", "contend", "conduct", "convict", "contort", "compact", "contrast", "connect", "concoct", "intact",
  // message
  "massage", "passage",
  // reach
  "each", "beach", "teach", "peach", "leach", "roach", "ranch", "retch", "react", "bleach", "breach", "preach",
  // pitch
  "patch", "witch", "ditch", "hitch", "bitch", "fitch", "mitch", "pinch", "stitch", "itch", "pith", "pitcher",
  // mail
  "mall", "main", "maid", "maim", "maul", "marl", "mali", "moil", "nail", "rail", "sail", "tail", "jail", "hail", "bail", "fail", "pail", "wail", "male", "mild", "mile",
  // send
  "spend", "spent", "sent", "seed", "sand", "bend", "lend", "tend", "mend", "fend", "vend", "wend", "rend", "pend",
  // follow
  "fellow", "hollow", "fallow", "follower",
  // linkedin
  "linked",
]);

/** The word and its plain inflections ("spending" → "spend", "contracts" → "contract"), for the near-miss check. */
function stems(token: string): string[] {
  const out = [token];
  for (const [suffix, replacement] of [["ies", "y"], ["ing", ""], ["ed", ""], ["es", ""], ["s", ""]] as const) {
    if (token.length > suffix.length + 2 && token.endsWith(suffix)) out.push(token.slice(0, -suffix.length) + replacement);
  }
  return out;
}

/** Edits between two words; a swapped pair ("emial") is one slip, not two. */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}

const NEGATIONS = new Set(["don", "dont", "not", "never", "no", "stop", "without", "nahi", "mat", "na"]);

function isOutreachWord(token: string): boolean {
  if (OUTREACH_WORD_SET.has(token)) return true;
  if (stems(token).some((stem) => NEAR_MISSES.has(stem))) return false;
  return OUTREACH_WORDS.some((word) => {
    if (token.length < 4 || word.length < 4) return false;
    if (token.startsWith(word) && word.length >= 5) return true;
    const allowed = word.length >= 7 ? 2 : 1;
    return Math.abs(token.length - word.length) <= allowed && editDistance(token, word) <= allowed;
  });
}

/**
 * Contact details asked for as data are not outreach (pilot finding L01).
 * A channel word is a thing, not an action, when a possessive, determiner or
 * quality comes before it ("their email", "an email address", "the contact
 * page", "high reach"), when a detail noun follows it ("whatsapp number",
 * "contact details", "linkedin profiles"), or when it continues such a list
 * ("their email and whatsapp"). Aimed at people ("email them", "whatsapp the
 * clinics") it is outreach.
 */
const CONTACT_DATA_WORDS = new Set(["contact", "email", "emails", "mail", "whatsapp", "linkedin", "dm", "dms", "reach"]);
const DATA_BEFORE = new Set([
  "their", "his", "her", "its", "my", "our", "your", "whose", "the", "a", "an", "all", "any", "each", "every", "some", "these", "those", "this", "that",
  "of", "with", "including", "incl", "plus", "valid", "verified", "working", "correct", "public", "official", "business", "personal", "direct", "generic",
  "high", "low", "good", "wide", "wider", "large", "more", "less", "big", "bigger", "huge", "organic", "total",
]);
const DATA_AFTER = new Set([
  "detail", "details", "info", "information", "number", "numbers", "address", "addresses", "id", "ids", "handle", "handles", "profile", "profiles",
  "url", "urls", "link", "links", "account", "accounts", "page", "pages", "person", "persons", "form", "forms", "data", "list", "lists", "point", "points",
  "channel", "channels", "route", "routes", "method", "methods", "option", "options", "column", "columns", "field", "fields",
]);
/** A verb aimed at the owner ("send me", "email us", "send the list to me") asks for data, not outreach. */
const OWNER_OBJECT = new Set(["me", "us"]);
const TO_OWNER = new Set(["to", "for"]);
/** "write them an email", "send each a message": the people before the article make the channel word an action. */
const PEOPLE_OBJECT = new Set(["them", "him", "her", "each", "everyone", "everybody", "all"]);
const ARTICLES = new Set(["a", "an", "the"]);

const CLAUSE_BREAK = /^[,.;!?\n]$/;

/** The outreach words of `words` that ask to contact people, each with whether a negation stands before it in the same clause ("no emails, whatsapp only" asks for WhatsApp). */
function outreachMentions(words: string): { negated: boolean }[] {
  const tokens = words.toLowerCase().match(/[a-z]+|[,.;!?\n]/g) ?? [];
  const data: boolean[] = [];
  const out: { negated: boolean }[] = [];
  tokens.forEach((token, index) => {
    const before = tokens[index - 1];
    const after = tokens[index + 1];
    const actionOnPeople = before !== undefined && ARTICLES.has(before) && PEOPLE_OBJECT.has(tokens[index - 2] ?? "");
    data[index] = CONTACT_DATA_WORDS.has(token) && !actionOnPeople && (
      (before !== undefined && DATA_BEFORE.has(before))
      || ((before === "and" || before === "or" || before === ",") && data[index - 2] === true)
      || (after !== undefined && DATA_AFTER.has(after))
    );
    if (data[index] || !isOutreachWord(token)) return;
    if (after !== undefined && OWNER_OBJECT.has(after)) return;
    const next = tokens.slice(index + 1, index + 6);
    if (next.some((word, offset) => TO_OWNER.has(word) && OWNER_OBJECT.has(next[offset + 1] ?? "") && !next.slice(0, offset).some(isOutreachWord))) return;
    let negated = false;
    for (let back = index - 1; back >= Math.max(0, index - 3) && !CLAUSE_BREAK.test(tokens[back]!); back -= 1) negated ||= NEGATIONS.has(tokens[back]!);
    out.push({ negated });
  });
  return out;
}

/** Whether the owner's words ask to contact people (typos allowed: "campagion", "contcat"; "don't contact" and "send me their emails" do not). */
export function outreachIntent(words: string): boolean {
  return outreachMentions(words).some((mention) => !mention.negated);
}

/**
 * The owner says in so many words that this is research without outreach:
 * "research only", "no outreach", "do not contact anyone", "without
 * contacting", or "no messages" / "no campaigns" standing as a clause of
 * their own. A negation of one channel ("don't email them, WhatsApp them",
 * "do not contact them by email") is not that: it still asks for outreach.
 */
const RESEARCH_ONLY = [
  /\bresearch[\s-]+only\b/i,
  /\b(?:only|just|purely|strictly)\s+research\b/i,
  /\bno\s+(?:cold\s+)?outreach\b/i,
  /\b(?:do\s+not|don'?t|dont|never)\s+(?:contact|approach|reach\s+out\s+to|get\s+in\s+touch\s+with)\s+(?:anyone|anybody|people|them|these|those|any\s+of\s+(?:them|these|those)|any\s+(?:business|businesses|clinic|clinics|lead|leads|person|one))\b(?!\s*(?:on|via|by|through|over|using|with|from|in|who|that|which|except|unless|until|before|outside)\b)/i,
  /\bwithout\s+(?:contacting|messaging|reaching\s+out)\b/i,
];
const NO_OUTREACH_CLAUSE = /^(?:and\s+|also\s+|please\s+)?no\s+(?:cold\s+)?(?:outreach|contact|contacting|messages?|messaging|campaigns?|pitching|pitches|sending)(?:\s+(?:please|at\s+all|yet|for\s+now|to\s+anyone|to\s+anybody|now|today))?$/i;

export function researchOnlyStated(text: string): boolean {
  if (RESEARCH_ONLY.some((pattern) => pattern.test(text))) return true;
  return text.split(/[.;!?,\n]|\s+(?:and|but|also)\s+/i).some((clause) => NO_OUTREACH_CLAUSE.test(clause.trim()));
}

/** The owner tells the assistant not to contact people ("stop contacting them", "don't message anyone yet", "research only"). */
export function outreachRevoked(words: string): boolean {
  return researchOnlyStated(words) || outreachMentions(words).some((mention) => mention.negated);
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
 * message offering exactly that. The model's own wording never counts, and
 * a message that says research only asks for none, whatever else is in it.
 */
export function outreachRequested(ownerText: string, lastAssistantText?: string | null): boolean {
  if (researchOnlyStated(ownerText)) return false;
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

const CONTACT_AFTER_TOOLS = new Set(["find_leads", "find_linkedin_leads", "find_customers_on_web", "find_instagram_prospects", "find_social_leads", "research_social_sources"]);

const actsOnOutreach = (message: HistoryMessage) => message.role === "tool" && message.status === "ok"
  && (message.tool === "prepare_outreach" || (CONTACT_AFTER_TOOLS.has(message.tool ?? "") && message.toolInput?.contactAfter === true));

/**
 * The owner's words that ask for outreach now, or null. Their latest
 * message (or its "yes" to an offer) counts; so does a request in one of
 * their two messages before it that nothing has acted on yet, so answering
 * a clarifying question ("which cities?" → "Austin") keeps the request.
 */
export function pendingOutreachRequest(history: readonly HistoryMessage[]): string | null {
  const index = pendingOutreachRequestIndex(history);
  return index === null ? null : history[index]!.content;
}

/** Where in `history` the pending outreach request is (see pendingOutreachRequest), or null. */
export function pendingOutreachRequestIndex(history: readonly HistoryMessage[]): number | null {
  const owners = history.flatMap((message, index) => (message.role === "user" ? [index] : []));
  for (const index of owners.slice(-3).reverse()) {
    const message = history[index]!;
    const before = [...history.slice(0, index)].reverse().find((item) => item.role === "assistant")?.content ?? null;
    if (!outreachRequested(message.content, before)) continue;
    return history.slice(index + 1).some(actsOnOutreach) ? null : index;
  }
  return null;
}

/**
 * In Autonomous mode the owner's latest request to contact people stands
 * until they say otherwise: the most recent owner message (of the last ten)
 * that asked for outreach, even when a plan already acted on it, so a long
 * piece of work keeps contacting what it finds. Null when none asked.
 */
export function standingOutreachRequestIndex(history: readonly HistoryMessage[]): number | null {
  const owners = history.flatMap((message, index) => (message.role === "user" ? [index] : []));
  for (const index of owners.slice(-10).reverse()) {
    const message = history[index]!;
    const before = [...history.slice(0, index)].reverse().find((item) => item.role === "assistant")?.content ?? null;
    if (outreachRequested(message.content, before)) return index;
    // A newer "stop contacting people" ends the standing request.
    if (outreachRevoked(message.content)) return null;
  }
  return null;
}

/**
 * The owner request a search serves (its objective and coverage): a
 * continuation's own request; otherwise the outreach request, so the plans
 * and research of one "find and contact" request stay together, unless the
 * owner has since written a new message and that outreach request only
 * stands (Autonomous mode, already acted on) or its research has stopped.
 * Then the new message is a new request, rather than being filed under, or
 * refused by, the old one.
 */
export function searchRequestFor(input: { continuationRequestId: string | null; latestOwnerId: string | null; outreachRequestId: string | null; outreachPending: boolean; outreachResearchStopped: boolean }): string | null {
  if (input.continuationRequestId) return input.continuationRequestId;
  const newer = Boolean(input.outreachRequestId && input.latestOwnerId && input.outreachRequestId !== input.latestOwnerId);
  if (newer && (!input.outreachPending || input.outreachResearchStopped)) return input.latestOwnerId;
  return input.outreachRequestId ?? input.latestOwnerId;
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

/** Tools whose successful result is a source: a page read, a search's results, a Treg answer, a browser page. */
function isSourceTool(tool: string | null): boolean {
  return tool === "read_webpage" || tool === "web_search" || tool === "treg_call" || Boolean(tool?.startsWith("browser_"));
}

function parsedLink(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

const LINK_IN_TEXT = /https?:\/\/[^\s"'<>]+/gi;

function decoded(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

const CONTACT_LIKE = /[^\s@/?#&=]+@[^\s@/?#&=]+|\+?\d[\d\s().-]{5,}\d|(?:[a-z0-9-]+\.)+[a-z]{2,}/gi;

/**
 * What the model wrote into the addresses it opened (query values, the
 * fragment, and path segments carrying an address or a long number), cut
 * to what grounding reads: email addresses, host names and phone-like
 * digit runs. The pages' own hosts are not among them.
 */
function modelWrittenTokens(pages: readonly URL[], known: string): string[] {
  const own = new Set(pages.map((page) => page.hostname.toLowerCase().replace(/^www\./, "")));
  // What an earlier source already gave is not a guess, whoever wrote it into the address since.
  const knownText = known.toLowerCase();
  const knownNumbers = [...known.matchAll(/\+?\d[\d\s().-]{5,}\d/g)].map((match) => match[0].replace(/\D/g, ""));
  const given = (token: string) => {
    const digits = /^\d+$/.test(token) ? token : null;
    return digits ? knownNumbers.some((number) => number.endsWith(digits) || digits.endsWith(number)) : knownText.includes(token.toLowerCase());
  };
  const tokens = new Set<string>();
  for (const page of pages) {
    // A path segment carries an address, or a number however it is written ("98220-11111").
    const values = [...page.searchParams.values(), decoded(page.hash.slice(1)), ...page.pathname.split("/").map(decoded).filter((segment) => segment.includes("@") || segment.replace(/\D/g, "").length >= 7)];
    for (const value of values) {
      for (const match of value.matchAll(CONTACT_LIKE)) {
        const token = match[0].trim();
        const bare = token.toLowerCase().replace(/^www\./, "");
        if (own.has(bare) || [...own].some((host) => host.endsWith(`.${bare}`))) continue;
        tokens.add(token);
        // An address names its site too; a number may come back without its punctuation.
        const domain = token.includes("@") ? token.split("@")[1]!.toLowerCase().replace(/^www\./, "") : null;
        if (domain && !own.has(domain)) tokens.add(domain);
        const digits = token.replace(/\D/g, "");
        if (!token.includes("@") && digits.length >= 7) tokens.add(digits);
      }
    }
  }
  return [...tokens].filter((token) => !given(token)).sort((a, b) => b.length - a.length);
}

/**
 * A page read's or browser page's result as a source: what the page
 * returned (its text, title, contacts and the links it lists), with the
 * page's own address cut to its path. The query string and fragment are
 * what the model wrote when it asked for the page, so reading
 * "…/search?q=info@guessed.in" grounds neither that address nor its site.
 * A link on the page back to that same address (a "#top" link resolves to
 * all of it) is cut the same way. A page that repeats what the model wrote
 * ("No results for info@guessed.in"), at the address it asked for or the
 * one it was redirected to, grounds none of that either: every address,
 * host or number the model put in either address is taken out of the page.
 */
function pageSourceText(text: string, pageUrls: readonly unknown[], known: string): string {
  const pages = pageUrls.flatMap((value) => {
    const page = typeof value === "string" ? parsedLink(value) : null;
    return page ? [page] : [];
  });
  let out = text;
  for (const page of pages) {
    const bare = `${page.origin}${page.pathname}`;
    const samePage = (value: string) => {
      const link = parsedLink(value);
      return Boolean(link && link.origin === page.origin && link.pathname === page.pathname && link.search === page.search);
    };
    out = out.replace(LINK_IN_TEXT, (match) => {
      // Punctuation after a link in the summary ("…/search?q=x. Text:") is not part of it, though a query may end in some too.
      for (let end = match.length; end > 0 && (end === match.length || /[.,;:!?)\]”]/.test(match[end]!)); end -= 1) {
        if (samePage(match.slice(0, end))) return `${bare}${match.slice(end)}`;
      }
      return match;
    });
  }
  for (const token of modelWrittenTokens(pages, known)) out = out.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ");
  return out;
}

/**
 * What contacts, links and business information may come from (actionsProblem's
 * ownerCorpus): what the owner wrote or attached, their saved documents, and
 * the successful results of reading or searching. A web search counts only
 * for what it returned: its summary repeats the query the model wrote, and a
 * guessed address or domain searched for is not thereby given. A page read
 * counts for the page, not for the query string the model opened it with.
 */
export function groundingCorpus(messages: readonly (Pick<TranscriptMessage, "role" | "tool" | "status" | "content" | "toolResult"> & { toolInput?: Record<string, unknown> | null })[], documentsText = ""): string {
  // In order: what a page may not ground is only what no earlier source (or saved document) gave.
  let known = documentsText;
  return messages
    .filter((message) => message.role === "user" || (message.role === "tool" && (message.tool === "read_document" || message.tool === "import_contacts" || (isSourceTool(message.tool) && message.status === "ok"))))
    .map((message) => {
      const part = sourceText(message, known);
      known += `\n${part}`;
      return part;
    })
    .join("\n") + `\n${documentsText}`;
}

/** One source's text for the corpus: a search's results, a page with what the model wrote into its address taken out, or the message itself. */
function sourceText(message: Pick<TranscriptMessage, "tool" | "content" | "toolResult"> & { toolInput?: Record<string, unknown> | null }, known: string): string {
  if (message.tool === "web_search") {
    const results = (message.toolResult?.data as { results?: unknown } | undefined)?.results;
    return (Array.isArray(results) ? results : [])
      .map((hit) => (hit && typeof hit === "object" ? hit as Record<string, unknown> : {}))
      .map((hit) => [hit.title, hit.url, hit.snippet].filter((part) => typeof part === "string").join(" — "))
      .join("\n");
  }
  const summary = typeof message.toolResult?.summary === "string" ? message.toolResult.summary : "";
  const text = `${message.content} ${summary}`;
  if (message.tool === "read_webpage" || message.tool?.startsWith("browser_")) {
    // The address the page was read at: its data, or where the summary names it ("Read <url>", "Page: <url>").
    const named = message.tool === "read_webpage" ? /^Read (\S+)/.exec(summary || message.content) : /^Page: (\S+)/m.exec(summary || message.content);
    return pageSourceText(text, [message.toolInput?.url, (message.toolResult?.data as { url?: unknown } | undefined)?.url, named?.[1]], known);
  }
  return text;
}

const HOST_IN_TEXT = /(?:^|[^a-z0-9.-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9])(?![a-z0-9-])/g;

/** Every host name written in `corpus` (in links, bare domains and email addresses), without "www.". */
export function corpusHosts(corpus: string): Set<string> {
  const hosts = new Set<string>();
  for (const match of corpus.toLowerCase().matchAll(HOST_IN_TEXT)) hosts.add(match[1]!.replace(/^www\./, ""));
  return hosts;
}

/**
 * Whether `url`'s site is one the owner wrote, a page they had read linked
 * to, or a web search returned (the assistant opens only links it was
 * given): the same host, or a subdomain of one. A host merely containing a
 * known one ("notacme.com" for "acme.com") or a parent of one is not given.
 */
export function urlGiven(url: unknown, corpus: string | Set<string>): boolean {
  if (typeof url !== "string" || !url.trim()) return false;
  let host: string;
  try {
    host = new URL(/^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
  const hosts = typeof corpus === "string" ? corpusHosts(corpus) : corpus;
  if (hosts.has(host)) return true;
  for (const known of hosts) if (host.endsWith(`.${known}`)) return true;
  return false;
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
  const contacts = actions.some((action) => action.tool === "prepare_outreach" || ((CONTACT_AFTER_TOOLS.has(action.tool) || DIRECT_CONTACT_TOOLS.has(action.tool)) && action.args.contactAfter === true));
  if (contacts && !input.outreachRequested) return outreachRequestProblem("", null);
  if (actions.some((action) => action.tool === "prepare_inquiry_replies") && !input.inquiryRepliesRequested) {
    return "The owner has not asked for their inquiries to be answered. Offer it in one sentence and wait for them to say yes.";
  }
  for (const action of actions) {
    if (action.tool === "add_instagram_contacts") {
      const invented = ungroundedInstagramContacts(action.args.usernames, input.ownerCorpus);
      if (invented.length) return `add_instagram_contacts: ${invented.join(", ")} is not an exact Instagram recipient supplied by the owner or a read source. Preserve the given username; do not invent or shorten it.`;
      continue;
    }
    if (action.tool === "add_contacts") {
      const invented = ungroundedContacts(action.args.contacts, input.ownerCorpus);
      if (invented.length) return `add_contacts: ${invented.join(", ")} ${invented.length === 1 ? "is" : "are"} not in what the owner wrote, a page read for them or a Treg answer. Add only those contacts, exactly as given.`;
      continue;
    }
    if (action.tool === "read_webpage" || action.tool === "browser_open") {
      if (!urlGiven(action.args.url, input.ownerCorpus)) return `${action.tool} opens only links the owner gave, links on a page already read, or results web_search returned. Search for it with web_search, or ask the owner for the link.`;
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

/**
 * A search tool's arguments as one comparable key (pilot fix F08): keys in
 * order, text trimmed and lower-cased, empty values left out, so a Retry
 * whose model repeats the same search is recognised as the same search.
 */
export function searchArgsKey(tool: string, args: Record<string, unknown>): string {
  const normal = (value: unknown): unknown => {
    if (typeof value === "string") return value.trim().replace(/\s+/g, " ").toLowerCase();
    if (Array.isArray(value)) return value.map(normal);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined && item !== null && item !== "").sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normal(item)]));
    }
    return value;
  };
  return `${tool}:${JSON.stringify(normal(args))}`;
}

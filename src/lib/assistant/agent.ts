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
  const pageIndex = reply.actions.findIndex((action) => action.tool === "read_webpage");
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
const LONG_RESULT_TOOLS = new Set(["read_webpage", "web_search", "treg_search", "treg_call"]);

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

/** The owner tells the assistant not to contact people ("stop contacting them", "don't message anyone yet"). */
export function outreachRevoked(words: string): boolean {
  const tokens = words.toLowerCase().match(/[a-z]+/g) ?? [];
  return tokens.some((token, index) => isOutreachWord(token) && tokens.slice(Math.max(0, index - 3), index).some((before) => NEGATIONS.has(before)));
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

const CONTACT_AFTER_TOOLS = new Set(["find_leads", "find_linkedin_leads", "find_customers_on_web", "find_instagram_prospects", "find_social_leads"]);

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
    if (action.tool === "read_webpage") {
      if (!urlGiven(action.args.url, input.ownerCorpus)) return "read_webpage opens only links the owner gave, links on a page already read, or results web_search returned. Search for it with web_search, or ask the owner for the link.";
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

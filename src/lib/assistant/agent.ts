import { ungroundedInstagramContacts } from "./instagramContacts";
import { ungroundedProfileValues } from "./profile";
import type { AssistantRole, BusinessProfile } from "./schema";

/**
 * The assistant's turn, pure parts: the reply schema the model fills, how
 * its actions are parsed and checked, how the conversation is shown to it,
 * and the guard against a reply that claims an action no tool performed.
 */

export const MAX_STEPS = 6;
export const MAX_ACTIONS_PER_STEP = 12;
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
 * completion message. Several page reads in a row run together (each is
 * independent); a browser step stays alone, as they share one browser. The
 * owner's request remains in the conversation.
 */
export function nextAgentBatch(reply: AgentReply): { batch: AgentReply; pending: AgentReply | null; replanAfterRead: boolean } {
  const pageIndex = reply.actions.findIndex((action) => PAGE_STATE_TOOLS.has(action.tool));
  const replanAfterRead = pageIndex >= 0 && pageIndex < MAX_ACTIONS_PER_STEP;
  let end = pageIndex;
  if (replanAfterRead && reply.actions[pageIndex]!.tool === "read_webpage") {
    while (end + 1 < Math.min(reply.actions.length, MAX_ACTIONS_PER_STEP) && reply.actions[end + 1]!.tool === "read_webpage") end += 1;
  }
  const count = replanAfterRead ? end + 1 : MAX_ACTIONS_PER_STEP;
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
export function unbackedClaim(message: string, succeededThisTurn: readonly string[], outreachStartedOnRecord: boolean, searchedOnRecord = false): string | null {
  // "I found 30 dentists" may report an earlier search that finished (on record); "I've sent / saved / prepared …" needs this turn's tool.
  const claims = [...message.matchAll(new RegExp(CLAIMS_DONE.source, "gi"))].map((match) => match[0].toLowerCase());
  const reportsEarlierSearch = searchedOnRecord && claims.length > 0 && claims.every((claim) => /\b(?:found|searched)$/.test(claim));
  if (!succeededThisTurn.length && claims.length && !reportsEarlierSearch) {
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

/** The owner's connected browser (browser_tab_*): each returns a page the next step reads. */
export const CONNECTED_PAGE_TOOLS = ["browser_tab_open", "browser_tab_read", "browser_tab_click", "browser_tab_scroll", "browser_tab_search"] as const;

/** The conversation as the model reads it: newest last, tool results by their summary. */
/** Tools whose result the model reads at length (the rest are cut to 1,500 characters). */
const LONG_RESULT_TOOLS = new Set(["read_webpage", "web_search", "treg_search", "treg_call", "browser_open", "browser_read", "browser_click", "browser_fill", "browser_scroll", ...CONNECTED_PAGE_TOOLS]);

/** Tools whose result the next action depends on (a page read, a browser step): the batch ends after them. */
export const PAGE_STATE_TOOLS = new Set(["read_webpage", "browser_open", "browser_read", "browser_click", "browser_fill", "browser_scroll", ...CONNECTED_PAGE_TOOLS]);

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

/**
 * Words that ask for outreach, in English and common Hinglish. One of five
 * letters or more also matches a slip of the keyboard ("campagion",
 * "contcat", "emial"); a shorter one ("send", "mail", "dm") only as written
 * or inflected, since too many real words sit a letter away from it. Words a
 * business uses to describe itself ("we sell", "we connect") are left out.
 */
const OUTREACH_WORDS = [
  "contact", "email", "emails", "mail", "message", "messages", "msg", "reach", "outreach", "campaign", "campaigns",
  "pitch", "send", "dm", "dms", "whatsapp", "linkedin",
  "followup", "follow", "bhejo", "bhej", "sampark",
];
const OUTREACH_WORD_SET = new Set(OUTREACH_WORDS);
/** The shortest outreach word a typo of which still counts. */
const TYPO_MIN_LENGTH = 5;

/**
 * Real words within a typo of an outreach word (pilot finding L01): "spend"
 * is not "send", "contract" is not "contact", "each" is not "reach",
 * "gmail" is not "email". They and their plain inflections are ruled out
 * before the typo tolerance, so budget wording ("Spend $0") or ordinary
 * prose never reads as a request to contact people. "follow" and "connect"
 * count only where they stand for outreach ("follow up", "connect with
 * them"), so "the following" and "connect my account" do not.
 */
const NEAR_MISSES = new Set([
  // contact
  "contract", "content", "context", "contest", "contain", "contend", "conduct", "convict", "contort", "compact", "contrast", "connect", "concoct", "intact",
  "constant", "concat",
  // email, emails
  "gmail", "ymail", "emil",
  // message, messages
  "massage", "passage", "menage", "dressage",
  // reach
  "each", "beach", "teach", "peach", "leach", "roach", "retch", "react", "breach", "preach", "reich",
  // pitch
  "patch", "witch", "ditch", "hitch", "bitch", "fitch", "mitch", "pinch", "itch", "pith", "pitchy",
  // follow, followup ("follow" also counts only as "follow up")
  "fellow", "hollow", "fallow", "allow", "follower",
  // campaign, campaigns
  "champaign", "camping", "campion", "campaigner",
  // whatsapp, linkedin
  "whatsup", "linked",
  // sampark, bhejo ("bheja", "bheje": was sent, not send)
  "spark", "bheja", "bheje",
  // send and mail take no typos (four letters); listed so that never changes unnoticed
  "spend", "spent", "sent", "seed", "sand", "bend", "lend", "tend", "mend", "fend", "vend",
  "mall", "main", "maid", "nail", "rail", "sail", "tail", "jail", "hail", "male", "mild", "mile",
]);

/** The word and its plain inflections ("spending" → "spend", "messaging" → "message", "followed" → "follow"). */
function stems(token: string): string[] {
  const out = [token];
  for (const [suffix, replacement] of [["ies", "y"], ["ing", ""], ["ing", "e"], ["ed", ""], ["d", ""], ["es", ""], ["s", ""]] as const) {
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

/** The outreach word `token` is (as written, inflected, or a typo of a word of five letters or more), or null. */
function outreachWordOf(token: string): string | null {
  const forms = stems(token);
  const exact = forms.find((form) => OUTREACH_WORD_SET.has(form));
  if (exact) return exact;
  if (token.length < 4 || forms.some((form) => NEAR_MISSES.has(form))) return null;
  return OUTREACH_WORDS.find((word) => {
    if (word.length < TYPO_MIN_LENGTH) return false;
    const allowed = word.length >= 7 ? 2 : 1;
    return Math.abs(token.length - word.length) <= allowed && editDistance(token, word) <= allowed;
  }) ?? null;
}

/** The owner's own things: "connect my account" is about AgentSDR, not about people. */
const OWN_THINGS = new Set(["my", "our", "your", "its"]);

/** Whether the word at `index` asks for outreach where it stands: "follow" only as "follow up", "connect" only as "connect with" someone. */
function outreachWordAt(tokens: readonly string[], index: number): boolean {
  const token = tokens[index]!;
  if (stems(token).includes("connect")) return tokens[index + 1] === "with" && !OWN_THINGS.has(tokens[index + 2] ?? "");
  const word = outreachWordOf(token);
  if (word === "follow") return tokens[index + 1] === "up";
  return word !== null;
}

const NEGATIONS = new Set(["don", "dont", "not", "never", "no", "cannot", "stop", "without", "avoid", "refrain", "hold", "skip", "pause", "cancel", "halt", "nahi", "mat", "na"]);
/** "can't", "won't", "shouldn't": the word before the "t" of a negative contraction. */
const CONTRACTED = new Set(["can", "won", "shouldn", "mustn", "wouldn", "couldn", "didn", "doesn", "isn", "aren", "wasn", "shan"]);
/** Words a negation reaches across without using up its three-word look-back: "I don't want you to contact anyone". */
const NEGATION_BRIDGE = new Set(["want", "wanna", "need", "wish", "like", "you", "to", "ever", "yet", "please", "even", "really", "actually", "try", "be", "going", "gonna", "should", "will", "would", "can", "could", "i", "we", "any", "off", "on", "from"]);
/** Hinglish puts the negation after the word: "contact mat karo", "email nahi karna". */
const AFTER_NEGATIONS = new Set(["nahi", "nahin", "nhi"]);
const HINDI_VERBS = new Set(["karo", "karna", "karni", "karne", "kare", "karein", "karen", "karenge", "karunga", "kijiye", "kijie", "kar", "bhejo", "bhejna", "bhejiye", "bhej", "hai", "chahiye"]);
/** Words that end a negation's reach over the channels that follow it ("don't email them, just WhatsApp them"). */
const CONTRAST = new Set(["but", "instead", "only", "just", "rather", "except", "then", "so", "also", "however", "though", "although", "sirf", "bas"]);
const LIST_JOINERS = new Set(["or", "and", "nor", ","]);
/** Words that start a new part of a sentence, past which a negation's three-word look-back does not reach (a list still carries it). */
const NEW_PART = new Set(["and", "but", "then", "so"]);

/**
 * Contact details asked for as data are not outreach (pilot finding L01). A
 * channel word is a thing, not an action, when a detail noun follows it
 * ("email address", "whatsapp number", "contact details", "emails of the
 * owners"), when a possessive or a quality comes before it ("their email",
 * "a valid email", "high reach"), after "with" that follows a noun ("clinics
 * with email and phone"), or when it continues such a list. An article alone
 * makes nothing data: "write an email to each clinic", "run the email
 * sequence" and "go ahead with email" ask for outreach.
 */
const CONTACT_DATA_WORDS = new Set(["contact", "email", "mail", "message", "whatsapp", "linkedin", "dm", "reach", "pitch"]);
const DATA_BEFORE = new Set([
  "their", "his", "her", "its", "my", "our", "your", "whose", "any",
  "of", "including", "incl", "plus", "valid", "verified", "working", "correct", "public", "official", "generic", "listed", "published", "business", "primary",
  "error", "warning", "status", "system", "welcome", "voice",
]);
const REACH_QUALITIES = new Set(["high", "low", "good", "wide", "wider", "large", "more", "less", "big", "bigger", "huge", "organic", "total", "social", "local", "global", "broad", "limited", "within", "easy"]);
const DATA_AFTER = new Set([
  "detail", "details", "info", "information", "number", "numbers", "address", "addresses", "id", "ids", "handle", "handles", "profile", "profiles",
  "url", "urls", "link", "links", "account", "accounts", "page", "pages", "person", "persons", "form", "forms", "data", "list", "lists", "point", "points",
  "route", "routes", "method", "methods", "option", "options", "column", "columns", "field", "fields", "domain", "domains", "deck", "decks", "of",
]);
/** "go ahead with email", "proceed with whatsapp": after these, "with" chooses a channel to contact people on. */
const CHOOSE_WITH = new Set(["ahead", "proceed", "go", "start", "continue", "begin", "launch", "off", "on", "carry", "ok", "okay", "yes", "yeah", "sure", "fine", "haan", ",", "then", "only", "just"]);
/** "export the contacts", "verify the emails", "find the email ids": the channel is what the verb handles. */
const DATA_VERBS = new Set([
  "export", "import", "download", "upload", "save", "sync", "delete", "remove", "merge", "dedupe", "list", "show", "count", "collect", "gather",
  "scrape", "extract", "fetch", "pull", "enrich", "verify", "validate", "check", "clean", "find", "get", "copy", "read", "view",
]);
const DETERMINERS = new Set(["the", "all", "these", "those", "every", "a", "an"]);
/** Who "me" is: the owner, in the owner's words; "you", in the assistant's. A verb aimed at them ("send me their emails", "email me the list") asks for data. */
const OWNER_OBJECT: ReadonlySet<string> = new Set(["me", "us"]);
const ASSISTANT_TO_OWNER: ReadonlySet<string> = new Set(["you"]);
/** Hinglish names the owner before the verb: "mujhe list bhejo". */
const HINDI_OWNER = new Set(["mujhe", "mujhko", "muje", "hume", "humein", "hamein", "humko", "hamko"]);

const CLAUSE_BREAK = /^[,.;!?\n]$/;
const SENTENCE_BREAK = /^[.;!?\n]$/;

function isContactData(tokens: readonly string[], index: number, data: readonly boolean[]): boolean {
  const token = tokens[index]!;
  const forms = stems(token);
  if (!forms.some((form) => CONTACT_DATA_WORDS.has(form))) return false;
  const before = tokens[index - 1];
  const after = tokens[index + 1];
  if (after !== undefined && DATA_AFTER.has(after)) return true;
  if (before === undefined) return false;
  if (DATA_BEFORE.has(before)) return true;
  if (forms.includes("reach") && REACH_QUALITIES.has(before)) return true;
  if (before === "with" && index >= 2 && !CHOOSE_WITH.has(tokens[index - 2]!)) return true;
  let verb = index - 1;
  while (verb > 0 && DETERMINERS.has(tokens[verb]!)) verb -= 1;
  if (DATA_VERBS.has(tokens[verb]!)) return true;
  return (before === "and" || before === "or" || before === ",") && data[index - 2] === true;
}

/** Whether the outreach word at `index` is aimed at the owner: "send me", "email us", "send the list to me", "mujhe list bhejo". */
function aimedAtOwner(tokens: readonly string[], index: number, owner: ReadonlySet<string>): boolean {
  if (owner.has(tokens[index + 1] ?? "")) return true;
  if (owner === OWNER_OBJECT) {
    for (let back = index - 1; back >= Math.max(0, index - 3) && !CLAUSE_BREAK.test(tokens[back]!); back -= 1) {
      if (HINDI_OWNER.has(tokens[back]!)) return true;
    }
  }
  for (let at = index + 1; at < Math.min(tokens.length, index + 6); at += 1) {
    if (CLAUSE_BREAK.test(tokens[at]!) || outreachWordAt(tokens, at)) return false;
    if (tokens[at] === "to" && owner.has(tokens[at + 1] ?? "")) return true;
  }
  return false;
}

/** How a mention is negated: as an action ("do not email"), as a thing ("no emails"), or not. */
type Negation = "action" | "thing" | null;
type Mention = { index: number; negated: boolean; negation: Negation };

/** "no emails", "without contact": a negation of the thing, which reaches only along a list of things. */
const THING_NEGATIONS = new Set(["no", "without"]);
/** What a list of things negated together is made of: "no emails, messages or calls to anyone". */
const LIST_OF_THINGS = new Set(["or", "and", "nor", ",", "a", "an", "the", "any", "single", "of", "to", "by", "via", "on", "through", "over", "using", "in", "anyone", "anybody", "them", "people", "everyone", "everybody", "at", "all", "please", "cold"]);

/**
 * How the outreach word at `index` is negated: by a negation in the three
 * words before it in the same clause ("don't contact them"), a Hinglish one
 * after it ("contact mat karo"), or the negation of the list it continues
 * ("do not email, whatsapp or call anyone", "do not contact anyone by email
 * or whatsapp", "no emails, messages or calls"). A contrast ("but", "just",
 * "instead") or a comma that does not continue a list ends that reach: "no
 * emails, whatsapp only" asks for WhatsApp; and a negated thing reaches no
 * further than its list: "clinics with no outreach team and email them"
 * asks to email them.
 */
function negationAt(tokens: readonly string[], index: number, previous: readonly Mention[]): Negation {
  // "with no website and pitch them": a negation before "and" negates what it stood with, not this word;
  // "don't wait, just email them": a contrast ends it too.
  for (let back = index - 1, budget = 3; back >= Math.max(0, index - 8) && budget > 0; back -= 1) {
    const word = tokens[back]!;
    if (CLAUSE_BREAK.test(word) || NEW_PART.has(word) || CONTRAST.has(word)) break;
    if (NEGATIONS.has(word)) return THING_NEGATIONS.has(word) ? "thing" : "action";
    if (word === "t" && CONTRACTED.has(tokens[back - 1] ?? "")) return "action";
    if (!NEGATION_BRIDGE.has(word)) budget -= 1;
  }
  for (let at = index + 1; at <= Math.min(tokens.length - 1, index + 3) && !CLAUSE_BREAK.test(tokens[at]!); at += 1) {
    if (tokens[at] === "mat" || tokens[at] === "mt") return "action";
    if (AFTER_NEGATIONS.has(tokens[at]!) && HINDI_VERBS.has(tokens[at + 1] ?? "")) return "action";
  }
  const last = previous.at(-1);
  if (!last?.negation || index - last.index > 7) return null;
  const between = tokens.slice(last.index + 1, index);
  if (between.some((word) => SENTENCE_BREAK.test(word) || CONTRAST.has(word))) return null;
  if (last.negation === "thing" && !between.every((word) => LIST_OF_THINGS.has(word))) return null;
  const comma = between.lastIndexOf(",");
  if (comma < 0) return last.negation;
  return between.slice(comma + 1).some((word) => LIST_JOINERS.has(word)) || LIST_JOINERS.has(tokens[index + 1] ?? "") ? last.negation : null;
}

/** Curly and other apostrophes as the plain one, so "Don’t" from a phone keyboard reads as "Don't". */
function plainApostrophes(text: string): string {
  return text.replace(/[\u2018\u2019\u02BC\u0060\u00B4]/g, "'");
}

/** The outreach words of `words` that ask to contact people, each with whether it is negated. */
function outreachMentions(words: string, owner: ReadonlySet<string> = OWNER_OBJECT): Mention[] {
  const tokens = plainApostrophes(words).toLowerCase().match(/[a-z]+|[,.;!?\n]/g) ?? [];
  const data: boolean[] = [];
  const out: Mention[] = [];
  tokens.forEach((_, index) => {
    data[index] = isContactData(tokens, index, data);
    if (data[index] || !outreachWordAt(tokens, index) || aimedAtOwner(tokens, index, owner)) return;
    const negation = negationAt(tokens, index, out);
    out.push({ index, negated: negation !== null, negation });
  });
  return out;
}

/** Whether the owner's words ask to contact people (typos allowed: "campagion", "contcat"; "don't contact" and "send me their emails" do not). */
export function outreachIntent(words: string): boolean {
  return outreachMentions(words).some((mention) => !mention.negated);
}

/**
 * The owner says in so many words that this is research without outreach
 * (pilot finding L01). Matched with wide recall, because a missed one
 * contacts people who were not to be contacted while a false one only makes
 * the assistant ask: "research only", "sirf research", "no outreach", "zero
 * outreach", "outreach: none", "do not contact anyone", "don't send any
 * messages", a negated list of channels ("do not email, whatsapp or call
 * anyone", "no emails, messages or calls"), "without contacting", "I'll
 * contact them myself", Hinglish "kisi ko contact mat karo", or "no
 * messages" / "no campaigns" as a clause of their own. Not: a negation of
 * one channel ("don't email them, WhatsApp them", "do not contact them by
 * email"), a rule about how ("do not contact anyone twice"), a business
 * described as research-only, or the question "No outreach yet?".
 */
const NOT = String.raw`(?:do\s+not|don'?t|do\s+n't|never|not\s+to|no\s+need\s+to|you\s+(?:must|should)\s+not|must\s+not|mustn'?t|should\s+not|shouldn'?t|can'?t|cannot|can\s+not|won'?t|will\s+not)`;
const ANYONE = String.raw`(?:anyone|anybody|any\s*one|no\s*one|people|them|these|those|everyone|everybody|any\s+of\s+(?:them|these|those|the\s+\w+)|any\s+(?:business|businesses|clinic|clinics|lead|leads|person|people|prospects?|company|companies|owner|owners)|the\s+(?:leads|clinics|businesses|people|owners|prospects|companies|results|list))`;
/** What makes "do not contact anyone …" a rule about how or whom, not a stop: "by email", "twice", "who replied". */
const QUALIFIED = String.raw`(?!\s*(?:(?:on|via|by|through|over|using|with|from|in|at)\s+(?!any\b|all\b)|(?:until|before|after)\s+(?!(?:i|we|you\s+hear|approval|my|our)\b)|(?:who|whom|whose|that|which|except|unless|outside|twice|more|during|without|if|when|other|than)\b))`;
const CONTACT_ANYONE = String.raw`(?:contact|message|msg|reach\s+out\s+to|approach|get\s+in\s+touch\s+with|pitch(?:\s+to)?|ping)`;
const CHANNEL = String.raw`(?:contact|e-?mail|mail|message|msg|text|sms|call|phone|ping|dm|whatsapp|linkedin|pitch|reach\s+out(?:\s+to)?)`;
const CHANNEL_NOUN = String.raw`(?:outreach|contact|messages?|e-?mails?|calls?|dms?|texts?|sms|whatsapps?|(?:whatsapp|linkedin)\s+messages?|campaigns?|pitches|pitching|messaging|emailing|calling)`;
const LIST_SEPARATOR = String.raw`(?:\s*,\s*(?:or\s+|and\s+|nor\s+)?|\s+or\s+|\s+and\s+|\s+nor\s+)`;
const RESEARCH_ONLY: readonly RegExp[] = [
  new RegExp(String.raw`\bresearch[\s-]+only\b(?!\s+(?:consultancy|consultants?|firm|company|agency|business|team|startup|shop|labs?|services?|outfit|house|studio|practice|clients?|projects?|tool|platform|product|plan|tier|package|account|work)\b)`, "i"),
  /\b(?:only|just|purely|strictly|sirf|bas|keval|kewal)\s+(?:do\s+(?:the\s+)?|for\s+)?research\b/i,
  new RegExp(String.raw`\b(?:don'?t|do\s+not|never)\s+(?:want|wish|need|like)\s+(?:you\s+to\s+|to\s+|any\s+)?(?:(?:${CONTACT_ANYONE})\s+${ANYONE}\b${QUALIFIED}|(?:do\s+)?(?:any\s+)?(?:outreach|contacting|messaging|campaigns?|messages|pitching|pitches)\b)`, "i"),
  /\b(?:outreach|contacting|messaging|campaigns?)\s+(?:is|are)\s+(?:not|n't)\s+(?:needed|required|necessary|wanted|allowed|permitted)\b|\b(?:outreach|contacting|messaging)\s+(?:is|are)\s+(?:off|forbidden|not\s+allowed)\b/i,
  /\b(?:i|we)(?:'ll|\s+will|\s+shall)\s+(?:handle|do|take\s+care\s+of|manage)\s+(?:the\s+|all\s+(?:the\s+)?)?(?:outreach|contacting|messaging|follow[\s-]?ups?)\b(?!\s+(?:with|through|using|via|for|in)\b)/i,
  /\b(?:sirf|bas|keval|kewal)\s+(?:list|leads?)\b/i,
  new RegExp(String.raw`\b${NOT}\s+(?:ever\s+)?${CONTACT_ANYONE}\s+${ANYONE}\b${QUALIFIED}`, "i"),
  new RegExp(String.raw`\b${NOT}\s+send\s+(?:(?:them|anyone|anybody)\s+)?(?:any\s+|a\s+single\s+)?(?:messages?|anything|outreach|pitch(?:es)?|dms?)\b${QUALIFIED}`, "i"),
  new RegExp(String.raw`\b${NOT}\s+${CHANNEL}(?:${LIST_SEPARATOR}${CHANNEL})+(?:\s+${ANYONE})?\s*(?:$|,)`, "i"),
  new RegExp(String.raw`\b(?:no|zero)\s+${CHANNEL_NOUN}(?:${LIST_SEPARATOR}${CHANNEL_NOUN})+(?:\s+(?:to\s+any(?:one|body)|at\s+all|please|whatsoever|of\s+any\s+kind|for\s+now|yet))?\s*(?:$|,)`, "i"),
  /\bwithout\s+(?:any\s+)?(?:contacting|messaging|emailing|pitching|reaching\s+out|outreach)\b(?!\s+(?:on|via|through|by|over|using)\b)/i,
  /\boutreach\s*(?:[:=\u2013\u2014-]\s*(?:none|no|off|nil|zero|0)|\s+(?:none|off))\b/i,
  /\b(?:i|we)(?:'ll|'d|'m\s+going\s+to|'re\s+going\s+to|\s+(?:will|would|shall|can|am\s+going\s+to|are\s+going\s+to|plan\s+to|prefer\s+to|want\s+to))\s+(?:\w+\s+){0,3}?(?:contact|reach|message|e-?mail|call|whatsapp|pitch|dm|text|outreach|follow)\w*\b[^.;!?\n]*?\b(?:myself|ourselves|on\s+(?:my|our)\s+own|personally)\b/i,
  /\b(?:main|mai|hum|ham)\s+(?:khud|apne\s+aap)\b[^.;!?\n]*\b(?:contact|sampark|message|e-?mail|call|whatsapp|outreach)/i,
  /\b(?:kisi|kisiko|koi)\b(?:\s+\w+){0,3}?\s+(?:contact|sampark|message|msg|e-?mail|mail|whatsapp|call|dm|pitch|outreach)\w*(?:\s+\w+){0,2}?\s+(?:mat|mt|nahi|nahin|nhi)\b/i,
  /\b(?:contact|sampark|outreach|message|msg)\s+(?:\w+\s+)?(?:mat|mt)\b/i,
  /\b(?:contact|sampark|outreach|message|msg)\s+(?:\w+\s+)?(?:nahi|nahin|nhi)\s+(?:karo|karna|karni|karne|kare|karein|karen|karenge|kijiye|kijie|bhejo|bhejna)\b/i,
];
/** Statements only: the question "No outreach yet?" asks how things stand. */
const NO_OUTREACH = /\b(?:no|zero|nil)\s+(?:cold\s+)?outreach\b(?!\s+(?:on|via|through|by|over|using|to|team|teams|agency|agencies|tool|tools|software|staff|person|people|budget|plan|strategy|department|manager|experience|history)\b)/i;
const NO_OUTREACH_CLAUSE = /^(?:and\s+|also\s+|please\s+)?(?:no|zero)\s+(?:cold\s+)?(?:outreach|contact|contacting|messages?|messaging|campaigns?|pitching|pitches|sending)(?:\s+(?:please|at\s+all|yet|for\s+now|to\s+anyone|to\s+anybody|now|today|whatsoever))?$/i;

export function researchOnlyStated(text: string): boolean {
  for (const sentence of plainApostrophes(text).match(/[^.;!?\n]+[.;!?\n]*/g) ?? []) {
    const question = sentence.includes("?");
    const body = sentence.replace(/[.;!?\n]+$/, "").trim();
    if (RESEARCH_ONLY.some((pattern) => pattern.test(body))) return true;
    if (question) continue;
    if (NO_OUTREACH.test(body)) return true;
    if (body.split(/,|\s+(?:and|but|also)\s+/i).some((clause) => NO_OUTREACH_CLAUSE.test(clause.trim()))) return true;
  }
  return false;
}

/** The owner tells the assistant not to contact people ("stop contacting them", "don't message anyone yet", "research only"). */
export function outreachRevoked(words: string): boolean {
  return researchOnlyStated(words) || outreachMentions(words).some((mention) => mention.negated);
}

const CONFIRMATIONS = new Set([
  "yes", "yeah", "yep", "yup", "ya", "sure", "ok", "okay", "go", "ahead", "do", "it", "please", "proceed", "confirm", "confirmed",
  "start", "right", "correct", "fine", "great", "perfect", "lets", "let", "s", "that", "haan", "han", "ha", "ji", "theek", "thik",
  "hai", "kar", "karo", "chalo", "done", "absolutely", "definitely", "now", "sounds", "good", "for", "with",
]);
const CONFIRMATION_CORE = new Set(["yes", "yeah", "yep", "yup", "ya", "sure", "ok", "okay", "go", "do", "proceed", "confirm", "confirmed", "haan", "han", "ha", "theek", "thik", "karo", "kar", "chalo", "absolutely", "definitely", "perfect"]);

/** A short "yes" (or "go ahead", "do it", "go for it", "haan karo") with nothing else in it. */
export function isConfirmation(text: string): boolean {
  const tokens = text.toLowerCase().match(/[a-z]+/g) ?? [];
  return tokens.length > 0 && tokens.length <= 6 && tokens.every((token) => CONFIRMATIONS.has(token)) && tokens.some((token) => CONFIRMATION_CORE.has(token));
}

/**
 * Whether the owner has asked for outreach: their latest message asks to
 * contact, message or pitch people, or says yes to the assistant's last
 * message offering exactly that ("Shall I send you their details?" offers
 * data, not outreach). The model's own wording never counts, and a message
 * that says research only asks for none, whatever else is in it.
 */
export function outreachRequested(ownerText: string, lastAssistantText?: string | null): boolean {
  if (researchOnlyStated(ownerText)) return false;
  if (outreachIntent(ownerText)) return true;
  return Boolean(lastAssistantText && isConfirmation(ownerText) && outreachMentions(lastAssistantText, ASSISTANT_TO_OWNER).some((mention) => !mention.negated));
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
 * A newer message that says research only, or not to contact people,
 * cancels it (pilot finding L01): the latest word wins.
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
    if (outreachRequested(message.content, before)) return history.slice(index + 1).some(actsOnOutreach) ? null : index;
    if (outreachRevoked(message.content)) return null;
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
  // review_leads (research agent v2) shows the request's leads as the server stored them: their sites and profiles may be opened.
  return tool === "read_webpage" || tool === "web_search" || tool === "treg_call" || tool === "review_leads" || Boolean(tool?.startsWith("browser_"));
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
 * instead of appearing in the chat: no contacts or business information the
 * owner or a read source never gave. (Which pages to open and whether a save
 * changes anything are the model's; page reads are still limited to public
 * addresses, and a save that changes nothing says so.)
 */
export function actionsProblem(actions: readonly AgentAction[], input: { profile: BusinessProfile; ownerCorpus: string; outreachRequested: boolean; inquiryRepliesRequested?: boolean }): string | null {
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
    if (action.tool !== "save_business_info") continue;
    const ungrounded = ungroundedProfileValues(action.args, input.ownerCorpus);
    if (ungrounded.length) {
      return `save_business_info: ${ungrounded.join(", ")} ${ungrounded.length === 1 ? "is" : "are"} not what the owner wrote. Save only the owner's own information, in their words; ask them about the rest.`;
    }
  }
  return null;
}

/** Whether two messages are the same words (case, spacing and punctuation aside), so a turn never repeats itself; a message that differs in a number or a place is new. */
export function sameMessage(a: string, b: string): boolean {
  const words = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");
  const left = words(a);
  return left.length > 0 && left === words(b);
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

import { messageLanguage } from "@/lib/assistant/handoff";
import { draftLeaks, draftPlaceholders } from "./ai/grounding";

/**
 * Wrong number: the route a message came through (a phone number, an email
 * address, a profile) reaches someone other than the intended lead. Distinct
 * from Do Not Contact (CONTEXT.md, "Contact restrictions"): outreach to that
 * route stops for good and the route is recorded as wrong in
 * crm_wrong_routes, but the lead is not opted out, and the person who
 * answered may get one brief closing acknowledgement, never anything else.
 *
 * Everything here is pure (shared by the reply agent, the classifier path,
 * the send checks and the record page); the database side is wrongRoutes.ts.
 */

export const WRONG_ROUTE_CHANNELS = ["email", "whatsapp", "linkedin", "instagram"] as const;
export type WrongRouteChannel = (typeof WRONG_ROUTE_CHANNELS)[number];

/**
 * Where the one closing acknowledgement stands:
 * - none: none was planned (recorded by a person, or no route to answer on);
 * - drafted: written and waiting (Review mode, or for the Automatic send);
 * - reserved: claimed for the Automatic send under the organization's lock;
 * - sending: the send attempt holds the single-use exemption;
 * - sent / failed / uncertain: what the provider said (never retried);
 * - blocked: not sent, and never will be (Do Not Contact, an explicit
 *   opt-out, a takeover, a newer message, a refused send).
 */
export const WRONG_ROUTE_ACK_STATUSES = ["none", "drafted", "reserved", "sending", "sent", "failed", "uncertain", "blocked"] as const;
export type WrongRouteAckStatus = (typeof WRONG_ROUTE_ACK_STATUSES)[number];

/** Statuses in which the acknowledgement draft may still pass the wrong-route block (once). */
export const ACK_CLAIMABLE: readonly WrongRouteAckStatus[] = ["drafted", "reserved"];

export function isWrongRouteChannel(channel: string): channel is WrongRouteChannel {
  return (WRONG_ROUTE_CHANNELS as readonly string[]).includes(channel);
}

/**
 * One comparable value per route: a lowercased email address, a phone
 * number's digits (a WhatsApp contact id "919876543210@s.whatsapp.net" and
 * "+91 98765 43210" are the same route), a profile id or URL lowercased.
 * A WhatsApp privacy id ("…@lid") carries no number, so it is a route of
 * its own ("<id>@lid"): recorded when the chat that wrote has no known
 * number, and compared by every send to a chat addressed by it.
 */
export function normalizeRoute(channel: WrongRouteChannel, value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (channel === "email") {
    const email = raw.toLowerCase();
    return /^[^\s@]+@[^\s@]+$/.test(email) ? email : null;
  }
  if (channel === "whatsapp") {
    if (/@lid$/i.test(raw)) {
      const id = raw.replace(/(?::\d+)?@lid$/i, "").replace(/\D/g, "");
      return id ? `${id}@lid` : null;
    }
    if (raw.includes("@") && !/@(?:s\.whatsapp\.net|c\.us)$/i.test(raw)) return null;
    const digits = raw.replace(/(?::\d+)?@.*$/, "").replace(/\D/g, "");
    return digits.length >= 7 && digits.length <= 15 ? digits : null;
  }
  return raw.toLowerCase().replace(/\/+$/, "");
}

/**
 * Every route a send or a conversation on this channel may reach: the
 * conversation's contact (the number that actually wrote) and the Person's
 * own address for the channel (where a new chat or email would go).
 */
export function candidateRoutes(channel: string, input: { providerContactId?: string | null; email?: string | null; phone?: string | null; linkedinUrl?: string | null }): string[] {
  if (!isWrongRouteChannel(channel)) return [];
  const values = channel === "email"
    ? [input.email]
    : channel === "whatsapp"
      ? [input.providerContactId, input.phone]
      : channel === "linkedin"
        ? [input.providerContactId, input.linkedinUrl]
        : [input.providerContactId];
  return [...new Set(values.map((value) => normalizeRoute(channel, value)).filter((route): route is string => Boolean(route)))];
}

function normalized(text: string): string {
  return text.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, " ").trim();
}

/**
 * The message says the route is wrong, in the plain words people use.
 * Conservative: a hint for the classifier path and the reply agent's
 * fallbacks, never the only reason outreach stops on a message the model
 * read differently.
 */
export function detectsWrongNumber(text: string): boolean {
  const value = normalized(text);
  return [
    /\bwrong\s+(?:number|no\.?|num|person|contact|guy|lady|whatsapp|email|address)\b/,
    /\b(?:you(?:'ve| have)?|u)\s+(?:got|have|messaged|texted|emailed)\s+the\s+wrong\b/,
    /\bnot\s+the\s+(?:right|correct)\s+(?:number|person)\b/,
    /\b(?:galat|gal?at|rong)\s+(?:number|no|nambar)\b/,
    /गलत\s*(?:नंबर|नम्बर|व्यक्ति)/,
    /\bn[uú]mero\s+(?:equivocado|errado|incorrecto)\b/,
    /\bmauvais\s+num[eé]ro\b/,
    /\bfalsche\s+nummer\b/,
  ].some((pattern) => pattern.test(value));
}

/**
 * An explicit request to stop, unsubscribe or not be contacted. Broader
 * than the classifier path's detectsExplicitDncIntent on purpose: next to
 * "wrong number" any of these means Do Not Contact and nothing is sent, and
 * erring this way only ever sends less.
 */
export function detectsOptOutWording(text: string): boolean {
  const value = normalized(text);
  return [
    /\bstop\b/,
    /\bunsubscribe\b/,
    /\bopt(?:\s|-)?out\b/,
    /\bremove\s+(?:me|this\s+number|my\s+number|my\s+email)\b/,
    /\b(?:do\s*n[o']?t|dont|never)\s+(?:ever\s+)?(?:contact|message|text|call|email|e-mail|whatsapp|write\s+to|msg)\b/,
    /\bno\s+more\s+(?:emails?|messages?|texts?|calls?)\b/,
    /\bleave\s+me\s+alone\b/,
    /\b(?:i'll|i\s+will|gonna)\s+(?:block|report)\b/,
    /\bmat\s+(?:karo|bhejo|bhejna)\b/,
    /(?:मत\s+(?:भेजो|भेजें|करो|करें)|बंद\s+करो)/,
  ].some((pattern) => pattern.test(value));
}

/**
 * The fixed closing line, in the recipient's language when it is one we
 * hold: used when the model's acknowledgement is missing or fails the
 * check, and on the classifier path, which has no model to write one.
 */
export function fallbackAcknowledgement(leadMessage: string, channel: string): string {
  const value = normalized(leadMessage);
  const target = channel === "email" ? "address" : channel === "whatsapp" ? "number" : null;
  if (/\bn[uú]mero\s+equivocado\b|\bincorrecto\b/.test(value)) return target === "address" ? "Disculpe la molestia: no volveremos a escribir a esta dirección." : "Disculpe la molestia: no volveremos a escribir a este número.";
  if (/\bn[uú]mero\s+errado\b/.test(value)) return target === "address" ? "Desculpe o incômodo: não enviaremos mais mensagens para este endereço." : "Desculpe o incômodo: não enviaremos mais mensagens para este número.";
  if (/\bmauvais\s+num[eé]ro\b/.test(value)) return "Désolé pour le dérangement : nous n'écrirons plus à ce numéro.";
  if (/\bfalsche\s+nummer\b/.test(value)) return "Entschuldigung für die Störung, wir schreiben diese Nummer nicht mehr an.";
  const language = messageLanguage(leadMessage);
  if (language === "hi") return target === "address" ? "क्षमा करें, हम इस पते पर दोबारा संदेश नहीं भेजेंगे।" : "क्षमा करें, हम इस नंबर पर दोबारा संदेश नहीं भेजेंगे।";
  if (language === "hinglish" || /\b(?:galat|rong)\s+(?:number|no|nambar)\b/.test(value)) return "Sorry, galti ho gayi. Hum is number par dobara message nahi karenge.";
  if (target === "address") return "Sorry about that—we won't email this address again.";
  if (target === "number") return "Sorry about that—we won't message this number again.";
  return "Sorry about that—we won't message you again.";
}

const ACK_MAX_LENGTH = 200;

/**
 * What a closing acknowledgement must never contain: it apologises and says
 * the messages stop, nothing more. No question, no offer or pitch, no link,
 * number, price or time, no request for the right number or person.
 */
export function acknowledgementProblems(text: string): string[] {
  const value = text.trim();
  if (!value) return ["it is empty"];
  const problems: string[] = [];
  if (value.length > ACK_MAX_LENGTH) problems.push(`it is ${value.length} characters; one short sentence is enough`);
  if (/[?¿؟？]/.test(value)) problems.push("it asks a question");
  if (/https?:\/\/|www\.|\b[\w.-]+\.(?:com|in|io|co|net|org|ai)\b|\S+@\S+\.\S+/i.test(value)) problems.push("it contains a link or address");
  if (/\d/.test(value)) problems.push("it contains a number, price or time");
  if (/\b(?:offer|discount|deal|price|pricing|cost|free|trial|demo|buy|purchase|product|services?|plan|solution|interested|book|meeting|call\s+(?:you|us)|business)\b/i.test(value)) problems.push("it pitches or offers something");
  if (/\b(?:correct|right|new|real|their|his|her)\s+(?:number|contact|email|address|details|person)\b|\b(?:share|forward|pass\s+(?:it|this|on)|send\s+(?:us|me)|let\s+(?:us|me)\s+know|could\s+you|can\s+you|would\s+you|do\s+you\s+know)\b/i.test(value)) {
    problems.push("it asks for something (the right number or person)");
  }
  const placeholders = draftPlaceholders(value);
  if (placeholders.length) problems.push(`it contains placeholders (${placeholders.slice(0, 2).join(", ")})`);
  const leaks = draftLeaks(value);
  if (leaks.length) problems.push("it talks about the instructions");
  return problems;
}

/** The acknowledgement to send: the model's when it passes the check, else the fixed line. */
export function closingAcknowledgement(candidate: string | null | undefined, leadMessage: string, channel: string): { text: string; problems: string[] } {
  const problems = candidate?.trim() ? acknowledgementProblems(candidate) : ["the model wrote none"];
  return problems.length ? { text: fallbackAcknowledgement(leadMessage, channel), problems } : { text: candidate!.trim(), problems: [] };
}

/** The record page's line: "Wrong number — outreach stopped" and where the acknowledgement stands. */
export function wrongRouteAckLabel(status: string, reason?: string | null): { label: string; tone: "done" | "waiting" | "you" | "failed" | "muted" } {
  switch (status) {
    case "sent": return { label: "Apology sent", tone: "done" };
    case "drafted": return { label: "Apology awaiting review", tone: "you" };
    case "reserved":
    case "sending": return { label: "Apology sending", tone: "waiting" };
    case "failed": return { label: `Apology failed${reason ? `: ${reason}` : ""}`, tone: "failed" };
    case "uncertain": return { label: "Apology delivery uncertain: check before doing anything else", tone: "failed" };
    case "blocked": return { label: `No apology sent${reason ? `: ${reason}` : ""}`, tone: "muted" };
    default: return { label: "No apology", tone: "muted" };
  }
}

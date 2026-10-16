import type { OwnerDecisionKind, RunLeadChannel } from "./schema";

/**
 * The handoff to a person: when the reply autopilot stops and the owner
 * takes over. Every open owner decision is a handoff and appears in the
 * Needs you list; this module holds what is decided without a database:
 * which kinds tell the lead a person takes over, how each is labelled and
 * ranked for the owner, and the one message the lead gets.
 */

/** Decisions that are reports, not handoffs: never in Needs you. */
export const REPORT_KINDS: readonly OwnerDecisionKind[] = ["interested", "opt_out"];

export function isHandoff(kind: OwnerDecisionKind): boolean {
  return !REPORT_KINDS.includes(kind);
}

/**
 * Handoffs where the lead is told, once, that a person will reply. Not for
 * `uncertain`: that is often an auto-reply, someone who left, or a message
 * nobody understood, where "I've passed this on" would be wrong.
 */
export const TELLS_THE_LEAD: OwnerDecisionKind[] = ["ready", "person", "complaint", "missing_info", "negotiation", "meeting", "commitment", "limit"];

export function tellsTheLead(kind: OwnerDecisionKind): boolean {
  return TELLS_THE_LEAD.includes(kind);
}

/** At most one handover message per conversation in this long. */
export const HANDOVER_INTERVAL_MS = 24 * 60 * 60_000;

/** An unanswered handoff is reminded once, this long after its first email. */
export const REMINDER_AFTER_MS = 3 * 60 * 60_000;

const LABELS: Record<OwnerDecisionKind, { label: string; priority: number; action: string }> = {
  ready: { label: "Ready to buy", priority: 0, action: "Contact them now" },
  person: { label: "Asked for a person", priority: 1, action: "Reply to them yourself" },
  complaint: { label: "Complaint", priority: 1, action: "Reply to them yourself" },
  negotiation: { label: "Price or discount", priority: 2, action: "Answer, or reply yourself" },
  meeting: { label: "Meeting to arrange", priority: 2, action: "Answer, or reply yourself" },
  missing_info: { label: "Answer needed", priority: 3, action: "Answer, and the assistant replies" },
  commitment: { label: "Promise to confirm", priority: 3, action: "Answer, or reply yourself" },
  limit: { label: "Chat limit reached", priority: 4, action: "Take over the chat" },
  uncertain: { label: "Take a look", priority: 4, action: "Read the chat" },
  interested: { label: "Interested", priority: 5, action: "" },
  opt_out: { label: "Opted out", priority: 5, action: "" },
};

export function handoffLabel(kind: OwnerDecisionKind): { label: string; priority: number; action: string } {
  return LABELS[kind] ?? LABELS.uncertain;
}

/** Whether the owner's answer in the card is what the lead is waiting for (rather than a call or their own reply). */
export function takesAnAnswer(kind: OwnerDecisionKind): boolean {
  return kind === "missing_info" || kind === "negotiation" || kind === "meeting" || kind === "commitment";
}

/** Most urgent first: by kind (ready to buy first), then the longest wait. */
export function byUrgency<T extends { kind: OwnerDecisionKind; createdAt: Date | string }>(a: T, b: T): number {
  return handoffLabel(a.kind).priority - handoffLabel(b.kind).priority
    || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}

/** "12 min", "3 h", "2 days": how long the lead has waited. */
export function waitedFor(since: Date | string, now: Date = new Date()): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(since).getTime()) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} days`;
}

const HINGLISH_WORDS = /\b(?:hai|hain|kya|nahi|nahin|aap|aapka|aapki|mujhe|humko|hum|chahiye|karna|karo|kitna|kitne|kab|kaise|kyun|bhai|ji|accha|acha|theek|thik|haan|bata|batao|sakte|milega)\b/gi;

/** The language a lead wrote in, as far as the handover needs it: Hindi script, Hinglish, or anything else (English). */
export function messageLanguage(text: string): "hi" | "hinglish" | "en" {
  if (/[\u0900-\u097F]/.test(text)) return "hi";
  return (text.match(HINGLISH_WORDS) ?? []).length >= 2 ? "hinglish" : "en";
}

/**
 * The one message the lead gets when a person takes over. It is sent from
 * the same number, mailbox or profile the outreach came from, signed by the
 * sender, so it speaks as the sender: honest (a personal reply follows),
 * no time promised beyond "soon", nothing about what the reply will say,
 * and in the lead's language. Written here, not by the model, so it is the
 * same checked text every time.
 */
export function handoverMessage(
  channel: RunLeadChannel,
  input: { kind: OwnerDecisionKind; leadMessage?: string | null; senderName?: string | null; leadFirstName?: string | null; subject?: string | null },
): { subject: string | null; body: string } {
  const language = messageLanguage(input.leadMessage ?? "");
  const ready = input.kind === "ready";
  const line = language === "hi"
    ? (ready ? "धन्यवाद! आगे की बात के लिए आपको जल्द ही व्यक्तिगत रूप से जवाब मिलेगा।" : "धन्यवाद! इस बारे में आपको जल्द ही व्यक्तिगत रूप से जवाब मिलेगा।")
    : language === "hinglish"
      ? (ready ? "Thank you! Aage ke liye aapko jaldi personally reply milega." : "Thanks! Is baare mein aapko jaldi personally reply milega.")
      : (ready ? "Thank you! I'll get back to you personally soon to take this forward." : "Thanks for your message! I'll get back to you personally on this soon.");
  if (channel !== "email") return { subject: null, body: line };
  const greeting = input.leadFirstName?.trim() ? `Hi ${input.leadFirstName.trim()},` : "Hello,";
  const subject = input.subject?.trim() ? (/^re:/i.test(input.subject.trim()) ? input.subject.trim() : `Re: ${input.subject.trim()}`) : "Re: your message";
  const name = input.senderName?.trim();
  return { subject, body: `${greeting}\n\n${line}${name ? `\n\n${name}` : ""}` };
}

/** Why the autopilot sent nothing for an "ok" or a "thanks"; the plan card shows it as settled, not as waiting. */
export const NO_ANSWER_NEEDED = "no answer needed:";

/** Why the autopilot holds a reply while the conversation waits in Needs you. */
export const WAITING_IN_NEEDS_YOU = "this chat waits for you in Needs you";

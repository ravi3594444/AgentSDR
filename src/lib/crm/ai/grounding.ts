/**
 * What a reply draft may say about the world, checked after the model writes
 * it. Drafts are reviewed before sending, but a reviewer skimming "I've sent
 * you a calendar invite" will not always notice that nothing was sent: no
 * calendar, attachment or invitation integration exists, and the model
 * cannot act. So a draft that claims a completed action the CRM has no
 * record of, or that leaves a placeholder such as "[Your Name]", is
 * rejected and the model is asked again with the reason.
 *
 * The record of what actually happened is `completedActions`: messages
 * already sent in the conversation, and stage moves a person recorded
 * (for example "meeting booked", which a person sets after booking one).
 * Pure, so the rules are unit-tested.
 */

export type DraftCompletedAction =
  | { kind: "message_sent"; channel: string; sentAt: string; subject: string | null; excerpt: string }
  | { kind: "stage_moved"; stage: string; occurredAt: string; note: string | null };

/** Who the draft is written as. Null fields are unknown, never to be filled in by the model. */
export type DraftSender = {
  name: string | null;
  company: string | null;
  /** The sending mailbox's signature as plain text, when it has one. */
  signature: string | null;
};

type ClaimKind = "booking" | "invitation" | "shared" | "attachment";

const CLAIMS: Array<{ kind: ClaimKind; pattern: RegExp }> = [
  // "I've booked / scheduled / set up … a meeting", "we have confirmed the call"
  {
    kind: "booking",
    pattern: /\b(?:i|we)(?:'ve|’ve| have)?\s+(?:just\s+|already\s+|now\s+|gone ahead and\s+)?(?:booked|scheduled|set up|confirmed|arranged|reserved|blocked(?: off)?|locked in|put)\b[^.!?\n]{0,60}?\b(?:meeting|call|demo|slot|session|appointment|calendar|time)\b/i,
  },
  // "the meeting is booked", "our call has been scheduled"
  {
    kind: "booking",
    pattern: /\b(?:meeting|call|demo|appointment|session)\s+(?:is|has been|was|’s|'s)\s+(?:now\s+|all\s+)?(?:booked|scheduled|confirmed|set up|locked in|in the calendar|on the calendar)\b/i,
  },
  // "I've sent you a calendar invite", "I sent the invitation"
  {
    kind: "invitation",
    pattern: /\b(?:i|we)(?:'ve|’ve| have)?\s+(?:just\s+|already\s+|now\s+)?(?:sent|shared|forwarded|emailed|added you to|dropped)\b[^.!?\n]{0,60}?\b(?:invite|invitation|calendar)\b/i,
  },
  // "the invite is on its way", "an invitation has been sent", "you should have received the invite"
  {
    kind: "invitation",
    pattern: /\b(?:invite|invitation)\s+(?:is|has been|was)\s+(?:sent|on (?:its|the) way|in your inbox)\b|\byou should (?:now )?(?:have|'ve|’ve)\s+(?:received|got(?:ten)?)\b[^.!?\n]{0,40}?\b(?:invite|invitation|calendar)\b/i,
  },
  // "I've sent over the deck / pricing / proposal / link"
  {
    kind: "shared",
    pattern: /\b(?:i|we)(?:'ve|’ve| have)?\s+(?:just\s+|already\s+|now\s+)?(?:sent|shared|forwarded|emailed)(?:\s+(?:you|over|across|through))*\b[^.!?\n]{0,40}?\b(link|deck|proposal|pricing|price list|quote|contract|document|brochure|case stud(?:y|ies)|one-pager|overview|presentation|slides)\b/i,
  },
  // Nothing can be attached to a draft.
  {
    kind: "attachment",
    pattern: /\b(?:i(?:'ve|’ve| have)?\s+attached|(?:please\s+)?find attached|attached (?:is|are|you(?:'ll|’ll| will) find|here)|i(?:'m|’m| am) attaching|enclosed (?:is|are|please find)|see (?:the )?attached)\b/i,
  },
];

const MEETING_STAGE = /meet|book|demo|call|schedul|appointment/i;

function excerpt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 20);
  return text.slice(start, Math.min(text.length, index + length + 20)).replace(/\s+/g, " ").trim();
}

/**
 * Claims of completed actions the record does not support, as short quotes.
 * A booking is supported by a stage move a person recorded for a meeting; a
 * shared document or link by an earlier sent message that mentions it.
 * Invitations and attachments are never supported: nothing in the product
 * sends either.
 */
export function unverifiedActionClaims(text: string, completedActions: readonly DraftCompletedAction[]): string[] {
  const meetingRecorded = completedActions.some((action) => action.kind === "stage_moved" && MEETING_STAGE.test(action.stage));
  const sentText = completedActions
    .filter((action): action is Extract<DraftCompletedAction, { kind: "message_sent" }> => action.kind === "message_sent")
    .map((action) => `${action.subject ?? ""} ${action.excerpt}`.toLowerCase())
    .join("\n");
  const claims: string[] = [];
  for (const { kind, pattern } of CLAIMS) {
    const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    for (const match of text.matchAll(global)) {
      if (kind === "booking" && meetingRecorded) continue;
      if (kind === "shared" && match[1] && sentText.includes(match[1].toLowerCase())) continue;
      claims.push(excerpt(text, match.index ?? 0, match[0].length));
    }
  }
  return [...new Set(claims)];
}

const PLACEHOLDERS: RegExp[] = [
  // [Your Name], [Company], [insert date] — but not a markdown link's [text](url)
  /\[[^\]\n]{1,60}\](?!\()/g,
  // {{first_name}}, {first name}
  /\{\{?\s*[A-Za-z_][\w .-]{0,40}\}\}?/g,
  // <Your Name>, <<company>>
  /<<?\s*(?:your|insert|company|name|first|last|date|time|link|calendar|sender|recipient)[^<>\n]{0,40}>>?/gi,
  // a sign-off line that is only "Your Name" (the phrase inside a sentence is ordinary English)
  /^[ \t]*(?:your name|your full name|your title|your company|sender name|company name)[ \t]*$/gim,
  // "insert date here"
  /\binsert (?:name|date|time|link|company|calendar link)\b/gi,
];

/** Template placeholders left in a draft, as written. */
export function draftPlaceholders(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of PLACEHOLDERS) {
    for (const match of text.matchAll(pattern)) found.add(match[0].trim());
  }
  return [...found];
}

const LEAKS: RegExp[] = [
  // The prompt's own field names reaching the recipient.
  /\b(?:completedActions|recentConversation|mergeVariables|acceptedClassification|stageChange|sequenceStep|channelConstraints)\b/,
  /\bsender\.(?:name|company|signature)\b/,
  /\bknowledge excerpts?\b/i,
  // The model describing itself instead of writing as the sender.
  /\bas an ai\b|\blanguage model\b|\bi(?:'m|’m| am) (?:unable|not able) to (?:send|book|schedule|attach)\b|\bi (?:cannot|can't|can’t) (?:send|book|schedule|attach)\b[^.!?\n]{0,40}\b(?:from here|directly)\b/i,
];

/** Prompt internals or self-description that must not reach the recipient, as written. */
export function draftLeaks(text: string): string[] {
  return LEAKS.flatMap((pattern) => {
    const match = pattern.exec(text);
    return match ? [match[0]] : [];
  });
}

/** Why a draft cannot be offered for review, or null. The message is fed back to the model on retry. */
export function draftGroundingProblem(
  content: { subject: string | null; bodyText: string },
  completedActions: readonly DraftCompletedAction[],
): string | null {
  const text = `${content.subject ?? ""}\n${content.bodyText}`;
  const placeholders = draftPlaceholders(text);
  if (placeholders.length) {
    return `The draft contains placeholders (${placeholders.slice(0, 3).map((p) => `"${p}"`).join(", ")}). Write the final text: use sender for the sign-off, and leave out anything unknown instead of a placeholder.`;
  }
  const leaks = draftLeaks(text);
  if (leaks.length) {
    return `The draft talks about the drafting context instead of to the recipient (${leaks.slice(0, 2).map((l) => `"${l}"`).join(", ")}). Write only what the sender would say to them.`;
  }
  const claims = unverifiedActionClaims(text, completedActions);
  if (claims.length) {
    return `The draft claims actions that completedActions does not record (${claims.slice(0, 2).map((c) => `"${c}"`).join("; ")}). Nothing has been booked, sent or attached yet: have the sender confirm or propose the step and say it will follow, without mentioning this rule.`;
  }
  return null;
}

/** A mailbox signature (HTML) as plain text lines, for the prompt; null when empty. */
export function signatureText(html: string | null | undefined): string | null {
  if (!html?.trim()) return null;
  const text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return text ? text.slice(0, 500) : null;
}

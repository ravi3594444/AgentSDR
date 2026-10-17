import type { AudienceChannel } from "./schema";

/**
 * What makes a cold first message easy to ignore, found without a model, so
 * the writer is told exactly what to fix (writer.server.ts hands these back
 * as the reason an answer was rejected). These are structural checks on the
 * text, not phrases: the model chooses the words, the harness only refuses
 * the shapes busy people skip (the same word opening two sentences, a list
 * of everything the business does, a first chat message too long to read on
 * a phone). Pure, so each rule is unit-tested.
 */

/** Legal forms a listing carries but nobody says in a greeting ("Sold By Tereza Inc." → "Sold By Tereza"). */
// Only forms that are never part of the name people use: not "Company" ("The Cleaning Company"),
// not "Co" after "&" ("Smith & Co"), not "PC" ("Gaming PC").
const LEGAL_SUFFIX = /(?:[\s,]+(?:private\s+limited|inc|incorporated|llc|l\.l\.c|ltd|limited|pvt|plc|llp|corp|gmbh|s\.r\.l|pty)\.?|,\s*(?:co|corporation|private)\.?)$/i;

/**
 * The business name as people say it: the legal form dropped, and anything
 * after a separator a listing adds ("Bright Smile | Best Dentist in Baner")
 * left out. Falls back to the original when cleaning would leave too little.
 */
export function displayBusinessName(name: string | null | undefined): string {
  const original = (name ?? "").replace(/\s+/g, " ").trim();
  if (!original) return "";
  let value = original.split(/\s+[|•·]\s+|\s+[-–—]\s+(?=\S)/)[0]!.trim();
  for (let i = 0; i < 3; i += 1) {
    const next = value.replace(LEGAL_SUFFIX, "").replace(/[\s,]+$/, "").trim();
    if (next === value) break;
    value = next;
  }
  return value.length >= 2 ? value : original;
}

/** The sentences of a message, without merge-field-only lines, the greeting and the sign-off. */
export function messageSentences(text: string): string[] {
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const content = lines.filter((line, index) => {
    if (/^\{\{[^{}]+\}\}$/.test(line)) return false; // the per-lead line, written separately
    if (index === 0 && /^(?:hi|hello|hey|dear|good\s\w+)\b.{0,60}[,!]?$/i.test(line) && line.length <= 70) return false;
    if (index === lines.length - 1 && /^[–—-]/.test(line)) return false;
    return true;
  });
  return content.flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z0-9"'“])/)).map((sentence) => sentence.trim()).filter(Boolean);
}

function firstWord(sentence: string): string {
  const match = /^[^\p{L}\p{N}{]*([\p{L}\p{N}']+)/u.exec(sentence);
  return match ? match[1]!.toLowerCase() : "";
}

/** Words of four letters or more that open more than one sentence ("Listen — …", "Listen, quick one …"). */
export function repeatedOpeners(text: string): string[] {
  const counts = new Map<string, number>();
  for (const sentence of messageSentences(text)) {
    const word = firstWord(sentence);
    if (word.length >= 4 && !word.startsWith("{{")) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts].filter(([, n]) => n > 1).map(([word]) => word);
}

/** The longest comma-separated run of items in one sentence (a list of services reads as a mass message). */
export function longestList(text: string): number {
  let longest = 0;
  for (const sentence of messageSentences(text)) {
    const items = sentence.replace(/\d,\d/g, "").split(/,|;|\s+(?:and|plus|&)\s+/i).map((item) => item.trim()).filter((item) => item.length > 1);
    longest = Math.max(longest, items.length);
  }
  return longest;
}

/** Characters a reader sees, counting a merge field as a short name and leaving out the per-lead line and the sign-off. */
export function visibleLength(text: string): number {
  return messageSentences(text).join(" ").replace(/\{\{[^{}]+\}\}/g, "xxxxxxxxxxxx").length;
}

/**
 * How long a first message's own text may be on each channel, without the
 * greeting, the lead's line and the sign-off. With a line of at most
 * PERSONAL_LINE_LIMITS, a first WhatsApp stays around 400 characters: what
 * one phone screen shows before "read more".
 */
export const FIRST_MESSAGE_LIMITS: Record<AudienceChannel, number> = { whatsapp: 260, linkedin: 400, instagram: 260, email: 900 };
/** How long the per-lead opening line may be on each channel. */
export const PERSONAL_LINE_LIMITS: Record<AudienceChannel, number> = { whatsapp: 120, linkedin: 120, instagram: 120, email: 200 };
/** More items than this in one sentence is a list of everything. */
export const MAX_LIST_ITEMS = 3;

/**
 * Why a first message would likely be ignored, each phrased as what to fix.
 * Follow-ups are checked for repetition and lists only.
 */
export function pitchProblems(channel: AudienceChannel, body: string, options: { first: boolean }): string[] {
  const problems: string[] = [];
  const repeated = repeatedOpeners(body);
  if (repeated.length) problems.push(`"${repeated.join("\", \"")}" opens more than one sentence; use a word or phrase from the owner's style at most once and start each sentence differently`);
  const list = longestList(body);
  if (list > MAX_LIST_ITEMS) problems.push(`one sentence lists ${list} things; name only the one or two that matter most to these leads, never everything the business offers`);
  if (options.first) {
    const length = visibleLength(body);
    const limit = FIRST_MESSAGE_LIMITS[channel];
    if (length > limit) problems.push(`the first ${channel === "email" ? "email" : "message"} reads ${length} characters without the greeting, the lead's own line and the sign-off; keep it under ${limit} so it is read on a phone`);
  }
  return problems;
}

/** Why a per-lead opening line clashes with the message it is put in front of, or null. */
export function lineClash(line: string, messageAfter: string): string | null {
  const opener = firstWord(line.trim());
  if (!opener || !messageAfter.trim()) return null;
  const after = messageSentences(messageAfter).map(firstWord);
  if (opener.length >= 4 && after.includes(opener)) return `it starts with "${opener}", as the message after it does; start differently`;
  const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  const lineWords = words(line);
  const afterText = ` ${words(messageAfter).join(" ")} `;
  for (let i = 0; i + 3 <= lineWords.length; i += 1) {
    const phrase = lineWords.slice(i, i + 3).join(" ");
    if (afterText.includes(` ${phrase} `)) return `it repeats "${phrase}" from the message after it`;
  }
  return null;
}

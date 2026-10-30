import { parseObjectiveControls, type ControlDefaults, type ObjectiveControls } from "./objective";
import type { AudienceChannel } from "./schema";

/**
 * The brief of a lead request (research agent v2): what the owner asked,
 * written down once by the model from every message the owner sent about it
 * (a clarification included), and read by every step after it — the lead
 * judge, the plan, the writer, the report. The model reads the owner's
 * words and sets the brief; this module takes spending restrictions only
 * from the owner's words. With no explicit budget, the model chooses its
 * sources without a request-level dollar cap. The target and time are the model's.
 */

export type Brief = {
  /** The request in one or two sentences, from all of the owner's messages about it. */
  goal: string;
  /** The assistant's provisional research choices; never extra requirements from the owner. */
  approach?: string;
  /** How many leads the owner asked for; null when they named no number. */
  leadTarget: number | null;
  /** The owner asked to contact the leads (email, message, DM, call…), not only to find them. */
  contact: boolean;
  /** The only channels the owner allowed; null when they named none. */
  channels: AudienceChannel[] | null;
  /** The most the owner allows on paid sources; 0 for free sources only; null when they said nothing. */
  spendCapUsd: number | null;
  /** How long the owner allows; null when they said nothing. */
  timeLimitMinutes: number | null;
  /** What finished means for this request, in a sentence ("5 dentists found", "both tests run"). */
  done: string;
};

export const BRIEF_CHANNELS: readonly AudienceChannel[] = ["email", "whatsapp", "linkedin", "instagram", "browser"];
/** As many as one plan can hold (outreach.server.ts HARD_MAX_LEADS). */
const MAX_TARGET = 1_000;
const MAX_MINUTES = 7 * 24 * 60;

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100,
  a: 1, an: 1, couple: 2, few: 3, dozen: 12,
};

function numberOf(token: string): number | null {
  const plain = token.replace(/,/g, "");
  if (/^\d+(?:\.\d+)?$/.test(plain)) return Number(plain);
  return WORD_NUMBERS[token.toLowerCase()] ?? null;
}

/** Every number the owner wrote, digits or words ("5", "five", "1,000"). */
export function numbersIn(text: string): number[] {
  return (text.match(/\d[\d,]*(?:\.\d+)?|\b[a-z]+\b/gi) ?? []).map(numberOf).filter((value): value is number => value !== null && !Number.isNaN(value));
}

/** Money amounts the owner wrote ("$10", "10 dollars", "10 usd"). */
export function amountsIn(text: string): number[] {
  const out: number[] = [];
  for (const match of text.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s?(?:usd|dollars?|bucks)\b/gi)) {
    out.push(Number((match[1] ?? match[2]!).replace(/,/g, "")));
  }
  return out;
}

/** Durations the owner wrote, in minutes ("2 hours", "an hour", "30 min", "a day"). */
export function durationsIn(text: string): number[] {
  const out: number[] = [];
  for (const match of text.matchAll(/\b(\d+(?:\.\d+)?|an?|one|two|three|four|five|six|eight|ten|twelve|twenty|thirty)\s*(minutes?|mins?|hours?|hrs?|h|days?)\b/gi)) {
    const value = numberOf(match[1]!);
    if (value === null) continue;
    const unit = match[2]!.toLowerCase();
    out.push(Math.round(value * (unit.startsWith("d") ? 1440 : unit.startsWith("h") ? 60 : 1)));
  }
  for (const match of text.matchAll(/\b(?:the\s+)?next\s+(hour|day)\b|\bhalf\s+an?\s+(hour)\b/gi)) {
    out.push(match[2] ? 30 : match[1]!.toLowerCase() === "day" ? 1440 : 60);
  }
  return out;
}

export type BriefCheck = { ok: true; brief: Brief; controls: ObjectiveControls } | { ok: false; error: string };

function optionalNumber(raw: Record<string, unknown>, key: string): number | null | undefined {
  const value = raw[key];
  if (value === undefined || value === null || value === "") return null;
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

/**
 * The brief the model wrote, checked against the owner's words, with the
 * objective controls it gives (defaults where the owner named nothing). An
 * error says exactly what to fix; it goes back to the model.
 */
export function checkBrief(raw: Record<string, unknown>, ownerWords: string, defaults: ControlDefaults): BriefCheck {
  const goal = typeof raw.goal === "string" ? raw.goal.replace(/\s+/g, " ").trim() : "";
  if (!goal) return { ok: false, error: "goal is required: the owner's request in one or two sentences, from all their messages about it" };
  // With no done of its own, the request is done when its goal is.
  const done = (typeof raw.done === "string" ? raw.done.replace(/\s+/g, " ").trim() : "") || goal;
  if (raw.approach !== undefined && raw.approach !== null && typeof raw.approach !== "string") {
    return { ok: false, error: "approach must be text describing your provisional search strategy, separate from the owner's goal" };
  }
  const approach = typeof raw.approach === "string" ? raw.approach.replace(/\s+/g, " ").trim().slice(0, 600) : "";
  if (raw.contact !== undefined && typeof raw.contact !== "boolean") return { ok: false, error: "contact must be true or false" };

  const target = optionalNumber(raw, "leadTarget");
  if (target === undefined || (target !== null && (!Number.isInteger(target) || target < 1 || target > MAX_TARGET))) {
    return { ok: false, error: `leadTarget must be a whole number from 1 to ${MAX_TARGET}, or null when the owner named no number` };
  }
  // The target and time are the model's to set; spending restrictions come only from the owner.
  const modelSpend = optionalNumber(raw, "spendCapUsd");
  if (modelSpend === undefined || (modelSpend !== null && modelSpend < 0)) return { ok: false, error: "spendCapUsd must be a number of dollars (0 for free sources only), or null when the owner said nothing about money" };
  // The model chooses the sources, not a budget the owner never gave.
  // Parsing the owner's words also keeps an explicit cap when the model
  // omits it, and prevents prices in the target market becoming a budget.
  const spend = parseObjectiveControls(ownerWords, defaults).spendCapUsd;
  if (spend !== null && modelSpend !== null && modelSpend > spend) {
    return { ok: false, error: `the owner did not allow $${modelSpend}; keep their request's cap of $${spend}` };
  }
  const minutes = optionalNumber(raw, "timeLimitMinutes");
  if (minutes === undefined || (minutes !== null && (!Number.isInteger(minutes) || minutes < 5 || minutes > MAX_MINUTES))) {
    return { ok: false, error: `timeLimitMinutes must be a whole number of minutes from 5 to ${MAX_MINUTES}, or null when the owner named no time` };
  }
  let channels: AudienceChannel[] | null = null;
  if (raw.channels !== undefined && raw.channels !== null) {
    if (!Array.isArray(raw.channels) || raw.channels.some((channel) => !BRIEF_CHANNELS.includes(channel as AudienceChannel))) {
      return { ok: false, error: "channels must list email, whatsapp, linkedin, instagram or browser, or be null when the owner named none" };
    }
    channels = [...new Set(raw.channels as AudienceChannel[])];
    if (!channels.length) channels = null;
  }
  const brief: Brief = {
    goal: goal.slice(0, 600),
    ...(approach ? { approach } : {}),
    leadTarget: target,
    contact: raw.contact === true,
    channels,
    spendCapUsd: spend,
    timeLimitMinutes: minutes,
    done: done.slice(0, 300),
  };
  return {
    ok: true,
    brief,
    controls: {
      leadTarget: target ?? defaults.leadTarget,
      timeLimitMinutes: minutes ?? Math.round(defaults.hours * 60),
      spendCapUsd: spend,
      named: { target: target !== null, time: minutes !== null, spend: spend !== null },
    },
  };
}

/** The brief in a line, for the model's context and the tool result. */
export function briefLine(brief: Brief, controls: Pick<ObjectiveControls, "leadTarget" | "timeLimitMinutes" | "spendCapUsd">): string {
  // Show a spending restriction only when the owner supplied it.
  const spend = controls.spendCapUsd === 0 ? "free sources only" : controls.spendCapUsd !== null ? `up to $${controls.spendCapUsd} on paid sources` : null;
  return [
    `Goal: ${brief.goal}`,
    `leads: ${brief.leadTarget ?? "no number named (as many as fit, until you judge it done)"}`,
    brief.contact ? `contact them${brief.channels ? ` only by ${brief.channels.join(" or ")}` : " on each lead's best ready channel"}` : "research only so far",
    ...(spend ? [spend] : []),
    `time: ${Math.round(controls.timeLimitMinutes)} min${brief.timeLimitMinutes === null ? " (default)" : ""}`,
    `done when: ${brief.done}`,
  ].join(" · ");
}

/** A stored brief (objective controls), or null when there is none or it is malformed. */
export function readBrief(value: unknown): Brief | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.goal !== "string" || typeof raw.done !== "string" || typeof raw.contact !== "boolean") return null;
  const channels = Array.isArray(raw.channels) ? raw.channels.filter((channel): channel is AudienceChannel => BRIEF_CHANNELS.includes(channel as AudienceChannel)) : null;
  const number = (key: string) => (typeof raw[key] === "number" && Number.isFinite(raw[key]) ? raw[key] as number : null);
  const approach = typeof raw.approach === "string" ? raw.approach.trim().slice(0, 600) : "";
  return { goal: raw.goal, ...(approach ? { approach } : {}), done: raw.done, contact: raw.contact, channels: channels?.length ? channels : null, leadTarget: number("leadTarget"), spendCapUsd: number("spendCapUsd"), timeLimitMinutes: number("timeLimitMinutes") };
}

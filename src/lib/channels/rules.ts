/**
 * Sending rules: the numbers that used to be hardcoded in the sending
 * engines, now set per organization in Settings → <channel> → Sending rules.
 *
 * Every rule is declared once here — label, help, default, unit and the
 * bounds it may take — and the settings page is generated from it, the API
 * validates against it, and the engines read resolved values through
 * `channelRules()` (rules.server.ts). Today's behaviour is each rule's
 * default, so an organization that never opens the page behaves exactly as
 * before.
 *
 * Two bounds per rule:
 *  - min / max: hard limits. A value outside them is refused, so a typo
 *    cannot, say, send 3,000 LinkedIn invitations in a day.
 *  - safe: the edge of what the platforms tolerate. Beyond it the page
 *    shows the rule's `warning` but still saves.
 *
 * Some rules can be overridden per connected account (a mailbox's daily
 * limit, a LinkedIn account's invitations, a WhatsApp number's new chats);
 * `override` says where. Resolution: account override → organization rule →
 * default.
 *
 * Client-safe: no database or server imports.
 */

import { resolveTimeZone } from "@/lib/timeZone";

export const CHANNELS = ["email", "linkedin", "whatsapp", "general"] as const;
export type Channel = (typeof CHANNELS)[number];

export type WeeklyHours = {
  /** IANA time zone, e.g. Asia/Kolkata. */
  timezone: string;
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
  /** "HH:mm", 24-hour. */
  start: string;
  end: string;
};

type Common = {
  key: string;
  label: string;
  help: string;
  /** Where an account can override it, shown under the rule. */
  override?: string;
};

export type NumberRule = Common & {
  kind: "number";
  unit: string;
  default: number;
  min: number;
  max: number;
  /** Values beyond this (in the risky direction) show the warning. */
  safe?: { above?: number; below?: number };
  warning?: string;
};

export type RangeRule = Common & {
  kind: "range";
  unit: string;
  default: [number, number];
  min: number;
  max: number;
  safe?: { above?: number; below?: number };
  warning?: string;
};

export type HoursRule = Common & {
  kind: "hours";
  default: WeeklyHours | null;
  /** May be null, meaning "any time". */
  optional?: boolean;
};

export type CountryRule = Common & { kind: "country"; default: string };

/** An IANA time zone, stored under its current name (src/lib/timeZone.ts). */
export type TimeZoneRule = Common & { kind: "timezone"; default: string };

/** A time of day, "HH:mm", 24-hour. */
export type ClockRule = Common & { kind: "time"; default: string };

export type Rule = NumberRule | RangeRule | HoursRule | CountryRule | TimeZoneRule | ClockRule;

export const CHANNEL_RULES = {
  email: [
    {
      key: "dailySendLimit",
      kind: "number",
      label: "Emails per day, per mailbox",
      help: "How many emails a newly connected mailbox sends a day. Warm mailboxes can send more; new ones should start low.",
      unit: "emails / day",
      default: 30,
      min: 1,
      max: 200,
      safe: { above: 50 },
      warning: "Above about 50 a day from one Google Workspace mailbox, deliverability usually drops and Google may throttle it.",
      override: "Each mailbox can set its own limit in Email → Accounts.",
    },
    {
      key: "sendGapMinutes",
      kind: "range",
      label: "Gap between emails from one mailbox",
      help: "After each send, the mailbox waits a random time in this range before the next, so sending looks human.",
      unit: "minutes",
      default: [18, 24],
      min: 1,
      max: 240,
      safe: { below: 10 },
      warning: "Sending more often than every 10 minutes from one mailbox looks automated to spam filters.",
    },
    {
      key: "sendingHours",
      kind: "hours",
      label: "Sending hours for new mailboxes",
      help: "When a newly connected mailbox may send. Each mailbox can change its own hours in Email → Accounts.",
      default: { timezone: "Asia/Kolkata", days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" },
    },
  ],
  linkedin: [
    {
      key: "invitesPerDayPremium",
      kind: "number",
      label: "Invitations per day, premium accounts",
      help: "Connection requests one LinkedIn account with Premium or Sales Navigator sends a day.",
      unit: "invitations / day",
      default: 30,
      min: 1,
      max: 100,
      safe: { above: 30 },
      warning: "LinkedIn restricts accounts that send much more than 30 invitations a day.",
      override: "Each account can set its own limit in LinkedIn → Accounts.",
    },
    {
      key: "invitesPerDayFree",
      kind: "number",
      label: "Invitations per day, free accounts",
      help: "Connection requests one free LinkedIn account sends a day.",
      unit: "invitations / day",
      default: 5,
      min: 1,
      max: 50,
      safe: { above: 10 },
      warning: "Free accounts have a much smaller weekly invitation allowance; more than 10 a day uses it up fast.",
      override: "Each account can set its own limit in LinkedIn → Accounts.",
    },
    {
      key: "invitesPerRun",
      kind: "range",
      label: "Invitations per run",
      help: "Each sending run sends a random number of invitations in this range, then the account rests.",
      unit: "invitations",
      default: [3, 4],
      min: 1,
      max: 20,
      safe: { above: 8 },
      warning: "Large bursts look automated; keep runs small and frequent.",
    },
    {
      key: "inviteDelaySeconds",
      kind: "range",
      label: "Delay between invitations",
      help: "Within a run, the wait between two invitations.",
      unit: "seconds",
      default: [30, 60],
      min: 5,
      max: 600,
      safe: { below: 20 },
      warning: "Invitations less than 20 seconds apart look automated.",
    },
    {
      key: "runGapMinutes",
      kind: "range",
      label: "Rest between runs",
      help: "After a run, the account rests a random time in this range before the next one.",
      unit: "minutes",
      default: [30, 60],
      min: 10,
      max: 720,
      safe: { below: 20 },
      warning: "Resting less than 20 minutes between runs makes activity look continuous.",
    },
    {
      key: "followUpsPerRun",
      kind: "range",
      label: "Follow-up messages per run",
      help: "Messages to people who accepted, sent per run.",
      unit: "messages",
      default: [3, 6],
      min: 1,
      max: 30,
      safe: { above: 10 },
      warning: "Many messages in one burst look automated.",
    },
    {
      key: "profileLookupsPerRun",
      kind: "range",
      label: "Profile lookups per run",
      help: "Profiles opened per run to find the LinkedIn member behind a lead.",
      unit: "profiles",
      default: [4, 8],
      min: 1,
      max: 40,
      safe: { above: 15 },
      warning: "Viewing many profiles quickly can trigger LinkedIn's limits.",
    },
    {
      key: "searchLeadsPerDay",
      kind: "number",
      label: "Search leads per day, per account",
      help: "How many leads one account pulls from LinkedIn searches a day.",
      unit: "leads / day",
      default: 400,
      min: 10,
      max: 2500,
      safe: { above: 1000 },
      warning: "Heavy searching is one of the faster ways to have an account limited.",
    },
    {
      key: "workingHours",
      kind: "hours",
      label: "Working hours for accounts without their own",
      help: "Any time unless you set hours here. An account's own working hours (LinkedIn → Accounts) always win.",
      default: null,
      optional: true,
    },
  ],
  whatsapp: [
    {
      key: "sendingHours",
      kind: "hours",
      label: "Sending hours for campaigns",
      help: "Any time unless you set hours here. Campaign messages only go out inside these hours; messages you send yourself are not affected.",
      default: null,
      optional: true,
    },
    {
      key: "warmupHours",
      kind: "number",
      label: "Warm-up after linking a number",
      help: "A newly linked number replies to existing chats right away but starts no new chats for this long.",
      unit: "hours",
      default: 24,
      min: 0,
      max: 336,
      safe: { below: 24 },
      warning: "New numbers that message strangers on their first day are banned far more often.",
    },
    {
      key: "newChatsPerDay",
      kind: "number",
      label: "New chats per day, per number",
      help: "Conversations one number may start in a rolling day. Replies to people who wrote first are not counted.",
      unit: "chats / day",
      default: 25,
      min: 1,
      max: 200,
      safe: { above: 25 },
      warning: "WhatsApp bans numbers that start many chats with people who don't have them saved.",
      override: "Each number can set its own limit in WhatsApp → Accounts.",
    },
    {
      key: "secondsBetweenSends",
      kind: "number",
      label: "Seconds between messages, per number",
      help: "The shortest gap between two messages sent from one number.",
      unit: "seconds",
      default: 10,
      min: 3,
      max: 600,
      safe: { below: 10 },
      warning: "Messages sent faster than every 10 seconds look automated.",
    },
  ],
  general: [
    {
      // Read by the daily rollover (src/lib/scheduler/dailyRollover.ts).
      key: "timeZone",
      kind: "timezone",
      label: "Time zone",
      help: "Your organization's time zone. The new day below starts at that time here.",
      default: "UTC",
    },
    {
      key: "dayStartsAt",
      kind: "time",
      label: "New day starts at",
      help: "Daily limits reset and the day's email queue is built at this time.",
      default: "00:00",
    },
    {
      key: "defaultPhoneCountry",
      kind: "country",
      label: "Default phone country",
      help: "The country assumed for phone numbers typed or imported without a + and country code.",
      default: "",
    },
    {
      // Read by the assistant's Autonomous mode (src/lib/assistant/autonomy.server.ts).
      key: "autonomousRunsPerDay",
      kind: "number",
      label: "Plans the assistant may start on its own a day",
      help: "In a chat with Autonomous on, outreach plans start without your Start button, up to this many in 24 hours. Past it, plans wait for you.",
      unit: "plans",
      default: 10,
      min: 1,
      max: 50,
      safe: { above: 20 },
      warning: "Many plans a day means many new people contacted without you reading the plan first.",
    },
    {
      key: "autonomousLeadsPerDay",
      kind: "number",
      label: "Leads the assistant may contact on its own a day",
      help: "The total leads in the plans it starts on its own in 24 hours. Each channel's own daily sending limits still apply on top of this.",
      unit: "leads",
      default: 300,
      min: 10,
      max: 2_000,
      safe: { above: 500 },
      warning: "Cold outreach at this volume risks your WhatsApp number and email reputation.",
    },
    {
      key: "autonomousSearchesPerDay",
      kind: "number",
      label: "Lead searches the assistant may start on its own a day",
      help: "Searches it starts in a chat with Autonomous on, in 24 hours. Paid searches (Apify, web search) also keep their own limits.",
      unit: "searches",
      default: 20,
      min: 1,
      max: 100,
      safe: { above: 40 },
      warning: "Many searches a day can get the Google Maps scraper blocked and spend paid search credits.",
    },
  ],
} as const satisfies Record<Channel, readonly Rule[]>;

/** The resolved, typed values of one channel's rules. */
type ValueOf<R> = R extends { kind: "number" } ? number
  : R extends { kind: "range" } ? [number, number]
  : R extends { kind: "hours"; optional: true } ? WeeklyHours | null
  : R extends { kind: "hours" } ? WeeklyHours
  : R extends { kind: "country" } ? string
  : R extends { kind: "timezone" } ? string
  : R extends { kind: "time" } ? string
  : never;
export type ChannelRuleValues<C extends Channel> = {
  [R in (typeof CHANNEL_RULES)[C][number] as R["key"]]: ValueOf<R>;
};

export function isChannel(value: string): value is Channel {
  return (CHANNELS as readonly string[]).includes(value);
}

export function rulesOf(channel: Channel): readonly Rule[] {
  return CHANNEL_RULES[channel] as readonly Rule[];
}

/** A number rule by key — what a per-account override is validated against. */
export function numberRule(channel: Channel, key: string): NumberRule {
  const rule = rulesOf(channel).find((r) => r.key === key);
  if (rule?.kind !== "number") throw new Error(`No number rule ${channel}.${key}`);
  return rule;
}

export function defaultValues<C extends Channel>(channel: C): ChannelRuleValues<C> {
  return Object.fromEntries(rulesOf(channel).map((rule) => [rule.key, rule.default])) as ChannelRuleValues<C>;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const COUNTRY = /^[A-Z]{2}$/;

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Why `value` is not acceptable for `rule`, or null when it is. */
export function ruleError(rule: Rule, value: unknown): string | null {
  switch (rule.kind) {
    case "number": {
      if (typeof value !== "number" || !Number.isInteger(value)) return `${rule.label} must be a whole number`;
      if (value < rule.min || value > rule.max) return `${rule.label} must be between ${rule.min} and ${rule.max}`;
      return null;
    }
    case "range": {
      if (!Array.isArray(value) || value.length !== 2 || !value.every((n) => typeof n === "number" && Number.isInteger(n))) {
        return `${rule.label} needs a lowest and a highest whole number`;
      }
      const [lo, hi] = value as [number, number];
      if (lo < rule.min || hi > rule.max) return `${rule.label} must stay between ${rule.min} and ${rule.max}`;
      if (lo > hi) return `${rule.label}: the lowest value can't be above the highest`;
      return null;
    }
    case "hours": {
      if (value === null && rule.optional) return null;
      const h = value as Partial<WeeklyHours> | null;
      if (!h || typeof h !== "object") return `${rule.label} is not valid`;
      if (typeof h.timezone !== "string" || !isTimeZone(h.timezone)) return `${rule.label}: unknown time zone`;
      if (!Array.isArray(h.days) || !h.days.length || !h.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
        return `${rule.label}: pick at least one day`;
      }
      if (typeof h.start !== "string" || !HHMM.test(h.start) || typeof h.end !== "string" || !HHMM.test(h.end)) {
        return `${rule.label}: times must look like 09:00`;
      }
      if (h.start >= h.end) return `${rule.label}: the end must be after the start`;
      return null;
    }
    case "country": {
      if (value === "") return null;
      if (typeof value !== "string" || !COUNTRY.test(value)) return `${rule.label} must be a two-letter country code, like IN or US`;
      return null;
    }
    case "timezone":
      return typeof value === "string" && value !== "" && isTimeZone(value) ? null : `${rule.label}: unknown time zone`;
    case "time":
      return typeof value === "string" && HHMM.test(value) ? null : `${rule.label}: times must look like 09:00`;
  }
}

/** A valid value in its stored form: time zones under their current IANA name. */
function normalize(rule: Rule, value: unknown): unknown {
  if (rule.kind === "timezone") return resolveTimeZone(value as string);
  if (rule.kind === "hours" && value !== null) {
    const h = value as WeeklyHours;
    return { ...h, days: [...new Set(h.days)].sort((a, b) => a - b) };
  }
  return value;
}

/** The warning to show for `value`, or null when it is within the safe range. */
export function ruleWarning(rule: Rule, value: unknown): string | null {
  if ((rule.kind !== "number" && rule.kind !== "range") || !rule.safe || !rule.warning) return null;
  const [lo, hi] = rule.kind === "number" ? [value as number, value as number] : (value as [number, number]);
  if (rule.safe.above !== undefined && hi > rule.safe.above) return rule.warning;
  if (rule.safe.below !== undefined && lo < rule.safe.below) return rule.warning;
  return null;
}

/**
 * Stored values merged over the defaults. Anything stored that is unknown,
 * or no longer valid (a bound tightened since), falls back to the default,
 * so the engines only ever see valid numbers.
 */
export function resolveValues<C extends Channel>(channel: C, stored: Record<string, unknown> | null | undefined): ChannelRuleValues<C> {
  const values: Record<string, unknown> = {};
  for (const rule of rulesOf(channel)) {
    const candidate = stored?.[rule.key];
    values[rule.key] = candidate !== undefined && ruleError(rule, candidate) === null ? normalize(rule, candidate) : rule.default;
  }
  return values as ChannelRuleValues<C>;
}

/** Validate a submitted set of values for one channel. Only known keys; returns the clean values or the first error. */
export function validateValues(channel: Channel, input: Record<string, unknown>): { ok: true; values: Record<string, unknown> } | { ok: false; error: string } {
  const known = new Map(rulesOf(channel).map((rule) => [rule.key, rule]));
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const rule = known.get(key);
    if (!rule) return { ok: false, error: `Unknown setting: ${key}` };
    const error = ruleError(rule, value);
    if (error) return { ok: false, error };
    values[key] = normalize(rule, value);
  }
  return { ok: true, values };
}

/** A random whole number in an inclusive range. */
export function pickInRange([lo, hi]: [number, number]): number {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

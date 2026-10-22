/**
 * Sending rules: the numbers that used to be hardcoded in the sending
 * engines, set per organization and read by them through `channelRules()`
 * (rules.server.ts).
 *
 * Sending is always on: no channel has sending hours or days, and the one
 * sending input a person sees is the "general" rule `newLeadsPerDay`, the
 * workspace-wide daily lead limit (Settings → Daily lead limit, enforced by
 * dailyLeadLimit.server.ts). The per-channel pacing below (emails per
 * mailbox, gaps, LinkedIn invitations and runs, WhatsApp warm-up and new
 * chats per number, Instagram DMs per account) is applied automatically and
 * has no settings page; a value an organization stored earlier keeps
 * applying. The other "general" rules are shown on Your business (the day
 * and phone numbers) and Lead research (a request's defaults), or hidden
 * (the Autonomous caps, still enforced): GENERAL_RULE_PAGES.
 *
 * Every rule is declared once here — label, help, default, unit and the
 * bounds it may take — and a settings form is generated from it, the API
 * validates against it. Today's behaviour is each rule's default, so an
 * organization that never changed one behaves exactly as before.
 *
 * Two bounds per rule:
 *  - min / max: hard limits. A value outside them is refused, so a typo
 *    cannot, say, send 3,000 LinkedIn invitations in a day.
 *  - safe: the edge of what the platforms tolerate. Beyond it the page
 *    shows the rule's `warning` but still saves.
 *
 * Some rules are overridden per connected account (a mailbox's daily
 * limit, a LinkedIn account's invitations, a WhatsApp number's new chats);
 * `override` says where. Resolution: account override → organization rule →
 * default.
 *
 * Client-safe: no database or server imports.
 */

import { resolveTimeZone } from "@/lib/timeZone";

export const CHANNELS = ["email", "linkedin", "whatsapp", "instagram", "general"] as const;
export type Channel = (typeof CHANNELS)[number];

/**
 * Rules that no longer exist: each channel's sending hours. A save naming
 * one is refused with RETIRED_RULE_ERROR, a stored copy is ignored when read
 * and dropped by the next save (db/migrations/20261022-always-on-sending.sql
 * strips the stored ones).
 */
export const RETIRED_RULE_KEYS: Record<Channel, readonly string[]> = {
  email: ["sendingHours", "sendGapMinutes"],
  linkedin: ["workingHours"],
  whatsapp: ["sendingHours"],
  instagram: ["sendingHours", "sendGapMinutes"],
  general: [],
};

export const RETIRED_RULE_ERROR = "Sending hours were removed: sending is always on, any time, every day. The daily lead limit is the one sending setting.";

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

export type CountryRule = Common & { kind: "country"; default: string };

/** An IANA time zone, stored under its current name (src/lib/timeZone.ts). */
export type TimeZoneRule = Common & { kind: "timezone"; default: string };

/** A time of day, "HH:mm", 24-hour. */
export type ClockRule = Common & { kind: "time"; default: string };

export type Rule = NumberRule | RangeRule | CountryRule | TimeZoneRule | ClockRule;

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
      override: "Each mailbox keeps the limit it was connected with.",
    },
    {
      key: "secondsBetweenSends",
      kind: "number",
      label: "Gap between emails from one mailbox",
      help: "The minimum time between emails sent from the same mailbox. Daily limits still apply.",
      unit: "seconds",
      default: 30,
      min: 3,
      max: 14400,
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
      override: "An account's own limit, when it has one, wins.",
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
      override: "An account's own limit, when it has one, wins.",
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
  ],
  whatsapp: [
    {
      key: "warmupHours",
      kind: "number",
      label: "Warm-up after linking a number",
      help: "A newly linked number replies to existing chats right away but starts no new chats for this long. 0 (the default) starts new chats right away; Unipile advises a day, because new numbers that message strangers on their first day are banned far more often.",
      unit: "hours",
      default: 0,
      min: 0,
      max: 336,
    },
    {
      key: "newChatsPerDay",
      kind: "number",
      label: "New chats per 24 hours, per number",
      help: "Conversations one number may start in a rolling 24-hour window. Each chat counts for 24 hours from when it started and then ages out on its own; there is no reset at midnight. Every campaign on the number shares the count. Replies in chats already open, and to people who wrote first, are not limited by it.",
      unit: "new chats / 24 hours",
      default: 25,
      min: 1,
      max: 200,
      safe: { above: 25 },
      warning: "WhatsApp bans numbers that start many chats with people who don't have them saved.",
      override: "A number's own limit, when it has one, wins.",
    },
    {
      key: "secondsBetweenSends",
      kind: "number",
      label: "Seconds between messages, per number",
      help: "The shortest gap between two messages sent from one number.",
      unit: "seconds",
      default: 30,
      min: 3,
      max: 600,
      safe: { below: 10 },
      warning: "Messages sent faster than every 10 seconds look automated.",
    },
  ],
  instagram: [
    { key: "newChatsPerDay", kind: "number", label: "New conversations per account", help: "Initial outreach DMs one connected Instagram account may attempt in a rolling 24 hours. Replies use the run's reply limits.", unit: "new chats / 24 hours", default: 10, min: 1, max: 100 },
    { key: "secondsBetweenSends", kind: "number", label: "Time between initial DMs", help: "The minimum time between initial outreach messages from the same account. Daily limits still apply.", unit: "seconds", default: 30, min: 3, max: 86400 },
  ],
  general: [
    {
      // Read by the daily rollover (src/lib/scheduler/dailyRollover.ts) and the daily lead limit (dailyLeadLimit.server.ts).
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
      help: "The daily lead limit and other daily limits reset, and the day's email queue is built, at this time.",
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
      // The one sending input a person sees (Settings → Daily lead limit). Enforced in each
      // engine's first-touch claim by newLeadAllowance (src/lib/channels/dailyLeadLimit.server.ts).
      key: "newLeadsPerDay",
      kind: "number",
      label: "Maximum new leads to contact per day",
      help: "People contacted for the first time, across email, LinkedIn, WhatsApp and Instagram together. A person counts once, when the first automated message to them starts sending; someone already contacted on any channel does not count again. Follow-ups, replies and messages you send yourself do not count. Each sender's own pacing still applies on top.",
      unit: "new leads / day",
      default: 50,
      min: 1,
      max: 1_000,
      safe: { above: 200 },
      warning: "Contacting more than about 200 new people a day risks your mailboxes, LinkedIn accounts and WhatsApp numbers being flagged as spam.",
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
    {
      // The three below are an objective's defaults (src/lib/assistant/objective*.ts): a request
      // that names its own target, time or spend ("find 50…", "within 2 hours", "spend up to $10") uses those.
      key: "objectiveLeadTarget",
      kind: "number",
      label: "Leads a request looks for",
      help: "When you ask the assistant to find leads without saying how many, it keeps searching (more places, other sources) until it has this many qualified leads, its time or spend limit is reached, or nothing else fits.",
      unit: "qualified leads",
      default: 25,
      min: 1,
      max: 1_000,
      safe: { above: 200 },
      warning: "A large target keeps the assistant searching, and spending, for longer on each request.",
    },
    {
      key: "objectiveHours",
      kind: "number",
      label: "Time a request may keep searching",
      help: "How long the assistant may keep working on one request's research when the request names no time. Searches already running finish; their leads are kept.",
      unit: "hours",
      default: 4,
      min: 1,
      max: 72,
      safe: { above: 24 },
      warning: "Long research windows keep paid searches and waits open for a day or more.",
    },
    {
      key: "objectiveSpendUsd",
      kind: "number",
      label: "Spend a request may use",
      help: "The most one request may spend on paid sources when it names no budget: Apify runs, Treg calls, browser minutes and AI web research (held at an estimate until the provider reports the cost). Tavily searches are counted in credits under your daily Tavily cap instead, and the AI model's own use for chat, judging the leads found and writing is not counted (your AI provider bills it). 0 keeps every request on free sources only: TinyFish, the built-in Google Maps scraper, LinkedIn search, Hacker News and Stack Exchange. Each provider's own budget still applies.",
      unit: "USD",
      default: 5,
      min: 0,
      max: 500,
      safe: { above: 50 },
      warning: "Paid sources are charged to your own accounts with them.",
    },
  ],
} as const satisfies Record<Channel, readonly Rule[]>;

/** The resolved, typed values of one channel's rules. */
type ValueOf<R> = R extends { kind: "number" } ? number
  : R extends { kind: "range" } ? [number, number]
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

/**
 * Where the "general" rules are shown: the daily lead limit alone on
 * Settings → Daily lead limit (/settings/sending), the organization's day
 * and phone numbers on Your business (/settings/business), a request's
 * research defaults on Lead research (/settings/research). The Autonomous
 * caps are hidden: no page shows them, and they keep their stored or
 * default values in autonomy.server.ts. Storage stays one row per
 * organization and channel. Every general rule is in exactly one entry
 * (rules.test.ts).
 */
export const GENERAL_RULE_PAGES = {
  sending: ["newLeadsPerDay"],
  business: ["timeZone", "dayStartsAt", "defaultPhoneCountry"],
  research: ["objectiveLeadTarget", "objectiveHours", "objectiveSpendUsd"],
  hidden: ["autonomousRunsPerDay", "autonomousLeadsPerDay", "autonomousSearchesPerDay"],
} as const satisfies Record<string, readonly (keyof ChannelRuleValues<"general">)[]>;

/** The rules a form shows: all of the channel's, or only `keys`, in registry order. An unknown key throws. */
export function rulesSubset(channel: Channel, keys?: readonly string[]): readonly Rule[] {
  const rules = rulesOf(channel);
  if (!keys) return rules;
  const unknown = keys.filter((key) => !rules.some((rule) => rule.key === key));
  if (unknown.length) throw new Error(`No ${channel} rule ${unknown.join(", ")}`);
  return rules.filter((rule) => keys.includes(rule.key));
}

/**
 * What a form showing `rules` sends when saved: their values only. A page
 * that shows part of a channel's rules never sends the others, so it cannot
 * overwrite what another page saved meanwhile (mergeStoredRules keeps them).
 */
export function ruleSubmission(rules: readonly Rule[], values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(rules.filter((rule) => rule.key in values).map((rule) => [rule.key, values[rule.key]]));
}

/**
 * The stored row after saving `values` (already validated): each submitted
 * rule replaces its stored value, or is dropped when it equals the default
 * (so an improved default reaches everyone who never changed it); rules not
 * submitted keep what is stored. A retired rule's stored copy is dropped; a
 * key this version does not know at all is kept, since a newer release
 * (during a rolling deploy) may have written it.
 */
export function mergeStoredRules(channel: Channel, stored: Record<string, unknown>, values: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...stored };
  for (const key of RETIRED_RULE_KEYS[channel]) delete next[key];
  for (const rule of rulesOf(channel)) {
    if (!(rule.key in values)) continue;
    const value = values[rule.key];
    if (JSON.stringify(value) === JSON.stringify(rule.default)) delete next[rule.key];
    else next[rule.key] = value;
  }
  return next;
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
    if (!rule && RETIRED_RULE_KEYS[channel].includes(key)) return { ok: false, error: key === "sendGapMinutes" ? "Send pacing is now measured in seconds; use secondsBetweenSends." : RETIRED_RULE_ERROR };
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

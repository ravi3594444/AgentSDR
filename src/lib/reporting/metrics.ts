import { wallTime, wallTimeToInstant } from "@/lib/scheduler/slots";

/**
 * The one set of metric definitions behind Overview (/assistant/results) and
 * Analytics (/analytics): what each figure counts, the window a period
 * covers and the time zone it is cut in, and how lead sources are
 * attributed. Pure and client-safe; metrics.server.ts reads each figure from
 * the ledgers with these definitions, so the same figure for the same
 * period, scope and time zone is the same number on both pages.
 *
 * - A period is whole local days in the organization's business time zone
 *   (the "general" Sending rule, Settings → Organization → General), as
 *   [first day 00:00, the day after the last 00:00). "Today" is the whole
 *   local day.
 * - Period figures count events inside the window. Current figures ("now")
 *   are a count at the moment they are read and ignore the period; the
 *   pages label them apart.
 * - Delivery evidence follows CONTEXT.md, weakest to strongest: queued,
 *   attempted, accepted, delivered, read, reply. A send is accepted by the
 *   provider; an uncertain send is never a send.
 */

// ---------------------------------------------------------------- definitions

export type MetricKey =
  | "sent"
  | "delivered"
  | "read"
  | "replies"
  | "peopleContacted"
  | "peopleReplied"
  | "contactedWhoReplied"
  | "replyRate"
  | "foundLeads"
  | "qualifiedLeads"
  | "contactableLeads"
  | "needsYouNow"
  | "draftsAwaitingReviewNow"
  | "actionRequiredNow"
  | "followUpsDueNow"
  | "plansAwaitingStartNow"
  | "stillToSendNow";

export type MetricDefinition = { label: string; kind: "period" | "now"; definition: string };

export const METRICS: Record<MetricKey, MetricDefinition> = {
  sent: {
    label: "Sent",
    kind: "period",
    definition: "Outreach messages the provider accepted in this period: emails, WhatsApp campaign messages, LinkedIn invitations and messages, initial Instagram DMs. Queued, failed and uncertain sends are not sends.",
  },
  delivered: {
    label: "Delivered",
    kind: "period",
    definition: "This period's sends the provider reported delivered (a read receipt counts too). Only WhatsApp reports delivery; other channels are not measured.",
  },
  read: {
    label: "Read",
    kind: "period",
    definition: "This period's sends with a read receipt. Only WhatsApp reports reads; other channels are not measured.",
  },
  replies: {
    label: "Replies",
    kind: "period",
    definition: "Inbound messages from leads in this period, on any channel.",
  },
  peopleContacted: {
    label: "People contacted",
    kind: "period",
    definition: "Distinct people with at least one sent outreach message in this period.",
  },
  peopleReplied: {
    label: "People who replied",
    kind: "period",
    definition: "Distinct people with at least one inbound message in this period, whether or not they were contacted.",
  },
  contactedWhoReplied: {
    label: "Replied",
    kind: "period",
    definition: "People contacted in this period who replied after their first send in it.",
  },
  replyRate: {
    label: "Reply rate",
    kind: "period",
    definition: "People contacted in this period who replied after their first send in it, divided by people contacted.",
  },
  foundLeads: {
    label: "Found",
    kind: "period",
    definition: "Leads a search or list produced in this period: qualified people, plus businesses found but not saved as a lead. A person counts once however many sources found them.",
  },
  qualifiedLeads: {
    label: "Qualified",
    kind: "period",
    definition: "People a search or list saved as leads in this period: an open business or profile that matched, with a contact detail or profile. Businesses found closed or with no contact detail at all are found, not qualified.",
  },
  contactableLeads: {
    label: "Contactable",
    kind: "period",
    definition: "Qualified people with an open contact route when last added to a list in this period (an email that is not suppressed, a WhatsApp number, a LinkedIn or Instagram profile), and not Do Not Contact.",
  },
  needsYouNow: {
    label: "Needs you",
    kind: "now",
    definition: "Open decisions waiting for you right now: missing information, complaints, negotiations, meetings. Interested and opt-out reports are not counted.",
  },
  draftsAwaitingReviewNow: {
    label: "Drafts to review",
    kind: "now",
    definition: "Replies drafted and waiting for your review right now.",
  },
  actionRequiredNow: {
    label: "Action required",
    kind: "now",
    definition: "Conversations in the Action required queue right now.",
  },
  followUpsDueNow: {
    label: "Follow-ups due",
    kind: "now",
    definition: "Follow-ups drafted for approval or past their time right now.",
  },
  plansAwaitingStartNow: {
    label: "Plans waiting for Start",
    kind: "now",
    definition: "Outreach plans prepared and waiting for your Start right now. Nothing is sent for them until then.",
  },
  stillToSendNow: {
    label: "Still to send",
    kind: "now",
    definition: "Leads still in an active sequence right now, waiting for their next send.",
  },
};

// ---------------------------------------------------------------- the calendar

/** A reporting window: [from, to) as instants, cut in one time zone. `from` null is since the beginning. */
export type ReportWindow = { from: Date | null; to: Date; timeZone: string };

/** The same window written for JSON: ISO instants. */
export type ReportWindowJson = { from: string | null; to: string; timeZone: string };

export function windowJson(window: ReportWindow): ReportWindowJson {
  return { from: window.from?.toISOString() ?? null, to: window.to.toISOString(), timeZone: window.timeZone };
}

/** The calendar day it is at `instant` in this time zone, as YYYY-MM-DD. */
export function localDate(timeZone: string, instant: Date | number = Date.now()): string {
  const wall = wallTime(timeZone, typeof instant === "number" ? instant : instant.getTime());
  return `${wall.year}-${String(wall.month).padStart(2, "0")}-${String(wall.day).padStart(2, "0")}`;
}

/** Adds `days` to a YYYY-MM-DD date. */
export function shiftDate(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The instant a local day begins (its 00:00) in this time zone. */
export function dayStart(day: string, timeZone: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(wallTimeToInstant(timeZone, year!, month!, date!, 0, 0));
}

/** Inclusive local days as a window: [first day 00:00, the day after the last 00:00). */
export function daysWindow(days: { from: string; to: string }, timeZone: string): ReportWindow & { from: Date } {
  return { from: dayStart(days.from, timeZone), to: dayStart(shiftDate(days.to, 1), timeZone), timeZone };
}

/** The presets both pages offer; each maps to the same days, so to the same window, on both. */
export const SHARED_PRESETS = ["today", "yesterday", "last_7_days", "last_30_days"] as const;
export type SharedPreset = (typeof SHARED_PRESETS)[number];

/** A preset's inclusive local days, from the local date it is today. */
export function presetDays(preset: SharedPreset, today: string): { from: string; to: string } {
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const day = shiftDate(today, -1);
      return { from: day, to: day };
    }
    case "last_7_days":
      return { from: shiftDate(today, -6), to: today };
    case "last_30_days":
      return { from: shiftDate(today, -29), to: today };
  }
}

/** A preset's window in this time zone at `now`. */
export function presetWindow(preset: SharedPreset, timeZone: string, now = new Date()): ReportWindow & { from: Date; days: { from: string; to: string } } {
  const days = presetDays(preset, localDate(timeZone, now));
  return { ...daysWindow(days, timeZone), days };
}

// ---------------------------------------------------------------- scope

/**
 * Whose work a figure counts: the whole organization, or the outreach runs,
 * lead lists and jobs of one run, owner request or chat
 * (src/lib/assistant/results.ts ResultsScope). Analytics is always the
 * organization.
 */
export type ReportScope = {
  kind: "run" | "request" | "thread" | "organization";
  runIds: readonly string[];
  audienceIds: readonly string[];
  jobIds: readonly string[];
};

export const WHOLE_ORGANIZATION: ReportScope = { kind: "organization", runIds: [], audienceIds: [], jobIds: [] };

// ---------------------------------------------------------------- period figures

/** The channels outreach is sent on; inbound replies arrive on the same four. */
export const REPORT_CHANNELS = ["email", "whatsapp", "linkedin", "instagram"] as const;
export type ReportChannel = (typeof REPORT_CHANNELS)[number];

/** Whether a channel's provider reports delivery and read receipts that the app records. */
export const RECEIPTS_RECORDED: Record<ReportChannel, boolean> = { email: false, whatsapp: true, linkedin: false, instagram: false };

export type ChannelCounts = { total: number; byChannel: Record<ReportChannel, number> };
/** Receipts: null on a channel that reports none ("not measured"); the total sums the channels that do. */
export type ReceiptCounts = { total: number; byChannel: Record<ReportChannel, number | null> };

export type PeriodMetrics = {
  sent: ChannelCounts & { linkedinInvitations: number; linkedinMessages: number };
  delivered: ReceiptCounts;
  read: ReceiptCounts;
  replies: ChannelCounts;
  peopleContacted: ChannelCounts;
  peopleReplied: ChannelCounts;
  contactedWhoReplied: ChannelCounts;
  replyRate: { total: number | null; byChannel: Record<ReportChannel, number | null> };
};

/** Replied people over contacted people; null when nobody was contacted. */
export function replyRate(replied: number, contacted: number): number | null {
  return contacted > 0 ? replied / contacted : null;
}

/**
 * One row of the period statement (metrics.server.ts): a section, then a
 * channel and kind, or null for the rows that roll them up. People are
 * deduplicated in SQL at each level, so a total is never a sum of channels.
 */
export type MetricRow = {
  section: "send" | "reply" | "replied_after";
  channel: string | null;
  kind: string | null;
  n: number;
  people: number;
  delivered: number;
  read: number;
};

const isChannel = (value: string | null): value is ReportChannel => REPORT_CHANNELS.includes(value as ReportChannel);
const zeros = (): Record<ReportChannel, number> => ({ email: 0, whatsapp: 0, linkedin: 0, instagram: 0 });

export function assemblePeriodMetrics(rows: readonly MetricRow[]): PeriodMetrics {
  const sent = { total: 0, byChannel: zeros(), linkedinInvitations: 0, linkedinMessages: 0 };
  const delivered = zeros();
  const read = zeros();
  const contacted = { total: 0, byChannel: zeros() };
  const replies = { total: 0, byChannel: zeros() };
  const replied = { total: 0, byChannel: zeros() };
  const after = { total: 0, byChannel: zeros() };
  for (const row of rows) {
    const n = Number(row.n) || 0;
    const people = Number(row.people) || 0;
    if (row.section === "send") {
      if (row.channel === null) {
        sent.total = n;
        contacted.total = people;
      } else if (isChannel(row.channel) && row.kind === null) {
        sent.byChannel[row.channel] = n;
        contacted.byChannel[row.channel] = people;
        delivered[row.channel] = Number(row.delivered) || 0;
        read[row.channel] = Number(row.read) || 0;
      } else if (row.channel === "linkedin") {
        if (row.kind === "invitation") sent.linkedinInvitations = n;
        else sent.linkedinMessages += n;
      }
    } else if (row.section === "reply") {
      if (row.channel === null) {
        replies.total = n;
        replied.total = people;
      } else if (isChannel(row.channel)) {
        replies.byChannel[row.channel] = n;
        replied.byChannel[row.channel] = people;
      }
    } else if (row.section === "replied_after") {
      if (row.channel === null) after.total = people;
      else if (isChannel(row.channel)) after.byChannel[row.channel] = people;
    }
  }
  const receipts = (counts: Record<ReportChannel, number>): ReceiptCounts => {
    const byChannel = Object.fromEntries(REPORT_CHANNELS.map((channel) => [channel, RECEIPTS_RECORDED[channel] ? counts[channel] : null])) as Record<ReportChannel, number | null>;
    return { total: REPORT_CHANNELS.reduce((sum, channel) => sum + (byChannel[channel] ?? 0), 0), byChannel };
  };
  return {
    sent,
    delivered: receipts(delivered),
    read: receipts(read),
    replies,
    peopleContacted: contacted,
    peopleReplied: replied,
    contactedWhoReplied: after,
    replyRate: {
      total: replyRate(after.total, contacted.total),
      byChannel: Object.fromEntries(REPORT_CHANNELS.map((channel) => [channel, replyRate(after.byChannel[channel], contacted.byChannel[channel])])) as Record<ReportChannel, number | null>,
    },
  };
}

// ---------------------------------------------------------------- current figures

/** Counts at the moment they were read, whatever the period. */
export type CurrentCounts = {
  /** ISO instant the counts were read. */
  at: string;
  /** Open owner decisions that are handoffs (Needs you); the navigation badge counts the same. */
  needsYou: number;
  /** Every open owner decision, reports (interested, opt-out) included, by kind. */
  openDecisions: number;
  decisionsByKind: { kind: string; count: number }[];
  draftsAwaitingReview: number;
  /** The Action required queue; the navigation badge counts the same. */
  actionRequired: number;
  followUpsDue: number;
  plansAwaitingStart: number;
  plansAwaiting: { id: string; name: string }[];
  stillToSend: Record<ReportChannel, number>;
};

// ---------------------------------------------------------------- lead sources

const SOURCE_NAMES: Record<string, string> = {
  google_maps: "Google Maps",
  apify_instagram: "Instagram",
  apify_facebook: "Facebook",
  apify_linkedin: "LinkedIn companies",
  web_search: "Website search",
  linkedin_search: "LinkedIn search",
  list: "Your list",
  existing: "Your leads",
  "inquiry:website_form": "Website form inquiry",
  "inquiry:instagram": "Instagram inquiry",
};

const PROVIDER_NAMES: Record<string, string> = {
  scraper: "the built-in scraper",
  apify: "Apify",
  tinyfish: "TinyFish",
  tavily: "Tavily",
  aimlapi: "AI/ML API",
  openrouter: "OpenRouter",
  unipile: "Unipile",
};

/** The provider a source always runs on, when it has only one. */
const FIXED_PROVIDER: Record<string, string> = {
  apify_instagram: "apify",
  apify_facebook: "apify",
  apify_linkedin: "apify",
  linkedin_search: "unipile",
};

/**
 * A lead's source and the provider that found it, as one key
 * ("google_maps:scraper"). The source is where the lead was found; the
 * provider is who searched it (recorded on the search job). Website-search
 * spellings are one source.
 */
export function leadSourceKey(source: string, provider: string | null | undefined): string {
  const name = source === "discovery:web-search" || (source.startsWith("web") && !SOURCE_NAMES[source]) ? "web_search" : source || "unknown";
  const by = FIXED_PROVIDER[name] ?? (provider && PROVIDER_NAMES[provider] ? provider : null);
  return by ? `${name}:${by}` : name;
}

/** "Google Maps through the built-in scraper", "Instagram through Apify", "Your list". */
export function leadSourceLabel(key: string): string {
  const at = key.lastIndexOf(":");
  const provider = at > 0 ? PROVIDER_NAMES[key.slice(at + 1)] : undefined;
  const source = provider ? key.slice(0, at) : key;
  const name = SOURCE_NAMES[source] ?? source.replace(/[_:-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
  return provider ? `${name} through ${provider}` : name;
}

/** People found by exactly this set of sources (keys), and how many of them can be contacted. */
export type SourceCombination = { sources: readonly string[]; people: number; contactable: number };

export type LeadSourceRow = {
  key: string;
  label: string;
  /** Qualified people plus the businesses it found but could not save as a lead. */
  found: number;
  qualified: number;
  contactable: number;
  /** Of its qualified people, how many another source found too. */
  alsoFoundElsewhere: number;
};

export type LeadSources = {
  rows: LeadSourceRow[];
  /** Each person once, however many sources found them. */
  total: { found: number; qualified: number; contactable: number };
  /** People more than one source found: listed under each, counted once. */
  multiSource: { people: number; examples: { name: string; sources: string[] }[] };
};

/**
 * Per-source qualified and contactable people from the combinations of
 * sources that found each person (metrics.server.ts groups people by the
 * sorted set of sources that found them). A person belongs to every source
 * in their set and to the total once.
 */
export function summarizeLeadSources(input: {
  combinations: readonly SourceCombination[];
  unsaved: readonly { source: string; count: number }[];
  examples?: readonly { name: string; sources: readonly string[] }[];
}): LeadSources {
  const rows = new Map<string, LeadSourceRow>();
  const row = (key: string) => {
    let entry = rows.get(key);
    if (!entry) {
      entry = { key, label: leadSourceLabel(key), found: 0, qualified: 0, contactable: 0, alsoFoundElsewhere: 0 };
      rows.set(key, entry);
    }
    return entry;
  };
  const total = { found: 0, qualified: 0, contactable: 0 };
  let multi = 0;
  for (const combination of input.combinations) {
    const sources = [...new Set(combination.sources)];
    if (!sources.length || combination.people <= 0) continue;
    total.qualified += combination.people;
    total.contactable += combination.contactable;
    if (sources.length > 1) multi += combination.people;
    for (const source of sources) {
      const entry = row(source);
      entry.qualified += combination.people;
      entry.contactable += combination.contactable;
      if (sources.length > 1) entry.alsoFoundElsewhere += combination.people;
    }
  }
  let unsaved = 0;
  for (const item of input.unsaved) {
    if (item.count <= 0) continue;
    row(item.source).found += item.count;
    unsaved += item.count;
  }
  for (const entry of rows.values()) entry.found += entry.qualified;
  total.found = total.qualified + unsaved;
  return {
    rows: [...rows.values()].sort((a, b) => b.found - a.found || a.label.localeCompare(b.label)),
    total,
    multiSource: {
      people: multi,
      examples: (input.examples ?? []).map((example) => ({ name: example.name, sources: [...new Set(example.sources)].map(leadSourceLabel).sort((a, b) => a.localeCompare(b)) })),
    },
  };
}

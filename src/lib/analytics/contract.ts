import type { CurrentCounts, LeadSources, PeriodMetrics, ReportChannel } from "@/lib/reporting/metrics";

/**
 * The shapes of GET /api/analytics/[view], shared by the route, the queries
 * (src/lib/analytics/*.server.ts) and the dashboard (src/components/analytics).
 * Client-safe: types and pure helpers only, no runtime imports.
 *
 * Counting conventions, so the views agree with each other and with Overview:
 * - Every count is for events inside the range, whole local days in the
 *   organization's business time zone (an explicit ?tz= overrides it and
 *   is labelled). A "funnel" is therefore period counts, not one cohort
 *   followed through; the UI says so.
 * - Sent, delivered, read, replies, people contacted and replied, the reply
 *   rate, lead sources and the "now" counts are the shared definitions of
 *   src/lib/reporting/metrics.ts, read the same way Overview reads them.
 * - "People" counts are distinct person ids; "messages"/"emails"/"calls" are rows.
 * - Rates are 0..1, or null when the denominator is 0.
 * - "now" snapshots (queues, capacity, pipeline) ignore the range.
 */

export const ANALYTICS_VIEWS = ["overview", "email", "linkedin", "whatsapp"] as const;
export type AnalyticsView = (typeof ANALYTICS_VIEWS)[number];

export const ANALYTICS_CHANNELS = ["email", "linkedin", "whatsapp"] as const;
export type AnalyticsChannel = (typeof ANALYTICS_CHANNELS)[number];

/** The longest range the endpoint answers, in days. Past 62 days points are weekly. */
export const MAX_ANALYTICS_RANGE_DAYS = 180;
export const WEEKLY_BUCKET_AFTER_DAYS = 62;

export type AnalyticsRange = {
  /** Inclusive, YYYY-MM-DD in `tz`. */
  from: string;
  /** Inclusive, YYYY-MM-DD in `tz`. */
  to: string;
  /** IANA zone the range is cut and bucketed in. */
  tz: string;
  /** The organization's business time zone, or an explicit ?tz= override. */
  tzSource: "organization" | "override";
  /** The preset the range was asked as (?range=7d), or null for explicit dates. */
  preset: string | null;
  /** [from, to) as ISO instants: the window every count reads. */
  window: { from: string; to: string };
  bucket: "day" | "week";
};

/** The shared period figures for the range and for the equally long range before it. */
export type SharedFigures = { current: PeriodMetrics; previous: PeriodMetrics };

/** A number for the range, and the same number for the equally long range just before it. */
export type Metric = {
  value: number;
  /** null when the previous period can't be computed (e.g. a "now" snapshot). */
  previous: number | null;
};

/** One point per bucket, zero-filled; `date` is the bucket's first day, YYYY-MM-DD. */
export type TimeSeries<K extends string> = {
  keys: readonly K[];
  points: Array<{ date: string } & Record<K, number>>;
};

export type BreakdownRow<K extends string = string> = { key: K; label: string; value: number };

// ---------------------------------------------------------------- overview

export type FunnelStageKey = "contacted" | "replied" | "positive" | "meeting" | "customer";

/**
 * The Overview is CRM-first: `crm` (conversations, pipeline, AI) leads, and
 * the outreach funnel and channel table show where those conversations came from.
 */
export type OverviewAnalytics = {
  view: "overview";
  range: AnalyticsRange;
  kpis: {
    /** Provider-accepted outreach sends (shared `sent`). */
    sent: Metric;
    /** Distinct people with at least one provider-accepted outreach send (shared `peopleContacted`). */
    contacted: Metric;
    /** Distinct people with an inbound message on any channel (shared `peopleReplied`). */
    replied: Metric;
    /** Contacted people who replied after their first send (shared `contactedWhoReplied`). */
    contactedWhoReplied: Metric;
    /** contactedWhoReplied / contacted (shared `replyRate`). */
    replyRate: { value: number | null; previous: number | null };
    /** Distinct CRM records moved into Interested or Customer. */
    positive: Metric;
    /** Distinct CRM records moved into a meeting subcategory (see MEETING_SUBCATEGORY_KEYS). */
    meetings: Metric;
    /** Distinct CRM records moved into Customer. */
    customers: Metric;
  };
  funnel: Array<{ key: FunnelStageKey; label: string; value: number }>;
  /** Per channel, from the shared figures; Instagram only when it has activity. */
  channels: Array<{
    channel: ReportChannel;
    sent: number;
    contacted: number;
    /** Contacted on this channel who replied on it after their first send. */
    replied: number;
    /** replied / contacted. */
    replyRate: number | null;
    positive: number;
  }>;
  /** Now, regardless of range: the shared current counts, plus account health. */
  attention: {
    at: string;
    needsYou: number;
    actionRequired: number;
    overdue: number;
    draftsAwaitingReview: number;
    plansAwaitingStart: number;
    mailboxesFailing: number;
    linkedinDisconnected: number;
    whatsappDisconnected: number;
  };
  /** The shared period figures, as Overview (/assistant/results) reads them for the same window. */
  metrics: SharedFigures;
  /** The shared current counts. */
  now: CurrentCounts;
  /** Qualified and contactable people per source and provider, each person once in the total. */
  sources: LeadSources;
  crm: CrmSummary;
};

/**
 * Subcategory keys that mean a meeting or demo was requested or held. The
 * taxonomy is operator-editable, so this is a convention, not a schema fact;
 * "meeting_no_show" is deliberately excluded.
 */
export const MEETING_SUBCATEGORY_KEYS = [
  "meeting_requested",
  "meeting_done",
  "demo_request",
  "demo_requested",
] as const;

// ---------------------------------------------------------------- email

export type EmailAnalytics = {
  view: "email";
  range: AnalyticsRange;
  kpis: {
    /** Emails the provider accepted (shared `sent`, email). */
    sent: Metric;
    /** Distinct people sent at least one email (shared `peopleContacted`, email). */
    contacted: Metric;
    /** Of them, people who replied by email after their first email (shared `contactedWhoReplied`, email). */
    replied: Metric;
    /** replied / contacted for the same range; previous likewise (shared `replyRate`, email). */
    replyRate: { value: number | null; previous: number | null };
    /** Suppression rows with reason 'bounced'. */
    bounced: Metric;
    /** Suppression rows with reason 'unsubscribed'. */
    unsubscribed: Metric;
  };
  sends: TimeSeries<"firstTouch" | "followUp">;
  replies: TimeSeries<"replies">;
  /** outreach_emails with status 'failed' in the range (by created_at). */
  failedSends: number;
  campaigns: Array<{
    id: string;
    name: string;
    status: string;
    leads: number;
    /** Leads past 'pending'. */
    contacted: number;
    /** Emails sent in the range. */
    sentInRange: number;
    /** Leads with sequence_status 'reply_received' (all time). */
    replied: number;
    /** replied / contacted. */
    replyRate: number | null;
    bounced: number;
    /** Sends per bucket in the range, for a row sparkline. */
    trend: number[];
  }>;
  /** Now. */
  mailboxes: {
    total: number;
    connected: number;
    failing: number;
    sentToday: number;
    capacityToday: number;
    rows: Array<{ id: string; email: string; status: string; sentToday: number; dailyLimit: number }>;
  };
};

// ---------------------------------------------------------------- linkedin

export type LinkedinAnalytics = {
  view: "linkedin";
  range: AnalyticsRange;
  kpis: {
    /** Invitations LinkedIn accepted from the sender (shared `sent`, LinkedIn invitations). */
    invites: Metric;
    /** Connections accepted: Lead.acceptMessageSentAt in range (falls back to Connection.connectedAt). */
    accepted: Metric;
    /** accepted / invites. */
    acceptanceRate: { value: number | null; previous: number | null };
    /** Acceptance message and follow-ups 1 to 3 LinkedIn accepted (shared `sent`, LinkedIn messages). */
    messages: Metric;
    /** Distinct people sent an invitation or message (shared `peopleContacted`, LinkedIn). */
    contacted: Metric;
    /** Of them, people who replied on LinkedIn after their first send (shared `contactedWhoReplied`, LinkedIn). */
    replied: Metric;
    /** replied / contacted (shared `replyRate`, LinkedIn). */
    replyRate: { value: number | null; previous: number | null };
  };
  activity: TimeSeries<"invites" | "accepted" | "replied">;
  funnel: Array<{ key: "invited" | "accepted" | "messaged" | "replied"; label: string; value: number }>;
  /** Now. */
  accounts: Array<{
    id: string;
    name: string;
    status: string;
    premium: boolean;
    sentToday: number;
    /** 30 premium, 5 free (src/functions/sendInvitations.ts). */
    dailyLimit: number;
    pending: number;
  }>;
  campaigns: Array<{
    id: string;
    name: string;
    status: string;
    leads: number;
    invited: number;
    accepted: number;
    replied: number;
    acceptanceRate: number | null;
    replyRate: number | null;
    trend: number[];
  }>;
};

// ---------------------------------------------------------------- whatsapp

export type WhatsappCallOutcome = "connected" | "didNotPickUp" | "notOnWhatsApp" | "failed" | "inProgress";

export type WhatsappAnalytics = {
  view: "whatsapp";
  range: AnalyticsRange;
  kpis: {
    calls: Metric;
    connected: Metric;
    connectRate: { value: number | null; previous: number | null };
    talkTimeMs: Metric;
    avgCallMs: { value: number | null; previous: number | null };
    /** Campaign messages WhatsApp accepted (shared `sent`, WhatsApp). */
    sent: Metric;
    /** Of them, reported delivered or read (shared `delivered`, WhatsApp). */
    delivered: Metric;
    /** Of them, with a read receipt (shared `read`, WhatsApp). */
    read: Metric;
    /** Distinct people sent a campaign message (shared `peopleContacted`, WhatsApp). */
    contacted: Metric;
    /** Of them, people who replied on WhatsApp after their first send (shared `contactedWhoReplied`, WhatsApp). */
    replied: Metric;
    /** replied / contacted (shared `replyRate`, WhatsApp). */
    replyRate: { value: number | null; previous: number | null };
    /** Outbound chat messages of any origin: campaign sends, replies, and messages typed on the phone. */
    messagesSent: Metric;
    /** Inbound whatsapp_messages (origin lead). */
    messagesReceived: Metric;
    /** Chats with an outbound message in range that got a later inbound reply / chats with an outbound message in range. */
    chatReplyRate: { value: number | null; previous: number | null };
    /** Chats AgentSDR started (first message origin agentsdr) in range. */
    newChats: Metric;
  };
  calls: TimeSeries<"connected" | "notConnected">;
  outcomes: Array<BreakdownRow<WhatsappCallOutcome>>;
  messages: TimeSeries<"sent" | "received">;
  campaigns: Array<{
    id: string;
    name: string;
    leads: number;
    calls: number;
    connected: number;
    connectRate: number | null;
    dueToday: number;
    trend: number[];
  }>;
  /** Now. */
  accounts: Array<{
    id: string;
    name: string;
    phone: string | null;
    status: string;
    /** New chats in the rolling 24 h window the guardrail uses. */
    newChats24h: number;
    newChatLimit: number;
    /** ISO; null once warm-up is over. */
    warmingUpUntil: string | null;
  }>;
};

// ---------------------------------------------------------------- crm (part of the overview)

export type CrmCategory = "customer" | "interested" | "not_interested" | "other" | "unclassified";

/** The CRM half of the Overview. */
export type CrmSummary = {
  kpis: {
    /** Inbound crm_conversation_messages (shared `replies`). */
    replies: Metric;
    /** crm_classifications created, excluding failed and stale. */
    classified: Metric;
    /** crm_drafts that reached 'sent' (by the message.sent event time). */
    draftsSent: Metric;
    /** Median minutes from an inbound message to the next outbound in its conversation. */
    medianFirstResponseMinutes: { value: number | null; previous: number | null };
    /** overridden / (accepted + overridden + auto_applied) classifications. */
    overrideRate: { value: number | null; previous: number | null };
  };
  /** Inbound replies per bucket by the category they were classified into. */
  repliesByCategory: TimeSeries<CrmCategory>;
  /** Now: open records per subcategory, funnel stages first by stage_rank. */
  pipeline: Array<{
    subcategoryId: string | null;
    name: string;
    categoryKey: CrmCategory;
    stageRank: number | null;
    count: number;
  }>;
  /** Stage moves into each subcategory during the range. */
  stageEntries: Array<{ subcategoryId: string; name: string; categoryKey: CrmCategory; entered: number }>;
  drafts: {
    generated: number;
    sentAsIs: number;
    sentEdited: number;
    discarded: number;
    /** Now (shared `draftsAwaitingReview`). */
    awaitingReview: number;
  };
  /** Now. */
  workflow: Array<BreakdownRow>;
};

export type AnalyticsResponse = OverviewAnalytics | EmailAnalytics | LinkedinAnalytics | WhatsappAnalytics;

export type AnalyticsResponseFor<V extends AnalyticsView> = Extract<AnalyticsResponse, { view: V }>;

// ---------------------------------------------------------------- helpers (pure)

/** part / whole, or null when whole is 0. */
export function ratio(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/** Signed change from previous to value as a fraction, or null when there's no base. */
export function change(value: number | null, previous: number | null): number | null {
  if (value === null || previous === null || previous === 0) return null;
  return (value - previous) / previous;
}

/** Adds `days` to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Inclusive day count between two YYYY-MM-DD dates. */
export function dayCount(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** The equally long range that ends the day before `from`. */
export function previousRange(range: Pick<AnalyticsRange, "from" | "to">): { from: string; to: string } {
  const days = dayCount(range.from, range.to);
  return { from: addDays(range.from, -days), to: addDays(range.from, -1) };
}

/** Bucket start dates for a range, oldest first. Weeks start on the range's first day. */
export function bucketStarts(range: Pick<AnalyticsRange, "from" | "to" | "bucket">): string[] {
  const step = range.bucket === "week" ? 7 : 1;
  const out: string[] = [];
  for (let d = range.from; d <= range.to; d = addDays(d, step)) out.push(d);
  return out;
}

/** The bucket a YYYY-MM-DD day falls in. */
export function bucketFor(day: string, range: Pick<AnalyticsRange, "from" | "bucket">): string {
  if (range.bucket === "day") return day;
  const offset = Math.floor(dayCount(range.from, day) - 1);
  return addDays(range.from, offset - (offset % 7));
}

/** Zero-filled series from day-level rows (`date` YYYY-MM-DD in tz). */
export function toSeries<K extends string>(
  keys: readonly K[],
  range: Pick<AnalyticsRange, "from" | "to" | "bucket">,
  rows: Array<{ date: string } & Partial<Record<K, number>>>,
): TimeSeries<K> {
  const byBucket = new Map<string, Record<K, number>>();
  for (const start of bucketStarts(range)) {
    byBucket.set(start, Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>);
  }
  for (const row of rows) {
    if (row.date < range.from || row.date > range.to) continue;
    const target = byBucket.get(bucketFor(row.date, range));
    if (!target) continue;
    for (const k of keys) target[k] += Number(row[k] ?? 0);
  }
  return { keys, points: [...byBucket].map(([date, values]) => ({ date, ...values })) };
}

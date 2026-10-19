import { numberRule } from "@/lib/channels/rules";
import { TINYFISH_LIMITS } from "@/lib/tinyfish/catalog";

/**
 * An objective (CONTEXT.md): one owner request pursued to an end. It owns a
 * lead target, a time limit and a spend cap — named in the request or the
 * organization's defaults (the "general" Sending rules) — and one final
 * report. Its searches are ordinary jobs carrying the request's id; when they
 * finish short of the target, with time and budget left, the work goes on
 * by itself: the driver job (objective.server.ts) resumes the request's chat
 * turn with a note of what was found where, and the model picks the next
 * source or query. It stops at the first of: target reached, sources
 * exhausted, spend cap used, time limit, the owner's cancel, or a recorded
 * failure; leads already saved are always kept.
 *
 * Pure: the controls read from the owner's words, the spend arithmetic, the
 * driver's decisions and the wording, so each is unit-tested.
 */

export type ObjectiveStatus = "active" | "paused" | "stopped";

export type StopReason = "target_reached" | "sources_exhausted" | "budget_spent" | "time_limit" | "cancelled" | "failed";
export const STOP_REASONS: readonly StopReason[] = ["target_reached", "sources_exhausted", "budget_spent", "time_limit", "cancelled", "failed"];

/** How the request ended, for the chat and Activity: the target reached is complete; any other limit leaves it partial. */
export type ObjectiveOutcome = "completed" | "partial" | "cancelled" | "failed";

export function outcomeOf(reason: StopReason): ObjectiveOutcome {
  if (reason === "target_reached") return "completed";
  if (reason === "cancelled") return "cancelled";
  if (reason === "failed") return "failed";
  return "partial";
}

/** The idempotency key of the objective's one final report (CONTEXT.md, Report key). */
export function objectiveReportKey(objectiveId: string, reason: StopReason): string {
  return `assistant_objective:${objectiveId}:${reason}`;
}

// ── Controls ─────────────────────────────────────────────────────────────────

export type ControlDefaults = { leadTarget: number; hours: number; spendUsd: number };

export type ObjectiveControls = {
  leadTarget: number;
  timeLimitMinutes: number;
  spendCapUsd: number;
  /** Which came from the owner's words (the rest are the organization's defaults). */
  named: { target: boolean; time: boolean; spend: boolean };
};

/** A named time shorter than this is taken as this: one search needs a few minutes to report at all. */
const MIN_NAMED_MINUTES = 5;

const TARGET_PATTERNS = [
  /\btarget\s*(?:of|:|=)?\s*(\d{1,6})\b/i,
  /\b(\d{1,6})\s+(?:new\s+|more\s+|qualified\s+|good\s+|fresh\s+|potential\s+)?(?:leads?|contacts?|prospects?)\b/i,
  // "find 40 real estate agents": a number right after the verb; "find dentists in 3 cities" is not one.
  /\b(?:find|get|need|want|collect|gather|bring|look\s+for|search\s+for)\s+(?:me\s+|us\s+)?(?:at\s+least\s+|about\s+|around\s+|up\s+to\s+|some\s+)?(\d{1,6})\b(?!\s*(?:%|percent|km|kms|kilomet|miles?|minutes?|mins?|hours?|hrs?|days?|cities|city|areas?|places?|countries|country|states?|districts?))/i,
];

const TIME_UNITS: [RegExp, number][] = [
  [/^(?:minutes?|mins?|m)$/i, 1],
  [/^(?:hours?|hrs?|h)$/i, 60],
  [/^(?:days?|d)$/i, 1_440],
];
// "within 2 hours", "in 30 minutes", "for an hour", "time limit of 3h"; "open 24 hours" names no limit.
const TIME_PATTERN = /\b(?:within|in|for|under|max(?:imum)?|up\s+to|no\s+more\s+than|at\s+most|time\s+limit(?:\s+of)?)\s+(?:the\s+next\s+)?(\d+(?:\.\d+)?|an?|one|half\s+an?)\s*(minutes?|mins?|hours?|hrs?|days?|h|m|d)\b/i;

// A budget, not a price: the amount next to spend/budget/cap ("spend up to $3", "budget $12.50", "a 10 dollar budget").
const SPEND_PATTERNS = [
  /\b(?:spend(?:ing)?|budget(?:ed)?|cap(?:ped)?)\b[^$\d\n]{0,20}?(?:\$|usd\s*|us\$\s*)(\d+(?:\.\d{1,2})?)/i,
  /\b(?:spend(?:ing)?|budget(?:ed)?|cap(?:ped)?)\b[^$\d\n]{0,20}?(\d+(?:\.\d{1,2})?)\s*(?:usd|dollars?|\$)/i,
  /(?:\$|usd\s*)(\d+(?:\.\d{1,2})?)\s*(?:budget|cap|max(?:imum)?|limit|to\s+spend|of\s+spend)/i,
  /\b(\d+(?:\.\d{1,2})?)\s*(?:usd|dollars?)\s*(?:budget|cap|max(?:imum)?|limit)/i,
];
const FREE_ONLY = /\b(?:free\s+sources\s+only|only\s+free\s+sources|free\s+only|no\s+paid\s+(?:sources|searches|tools)|don'?t\s+spend(?:\s+anything|\s+money)?|without\s+spending)\b/i;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function namedTarget(text: string): number | null {
  for (const pattern of TARGET_PATTERNS) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

function namedMinutes(text: string): number | null {
  const match = text.match(TIME_PATTERN);
  if (!match) return null;
  const amount = /^half/i.test(match[1]!) ? 0.5 : /^(?:an?|one)$/i.test(match[1]!) ? 1 : Number(match[1]);
  const unit = TIME_UNITS.find(([pattern]) => pattern.test(match[2]!))?.[1] ?? null;
  return unit === null || !Number.isFinite(amount) ? null : Math.round(amount * unit);
}

function namedSpend(text: string): number | null {
  if (FREE_ONLY.test(text)) return 0;
  for (const pattern of SPEND_PATTERNS) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

/**
 * The request's controls: what the owner's words name (a target, a time, a
 * budget), each held inside the Sending rules' hard bounds, and the
 * organization's defaults for the rest.
 */
export function parseObjectiveControls(text: string, defaults: ControlDefaults): ObjectiveControls {
  const target = numberRule("general", "objectiveLeadTarget");
  const hours = numberRule("general", "objectiveHours");
  const spend = numberRule("general", "objectiveSpendUsd");
  const words = text.replace(/\s+/g, " ");
  const leadTarget = namedTarget(words);
  const minutes = namedMinutes(words);
  const spendUsd = namedSpend(words);
  return {
    leadTarget: clamp(Math.round(leadTarget ?? defaults.leadTarget), target.min, target.max),
    timeLimitMinutes: minutes === null ? clamp(defaults.hours, hours.min, hours.max) * 60 : clamp(minutes, MIN_NAMED_MINUTES, hours.max * 60),
    spendCapUsd: Math.round(clamp(spendUsd ?? defaults.spendUsd, spend.min, spend.max) * 100) / 100,
    named: { target: leadTarget !== null, time: minutes !== null, spend: spendUsd !== null },
  };
}

// ── Money ────────────────────────────────────────────────────────────────────

export function usd(value: number): string {
  return `$${(Math.round(value * 100) / 100).toFixed(2)}`;
}

/**
 * Ledger rows that serve one request: its jobs' Apify runs, its Treg calls,
 * its metered provider use (provider_usage), the AI web research its website
 * searches reported, and the Tavily credits its website searches used.
 */
export type LedgerRow =
  | { ledger: "apify"; status: string; usageUsd: number | null; maxChargeUsd: number }
  | { ledger: "treg"; status: string; costUsd: number | null; ceilingUsd: number }
  | { ledger: "usage"; provider: string; product: string; status: string; units: number; usedUnits: number | null }
  | { ledger: "ai_search"; costUsd: number }
  | { ledger: "tavily_job"; credits: number };

export type SpendBreakdown = {
  apifyUsd: number;
  tregUsd: number;
  browserUsd: number;
  aiSearchUsd: number;
  /** Held by paid work still open (an Apify run, a Treg call, a browser session): counted until it settles. */
  reservedUsd: number;
  /** Kept counted because the provider's answer was lost; never refunded or retried. */
  uncertainUsd: number;
  /** Tavily is priced by the owner's Tavily plan, so it is counted in credits, not dollars. */
  tavilyCredits: number;
  totalUsd: number;
  settledUsd: number;
};

/** Dollars per unit of metered provider_usage products; anything not here is free (TinyFish Search and Fetch, HN, Stack Exchange). */
const UNIT_PRICES: Record<string, number> = {
  "tinyfish:browser": TINYFISH_LIMITS.browserUsdPerMinute,
};

const round6 = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

export function spendFromLedgers(rows: readonly LedgerRow[]): SpendBreakdown {
  const spend = { apifyUsd: 0, tregUsd: 0, browserUsd: 0, aiSearchUsd: 0, reservedUsd: 0, uncertainUsd: 0, tavilyCredits: 0 };
  for (const row of rows) {
    if (row.ledger === "apify") {
      const open = row.status === "starting" || row.status === "running";
      const amount = open ? row.maxChargeUsd : row.usageUsd ?? 0;
      spend.apifyUsd += amount;
      if (open) spend.reservedUsd += amount;
    } else if (row.ledger === "treg") {
      const open = row.status === "calling";
      const amount = open ? row.ceilingUsd : row.costUsd ?? 0;
      spend.tregUsd += amount;
      if (open) spend.reservedUsd += amount;
    } else if (row.ledger === "usage") {
      const key = `${row.provider}:${row.product}`;
      // Reserved and uncertain rows keep every reserved unit counted; settled ones what was used.
      const units = row.status === "reserved" || row.status === "uncertain" ? row.units : row.usedUnits ?? row.units;
      if (key === "tavily:search") {
        spend.tavilyCredits += units;
        continue;
      }
      const price = UNIT_PRICES[key] ?? 0;
      if (!price) continue;
      const amount = units * price;
      spend.browserUsd += amount;
      if (row.status === "reserved") spend.reservedUsd += amount;
      if (row.status === "uncertain") spend.uncertainUsd += amount;
    } else if (row.ledger === "ai_search") {
      spend.aiSearchUsd += row.costUsd;
    } else {
      spend.tavilyCredits += row.credits;
    }
  }
  const totalUsd = spend.apifyUsd + spend.tregUsd + spend.browserUsd + spend.aiSearchUsd;
  return {
    apifyUsd: round6(spend.apifyUsd),
    tregUsd: round6(spend.tregUsd),
    browserUsd: round6(spend.browserUsd),
    aiSearchUsd: round6(spend.aiSearchUsd),
    reservedUsd: round6(spend.reservedUsd),
    uncertainUsd: round6(spend.uncertainUsd),
    tavilyCredits: spend.tavilyCredits,
    totalUsd: round6(totalUsd),
    settledUsd: round6(totalUsd - spend.reservedUsd),
  };
}

export type SpendRoom = { ok: true; maxUsd: number } | { ok: false; wait: boolean; reason: string };

const EPSILON = 0.000_001;

/**
 * Whether paid work may reserve `wantUsd` (its least possible cost) against
 * the request's cap, and how much it may take at most. Settled spend at the
 * cap refuses; other paid work still holding part of it is a wait, since
 * what it does not use comes back when it settles.
 */
export function spendRoom(input: { capUsd: number; settledUsd: number; reservedUsd: number; wantUsd: number }): SpendRoom {
  const { capUsd, settledUsd, reservedUsd } = input;
  if (capUsd <= 0) return { ok: false, wait: false, reason: "this request is limited to free sources (its spend cap is $0)" };
  if (settledUsd >= capUsd - EPSILON) return { ok: false, wait: false, reason: `this request's spend cap of ${usd(capUsd)} is used (${usd(settledUsd)} recorded)` };
  const left = capUsd - settledUsd - reservedUsd;
  if (left + EPSILON < Math.max(input.wantUsd, 0.01)) {
    if (reservedUsd > EPSILON) return { ok: false, wait: true, reason: `this request's other paid work holds ${usd(reservedUsd)} of its ${usd(capUsd)} spend cap until it settles` };
    return { ok: false, wait: false, reason: `this request's spend cap of ${usd(capUsd)} leaves ${usd(Math.max(0, left))}, less than the ${usd(input.wantUsd)} this needs` };
  }
  return { ok: true, maxUsd: round6(Math.max(0, left)) };
}

// ── Limits and the driver ────────────────────────────────────────────────────

export type LimitFacts = { now: Date; deadline: Date; leadTarget: number; leads: number; spendCapUsd: number; spentUsd: number };

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (!hours) return `${mins} min`;
  return mins ? `${hours} h ${mins} min` : `${hours} h`;
}

/** The first limit the request has reached, in order: its target, its spend cap (settled spend), its time. */
export function limitReached(facts: LimitFacts): { reason: StopReason; detail: string } | null {
  if (facts.leads >= facts.leadTarget) return { reason: "target_reached", detail: `${facts.leads} qualified leads found, the target was ${facts.leadTarget}` };
  if (facts.spendCapUsd > 0 && facts.spentUsd >= facts.spendCapUsd - EPSILON) return { reason: "budget_spent", detail: `${usd(facts.spentUsd)} of the ${usd(facts.spendCapUsd)} spend cap was used` };
  if (facts.now.getTime() >= facts.deadline.getTime()) return { reason: "time_limit", detail: "the time limit passed" };
  return null;
}

/** How a continuation turn ended (agent.server.ts runAgentTurn). */
export type TurnEnd = "done" | "failed" | "no_ai" | "max_steps";

/** The latest continuation turn, kept in the objective's progress. */
export type Continuation = {
  n: number;
  attempt: number;
  startedAt: string;
  endedAt: string | null;
  end: TurnEnd | null;
  leadsAtStart: number;
  /** Judged once its turn ended: it started work (productive), or met only a full slot or quota wait (waiting). */
  judged: "productive" | "waiting" | null;
  waitUntil?: string | null;
};

export type DriverFacts = LimitFacts & {
  status: "active" | "paused";
  /** The request's searches still queued or running. */
  openChildren: number;
  /** Plans its finished searches still owe (a "find and contact" request). */
  followUpsPending: number;
  /** A turn holds the chat (the owner's, a follow-up's or a continuation). */
  threadBusy: boolean;
  continuation: Continuation | null;
  /** Searches started for the request since the latest continuation began. */
  newSearches: number;
  /** Searches the latest continuation tried that were refused only for a full slot or a quota wait. */
  waitRefusals: string[];
  /** Other refusals it met (the first one is said in the report). */
  refusals: string[];
  /** Continuations in a row that found no new lead. */
  dry: number;
};

export type DriverStep =
  | { kind: "stop"; reason: StopReason; detail: string }
  | { kind: "wait"; delayMs: number; reason: string }
  | { kind: "judge"; judged: "productive" | "waiting"; waitUntil: Date | null }
  | { kind: "continue"; n: number; attempt: number; dry: number };

export const MAX_CONTINUATION_ATTEMPTS = 3;
export const MAX_DRY_CONTINUATIONS = 2;
const WATCH_MS = 60_000;
const TURN_POLL_MS = 15_000;
const PAUSED_POLL_MS = 60_000;
const RETRY_BACKOFF_MS = 60_000;
const SLOT_RETRY_MS = 5 * 60_000;

/**
 * What the driver does next, from what is recorded: stop at a limit, wait
 * while work runs (or a slot or quota frees), judge a finished continuation
 * turn, or start the next one. A turn whose process stopped is taken again,
 * and one the model could not answer is retried, a bounded number of times;
 * a turn that starts nothing means no source is left to try.
 */
export function nextDriverStep(facts: DriverFacts): DriverStep {
  const limit = limitReached(facts);
  if (limit) return { kind: "stop", ...limit };
  const untilDeadline = Math.max(1_000, facts.deadline.getTime() - facts.now.getTime() + 1_000);
  const wait = (delayMs: number, reason: string): DriverStep => ({ kind: "wait", delayMs: Math.min(delayMs, untilDeadline), reason });
  if (facts.status === "paused") return wait(PAUSED_POLL_MS, "paused by the owner");

  const turn = facts.continuation;
  if (turn && !turn.judged) {
    if (!turn.endedAt) {
      if (facts.threadBusy) return wait(TURN_POLL_MS, "the assistant is choosing the next source");
      // It never recorded its end: the process running it stopped. Taken again, a bounded number of times.
      if (turn.attempt >= MAX_CONTINUATION_ATTEMPTS) return { kind: "stop", reason: "failed", detail: `the assistant's continuation was interrupted ${turn.attempt} times` };
      return { kind: "continue", n: turn.n, attempt: turn.attempt + 1, dry: facts.dry };
    }
    if (turn.end === "failed" || turn.end === "no_ai") {
      if (turn.attempt >= MAX_CONTINUATION_ATTEMPTS) {
        return { kind: "stop", reason: "failed", detail: turn.end === "no_ai" ? "no AI provider is set up to choose the next source" : `the AI model did not give a usable answer after ${turn.attempt} tries` };
      }
      const retryAt = new Date(turn.endedAt).getTime() + RETRY_BACKOFF_MS * turn.attempt;
      if (facts.now.getTime() < retryAt) return wait(retryAt - facts.now.getTime(), "the AI model did not answer; trying again shortly");
      return { kind: "continue", n: turn.n, attempt: turn.attempt + 1, dry: facts.dry };
    }
    if (facts.newSearches > 0 || facts.leads > turn.leadsAtStart) return { kind: "judge", judged: "productive", waitUntil: null };
    if (facts.waitRefusals.length) return { kind: "judge", judged: "waiting", waitUntil: new Date(facts.now.getTime() + SLOT_RETRY_MS) };
    const why = facts.refusals[0];
    return { kind: "stop", reason: "sources_exhausted", detail: why ? `no other source could be searched (${why.replace(/\.$/, "")})` : "the assistant found no further source or query worth searching" };
  }

  if (facts.openChildren > 0) return wait(WATCH_MS, `${facts.openChildren} search${facts.openChildren === 1 ? "" : "es"} still running`);
  if (facts.followUpsPending > 0) return wait(TURN_POLL_MS, "preparing the plan for the leads found");
  if (facts.threadBusy) return wait(TURN_POLL_MS, "the chat is busy");
  if (turn?.judged === "waiting" && turn.waitUntil && facts.now.getTime() < new Date(turn.waitUntil).getTime()) {
    return wait(new Date(turn.waitUntil).getTime() - facts.now.getTime(), "a provider slot or quota is full; trying again when it frees");
  }
  const dry = turn ? (facts.leads > turn.leadsAtStart ? 0 : facts.dry + 1) : 0;
  if (dry >= MAX_DRY_CONTINUATIONS) return { kind: "stop", reason: "sources_exhausted", detail: `${dry} continuations in a row found no new lead` };
  return { kind: "continue", n: (turn?.n ?? 0) + 1, attempt: 1, dry };
}

// ── Wording ──────────────────────────────────────────────────────────────────

/** One source's yield for the request (a source, through its provider: "Google Maps through the built-in scraper"). */
export type SourceYield = {
  label: string;
  searches: number;
  found: number;
  eligible: number;
  notSearched: number;
  failed: number;
  open: number;
  notes: string[];
};

export type ContactRoutes = { email: number; whatsapp: number; linkedin: number; instagram: number };

/** The web searches and page reads the assistant ran itself for the request (they start no job). */
export type WebUse = { searches: number; pagesRead: number };

function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

/** A recorded reason, short: without the "X was not searched:" lead the line already says, cut at a word. */
export function reasonText(note: string, max = 160): string {
  const text = note.replace(/\s+/g, " ").trim().replace(/^(?:not searched:\s*|[\w ]{1,40} was not searched:\s*)/i, "").replace(/\.$/, "");
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max / 2)).replace(/[\s,;:(]+$/, "")}…`;
}

export function sourceLine(source: SourceYield): string {
  const parts: string[] = [];
  const ran = source.searches - source.notSearched - source.failed - source.open;
  const why = source.notes[0] ? ` (${reasonText(source.notes[0])})` : "";
  if (ran > 0) parts.push(`${plural(ran, "search", "searches")}, ${source.found} found, ${source.eligible} can be contacted`);
  if (source.open) parts.push(`${source.open} still running`);
  if (source.notSearched) parts.push(`${source.notSearched} not searched${why}`);
  if (source.failed) parts.push(`${source.failed} failed${source.notSearched ? "" : why}`);
  return `${source.label}: ${parts.join("; ") || "nothing yet"}`;
}

function sourcesText(sources: readonly SourceYield[], web: WebUse | null): string {
  const lines = sources.map(sourceLine);
  if (web && (web.searches || web.pagesRead)) lines.push(`the assistant's own web research: ${[web.searches ? plural(web.searches, "web search", "web searches") : null, web.pagesRead ? plural(web.pagesRead, "page") + " read" : null].filter(Boolean).join(", ")}`);
  return lines.join("; ") || "nothing yet";
}

function spendText(spend: SpendBreakdown, capUsd: number): string {
  const parts = [
    spend.apifyUsd ? `Apify ${usd(spend.apifyUsd)}` : null,
    spend.tregUsd ? `Treg ${usd(spend.tregUsd)}` : null,
    spend.browserUsd ? `browser ${usd(spend.browserUsd)}` : null,
    spend.aiSearchUsd ? `AI web research ${usd(spend.aiSearchUsd)}` : null,
  ].filter(Boolean);
  const held = spend.reservedUsd ? `, ${usd(spend.reservedUsd)} of it held by paid work still open` : "";
  const uncertain = spend.uncertainUsd ? `, ${usd(spend.uncertainUsd)} kept because a provider's answer was lost` : "";
  const tavily = spend.tavilyCredits ? `; ${plural(spend.tavilyCredits, "Tavily credit")} (priced by your Tavily plan)` : "";
  return `${usd(spend.totalUsd)} of the ${usd(capUsd)} cap${parts.length ? ` (${parts.join(", ")}${held}${uncertain})` : held || uncertain ? ` (${(held + uncertain).slice(2)})` : ""}${tavily}`;
}

/**
 * The note that resumes the request's turn (an EVENT the owner reads and the
 * model acts on): found against the target, spend and time left, and what
 * each source yielded, so the next source or query is chosen by yield.
 */
export function continuationNote(input: {
  request: string;
  n: number;
  leads: number;
  leadTarget: number;
  spend: SpendBreakdown;
  spendCapUsd: number;
  msLeft: number;
  sources: readonly SourceYield[];
  web: WebUse | null;
}): string {
  const request = input.request.replace(/\s+/g, " ").trim().slice(0, 200);
  return [
    `Continuing your request “${request}” on its own (step ${input.n}): ${input.leads} of ${input.leadTarget} qualified leads so far, ${Math.max(0, input.leadTarget - input.leads)} to go.`,
    `Spent ${input.spendCapUsd > 0 ? `${usd(input.spend.totalUsd)} of ${usd(input.spendCapUsd)}` : "nothing (free sources only)"}; ${formatDuration(input.msLeft)} left.`,
    `Searched so far — ${sourcesText(input.sources, input.web)}.`,
    "Next: another source or a different query, chosen by these yields; a search that already ran is not repeated, and when nothing else fits the request the research stops here.",
  ].join(" ");
}

const STOP_WORDS: Record<StopReason, string> = {
  target_reached: "the target was reached",
  sources_exhausted: "no further source was left to try",
  budget_spent: "the spend cap was used",
  time_limit: "the time limit passed",
  cancelled: "it was cancelled",
  failed: "it failed",
};

/** The objective's one final report, from recorded counts only. */
export function objectiveReportText(input: {
  request: string;
  reason: StopReason;
  /** The exact reason, as recorded (who cancelled, which limit, what failed). */
  detail: string;
  leads: number;
  leadTarget: number;
  routes: ContactRoutes;
  spend: SpendBreakdown;
  spendCapUsd: number;
  sources: readonly SourceYield[];
  web: WebUse | null;
  /** Searches still running when it stopped: their leads are saved as they finish. */
  stillRunning: number;
}): string {
  const head = input.reason === "target_reached" ? "Research finished" : "Research stopped";
  const why = input.detail ? input.detail : STOP_WORDS[input.reason];
  const remaining = Math.max(0, input.leadTarget - input.leads);
  const routes = [
    input.routes.email ? `${input.routes.email} by email` : null,
    input.routes.whatsapp ? `${input.routes.whatsapp} by WhatsApp or phone` : null,
    input.routes.linkedin ? `${input.routes.linkedin} on LinkedIn` : null,
    input.routes.instagram ? `${input.routes.instagram} on Instagram` : null,
  ].filter(Boolean);
  const request = input.request.replace(/\s+/g, " ").trim().slice(0, 200);
  return [
    `${head}: ${why} (request “${request}”).`,
    `${plural(input.leads, "qualified lead")} of the ${input.leadTarget} wanted${remaining ? `; ${remaining} still to find` : ""}.${routes.length ? ` Contact routes: ${routes.join(", ")}.` : ""}`,
    `Searched — ${sourcesText(input.sources, input.web)}.`,
    `Recorded spend: ${spendText(input.spend, input.spendCapUsd)}.`,
    input.stillRunning ? `${plural(input.stillRunning, "search", "searches")} still running when it stopped; ${input.stillRunning === 1 ? "its" : "their"} leads are saved as ${input.stillRunning === 1 ? "it finishes" : "they finish"}.` : null,
    "Every lead found is kept: the lead lists are in this chat, and the people in Leads.",
  ].filter(Boolean).join(" ");
}

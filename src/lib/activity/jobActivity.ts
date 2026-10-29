/**
 * What an assistant search job is doing now and through what, told only
 * from what its row recorded (status, stage, run_after, attempts, heartbeat,
 * progress, the provider run it waits on, the provider its payload chose):
 * never a guess, never an ETA. The chat's request card, the request panel,
 * the Requests page and Activity all read a job's state from here, so an
 * open search is one of six things everywhere:
 *
 * - Queued: not started yet, or held before its next step (a free provider
 *   run slot, a provider's allowance, the request's spend cap settling);
 * - Searching / Reading pages: a step is running, or due to run now;
 * - Waiting for provider results: it started a run at its provider and
 *   checks it again at the recorded time;
 * - Retrying: its last step failed (or its worker stopped reporting) and it
 *   runs again on its own;
 * - Needs you: it waits for the owner (they paused the request's research).
 *
 * A finished job has no activity (null): its outcome is status.ts jobState.
 * Pure and client-safe.
 */

import { AIML_PROVIDER_KEY, AIML_PROVIDER_NAME } from "@/lib/ai/aimlapi-types";

export type JobPhase = "queued" | "searching" | "reading" | "waiting_provider" | "retrying" | "needs_you";

export const JOB_PHASE_LABELS: Record<JobPhase, string> = {
  queued: "Queued",
  searching: "Searching",
  reading: "Reading pages",
  waiting_provider: "Waiting for provider results",
  retrying: "Retrying",
  needs_you: "Needs you",
};

export type JobActivityFacts = {
  kind: string;
  status: string;
  stage: string | null;
  runAfter: string | Date | null;
  heartbeatAt: string | Date | null;
  attempts: number;
  progress: Record<string, unknown> | null;
  /** It waits on a run it started at its provider (the job's external id is set). */
  providerRun?: boolean;
};

export type JobActivity = {
  phase: JobPhase;
  label: string;
  /** Why it is in that state, as recorded (a wait's reason, the last error); null when nothing needs saying. */
  reason: string | null;
  /** When it is next looked at (its recorded run_after, or a provider's own "until"), only while that is ahead. */
  nextCheckAt: string | null;
};

/** A running step with no heartbeat for this long is picked up again by another worker (worker.ts STALE_MS). */
const STALE_MS = 3 * 60_000;
/** A run_after this close is "now": the job is between two steps, not waiting. */
const DUE_WITHIN_MS = 5_000;

const PROVIDER_NAMES: Record<string, string> = { apify: "Apify", brightdata: "Bright Data", tinyfish: "TinyFish", tavily: "Tavily", unipile: "Unipile", exa: "Exa" };

function instant(value: string | Date | null | undefined): number | null {
  if (!value) return null;
  const at = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/** The first sentence of a recorded error, short enough for one line. */
function shortError(value: string): string {
  const sentence = value.replace(/\s+/g, " ").trim().split(/(?<=[a-z0-9)])\.\s/i)[0]!.replace(/\.$/, "");
  return sentence.length > 160 ? `${sentence.slice(0, 159)}…` : sentence;
}

/** The phase a stage of work belongs to; the step line (jobStep) says exactly which step. */
function stagePhase(stage: string): JobPhase {
  return stage === "reading" || stage === "enriching" ? "reading" : "searching";
}

/** Stages in which a job that waits is waiting on its provider's run (an Actor run, a scraper job, a LinkedIn search, a collection). */
const PROVIDER_STAGES = new Set(["apify", "searching", "collecting", "profiles"]);

function activity(phase: JobPhase, reason: string | null, nextCheckAt: number | null, now: number): JobActivity {
  return { phase, label: JOB_PHASE_LABELS[phase], reason, nextCheckAt: nextCheckAt !== null && nextCheckAt > now ? new Date(nextCheckAt).toISOString() : null };
}

export function jobActivity(job: JobActivityFacts, nowDate: Date): JobActivity | null {
  if (job.status !== "queued" && job.status !== "running") return null;
  const now = nowDate.getTime();
  const progress = job.progress ?? {};
  const stage = text(job.stage) ?? text(progress.stage) ?? "queued";
  const runAfter = instant(job.runAfter);
  const waiting = (progress.waiting ?? null) as { kind?: unknown; reason?: unknown; provider?: unknown; until?: unknown } | null;
  const waitReason = text(waiting?.reason);
  const provider = PROVIDER_NAMES[String(waiting?.provider ?? "")] ?? null;

  if (job.status === "running") {
    const beat = instant(job.heartbeatAt);
    if (beat !== null && now - beat > STALE_MS) return activity("retrying", "its worker stopped reporting a few minutes ago; another one picks it up on its own", null, now);
    return activity(stagePhase(stage), null, null, now);
  }

  if (waiting) {
    if (waiting.kind === "objective") return activity("searching", waitReason, runAfter, now);
    if (waiting.kind === "paused" && /\bowner paused\b/i.test(waitReason ?? "")) return activity("needs_you", "you paused this request's research; it continues when you resume it in the chat", null, now);
    if (waiting.kind === "slot") return activity("queued", `waiting for a free ${provider ?? "provider"} run slot${waitReason ? `: ${waitReason}` : ""}`, runAfter, now);
    if (waiting.kind === "quota") return activity("queued", `waiting for ${provider ? `${provider}'s` : "the provider's"} limit${waitReason ? `: ${waitReason}` : ""}`, instant(text(waiting.until)) ?? runAfter, now);
    return activity("queued", waitReason, runAfter, now);
  }

  const lastError = text(progress.lastError);
  if (lastError && job.attempts > 0) return activity("retrying", shortError(lastError), runAfter, now);

  const ahead = runAfter !== null && runAfter > now + DUE_WITHIN_MS;
  if (ahead) {
    if (job.providerRun || PROVIDER_STAGES.has(stage)) return activity("waiting_provider", null, runAfter, now);
    if (stage === "queued") return activity("queued", text(progress.note), runAfter, now);
    return activity(stagePhase(stage), null, runAfter, now);
  }
  // Due now: not picked up yet when it has not started; otherwise between two steps of its work.
  return stage === "queued" ? activity("queued", text(progress.note), null, now) : activity(stagePhase(stage), null, null, now);
}

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The live step of an open job, short, with its fraction when the job reports both counts. */
export function jobStep(job: { kind: string; stage: string | null; progress: Record<string, unknown> | null }): { step: string; progress: { done: number; total: number } | null } {
  const p = job.progress ?? {};
  const stage = text(job.stage) && STEPS.has(job.stage!) ? job.stage! : String(p.stage ?? "");
  const pair = (done: unknown, total: unknown) => {
    const d = num(done), t = num(total);
    return d !== null && t !== null && t > 0 ? { done: Math.min(d, t), total: t } : null;
  };
  switch (stage) {
    case "queued": return { step: text(p.note) ?? "Starting", progress: null };
    case "apify":
    case "profiles":
    case "searching": {
      const found = num(p.found);
      if (job.kind === "linkedin_search" && found) return { step: `${plural(found, "profile")} so far`, progress: null };
      return { step: "Searching", progress: pair(p.searchesDone, p.searches) };
    }
    case "collecting": return { step: "Collecting posts and profiles", progress: null };
    case "reading": return { step: "Reading pages for contacts", progress: pair(p.read ?? p.pagesRead, p.toRead ?? p.websites ?? p.candidates) };
    case "enriching": return { step: "Reading websites for contacts", progress: pair(p.websitesChecked, p.websitesToCheck) };
    case "saving": return { step: "Saving contacts", progress: pair(p.saved, p.found) };
    case "qualifying": return { step: "Checking each lead against your request", progress: pair(p.judged, p.toJudge) };
    case "watching": return { step: "Following the request's searches", progress: null };
    default: return { step: "Working", progress: null };
  }
}

const STEPS = new Set(["queued", "apify", "profiles", "searching", "collecting", "reading", "enriching", "saving", "qualifying", "watching"]);

/** A web search provider as the owner knows it (the provider a job's payload chose, or a search recorded). */
export function webSearchProviderName(provider: string | null | undefined): string {
  switch (provider) {
    case "tinyfish": return "TinyFish Search";
    case "tavily": return "Tavily";
    case "openrouter": return "OpenRouter web search";
    case AIML_PROVIDER_KEY: return `${AIML_PROVIDER_NAME} web research`;
    default: return "web search";
  }
}

/** The payload facts a job's transport is read from (http.server.ts selects only these, never the whole payload). */
export type JobTransportFacts = {
  kind: string;
  progress: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  /** payload.provider: "apify" | "scraper" for Maps and social discovery. */
  provider?: string | null;
  /** payload.target: "maps" | "facebook" | "linkedin" | "instagram". */
  target?: string | null;
  /** payload.searchProvider: the web search provider a web discovery chose. */
  searchProvider?: string | null;
};

const PLATFORMS: Record<string, string> = { reddit: "Reddit", x: "X", instagram: "Instagram", facebook: "Facebook" };

/**
 * Where a search ran and through what, from its recorded facts: "Google Maps
 * · Maps scraper", "Facebook pages · Apify", "LinkedIn · Unipile", "Web ·
 * Tavily", "Reddit · Bright Data". Null when nothing says.
 */
export function jobTransport(job: JobTransportFacts): { source: string; via: string | null } | null {
  const progress = job.progress ?? {};
  const result = job.result ?? {};
  if (job.kind === "linkedin_search") return { source: "LinkedIn", via: "Unipile" };
  if (job.kind === "apify_instagram") return { source: "Instagram", via: "Apify" };
  if (job.kind === "social_research") {
    const sources = (Array.isArray(result.sources) ? result.sources : Array.isArray(progress.sources) ? progress.sources : []) as { platform?: unknown; state?: unknown }[];
    const searched = sources.filter((item) => item.state !== "skipped" && item.state !== "not_searched").map((item) => PLATFORMS[String(item.platform)] ?? String(item.platform ?? "")).filter(Boolean);
    return { source: searched.length ? searched.join(", ") : "Social media", via: "Bright Data" };
  }
  if (job.kind === "web_discovery") {
    const recorded = (Array.isArray(result.searches) ? result.searches : []) as { provider?: unknown }[];
    const used = [...new Set(recorded.map((item) => text(item.provider)).filter((item): item is string => Boolean(item)))];
    const via = used.length ? used.map(webSearchProviderName).join(", ") : job.searchProvider ? webSearchProviderName(job.searchProvider) : null;
    return { source: "Websites and directories", via };
  }
  if (job.kind === "discovery") {
    const target = text(result.target) ?? job.target ?? "maps";
    const provider = text(result.provider) ?? job.provider ?? (progress.provider === "Apify" ? "apify" : null);
    const recordedSource = text(progress.source) ?? "";
    if (/not searched; website search instead/i.test(recordedSource)) return { source: "Google Maps (handed to web search)", via: null };
    if (target === "facebook") return { source: "Facebook pages", via: "Apify" };
    if (target === "linkedin") return { source: "LinkedIn companies", via: "Apify" };
    if (target === "instagram") return { source: "Instagram", via: "Apify" };
    if (provider === "apify" || /through Apify/i.test(recordedSource)) return { source: "Google Maps", via: "Apify" };
    if (provider === "scraper" || /built-in scraper/i.test(recordedSource)) return { source: "Google Maps", via: "Maps scraper" };
    return { source: "Google Maps", via: null };
  }
  return null;
}

/** "Google Maps · Maps scraper", for one line. */
export function transportLine(transport: { source: string; via: string | null } | null): string | null {
  return transport ? [transport.source, transport.via].filter(Boolean).join(" · ") : null;
}

/** The research tools that run without a job, and what they ran through (null: not a research tool). */
export function toolTransport(tool: string | null, toolResult: { data?: Record<string, unknown> } | null): string | null {
  if (!tool) return null;
  if (tool === "exa_search" || tool === "exa_read") return "Exa";
  if (tool === "web_search") {
    const provider = text(toolResult?.data?.provider);
    return provider ? webSearchProviderName(provider).replace(/^web search$/, "Web search") : "Web search";
  }
  if (tool.startsWith("browser_tab_") || tool === "browser_task") return "Your Chrome";
  if (tool.startsWith("browser_") && tool !== "browser_connection") return "TinyFish browser";
  if (tool === "treg_search" || tool === "treg_call") return "Treg";
  return null;
}

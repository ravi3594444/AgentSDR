/**
 * What one lead search shows in the chat's request card
 * (RequestActivity.tsx): what it looked for, what it ran through (the
 * source and its transport, from the job's recorded facts: jobActivity.ts),
 * its state in the words used everywhere (Queued, Searching, Reading pages,
 * Waiting for provider results, Retrying, Needs you, then Done, Failed, Not
 * searched, Cancelled), its live step with a fraction when the job reports
 * one, its Found / Contactable / Matching when done, and every other fact the
 * job recorded as a detail line. Pure, so the wording is tested without a
 * browser; every figure comes from the job's own progress or result, never
 * from the model's words.
 */

import { jobActivity, jobStep, jobTransport, transportLine, type JobPhase } from "@/lib/activity/jobActivity";

export const RESEARCH_TOOLS = new Set(["find_leads", "find_linkedin_leads", "find_customers_on_web", "find_instagram_prospects", "find_social_leads", "research_social_sources"]);

export type ResearchMessage = {
  id: string;
  tool: string | null;
  status: "running" | "ok" | "error" | null;
  content: string;
  toolInput: Record<string, unknown> | null;
  toolResult: { display?: string; data?: Record<string, unknown> } | null;
};

export type ResearchJob = {
  id: string;
  kind: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  stage: string;
  progress: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  audienceId: string | null;
  /** Timing and transport facts (http.server.ts); absent on rows from before they were sent. */
  runAfter?: string | null;
  heartbeatAt?: string | null;
  attempts?: number;
  providerRun?: boolean;
  provider?: string | null;
  target?: string | null;
  searchProvider?: string | null;
};

export type SourceIcon = "maps" | "linkedin" | "web" | "instagram" | "facebook" | "reddit" | "x" | "social";
/** open: the job is queued or running (its phase says how); starting: the tool's own call has not returned yet. */
export type RowState = "starting" | "open" | "done" | "skipped" | "failed" | "cancelled";

/** The three figures a search and a request are counted by, named the same everywhere (requests.ts RequestNumbers). */
export type ResearchStat = { label: "Found" | "Contactable" | "Matching"; value: number };

export type ResearchRow = {
  id: string;
  /** What was searched: "real estate agencies in Miami, FL". */
  title: string;
  /** Where and through what: "Google Maps · Maps scraper", "Facebook pages · Apify", "Reddit · Bright Data". */
  source: string;
  icon: SourceIcon;
  state: RowState;
  /** While open, its phase (jobActivity.ts). */
  phase: JobPhase | null;
  /** The state as shown: "Searching", "Waiting for provider results", "Done", "Failed". */
  label: string;
  /** The live step, short ("Reading websites for contacts"), while open. */
  step: string | null;
  /** Why it is in that state, as recorded (a wait's reason, the last error), while open. */
  reason: string | null;
  /** When it is next looked at (its recorded run_after), while that is ahead. */
  nextCheckAt: string | null;
  /** Done and total of the live step, when the job reports both. */
  progress: { done: number; total: number } | null;
  /** Found, Contactable and (once judged) Matching, when done. */
  stats: ResearchStat[];
  /** Everything else the job recorded, one fact a line. */
  details: string[];
  error: string | null;
  audienceId: string | null;
  contactable: number | null;
  excluded: number | null;
};

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const PLATFORM: Record<string, string> = { reddit: "Reddit", x: "X", instagram: "Instagram", facebook: "Facebook" };

/** Where a search ran, from its job's recorded facts; before the job is known, from the tool and its arguments. */
function sourceOf(message: ResearchMessage, job: ResearchJob | undefined): { source: string; icon: SourceIcon } {
  const input = message.toolInput ?? {};
  const recorded = job ? transportLine(jobTransport({ kind: job.kind, progress: job.progress, result: job.result, provider: job.provider ?? null, target: job.target ?? null, searchProvider: job.searchProvider ?? null })) : null;
  if (message.tool === "research_social_sources" || job?.kind === "social_research") {
    const platforms = (Array.isArray(input.platforms) ? input.platforms : Array.isArray(job?.result?.platforms) ? (job!.result!.platforms as unknown[]) : [])
      .filter((item): item is string => typeof item === "string");
    const icon: SourceIcon = platforms.length === 1 && (platforms[0] === "reddit" || platforms[0] === "x" || platforms[0] === "instagram" || platforms[0] === "facebook") ? platforms[0] as SourceIcon : "social";
    const fallback = `${platforms.length ? platforms.map((item) => PLATFORM[item] ?? item).join(", ") : "Social media"} · Bright Data`;
    return { source: recorded && !recorded.startsWith("Social media") ? recorded : fallback, icon };
  }
  if (message.tool === "find_social_leads") {
    // The platform it was asked for; its job runs it through Apify.
    const platform = str(input.platform) ?? job?.target ?? null;
    if (platform === "linkedin") return { source: "LinkedIn companies · Apify", icon: "linkedin" };
    if (platform === "instagram") return { source: "Instagram · Apify", icon: "instagram" };
    return { source: "Facebook pages · Apify", icon: "facebook" };
  }
  if (message.tool === "find_instagram_prospects" || job?.kind === "apify_instagram") return { source: recorded ?? "Instagram · Apify", icon: "instagram" };
  if (message.tool === "find_linkedin_leads" || job?.kind === "linkedin_search") return { source: recorded ?? "LinkedIn · Unipile", icon: "linkedin" };
  if (message.tool === "find_customers_on_web" || job?.kind === "web_discovery") return { source: recorded ?? "Websites and directories", icon: "web" };
  if (message.tool === "find_leads" || job?.kind === "discovery") return { source: recorded ?? "Google Maps", icon: "maps" };
  // A search this card does not know yet: what its job recorded, else the tool's own name.
  return { source: recorded ?? (message.tool ?? "Search").replace(/_/g, " ").replace(/^./, (first) => first.toUpperCase()), icon: "web" };
}

/** What a search looked for, as the chat names it; social research leads with who it looked for. */
export function researchTitle(message: ResearchMessage, job?: Pick<ResearchJob, "result">): string {
  const data = message.toolResult?.data ?? {};
  const input = message.toolInput ?? {};
  const where = str(input.where);
  const phrase = str(data.phrase) ?? str(job?.result?.phrase);
  const customers = str(input.customers);
  if (message.tool === "research_social_sources" && phrase && customers && !phrase.toLowerCase().includes(customers.toLowerCase())) return `${customers}: ${phrase}`;
  return str(data.phrase) ?? str(job?.result?.phrase) ?? str(data.keywords) ?? str(data.customers)
    ?? ([str(input.what) ?? str(input.customers) ?? str(input.role), where ? `in ${where}` : null].filter(Boolean).join(" ") || "Lead search");
}

function doneFacts(job: ResearchJob): { stats: ResearchStat[]; details: string[] } {
  const r = job.result ?? {};
  const n = (key: string) => num(r[key]) ?? 0;
  const linkedin = job.kind === "linkedin_search";
  const instagram = job.kind === "apify_instagram";
  const social = job.kind === "social_research";
  const fit = (r.fit ?? null) as { contactable?: number; qualified?: number; notMatching?: number; unconfirmed?: number; pending?: number } | null;
  const stats: ResearchStat[] = [{ label: "Found", value: n("found") }, { label: "Contactable", value: n("eligible") }];
  if (fit && (fit.contactable ?? 0) > 0) stats.push({ label: "Matching", value: fit.qualified ?? 0 });
  const details: string[] = [];
  if (social) details.push(`Found: ${plural(n("found"), "person or business", "people or businesses")}`);
  if (linkedin) details.push(`Found: ${plural(n("found"), "LinkedIn profile")}`);
  if (instagram) details.push(`Found: ${plural(n("found"), "Instagram account")}`);
  if (social && n("discussions")) details.push(`${plural(n("discussions"), "relevant post")} and comments read`);
  if (!linkedin) {
    const routes = [n("withEmail") && `${n("withEmail")} by email`, n("withPhoneOnly") && `${n("withPhoneOnly")} by phone only`, n("withInstagram") && `${n("withInstagram")} with Instagram profiles`].filter(Boolean);
    if (routes.length) details.push(`Reachable: ${routes.join(", ")}`);
  } else if (n("eligible")) details.push("Contactable on LinkedIn");
  if (instagram) details.push("Potential matches, not interest");
  if (instagram && n("instagramOnly")) details.push(`${n("instagramOnly")} found on Instagram only — approved DM plan and connected sender required`);
  if (fit && (fit.contactable ?? 0) > 0) {
    const parts = [`${fit.qualified ?? 0} match your request`, fit.notMatching ? `${fit.notMatching} do not` : null, fit.unconfirmed ? `${fit.unconfirmed} unconfirmed` : null, fit.pending ? `${fit.pending} not judged yet` : null].filter(Boolean);
    details.push(parts.join(", "));
  }
  if (social && n("needSignals")) details.push(`${n("needSignals")} asked for something like this in their own words`);
  if (n("excluded")) details.push(`${n("excluded")} left out with reasons`);
  if (n("duplicates")) details.push(`${plural(n("duplicates"), "duplicate")} skipped`);
  if (n("alreadyKnown")) details.push(`${n("alreadyKnown")} already in your leads (not duplicated)`);
  if (social && n("creditsUsed")) details.push(`Bright Data credits used: ${n("creditsUsed")} (estimated)`);
  for (const key of ["note", "fitNote", "providerNote"]) { const text = str(r[key]); if (text) details.push(text); }
  return { stats, details };
}

export function researchRow(message: ResearchMessage, job: ResearchJob | undefined, now: Date = new Date()): ResearchRow {
  const { source, icon } = sourceOf(message, job);
  const base = { id: message.id, title: researchTitle(message, job), source, icon, phase: null, step: null, reason: null, nextCheckAt: null, progress: null, stats: [], details: [], error: null, audienceId: null, contactable: null, excluded: null };
  const display = str(message.toolResult?.display) ?? str(message.content);
  if (message.status === "running") return { ...base, state: "starting", label: "Starting" };
  if (message.status === "error") return { ...base, state: "failed", label: "Not started", error: display };
  if (!job) {
    const audienceId = str(message.toolResult?.data?.audienceId);
    return { ...base, state: "done", label: "Done", details: display ? [display] : [], audienceId };
  }
  if (job.status === "queued" || job.status === "running") {
    const live = jobActivity({ kind: job.kind, status: job.status, stage: job.stage, runAfter: job.runAfter ?? null, heartbeatAt: job.heartbeatAt ?? null, attempts: job.attempts ?? 0, progress: job.progress, providerRun: job.providerRun }, now)!;
    const step = live.phase === "searching" || live.phase === "reading" ? jobStep(job) : null;
    return { ...base, state: "open", phase: live.phase, label: live.label, step: step && step.step !== live.label ? step.step : null, progress: step?.progress ?? null, reason: live.reason, nextCheckAt: live.nextCheckAt };
  }
  if (job.status === "cancelled") return { ...base, state: "cancelled", label: "Cancelled", error: job.error };
  if (job.status === "failed") return { ...base, state: "failed", label: "Failed", error: job.error ?? "The search failed." };
  const r = job.result ?? {};
  if (r.notSearched) {
    const note = str(r.note);
    return { ...base, state: "skipped", label: "Not searched", details: note ? [note] : [] };
  }
  const facts = doneFacts(job);
  return { ...base, state: "done", label: "Done", stats: facts.stats, details: facts.details, audienceId: job.audienceId, contactable: num(r.eligible), excluded: num(r.excluded) };
}

export type ResearchSummary = { total: number; open: number; done: number; skipped: number; failed: number; retrying: number; needsYou: number; found: number; contactable: number; matching: number | null };

/** The card's figures when no request summary covers them: what the finished searches found together. */
export function researchSummary(rows: ResearchRow[]): ResearchSummary {
  const sum = (label: ResearchStat["label"]) => rows.reduce((total, row) => total + (row.stats.find((stat) => stat.label === label)?.value ?? 0), 0);
  const judged = rows.some((row) => row.stats.some((stat) => stat.label === "Matching"));
  return {
    total: rows.length,
    open: rows.filter((row) => row.state === "open" || row.state === "starting").length,
    done: rows.filter((row) => row.state === "done" || row.state === "skipped").length,
    skipped: rows.filter((row) => row.state === "skipped").length,
    failed: rows.filter((row) => row.state === "failed" || row.state === "cancelled").length,
    retrying: rows.filter((row) => row.phase === "retrying").length,
    needsYou: rows.filter((row) => row.phase === "needs_you").length,
    found: sum("Found"),
    contactable: sum("Contactable"),
    matching: judged ? sum("Matching") : null,
  };
}

/** The card's header line: where the research is, in a few words, without its figures (they have their own row). */
export function researchHeadline(summary: ResearchSummary): { title: string; detail: string | null } {
  const searches = (n: number) => plural(n, "search", "searches");
  if (summary.open > 0) {
    const notes = [summary.needsYou ? `${summary.needsYou} need${summary.needsYou === 1 ? "s" : ""} you` : null, summary.retrying ? `${summary.retrying} retrying` : null, summary.failed ? `${summary.failed} failed` : null].filter(Boolean);
    return { title: "Researching", detail: `${summary.open} of ${searches(summary.total)} still going${notes.length ? ` · ${notes.join(" · ")}` : ""}` };
  }
  if (summary.total === 0) return { title: "Activity", detail: null };
  if (summary.done === 0 && summary.failed > 0) return { title: summary.failed === 1 ? "Search failed" : "Searches failed", detail: `${summary.failed === 1 ? "The search" : `All ${summary.failed} searches`} failed` };
  if (summary.skipped === summary.total) return { title: summary.total === 1 ? "Source not searched" : "Sources not searched", detail: "See the reason below" };
  return { title: summary.total === 1 ? "Search finished" : "Searches finished", detail: summary.failed ? `${searches(summary.total)}, ${summary.failed} failed` : searches(summary.total) };
}

export type RequestFigure = { label: "Found" | "Contactable" | "Matching" | "Contacted" | "Replied" | "Interested"; value: string };

/**
 * The request card's figures, in the order and names used everywhere: Found,
 * Contactable, Matching, then Contacted, Replied, Interested only once
 * outreach is relevant. Read from the request's summary (the same numbers
 * as the panel beside the chat) when it has them; from the card's own
 * finished searches when it has none (older searches carry no request).
 * While the summary loads the figures read "—", never a number that is
 * then replaced. Matching is "of N" only for a target the owner named.
 */
export function requestFigures(input: {
  numbers: { found: number | null; contactable: number | null; matching: number | null; contacted: number; replied: number; interested: number } | null | undefined;
  target: number | null;
  rows: ResearchSummary;
  outreach: boolean;
}): RequestFigure[] {
  const { numbers, rows } = input;
  const format = (value: number | null) => (value === null ? "—" : value.toLocaleString("en-US"));
  const searched = numbers === undefined ? { found: null, contactable: null, matching: null, loading: true }
    : numbers && numbers.found !== null ? { found: numbers.found, contactable: numbers.contactable, matching: numbers.matching, loading: false }
    : { found: rows.found, contactable: rows.contactable, matching: rows.matching, loading: false };
  const figures: RequestFigure[] = [
    { label: "Found", value: format(searched.found) },
    { label: "Contactable", value: format(searched.contactable) },
  ];
  if (searched.loading || searched.matching !== null) {
    const target = input.target && searched.matching !== null ? ` of ${input.target.toLocaleString("en-US")}` : "";
    figures.push({ label: "Matching", value: `${format(searched.matching)}${target}` });
  }
  if (input.outreach) {
    figures.push(
      { label: "Contacted", value: numbers ? format(numbers.contacted) : "—" },
      { label: "Replied", value: numbers ? format(numbers.replied) : "—" },
      { label: "Interested", value: numbers ? format(numbers.interested) : "—" },
    );
  }
  return figures;
}

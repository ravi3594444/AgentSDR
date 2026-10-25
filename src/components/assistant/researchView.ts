/**
 * What one lead search shows in the chat's research card
 * (ResearchGroup.tsx): its source, its state, a short live step with a
 * fraction when the job reports one, three figures when it is done, and
 * every other fact the job recorded as a detail line under it. Pure, so the
 * card's wording is tested without a browser; every figure comes from the
 * job's own progress or result, never from the model's words.
 */

import { formatChatTime } from "@/lib/assistant/chatTime";

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
};

export type SourceIcon = "maps" | "linkedin" | "web" | "instagram" | "facebook" | "reddit" | "x" | "social";
export type RowState = "starting" | "running" | "waiting" | "done" | "skipped" | "failed" | "cancelled";

export type ResearchRow = {
  id: string;
  /** What was searched: "real estate agencies in Miami, FL". */
  title: string;
  /** Where: "Google Maps", "Facebook pages via Apify", "Reddit, X via Bright Data". */
  source: string;
  icon: SourceIcon;
  state: RowState;
  /** The live step or the end state, short: "Reading websites", "Failed". */
  step: string;
  /** Done and total of the live step, when the job reports both. */
  progress: { done: number; total: number } | null;
  /** The figures a finished search shows large. */
  stats: { label: string; value: number }[];
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

/** "Google Maps through the built-in scraper" → "Google Maps". */
function shortSource(source: string | null): string | null {
  return source ? source.replace(/\s+through\s+.*$/i, "").trim() : null;
}

function sourceOf(message: ResearchMessage, job: ResearchJob | undefined): { source: string; icon: SourceIcon } {
  const input = message.toolInput ?? {};
  const progress = job?.progress ?? {};
  const viaApify = progress.provider === "Apify" || job?.result?.provider === "apify";
  if (message.tool === "research_social_sources" || job?.kind === "social_research") {
    const platforms = (Array.isArray(input.platforms) ? input.platforms : Array.isArray(job?.result?.platforms) ? (job!.result!.platforms as unknown[]) : [])
      .filter((item): item is string => typeof item === "string");
    const names = platforms.map((item) => PLATFORM[item] ?? item);
    const icon: SourceIcon = platforms.length === 1 && (platforms[0] === "reddit" || platforms[0] === "x" || platforms[0] === "instagram" || platforms[0] === "facebook") ? platforms[0] as SourceIcon : "social";
    return { source: `${names.length ? names.join(", ") : "Social media"} via Bright Data`, icon };
  }
  if (message.tool === "find_social_leads") {
    const platform = str(input.platform);
    if (platform === "linkedin") return { source: "LinkedIn companies via Apify", icon: "linkedin" };
    if (platform === "instagram") return { source: "Instagram via Apify", icon: "instagram" };
    return { source: "Facebook pages via Apify", icon: "facebook" };
  }
  if (message.tool === "find_instagram_prospects" || job?.kind === "apify_instagram") return { source: "Instagram via Apify", icon: "instagram" };
  if (message.tool === "find_linkedin_leads" || job?.kind === "linkedin_search") return { source: "LinkedIn", icon: "linkedin" };
  if (message.tool === "find_customers_on_web" || job?.kind === "web_discovery") return { source: "Web search", icon: "web" };
  return { source: `${shortSource(str(progress.source)) ?? "Google Maps"}${viaApify && !/apify/i.test(String(progress.source ?? "")) ? " via Apify" : ""}`, icon: "maps" };
}

/** What a search looked for, as the chat names it; social research leads with who it looked for. */
export function researchTitle(message: ResearchMessage, job?: ResearchJob): string {
  const data = message.toolResult?.data ?? {};
  const input = message.toolInput ?? {};
  const where = str(input.where);
  const phrase = str(data.phrase) ?? str(job?.result?.phrase);
  const customers = str(input.customers);
  if (message.tool === "research_social_sources" && phrase && customers && !phrase.toLowerCase().includes(customers.toLowerCase())) return `${customers}: ${phrase}`;
  return str(data.phrase) ?? str(job?.result?.phrase) ?? str(data.keywords) ?? str(data.customers)
    ?? ([str(input.what) ?? str(input.customers) ?? str(input.role), where ? `in ${where}` : null].filter(Boolean).join(" ") || "Lead search");
}

/** The live step of a running job, short, with its fraction when the job reports one. */
function liveStep(job: ResearchJob, timeZone: string): { step: string; progress: { done: number; total: number } | null; waiting: boolean } {
  const p = job.progress;
  const waiting = (p.waiting ?? null) as { reason?: string | null; until?: string } | null;
  const stage = job.stage in STAGES ? job.stage : String(p.stage ?? "");
  if (waiting) {
    const until = waiting.until ? ` until ${formatChatTime(waiting.until, timeZone)}` : "";
    return { step: `Waiting${until}: ${waiting.reason ?? "a provider asked to wait"}`, progress: null, waiting: true };
  }
  const pair = (done: unknown, total: unknown) => {
    const d = num(done), t = num(total);
    return d !== null && t !== null && t > 0 ? { done: Math.min(d, t), total: t } : null;
  };
  switch (stage) {
    case "queued": return { step: str(p.note) ?? "Starting", progress: null, waiting: false };
    case "searching": {
      const found = num(p.found);
      return { step: job.kind === "linkedin_search" && found ? `Searching · ${plural(found, "profile")} so far` : "Searching", progress: null, waiting: false };
    }
    case "collecting": return { step: "Collecting posts and profiles", progress: null, waiting: false };
    case "reading": return { step: "Reading pages for contacts", progress: pair(p.read ?? p.pagesRead, p.toRead ?? p.candidates), waiting: false };
    case "enriching": return { step: "Reading websites for contacts", progress: pair(p.websitesChecked, p.websitesToCheck), waiting: false };
    case "saving": return { step: "Saving contacts", progress: pair(p.saved, p.found), waiting: false };
    case "qualifying": return { step: "Checking each lead against your request", progress: pair(p.judged, p.toJudge), waiting: false };
    default: return { step: "Working", progress: null, waiting: false };
  }
}

const STAGES: Record<string, true> = { queued: true, searching: true, collecting: true, reading: true, enriching: true, saving: true, qualifying: true };

function doneFacts(job: ResearchJob): { stats: ResearchRow["stats"]; details: string[] } {
  const r = job.result ?? {};
  const n = (key: string) => num(r[key]) ?? 0;
  const linkedin = job.kind === "linkedin_search";
  const instagram = job.kind === "apify_instagram";
  const social = job.kind === "social_research";
  const fit = (r.fit ?? null) as { contactable?: number; qualified?: number; notMatching?: number; unconfirmed?: number; pending?: number } | null;
  const stats: ResearchRow["stats"] = [
    { label: social ? "people or businesses" : linkedin ? "profiles" : instagram ? "accounts" : "found", value: n("found") },
    { label: "contactable", value: n("eligible") },
  ];
  if (fit && (fit.contactable ?? 0) > 0) stats.push({ label: "match", value: fit.qualified ?? 0 });
  const details: string[] = [];
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

export function researchRow(message: ResearchMessage, job: ResearchJob | undefined, timeZone: string): ResearchRow {
  const { source, icon } = sourceOf(message, job);
  const base = { id: message.id, title: researchTitle(message, job), source, icon, progress: null, stats: [], details: [], error: null, audienceId: null, contactable: null, excluded: null };
  const display = str(message.toolResult?.display) ?? str(message.content);
  if (message.status === "running") return { ...base, state: "starting", step: "Starting" };
  if (message.status === "error") return { ...base, state: "failed", step: "Not started", error: display };
  if (!job) {
    const audienceId = str(message.toolResult?.data?.audienceId);
    return { ...base, state: "done", step: "Done", details: display ? [display] : [], audienceId };
  }
  if (job.status === "queued" || job.status === "running") {
    const live = liveStep(job, timeZone);
    return { ...base, state: live.waiting ? "waiting" : "running", step: live.step, progress: live.progress };
  }
  if (job.status === "cancelled") return { ...base, state: "cancelled", step: "Cancelled", error: job.error };
  if (job.status === "failed") return { ...base, state: "failed", step: "Failed", error: job.error ?? "The search failed." };
  const r = job.result ?? {};
  if (r.notSearched) {
    const note = str(r.note);
    return { ...base, state: "skipped", step: "Not searched", details: note ? [note] : [] };
  }
  const facts = doneFacts(job);
  return { ...base, state: "done", step: "Done", stats: facts.stats, details: facts.details, audienceId: job.audienceId, contactable: num(r.eligible), excluded: num(r.excluded) };
}

export type ResearchSummary = { total: number; running: number; done: number; skipped: number; failed: number; found: number; contactable: number; match: number | null };

/** The group's header: how many searches are where, and what the finished ones found together. */
export function researchSummary(rows: ResearchRow[]): ResearchSummary {
  const sum = (label: string) => rows.reduce((total, row) => total + (row.stats.find((stat) => stat.label === label)?.value ?? 0), 0);
  const matched = rows.filter((row) => row.stats.some((stat) => stat.label === "match"));
  return {
    total: rows.length,
    running: rows.filter((row) => row.state === "running" || row.state === "starting" || row.state === "waiting").length,
    done: rows.filter((row) => row.state === "done" || row.state === "skipped").length,
    skipped: rows.filter((row) => row.state === "skipped").length,
    failed: rows.filter((row) => row.state === "failed" || row.state === "cancelled").length,
    found: rows.reduce((total, row) => total + (row.stats[0]?.value ?? 0), 0),
    contactable: sum("contactable"),
    match: matched.length ? sum("match") : null,
  };
}

/** The header line: what is happening now, in a few words. */
export function researchHeadline(summary: ResearchSummary): { title: string; detail: string } {
  const sources = plural(summary.total, "source");
  if (summary.running > 0) {
    const finished = summary.done + summary.failed;
    return { title: `Researching ${sources}`, detail: finished ? `${summary.done} done${summary.failed ? `, ${summary.failed} failed` : ""}, ${summary.running} still going` : "Results appear here as each one finishes" };
  }
  if (summary.done === 0 && summary.failed > 0) return { title: summary.failed === 1 ? "Search failed" : "Searches failed", detail: `${summary.failed === 1 ? "The search" : `All ${summary.failed} searches`} failed` };
  if (summary.skipped === summary.total && summary.total > 0) return { title: summary.total === 1 ? "Source not searched" : "Sources not searched", detail: "See the reason below" };
  const found = [`${summary.found} found`, `${summary.contactable} contactable`, summary.match !== null ? `${summary.match} match` : null].filter(Boolean).join(" · ");
  return { title: summary.failed ? `Searches finished, ${summary.failed} failed` : summary.total === 1 ? "Search finished" : "Searches finished", detail: found };
}

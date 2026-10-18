/**
 * Which platforms an owner's request named, and how far each was searched,
 * told from the searches the request started (their jobs). A request naming
 * Google Maps, Instagram and LinkedIn is not done after Maps alone: each
 * named platform shows searched, searching, waiting, not searched or not
 * started, with the actual reason. A website's Instagram link is contact
 * enrichment, not an Instagram search, so only a search on the platform
 * itself counts. Pure; coverage.server.ts reads the jobs.
 */

export type Platform = "google_maps" | "instagram" | "facebook" | "linkedin" | "web";

export const PLATFORM_LABELS: Record<Platform, string> = {
  google_maps: "Google Maps",
  instagram: "Instagram",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  web: "Websites and directories",
};

const NAMED: [Platform, RegExp][] = [
  ["google_maps", /\b(?:google\s*maps?|g\s*maps?|maps)\b/i],
  ["instagram", /\b(?:instagram|insta|ig)\b/i],
  ["facebook", /\b(?:facebook|fb)\b/i],
  ["linkedin", /\b(?:linked\s*in|linkedin|linked)\b/i],
  ["web", /\b(?:websites?|web\s*search|directories|directory|google(?!\s*maps))\b/i],
];

/** The platforms the owner's words name, in a fixed order; none for a request that leaves the choice to the assistant. */
export function namedPlatforms(text: string): Platform[] {
  return NAMED.filter(([, pattern]) => pattern.test(text)).map(([platform]) => platform);
}

export type CoverageJob = {
  kind: string;
  status: string;
  stage: string | null;
  payload: Record<string, unknown> | null;
  progress: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: string | null;
};

/** The platform a search job searches, or null for jobs that are not searches. */
export function platformOfJob(job: Pick<CoverageJob, "kind" | "payload">): Platform | null {
  if (job.kind === "apify_instagram") return "instagram";
  if (job.kind === "web_discovery") return "web";
  if (job.kind === "linkedin_search") return "linkedin";
  if (job.kind !== "discovery") return null;
  const target = job.payload?.target;
  return target === "facebook" || target === "linkedin" ? target : target === "instagram" ? "instagram" : "google_maps";
}

export type PlatformState = "searched" | "searching" | "waiting" | "partial" | "not searched" | "failed" | "not started";

export type PlatformCoverage = { platform: Platform; state: PlatformState; detail: string | null };

function jobState(job: CoverageJob): { state: PlatformState; detail: string | null; found: number } {
  const result = job.result ?? {};
  const found = Number(result.found ?? 0);
  if (job.status === "failed") return { state: "failed", detail: job.error, found: 0 };
  if (job.status === "cancelled") return { state: "not searched", detail: "cancelled", found: 0 };
  if (job.status === "succeeded") {
    if (result.notSearched === true || result.handedToJobId) return { state: "not searched", detail: typeof result.note === "string" ? result.note : null, found: 0 };
    return { state: "searched", detail: `${found} found, ${Number(result.eligible ?? 0)} can be contacted`, found };
  }
  const waiting = job.progress?.waiting as { reason?: unknown; until?: unknown } | undefined;
  if (waiting) return { state: "waiting", detail: typeof waiting.reason === "string" ? waiting.reason : null, found: 0 };
  return { state: "searching", detail: null, found: 0 };
}

/**
 * Each named platform's state over the request's search jobs: searched when
 * all its searches finished, partial when some did while others still run or
 * failed, otherwise the state of its searches.
 */
export function requestCoverage(named: readonly Platform[], jobs: readonly CoverageJob[]): PlatformCoverage[] {
  return named.map((platform) => {
    const states = jobs.filter((job) => platformOfJob(job) === platform).map(jobState);
    if (!states.length) return { platform, state: "not started", detail: null };
    const searched = states.filter((entry) => entry.state === "searched");
    const pending = states.filter((entry) => entry.state === "searching" || entry.state === "waiting");
    if (searched.length && searched.length === states.length) {
      return { platform, state: "searched", detail: `${searched.reduce((sum, entry) => sum + entry.found, 0)} found in ${searched.length} search${searched.length === 1 ? "" : "es"}` };
    }
    if (searched.length) {
      const rest = states.find((entry) => entry.state !== "searched")!;
      return { platform, state: "partial", detail: `${searched.length} of ${states.length} searches done${rest.detail ? `; ${rest.state}: ${rest.detail}` : `; ${rest.state}`}` };
    }
    const first = pending[0] ?? states[0]!;
    return { platform, state: first.state, detail: first.detail };
  });
}

/** One line for the chat: every named platform with its state and reason. */
export function coverageLine(coverage: readonly PlatformCoverage[]): string | null {
  if (coverage.length < 2) return null;
  return `Requested platforms: ${coverage.map((entry) => `${PLATFORM_LABELS[entry.platform]} — ${entry.state}${entry.detail ? ` (${entry.detail.replace(/\s+/g, " ").slice(0, 160)})` : ""}`).join("; ")}.`;
}

import type { WorkItem } from "@/lib/activity/activity.server";

/**
 * The way back to one search's leads, wherever that search is shown: its
 * card in the chat, its row under a request (beside the chat and on the
 * Requests page) and the request's final report. Each opens the same list
 * (ProspectsList) with one GET. Pure and client-safe.
 */

/** "View leads (5)": the count is the search's contactable leads (result.eligible), as its card and report call them. */
export function viewLeadsLabel(count: number | null | undefined): string {
  return typeof count === "number" && Number.isFinite(count) && count >= 0 ? `View leads (${count.toLocaleString("en-US")})` : "View leads";
}

/** The one request opening a list makes: a GET, never cached. Reading a list never prepares, approves or sends anything. */
export function prospectsRequest(audienceId: string): { url: string; init: { cache: "no-store" } } {
  return { url: `/api/assistant/audiences/${encodeURIComponent(audienceId)}/prospects`, init: { cache: "no-store" } };
}

/** Jobs that are not a search of their own: a lead request's driver, and the job that starts a plan's outreach. */
const NOT_A_SEARCH = new Set(["objective", "outreach_start"]);
const FINISHED: ReadonlySet<WorkItem["state"]> = new Set(["completed", "partial"]);

/** The list a request row offers under it: a finished search's own, counted by its contactable leads; null for anything else. */
export function searchListOf(item: Pick<WorkItem, "type" | "kind" | "state" | "audienceId" | "eligible">): { audienceId: string; count: number | null } | null {
  if (item.type !== "job" || NOT_A_SEARCH.has(item.kind) || !item.audienceId || !FINISHED.has(item.state)) return null;
  return { audienceId: item.audienceId, count: item.eligible };
}

/** A request row's counts: a search's found and contactable leads, a plan's leads, contacted, replied and failed. */
export function workCounts(item: Pick<WorkItem, "found" | "eligible" | "counts">): string {
  return [
    item.found !== null ? `${item.found} found` : null,
    item.eligible !== null ? `${item.eligible} contactable` : null,
    item.counts ? `${item.counts.leads} ${item.counts.leads === 1 ? "lead" : "leads"} · ${item.counts.contacted} contacted · ${item.counts.replied} replied${item.counts.failed ? ` · ${item.counts.failed} failed` : ""}` : null,
  ].filter(Boolean).join(" · ");
}

/**
 * The final report's links, as shown. Reports stored before this change
 * link to the chat they are in (which only reloads it); that link is
 * dropped, the lists themselves are shown under the report instead. The
 * Leads link is every saved lead of the workspace, and says so.
 */
export function reportLinks(links: readonly { label: string; href: string }[], threadId: string): { label: string; href: string }[] {
  const self = new Set([`/assistant?thread=${threadId}`, `/assistant?thread=${encodeURIComponent(threadId)}`]);
  return links.flatMap((link) => (self.has(link.href) ? [] : [link.href === "/leads" ? { label: "All saved leads", href: link.href } : link]));
}

type JobLike = { kind: string; audienceId: string | null; result: Record<string, unknown> | null; progress: Record<string, unknown> | null };

const SEARCH_TITLES: Record<string, string> = {
  discovery: "Lead search",
  web_discovery: "Website and directory search",
  linkedin_search: "LinkedIn people search",
  apify_instagram: "Instagram search",
  social_research: "Social research",
};

/** The lists a report names (its data.audienceIds), each with its search's contactable count and source when that search is loaded. */
export function reportAudiences(data: Record<string, unknown> | undefined, jobs: readonly JobLike[]): { audienceId: string; count: number | null; title: string | null }[] {
  const ids = Array.isArray(data?.audienceIds) ? data.audienceIds : [];
  const unique = [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
  return unique.map((audienceId) => {
    const job = jobs.find((candidate) => candidate.audienceId === audienceId && !NOT_A_SEARCH.has(candidate.kind));
    const eligible = job?.result?.eligible;
    const source = job?.progress?.source;
    return {
      audienceId,
      count: typeof eligible === "number" ? eligible : null,
      title: typeof source === "string" && source.trim() ? source : job ? SEARCH_TITLES[job.kind] ?? null : null,
    };
  });
}

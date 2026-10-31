import type { ObjectiveView } from "@/lib/assistant/objective.server";
import type { RequestCheck } from "@/lib/assistant/leadFit";
import { RESEARCH_TOOLS, type ResearchRow } from "./researchView";

export type ProgressMessage = {
  id: string;
  role?: string;
  tool: string | null;
  status: string | null;
  createdAt?: string;
  toolInput?: Record<string, unknown> | null;
  toolResult: { data?: Record<string, unknown> } | null;
};
export const RESEARCH_STAGES = [
  { id: "approach", label: "Approach" },
  { id: "discover", label: "Find" },
  { id: "check", label: "Check fit" },
  { id: "shortlist", label: "Shortlist" },
  { id: "results", label: "Results" },
] as const;
export type ResearchStage = typeof RESEARCH_STAGES[number]["id"];
type Phase = "working" | "waiting" | "paused" | "finished" | "unknown";
export type ProgressObjective = Pick<ObjectiveView, "status" | "request" | "review" | "leadTarget" | "targetNamed" | "leads" | "matching" | "waiting" | "nextEligibleAt" | "stopDetail" | "createdAt" | "stoppedAt">;
export type ResearchProgressModel = {
  stage: ResearchStage;
  phase: Phase;
  title: string;
  action: string;
  goal: string | null;
  approach: string | null;
  visited: ResearchStage[];
  review: { total: number; reviewed: number; uncertain: number; excluded: number; remaining: number } | null;
  target: { matched: number; total: number; named: boolean; newOnly?: boolean } | null;
  latestAt: string | null;
  elapsedMs: number | null;
  nextAt: string | null;
};

const LEAD_TOOLS = new Set(["review_leads", "set_lead_fit"]);
const useful = (message: ProgressMessage) => Boolean(message.tool) && (!message.role || message.role === "tool");
const text = (value: unknown, max = 220) => typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim().slice(0, max) : null;

/** Ordinary browser tasks do not acquire a lead funnel. A research brief is available before its first search. */
export function hasResearchActivity(messages: readonly ProgressMessage[]): boolean {
  const tools = messages.filter(useful);
  return tools.some((message) => RESEARCH_TOOLS.has(message.tool!) || LEAD_TOOLS.has(message.tool!))
    || tools.some((message) => message.tool === "set_brief" && message.status !== "error") && !tools.some((message) => message.tool === "browser_task");
}

function stageOf(message: ProgressMessage, previous: ResearchStage): ResearchStage | null {
  const name = message.tool;
  if (name === "browser_connection" || name === "browser_task" || name === "browser_tab_close") return null;
  if (name === "set_brief") return "approach";
  if (name === "finish_request") return "results";
  if (name === "prepare_outreach" || name === "review_leads" && message.toolInput?.filter === "match") return "shortlist";
  if (name === "review_leads" || name === "set_lead_fit" || name === "check_browser_routes") return "check";
  if (name === "web_search" || name === "exa_search" || name && RESEARCH_TOOLS.has(name)) return "discover";
  if (name === "add_contacts" || name === "add_instagram_contacts" || name === "use_existing_leads") return "discover";
  if (name === "read_webpage" || name === "exa_read" || name?.startsWith("browser_tab_") || name?.startsWith("browser_")) return previous === "check" || previous === "shortlist" ? previous : "discover";
  return null;
}

function host(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try { return new URL(value).hostname.replace(/^www\./, ""); } catch { return null; }
}

function actionOf(message: ProgressMessage): string {
  const input = message.toolInput ?? {};
  const site = host(input.url);
  switch (message.tool) {
    case "set_brief": return "Recording the goal and research approach";
    case "check_setup": return "Checking the available research tools";
    case "set_lead_fit": return "Recording a candidate’s fit and supporting evidence";
    case "review_leads": return input.filter === "match" ? "Reviewing the matching candidates" : "Reviewing saved candidates and their evidence";
    case "prepare_outreach": return "Preparing the selected leads for outreach";
    case "finish_request": return "Preparing the research results";
    case "add_contacts": case "add_instagram_contacts": return "Saving discovered candidates";
    case "use_existing_leads": return "Reading the existing lead list";
    case "web_search": case "exa_search": return ["Searching the web", text(input.query ?? input.keywords, 120)].filter(Boolean).join(" · ");
    case "read_webpage": case "exa_read": return site ? `Reading ${site}` : "Reading a candidate’s source page";
    case "browser_tab_open": return site ? `Opening ${site} in Chrome` : "Opening a source in Chrome";
    case "browser_tab_read": return "Reading the open page in Chrome";
    case "browser_tab_scroll": return "Reading more results in Chrome";
    case "browser_tab_search": return "Searching the open page in Chrome";
    case "browser_tab_click": return "Following a result in Chrome";
    case "check_browser_routes": return "Checking candidates’ browser contact routes";
    default: return "Working on the research";
  }
}

/** A judge's unconfirmed is still unchecked until the assistant inspects it (the server's finish rule). */
export function reviewedCounts(check: RequestCheck | null | undefined): ResearchProgressModel["review"] {
  if (!check) return null;
  const values = [check.leads, check.match, check.noMatch, check.unconfirmed, check.pending, check.unchecked];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0) || check.unchecked > check.leads || check.pending > check.unchecked) return null;
  const reviewed = check.leads - check.unchecked;
  const uncertain = Math.max(0, check.unconfirmed - (check.unchecked - check.pending));
  if (reviewed !== check.match + check.noMatch + uncertain) return null;
  return { total: check.leads, reviewed, uncertain, excluded: check.noMatch, remaining: check.unchecked };
}

/** Presentation of recorded tools and server counts; it does not drive or constrain the agent. */
export function researchProgress(input: {
  messages: readonly ProgressMessage[];
  objective?: ProgressObjective | null;
  rows: readonly ResearchRow[];
  agentActive: boolean;
  statusKnown: boolean;
  now: Date;
}): ResearchProgressModel | null {
  if (!hasResearchActivity(input.messages) && !input.rows.length) return null;
  const tools = input.messages.filter(useful);
  const objective = input.objective;
  let stage: ResearchStage = "approach";
  const visited = new Set<ResearchStage>();
  let approach: string | null = null;
  for (const message of tools) {
    if (message.status === "error") continue;
    const next = stageOf(message, stage);
    if (next) stage = next;
    if (message.status === "ok") {
      if (message.tool === "set_brief") visited.add("approach");
      if (message.tool === "set_lead_fit") visited.add("check");
      if (message.tool === "prepare_outreach" || message.tool === "review_leads" && message.toolInput?.filter === "match" && (objective?.review?.match ?? 0) > 0) visited.add("shortlist");
      if (message.tool === "finish_request") visited.add("results");
    }
    const brief = message.toolResult?.data?.brief as { approach?: unknown } | undefined;
    if (message.tool === "set_brief" && message.status === "ok") approach = text(brief?.approach, 600);
  }
  const running = input.agentActive ? tools.findLast((message) => message.status === "running") : undefined;
  const openRows = input.rows.filter((row) => row.state === "open" || row.state === "starting");
  const openRow = openRows.find((row) => row.state === "starting" || row.phase === "searching" || row.phase === "reading")
    ?? openRows.find((row) => row.phase !== "needs_you") ?? openRows[0];
  const finish = tools.findLast((message) => message.tool === "finish_request" && message.status === "ok");
  const review = reviewedCounts(objective?.review);
  if ((review?.total ?? 0) > 0 || input.rows.some((row) => row.state === "done" && row.stats.some((stat) => stat.label === "Found" && stat.value > 0))) visited.add("discover");
  if ((review?.reviewed ?? 0) > 0) visited.add("check");
  let phase: Phase;
  let title: string;
  let action: string;
  if (!input.statusKnown) {
    phase = "unknown"; title = "Live status unavailable"; action = "Saved progress is shown below. Refresh status to confirm what is running.";
  } else if (objective?.status === "paused") {
    phase = "paused"; title = "Research paused"; action = text(objective.waiting) ?? "Saved candidates and results are kept.";
  } else if (!input.agentActive && !openRow && (objective?.status === "stopped" || finish)) {
    phase = "finished"; stage = "results"; title = "Research results"; action = text(objective?.stopDetail) ?? "Review the matches, uncertainties and exclusions below.";
  } else if (running) {
    phase = "working"; title = ({ approach: "Choosing an approach", discover: "Finding candidates", check: "Checking potential clients", shortlist: "Preparing the shortlist", results: "Preparing results" })[stage]; action = actionOf(running);
  } else if (openRow) {
    stage = openRow.checkingFit ? "check" : "discover";
    phase = openRow.phase === "searching" || openRow.phase === "reading" || openRow.state === "starting" ? "working" : "waiting";
    title = openRow.phase === "needs_you" ? "Research needs your attention" : phase === "waiting" ? openRow.label : openRow.checkingFit ? "Checking potential clients" : "Finding candidates";
    action = [openRow.step ?? openRow.title, openRow.source, openRow.reason].filter(Boolean).join(" · ");
  } else if (input.agentActive) {
    phase = "working"; title = finish ? "Preparing results" : "Researching"; action = finish ? "Preparing the final research summary" : "Working on the next research step";
  } else {
    phase = "waiting"; title = objective?.status === "active" ? "Research continues" : "Saved research"; action = text(objective?.waiting) ?? "Waiting for the next recorded research step.";
  }
  const stamps = tools.map((message) => message.createdAt).filter((at): at is string => Boolean(at) && Number.isFinite(Date.parse(at!)));
  const latestAt = stamps.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
  const start = Date.parse(objective?.createdAt ?? "");
  const end = Date.parse(objective?.stoppedAt ?? "");
  const elapsedMs = Number.isFinite(start) ? Math.max(0, (Number.isFinite(end) ? end : input.now.getTime()) - start) : null;
  const total = objective?.leadTarget;
  return {
    stage, phase, title, action, approach, visited: [...visited], goal: text(objective?.request, 600),
    review,
    target: total && Number.isSafeInteger(total) && total > 0 && Number.isSafeInteger(objective?.leads) && objective!.leads >= 0 ? { matched: objective!.leads, total, named: objective!.targetNamed, ...((objective!.matching ?? objective!.leads) > objective!.leads ? { newOnly: true } : {}) } : null,
    latestAt, elapsedMs, nextAt: objective?.nextEligibleAt ?? openRow?.nextCheckAt ?? null,
  };
}

import { RESEARCH_TOOLS } from "./researchView";

/** Routine steps: a one-line row in Details rather than a card. */
export const COMPACT_TOOLS = new Set([
  "check_setup", "save_business_info", "search_knowledge", "lead_search_status", "list_audiences", "list_runs",
  "list_decisions", "pause_outreach", "resume_outreach", "stop_outreach", "switch_to_review", "answer_decision", "read_webpage", "list_inquiries",
  "set_brief", "review_leads", "set_lead_fit", "finish_request", "control_research", "web_search",
  "browser_open", "browser_read", "browser_click", "browser_fill", "browser_scroll", "browser_close",
  "browser_connection", "browser_tab_open", "browser_tab_read", "browser_tab_click", "browser_tab_scroll", "browser_tab_search", "browser_tab_close",
  "browser_tab_act", "browser_tab_screenshot", "browser_tab_visual", "browser_task", "browser_tab_use", "browser_tab_show", "check_browser_routes",
]);

type ActivityMessage = {
  role: string;
  content?: string;
  tool: string | null;
  status: string | null;
  toolResult: { data?: Record<string, unknown>; suggestions?: unknown[]; display?: string; summary?: string; reportKey?: unknown; transient?: unknown } | null;
};

/** One live card per run. Retries remain in server history, not duplicate Start buttons. */
export function visibleChatMessages<T extends ActivityMessage & {
  content: string;
  toolResult: { data?: Record<string, unknown>; hidden?: boolean; summary?: string; display?: string; suggestions?: unknown[] } | null;
}>(messages: readonly T[]): T[] {
  const lastPlan = new Map<string, T>();
  for (const message of messages) {
    const id = message.toolResult?.data?.runId;
    if (!message.toolResult?.hidden && message.tool === "prepare_outreach" && message.status === "ok" && typeof id === "string") lastPlan.set(id, message);
  }
  return messages.filter((message, index) => {
    if (message.toolResult?.hidden) return false;
    const id = message.toolResult?.data?.runId;
    if (message.tool === "prepare_outreach" && message.status === "ok" && typeof id === "string" && lastPlan.get(id) !== message) return false;
    if (message.role !== "assistant" || message.status === "error" || message.toolResult?.suggestions?.length || message.content.includes("?")) return true;
    const text = message.content.replace(/\s+/g, " ").trim();
    for (let previousIndex = index - 1; previousIndex >= 0; previousIndex--) {
      const previous = messages[previousIndex]!;
      if (previous.role === "user" || previous.role === "assistant") break;
      if (previous.role !== "tool" || previous.status !== "ok") continue;
      if (previousIndex !== index - 1 && !COMPACT_TOOLS.has(previous.tool ?? "")) continue;
      if ([previous.content, previous.toolResult?.display, previous.toolResult?.summary].some((value) => typeof value === "string" && value.replace(/\s+/g, " ").trim() === text)) return false;
    }
    return true;
  });
}

export function activityPresentation(messages: readonly { status: string | null }[], active: boolean, statusKnown = true): { label: string; status: "running" | "ok" | "error" } {
  const running = messages.some(message => message.status === "running");
  if (!running) return { label: "Activity", status: "ok" };
  if (!statusKnown) return { label: "Status unavailable", status: "error" };
  return active ? { label: "Working", status: "running" } : { label: "Step interrupted", status: "error" };
}

/** Tool cards that are the result the owner asked for, or ask them to act: shown in the conversation, never folded away. */
export const RESULT_TOOLS = new Set([
  "prepare_outreach", "prepare_inquiry_replies", "owner_decision", "report", "daily_summary", "diagnose_delivery",
  "import_contacts", "read_document", "add_contacts", "add_instagram_contacts", "use_existing_leads", "describe_audience",
]);

/** Report events whose figures the request card shows in place (a search finished, the research continues, a plan is ready, outreach started). */
const PROGRESS_EVENTS = new Set(["search_report", "plan_ready", "outreach_started", "continuation"]);

function eventKind(toolResult: ActivityMessage["toolResult"]): string | null {
  const event = toolResult?.data?.event;
  return event && typeof event === "object" && typeof (event as { kind?: unknown }).kind === "string" ? (event as { kind: string }).kind : null;
}

/**
 * One owner turn, laid out once: its searches (`research`, shown as rows of
 * one request card that updates in place), what stays in the conversation
 * (`visible`: the last answer, a question, an assistant error, plans,
 * decisions, asked-for reports, the request's final report, notices, and
 * the newest Retry), and everything else, in order, behind the card's
 * Details (`details`: routine tool cards, failed technical steps, the
 * progress reports the card already shows, retry notices and earlier
 * narration). Nothing is dropped: every message lands in exactly one list.
 * `latestId`: the newest message of the whole chat (only it may offer Retry).
 */
export function splitTurn<T extends ActivityMessage & { id: string }>(messages: readonly T[], latestId: string | null): { research: T[]; visible: T[]; details: T[] } {
  const lastAnswer = messages.findLastIndex((message) => message.role === "assistant");
  const research: T[] = [];
  const visible: T[] = [];
  const details: T[] = [];
  messages.forEach((message, index) => {
    const data = message.toolResult?.data;
    if (message.role === "tool") {
      if (RESEARCH_TOOLS.has(message.tool ?? "")) research.push(message);
      else if (RESULT_TOOLS.has(message.tool ?? "") && !(message.tool === "prepare_outreach" && data?.covered === true)) visible.push(message);
      else details.push(message);
      return;
    }
    if (message.role === "assistant") {
      const question = message.content?.includes("?") || Boolean(message.toolResult?.suggestions?.length);
      (index === lastAnswer || question || message.status === "error" ? visible : details).push(message);
      return;
    }
    if (message.role === "event") {
      const result = message.toolResult;
      const finalReport = typeof result?.reportKey === "string" && data && typeof data.objective === "object" && data.objective !== null;
      const progress = PROGRESS_EVENTS.has(eventKind(message.toolResult) ?? "") || (typeof result?.reportKey === "string" && !finalReport);
      const retry = data?.retry === true || result?.transient === true;
      if (finalReport) visible.push(message);
      else if (retry) (data?.retry === true && message.id === latestId ? visible : details).push(message);
      else (progress ? details : visible).push(message);
      return;
    }
    visible.push(message);
  });
  return { research, visible, details };
}

/** Keep the final answer and useful cards visible; routine steps stay in an expandable activity log. */
export const COMPACT_TOOLS = new Set([
  "check_setup", "save_business_info", "search_knowledge", "lead_search_status", "list_audiences", "list_runs",
  "list_decisions", "pause_outreach", "resume_outreach", "stop_outreach", "switch_to_review", "answer_decision", "read_webpage", "list_inquiries",
  "set_brief", "review_leads", "set_lead_fit", "finish_request", "control_research", "web_search",
  "browser_open", "browser_read", "browser_click", "browser_fill", "browser_scroll", "browser_close",
  "browser_connection", "browser_tab_open", "browser_tab_read", "browser_tab_click", "browser_tab_scroll", "browser_tab_search", "browser_tab_close",
  "browser_tab_act", "browser_tab_screenshot", "browser_tab_visual",
]);

type ActivityMessage = {
  role: string;
  content?: string;
  tool: string | null;
  status: string | null;
  toolResult: { data?: Record<string, unknown>; suggestions?: unknown[]; display?: string; summary?: string } | null;
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

export type ChatActivityItem<T> = { kind: "message"; message: T } | { kind: "activity"; messages: T[] };

export function activityPresentation(messages: readonly { status: string | null }[], active: boolean, statusKnown = true): { label: string; status: "running" | "ok" | "error" } {
  const running = messages.some(message => message.status === "running");
  if (!running) return { label: "Activity", status: "ok" };
  if (!statusKnown) return { label: "Status unavailable", status: "error" };
  return active ? { label: "Working", status: "running" } : { label: "Step interrupted", status: "error" };
}

/** Nothing is deleted or rewritten, and errors, decisions, plans and research cards never disappear into the log. */
export function groupChatActivity<T extends ActivityMessage>(messages: readonly T[]): ChatActivityItem<T>[] {
  const lastAnswer = messages.findLastIndex((message) => message.role === "assistant");
  const out: ChatActivityItem<T>[] = [];
  let activity: Extract<ChatActivityItem<T>, { kind: "activity" }> | null = null;
  messages.forEach((message, index) => {
    const question = message.content?.includes("?") || Boolean(message.toolResult?.suggestions?.length);
    const routine = (message.role === "assistant" && index !== lastAnswer && message.status !== "error" && !question)
      || (message.role === "tool" && message.status !== "error" && (COMPACT_TOOLS.has(message.tool ?? "") || (message.tool === "prepare_outreach" && message.toolResult?.data?.covered === true)))
      || (message.role === "event" && message.toolResult?.data?.retry === true && index < messages.length - 1);
    if (routine) {
      if (!activity) { activity = { kind: "activity", messages: [] }; out.push(activity); }
      activity.messages.push(message);
    } else out.push({ kind: "message", message });
  });
  return out;
}

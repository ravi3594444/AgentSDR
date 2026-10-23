/** Keep the final answer and useful cards visible; routine steps stay in an expandable activity log. */
export const COMPACT_TOOLS = new Set([
  "check_setup", "save_business_info", "search_knowledge", "lead_search_status", "list_audiences", "list_runs",
  "list_decisions", "pause_outreach", "resume_outreach", "stop_outreach", "switch_to_review", "answer_decision", "read_webpage", "list_inquiries",
  "set_brief", "review_leads", "set_lead_fit", "finish_request", "control_research", "web_search",
  "browser_open", "browser_read", "browser_click", "browser_fill", "browser_scroll", "browser_close",
]);

type ActivityMessage = {
  role: string;
  tool: string | null;
  status: string | null;
  toolResult: { data?: Record<string, unknown> } | null;
};

export type ChatActivityItem<T> = { kind: "message"; message: T } | { kind: "activity"; messages: T[] };

/** Nothing is deleted or rewritten, and errors, decisions, plans and research cards never disappear into the log. */
export function groupChatActivity<T extends ActivityMessage>(messages: readonly T[]): ChatActivityItem<T>[] {
  const lastAnswer = messages.findLastIndex((message) => message.role === "assistant");
  const out: ChatActivityItem<T>[] = [];
  messages.forEach((message, index) => {
    const routine = (message.role === "assistant" && index !== lastAnswer)
      || (message.role === "tool" && message.status !== "error" && COMPACT_TOOLS.has(message.tool ?? ""))
      || (message.role === "event" && message.toolResult?.data?.retry === true && index < messages.length - 1);
    const previous = out.at(-1);
    if (routine && previous?.kind === "activity") previous.messages.push(message);
    else out.push(routine ? { kind: "activity", messages: [message] } : { kind: "message", message });
  });
  return out;
}

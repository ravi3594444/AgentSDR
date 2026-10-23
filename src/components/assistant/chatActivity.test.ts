import { describe, expect, test } from "bun:test";
import { groupChatActivity } from "./chatActivity";

const row = (id: string, role = "tool", tool: string | null = null, status: string | null = "ok", retry = false) => ({ id, role, tool, status, toolResult: retry ? { data: { retry: true } } : null });

describe("the chat's activity log", () => {
  test("repeated checking narration and routine tools collapse, while the answer stays visible", () => {
    const messages = [row("checking", "assistant"), row("runs", "tool", "list_runs"), row("checking-again", "assistant"), row("decisions", "tool", "list_decisions"), row("answer", "assistant")];
    const items = groupChatActivity(messages);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ kind: "activity", messages: messages.slice(0, 4) });
    expect(items[1]).toEqual({ kind: "message", message: messages[4] });
  });

  test("delivery checks, research, plans, owner decisions and failures remain visible", () => {
    const messages = [row("brief", "tool", "set_brief"), row("search", "tool", "find_leads"), row("plan", "tool", "prepare_outreach"), row("delivery", "tool", "diagnose_delivery"), row("decision", "tool", "owner_decision"), row("failed", "tool", "web_search", "error")];
    const items = groupChatActivity(messages);
    expect(items.filter((item) => item.kind === "message").map((item) => item.message.id)).toEqual(["search", "plan", "delivery", "decision", "failed"]);
    expect(items.flatMap((item) => item.kind === "activity" ? item.messages : [item.message])).toEqual(messages);
  });

  test("only the latest retry failure stays outside the activity log", () => {
    const previous = row("old", "event", null, null, true);
    const latest = row("latest", "event", null, null, true);
    expect(groupChatActivity([previous, latest])).toEqual([{ kind: "activity", messages: [previous] }, { kind: "message", message: latest }]);
  });
});

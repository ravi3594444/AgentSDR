import { describe, expect, test } from "bun:test";
import { activityPresentation, groupChatActivity, visibleChatMessages } from "./chatActivity";

const row = (id: string, role = "tool", tool: string | null = null, status: string | null = "ok", retry = false) => ({ id, role, tool, status, toolResult: retry ? { data: { retry: true } } : null });

describe("the chat's activity log", () => {
  test("an interrupted tool is not live work merely because its stored status says running", () => {
    expect(activityPresentation([{ status: "running" }], false)).toEqual({ label: "Step interrupted", status: "error" });
    expect(activityPresentation([{ status: "running" }], true)).toEqual({ label: "Working", status: "running" });
    expect(activityPresentation([{ status: "ok" }], false)).toEqual({ label: "Activity", status: "ok" });
  });
  test("an unavailable status does not assert work is still running or safely completed", () => {
    expect(activityPresentation([{ status: "running" }], true, false)).toEqual({ label: "Status unavailable", status: "error" });
  });
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

  test("a turn has one activity log even when plan cards separate its steps", () => {
    const messages = [row("brief", "tool", "set_brief"), row("plan", "tool", "prepare_outreach"), row("review", "tool", "review_leads"), row("answer", "assistant")];
    const items = groupChatActivity(messages);
    expect(items.filter((item) => item.kind === "activity")).toEqual([{ kind: "activity", messages: [messages[0], messages[2]] }]);
    expect(items.filter((item) => item.kind === "message").map((item) => item.message.id)).toEqual(["plan", "answer"]);
  });

  test("repeated successful cards for one run have one Start button; failures and different plans stay", () => {
    const plan = (id: string, runId: string, status = "ok") => ({ ...row(id, "tool", "prepare_outreach", status), content: "Plan ready", toolResult: { data: { runId } } });
    const messages = [plan("old", "run-1"), plan("other", "run-2"), plan("failed", "run-1", "error"), plan("latest", "run-1")];
    expect(visibleChatMessages(messages).map((message) => message.id)).toEqual(["other", "failed", "latest"]);
  });

  test("an assistant echo of the preceding brief is removed without hiding a final answer or suggestions", () => {
    const brief = { ...row("brief", "tool", "set_brief"), content: "Brief saved", toolResult: { display: "Noted the request" } };
    const echo = { ...row("echo", "assistant"), content: "Noted the request" };
    const answer = { ...row("answer", "assistant"), content: "Your two plans are ready." };
    expect(visibleChatMessages([brief, echo, answer]).map((message) => message.id)).toEqual(["brief", "answer"]);
    expect(visibleChatMessages([brief, { ...echo, toolResult: { suggestions: ["View plans"] } }])).toHaveLength(2);
  });
  test("a brief echo across routine events is removed without removing tool history", () => {
    const brief = { ...row("brief", "tool", "set_brief"), content: "Brief saved", toolResult: { display: "Noted the request" } };
    const event = { ...row("event", "event", null, null, true), content: "Progress updated" };
    const setup = { ...row("setup", "tool", "check_setup"), content: "Connections checked" };
    const echo = { ...row("echo", "assistant"), content: "Noted  the request" };
    expect(visibleChatMessages([brief, event, setup, echo]).map(message => message.id)).toEqual(["brief", "event", "setup"]);
  });
  test("a new owner turn keeps the same acknowledgement", () => {
    const brief = { ...row("brief", "tool", "set_brief"), content: "Request saved" };
    const user = { ...row("user", "user"), content: "Save it again" };
    const answer = { ...row("answer", "assistant"), content: "Request saved" };
    expect(visibleChatMessages([brief, user, answer])).toHaveLength(3);
  });
  test("questions and assistant errors stay visible before the final answer", () => {
    const question = { ...row("question", "assistant"), content: "Which offer should I mention?" };
    const error = { ...row("error", "assistant", null, "error"), content: "Source unavailable" };
    const answer = { ...row("answer", "assistant"), content: "Ready for review" };
    expect(groupChatActivity([question, error, answer]).map(item => item.kind)).toEqual(["message", "message", "message"]);
  });
  test("a question matching a successful tool is still visible", () => {
    const tool = { ...row("tool", "tool", "check_setup"), content: "Which sender?" };
    const question = { ...row("question", "assistant"), content: "Which sender?" };
    expect(visibleChatMessages([tool, question])).toHaveLength(2);
  });

});

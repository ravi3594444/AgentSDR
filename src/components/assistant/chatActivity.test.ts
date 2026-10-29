import { describe, expect, test } from "bun:test";
import { activityPresentation, splitTurn, visibleChatMessages } from "./chatActivity";

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
  test("repeated checking narration and routine tools go behind Details, while the answer stays visible", () => {
    const messages = [row("checking", "assistant"), row("runs", "tool", "list_runs"), row("checking-again", "assistant"), row("decisions", "tool", "list_decisions"), row("answer", "assistant")];
    const turn = splitTurn(messages, "answer");
    expect(turn.details.map((item) => item.id)).toEqual(["checking", "runs", "checking-again", "decisions"]);
    expect(turn.visible.map((item) => item.id)).toEqual(["answer"]);
    expect(turn.research).toEqual([]);
  });

  test("searches become the request card's rows; plans, delivery checks and decisions stay; a failed technical step goes behind Details", () => {
    const messages = [row("brief", "tool", "set_brief"), row("search", "tool", "find_leads"), row("web", "tool", "find_customers_on_web"), row("plan", "tool", "prepare_outreach"), row("delivery", "tool", "diagnose_delivery"), row("decision", "tool", "owner_decision"), row("failed", "tool", "web_search", "error"), row("exa", "tool", "exa_search")];
    const turn = splitTurn(messages, null);
    expect(turn.research.map((item) => item.id)).toEqual(["search", "web"]);
    expect(turn.visible.map((item) => item.id)).toEqual(["plan", "delivery", "decision"]);
    expect(turn.details.map((item) => item.id)).toEqual(["brief", "failed", "exa"]);
    // Every message lands in exactly one place.
    expect([...turn.research, ...turn.visible, ...turn.details]).toHaveLength(messages.length);
  });

  test("only the newest Retry stays in the conversation; earlier retries and retry notices go behind Details", () => {
    const previous = row("old", "event", null, null, true);
    const latest = row("latest", "event", null, null, true);
    const note = { ...row("note", "event", null, null), toolResult: { transient: true } };
    expect(splitTurn([previous, note, latest], "latest")).toEqual({ research: [], visible: [latest], details: [previous, note] });
    expect(splitTurn([previous, latest], "later-message").visible).toEqual([]);
  });

  test("progress reports update the card in place; the request's final report and other notices stay", () => {
    const report = (id: string, kind: string) => ({ ...row(id, "event", null, null), toolResult: { reportKey: `job:${id}`, data: { event: { kind } } } });
    const continuation = { ...row("round", "event", null, null), toolResult: { data: { event: { kind: "continuation" } } } };
    const final = { ...row("final", "event", null, null), toolResult: { reportKey: "objective:o", data: { objective: { leads: 3 } } } };
    const notice = { ...row("notice", "event", null, null), toolResult: null };
    const turn = splitTurn([report("done", "search_report"), continuation, report("ready", "plan_ready"), notice, final], null);
    expect(turn.details.map((item) => item.id)).toEqual(["done", "round", "ready"]);
    expect(turn.visible.map((item) => item.id)).toEqual(["notice", "final"]);
  });

  test("a turn keeps its plan card and answer visible around the routine steps", () => {
    const messages = [row("brief", "tool", "set_brief"), row("plan", "tool", "prepare_outreach"), row("review", "tool", "review_leads"), row("answer", "assistant")];
    const turn = splitTurn(messages, "answer");
    expect(turn.details.map((item) => item.id)).toEqual(["brief", "review"]);
    expect(turn.visible.map((item) => item.id)).toEqual(["plan", "answer"]);
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
    expect(splitTurn([question, error, answer], "answer").visible.map((item) => item.id)).toEqual(["question", "error", "answer"]);
  });
  test("a question matching a successful tool is still visible", () => {
    const tool = { ...row("tool", "tool", "check_setup"), content: "Which sender?" };
    const question = { ...row("question", "assistant"), content: "Which sender?" };
    expect(visibleChatMessages([tool, question])).toHaveLength(2);
  });

});

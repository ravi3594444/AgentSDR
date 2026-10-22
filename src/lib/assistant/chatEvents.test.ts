import { describe, expect, test } from "bun:test";
import { compactEvent, eventData, reportAsOf } from "./chatEvents";

// P04: a chat report is a snapshot. An early "0 contacted" must read as
// historical: each says when it was written, in the organization's zone, and
// points to where the current counts are.
describe("chat reports say when they were written", () => {
  const createdAt = "2026-10-21T05:48:10.000Z";
  const pointer = "Current counts are in This request, and on the plan card when there is one.";

  test("a run report, a results card, a daily summary and a job's report event carry 'As of' in the organization's zone", () => {
    expect(reportAsOf({ role: "tool", tool: "report", createdAt, toolResult: { data: { channels: [] } } }, "Asia/Kolkata")).toEqual({ label: "As of Wed, Oct 21, 11:18 AM", pointer });
    expect(reportAsOf({ role: "tool", tool: "daily_summary", createdAt, toolResult: { data: { day: "2026-10-20" } } }, "UTC")?.label).toBe("As of Wed, Oct 21, 5:48 AM");
    expect(reportAsOf({ role: "event", tool: null, createdAt, toolResult: { reportKey: "job:abc", data: { event: { kind: "outreach_started" } } } }, "Asia/Kolkata")?.pointer).toBe(pointer);
    expect(reportAsOf({ role: "event", tool: null, createdAt, toolResult: { reportKey: "objective:o1" } }, "Asia/Kolkata")?.label).toBe("As of Wed, Oct 21, 11:18 AM");
  });

  test("anything that is not a report has none: an ordinary event, the owner's words, another tool's card", () => {
    expect(reportAsOf({ role: "event", tool: null, createdAt, toolResult: { data: { retry: true } } }, "UTC")).toBeNull();
    expect(reportAsOf({ role: "user", tool: null, createdAt, toolResult: null }, "UTC")).toBeNull();
    expect(reportAsOf({ role: "tool", tool: "find_leads", createdAt, toolResult: { data: {} } }, "UTC")).toBeNull();
    expect(reportAsOf({ role: "tool", tool: "report", createdAt: "", toolResult: null }, "UTC")).toBeNull();
  });
});

describe("older chats render as they always did", () => {
  test("an event with text only, or other data, has no compact form", () => {
    expect(compactEvent({})).toBeNull();
    expect(compactEvent({ toolResult: null })).toBeNull();
    expect(compactEvent({ toolResult: { reportKey: "job:1" } })).toBeNull();
    expect(compactEvent({ toolResult: { data: { retry: true } } })).toBeNull();
    expect(compactEvent({ toolResult: { objectiveNote: "o:1", objectiveId: "o" } })).toBeNull();
  });

  test("an unknown or malformed event is ignored, not guessed at", () => {
    expect(compactEvent({ toolResult: { data: { event: { kind: "something_new" } } } })).toBeNull();
    expect(compactEvent({ toolResult: { data: { event: "search_report" } } })).toBeNull();
    expect(eventData({ data: { event: [] } })).toBeNull();
  });
});

describe("the compact line for each report", () => {
  test("a search: found, contactable, and the match when it was judged", () => {
    const line = compactEvent({ toolResult: { data: { event: { kind: "search_report", jobId: "j", ok: true, source: "Google Maps", found: 24, contactable: 18, matching: 9, judged: 18 } } } });
    expect(line).toEqual({ title: "Search finished · Google Maps", figures: [{ label: "found", value: "24" }, { label: "contactable", value: "18" }, { label: "match", value: "9 of 18" }], tone: "good", note: null });
    const empty = compactEvent({ toolResult: { data: { event: { kind: "search_report", jobId: "j", ok: true, source: null, found: 3, contactable: 0, matching: null, judged: null } } } });
    expect(empty?.figures).toHaveLength(2);
    expect(empty?.tone).toBe("warning");
    expect(compactEvent({ toolResult: { data: { event: { kind: "search_report", jobId: "j", ok: false, source: "Google Maps", found: 0, contactable: 0, matching: null, judged: null, error: "the provider timed out" } } } })).toMatchObject({ title: "Search failed · Google Maps", tone: "bad", note: "the provider timed out" });
  });

  test("a plan: its leads per channel, largest first, and why it waits", () => {
    const line = compactEvent({ toolResult: { data: { event: { kind: "plan_ready", runId: "r", leads: 12, channels: { email: 4, whatsapp: 8 }, waitingReason: null } } } });
    expect(line?.figures).toEqual([{ label: "leads", value: "12" }, { label: "WhatsApp", value: "8" }, { label: "Email", value: "4" }]);
    expect(line?.note).toBe("Nothing is sent before Start.");
    expect(compactEvent({ toolResult: { data: { event: { kind: "plan_ready", runId: "r", leads: 1, channels: { email: 1 }, waitingReason: "it adds a channel" } } } })?.note).toBe("Not started with the rest: it adds a channel");
  });

  test("outreach started: leads per started channel, and what did not start", () => {
    const line = compactEvent({ toolResult: { data: { event: { kind: "outreach_started", runId: "r", ok: true, automatic: false, launches: [{ channel: "email", added: 10, skipped: 0, problem: null }, { channel: "whatsapp", added: 0, skipped: 0, problem: "no number connected" }] } } } });
    expect(line).toMatchObject({ title: "Outreach started · replies wait in the Inbox", tone: "warning", figures: [{ label: "Email", value: "10" }] });
    expect(line?.note).toBe("WhatsApp not started: no number connected");
  });

  test("outreach started whose emails are not prepared yet: still started, in warning tone, with the launch note", () => {
    const note = "Its emails are not in the sending queue yet (the queue could not be updated just now); it is topped up again within 10 minutes.";
    const line = compactEvent({ toolResult: { data: { event: { kind: "outreach_started", runId: "r", ok: true, automatic: true, launches: [{ channel: "email", added: 4, skipped: 0, problem: null, note }] } } } });
    expect(line).toMatchObject({ title: "Outreach started · Automatic replies", tone: "warning", figures: [{ label: "Email", value: "4" }] });
    expect(line?.note).toBe(`Email: ${note}`);
    const both = compactEvent({ toolResult: { data: { event: { kind: "outreach_started", runId: "r", ok: true, automatic: false, launches: [{ channel: "email", added: 4, skipped: 0, problem: null, note }, { channel: "whatsapp", added: 0, skipped: 2, problem: "no number connected" }] } } } });
    expect(both?.note).toBe(`Email: ${note}; WhatsApp not started: no number connected`);
    // Without a note or a problem it says when messages go out, without sending hours.
    expect(compactEvent({ toolResult: { data: { event: { kind: "outreach_started", runId: "r", ok: true, automatic: false, launches: [{ channel: "email", added: 4, skipped: 0, problem: null }] } } } })).toMatchObject({ tone: "good", note: "Messages go out as each sender's limits and gaps allow." });
  });

  test("the research continuing: leads of target, spend of cap, time left", () => {
    expect(compactEvent({ toolResult: { data: { event: { kind: "continuation", n: 2, leads: 7, target: 20, spentUsd: 1.234, capUsd: 5, minutesLeft: 95.4 } } } })?.figures).toEqual([
      { label: "leads", value: "7 of 20" },
      { label: "spent", value: "$1.23 of $5.00" },
      { label: "left", value: "95 min" },
    ]);
  });
});

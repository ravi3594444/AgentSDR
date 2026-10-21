import { describe, expect, test } from "bun:test";
import { compactEvent, eventData } from "./chatEvents";

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

  test("the research continuing: leads of target, spend of cap, time left", () => {
    expect(compactEvent({ toolResult: { data: { event: { kind: "continuation", n: 2, leads: 7, target: 20, spentUsd: 1.234, capUsd: 5, minutesLeft: 95.4 } } } })?.figures).toEqual([
      { label: "leads", value: "7 of 20" },
      { label: "spent", value: "$1.23 of $5.00" },
      { label: "left", value: "95 min" },
    ]);
  });
});

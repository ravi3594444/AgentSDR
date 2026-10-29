import { describe, expect, test } from "bun:test";
import type { ResearchStatus } from "./messages";
import { accessLine, elapsed, lastLine, nowLine, OFFLINE_AFTER_MS, popupState } from "./popupState";

const NOW = 1_800_000_000_000;

function status(over: Partial<ResearchStatus> = {}): ResearchStatus {
  return {
    connected: true,
    apiBase: "https://app.agentsdr.ai",
    organizationName: "Acme Dental",
    userEmail: "priya@acme.in",
    sites: ["web", "linkedin", "x", "reddit", "instagram", "facebook"],
    domains: [],
    access: "all",
    activity: null,
    lastActivity: null,
    paused: false,
    busy: false,
    openTabs: 0,
    sharedTabs: [],
    attention: null,
    lastContactAt: NOW - 5_000,
    lastError: null,
    ...over,
  };
}

describe("popupState", () => {
  test("connected, stopped, needs you, offline and not connected", () => {
    expect(popupState(status(), NOW).label).toBe("Connected");
    expect(popupState(status({ connected: false }), NOW).label).toBe("Not connected");
    expect(popupState(status({ paused: true, attention: { detail: "Sign in", url: "https://x.com", tabId: 3 } }), NOW).label).toBe("Stopped");
    expect(popupState(status({ attention: { detail: "Sign in", url: "https://x.com", tabId: 3 } }), NOW).label).toBe("Needs you");
    expect(popupState(status({ lastError: "Failed to fetch" }), NOW)).toMatchObject({ label: "Offline", detail: expect.stringContaining("Failed to fetch") });
    expect(popupState(status({ lastContactAt: NOW - OFFLINE_AFTER_MS - 1 }), NOW).label).toBe("Offline");
  });

  test("a running command is not offline even when the app has been quiet", () => {
    expect(popupState(status({ busy: true, lastContactAt: NOW - OFFLINE_AFTER_MS - 1 }), NOW)).toMatchObject({ label: "Connected", detail: "Working in this browser" });
  });

  test("a worker that just started (no contact yet, no error) is connected", () => {
    expect(popupState(status({ lastContactAt: null }), NOW).label).toBe("Connected");
  });
});

describe("accessLine", () => {
  test("all websites, or the selected sites and websites by name", () => {
    expect(accessLine(status())).toBe("All websites");
    expect(accessLine(status({ access: "selected", sites: ["linkedin"], domains: ["acme.com"] }))).toBe("Selected sites: LinkedIn, acme.com");
    expect(accessLine(status({ access: "selected", sites: [], domains: [] }))).toBe("No websites");
  });
});

describe("now and last", () => {
  test("what it does now and since when, the last thing and whether it worked", () => {
    expect(nowLine(status({ activity: { label: "Reading a page", since: NOW - 12_000 }, busy: true }), NOW)).toBe("Reading a page · 12 s");
    expect(nowLine(status(), NOW)).toBe("Nothing right now");
    expect(nowLine(status({ paused: true }), NOW)).toBe("Stopped");
    expect(lastLine(status({ lastActivity: { label: "Opening acme.com", at: NOW - 120_000, ok: true } }), NOW)).toBe("Opening acme.com · worked · 2 min ago");
    expect(lastLine(status({ lastActivity: { label: "Filling in a field", at: NOW - 3_000, ok: false } }), NOW)).toBe("Filling in a field · didn't work · 3 s ago");
    expect(lastLine(status(), NOW)).toBe("Nothing yet");
  });

  test("elapsed time reads as seconds, minutes or hours", () => {
    expect(elapsed(NOW - 59_000, NOW)).toBe("59 s");
    expect(elapsed(NOW - 90 * 60_000, NOW)).toBe("1 h 30 min");
    expect(elapsed(NOW - 120 * 60_000, NOW)).toBe("2 h");
    expect(elapsed(NOW + 5_000, NOW)).toBe("0 s");
  });
});

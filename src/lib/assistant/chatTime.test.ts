import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatChatDate, formatChatDateTime, formatChatTime } from "./chatTime";

// Pilot finding L04: the chat's times are written in one explicit time zone
// (the organization's), so the server and the browser render the same text
// and a reload never changes a message's time.
describe("chat times in an explicit time zone", () => {
  const instant = "2026-10-21T05:48:10.000Z";

  test("the same instant reads in the organization's zone, whatever the process's zone is", () => {
    expect(formatChatTime(instant, "Asia/Kolkata")).toBe("11:18 AM");
    expect(formatChatTime(instant, "UTC")).toBe("5:48 AM");
    expect(formatChatTime(new Date(instant), "America/New_York")).toBe("1:48 AM");
    expect(formatChatDateTime(instant, "Asia/Kolkata")).toBe("Wed, Oct 21, 11:18 AM");
    expect(formatChatDateTime(instant, "UTC")).toBe("Wed, Oct 21, 5:48 AM");
    expect(formatChatDate("2026-10-21T20:30:00.000Z", "Asia/Kolkata")).toBe("Oct 22, 2026");
    expect(formatChatDate("2026-10-21T20:30:00.000Z", "UTC")).toBe("Oct 21, 2026");
  });

  test("an unknown zone falls back to UTC rather than the process's zone, and a bad instant to nothing", () => {
    expect(formatChatTime(instant, "Mars/Olympus")).toBe("5:48 AM");
    expect(formatChatTime("not a date", "UTC")).toBe("");
    expect(formatChatDateTime("", "UTC")).toBe("");
  });
});

describe("the chat formats nothing in the browser's or the server's own zone", () => {
  const source = readFileSync(join(import.meta.dir, "..", "..", "components", "assistant", "AssistantClient.tsx"), "utf8");

  test("AssistantClient.tsx calls no toLocale*() and needs no suppressHydrationWarning for a time", () => {
    expect(source).not.toMatch(/toLocale(?:Time|Date)?String\(/);
    expect(source).not.toContain("suppressHydrationWarning");
    expect(source).toContain("formatChatTime(");
  });
});

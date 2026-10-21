import { describe, expect, test } from "bun:test";

import { describeOpening } from "./sendingWindow";

describe("describeOpening", () => {
  test("the time is said in the given time zone", () => {
    expect(describeOpening(new Date("2026-10-19T03:30:00Z"), "Asia/Kolkata")).toBe("Monday 19 Oct at 09:00");
    expect(describeOpening(new Date("2026-10-19T03:30:00Z"), "UTC")).toBe("Monday 19 Oct at 03:30");
  });
});

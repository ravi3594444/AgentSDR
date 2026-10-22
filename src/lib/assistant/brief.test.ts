import { describe, expect, test } from "bun:test";
import { amountsIn, briefLine, checkBrief, durationsIn, numbersIn, readBrief } from "./brief";

const DEFAULTS = { leadTarget: 25, hours: 4, spendUsd: 5 };
const base = { goal: "Find hair salons in Miami on Instagram and DM them", done: "10 Miami salons found and a DM plan prepared", contact: true };

describe("the owner's numbers", () => {
  test("digits and words", () => {
    expect(numbersIn("Find five salons, then 1,000 more")).toEqual(expect.arrayContaining([5, 1000]));
    expect(amountsIn("keep it under $2, or 10 dollars at most")).toEqual([2, 10]);
    expect(durationsIn("finish in the next hour, or 30 min, or 2 days")).toEqual(expect.arrayContaining([60, 30, 2880]));
  });
});

describe("checkBrief", () => {
  test("a brief within the defaults is taken as written", () => {
    const checked = checkBrief({ ...base, leadTarget: 10, channels: ["instagram"], spendCapUsd: 0, timeLimitMinutes: 60 }, "Find 10 hair salons on Instagram and DM them. Miami. Use only free tools, finish in the next hour.", DEFAULTS);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.brief.channels).toEqual(["instagram"]);
    expect(checked.controls).toEqual({ leadTarget: 10, timeLimitMinutes: 60, spendCapUsd: 0, named: { target: true, time: true, spend: true } });
  });

  test("nothing named: the defaults apply and are marked as defaults", () => {
    const checked = checkBrief({ ...base, leadTarget: null, spendCapUsd: null, timeLimitMinutes: null }, "Find salons", DEFAULTS);
    expect(checked.ok && checked.controls).toEqual({ leadTarget: 25, timeLimitMinutes: 240, spendCapUsd: 5, named: { target: false, time: false, spend: false } });
  });

  test("only money above the default needs the owner's own number", () => {
    expect(checkBrief({ ...base, spendCapUsd: 50 }, "Find salons in Miami", DEFAULTS)).toMatchObject({ ok: false, error: expect.stringContaining("did not allow $50") });
    // The lead target and the time are the model's to set ("all of them", "keep going").
    expect(checkBrief({ ...base, leadTarget: 100 }, "Find salons in Miami", DEFAULTS).ok).toBe(true);
    expect(checkBrief({ ...base, timeLimitMinutes: 600 }, "Find salons in Miami", DEFAULTS).ok).toBe(true);
    // Written by the owner: allowed.
    expect(checkBrief({ ...base, leadTarget: 100, spendCapUsd: 50, timeLimitMinutes: 600 }, "Find 100 salons, spend up to $50, take 10 hours", DEFAULTS).ok).toBe(true);
  });

  test("bad values are refused with what to fix", () => {
    expect(checkBrief({ ...base, goal: "" }, "x", DEFAULTS)).toMatchObject({ ok: false, error: expect.stringContaining("goal is required") });
    // With no done of its own, the request is done when its goal is.
    const noDone = checkBrief({ ...base, done: "" }, "x", DEFAULTS);
    expect(noDone.ok && noDone.brief.done).toBe(noDone.ok ? noDone.brief.goal : false);
    expect(checkBrief({ ...base, leadTarget: 2.5 }, "x", DEFAULTS).ok).toBe(false);
    expect(checkBrief({ ...base, channels: ["fax"] }, "x", DEFAULTS).ok).toBe(false);
    expect(checkBrief({ ...base, contact: "yes" }, "x", DEFAULTS).ok).toBe(false);
  });

  test("a stored brief reads back; a malformed one is null", () => {
    const checked = checkBrief({ ...base, leadTarget: 10, channels: ["instagram"] }, "Find 10", DEFAULTS);
    if (!checked.ok) throw new Error(checked.error);
    expect(readBrief(JSON.parse(JSON.stringify(checked.brief)))).toEqual(checked.brief);
    expect(readBrief({ goal: "x" })).toBeNull();
    expect(briefLine(checked.brief, checked.controls)).toContain("contact them only by instagram");
  });
});

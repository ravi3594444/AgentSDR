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
    expect(checked.ok && checked.controls).toEqual({ leadTarget: 25, timeLimitMinutes: 240, spendCapUsd: null, named: { target: false, time: false, spend: false } });
  });

  test("a model cannot invent a spending restriction when the owner named none", () => {
    for (const spendCapUsd of [0, 1, 50]) {
      const checked = checkBrief({ ...base, spendCapUsd }, "Find successful business owners and DM them asking what costs them the most money", DEFAULTS);
      expect(checked.ok && checked.controls.spendCapUsd).toBeNull();
      expect(checked.ok && checked.brief.spendCapUsd).toBeNull();
      expect(checked.ok && checked.controls.named.spend).toBe(false);
    }
    // The lead target and the time are the model's to set ("all of them", "keep going").
    expect(checkBrief({ ...base, leadTarget: 100 }, "Find salons in Miami", DEFAULTS).ok).toBe(true);
    expect(checkBrief({ ...base, timeLimitMinutes: 600 }, "Find salons in Miami", DEFAULTS).ok).toBe(true);
    // Written by the owner: allowed.
    expect(checkBrief({ ...base, leadTarget: 100, spendCapUsd: 50, timeLimitMinutes: 600 }, "Find 100 salons, spend up to $50, take 10 hours", DEFAULTS).ok).toBe(true);
  });

  test("saved search allowances never become an unnamed request's budget", () => {
    for (const spendUsd of [0, 1, 5]) {
      const checked = checkBrief({ ...base, spendCapUsd: null }, "Find owners and contact them", { ...DEFAULTS, spendUsd });
      expect(checked.ok && checked.controls.spendCapUsd).toBeNull();
      if (checked.ok) expect(briefLine(checked.brief, checked.controls)).not.toMatch(/free sources|paid sources|\$0/);
    }
  });

  test("the owner's explicit free-only or dollar cap still applies when omitted by the model", () => {
    const free = checkBrief({ ...base, spendCapUsd: null }, "Find salons. Use only free tools.", DEFAULTS);
    expect(free.ok && free.controls.spendCapUsd).toBe(0);
    const capped = checkBrief({ ...base, spendCapUsd: null }, "Find salons. Spend up to $3.", DEFAULTS);
    expect(capped.ok && capped.controls.spendCapUsd).toBe(3);
    expect(checkBrief({ ...base, spendCapUsd: 20 }, "Find salons. Use only free tools.", DEFAULTS)).toMatchObject({ ok: false });
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

  test("the assistant's approach survives storage without becoming the owner's goal", () => {
    const goal = "Find established businesses and ask which services cost them the most";
    const approach = "Compare retail owners found on LinkedIn and business directories; change sources if evidence is weak";
    const checked = checkBrief({ goal, contact: true, done: "A plan asking about their largest expenses", approach }, goal, DEFAULTS);
    if (!checked.ok) throw new Error(checked.error);
    expect(checked.brief.goal).toBe(goal);
    expect(checked.brief.approach).toBe(approach);
    expect(checked.brief.done).toBe("A plan asking about their largest expenses");
    expect(readBrief(JSON.parse(JSON.stringify(checked.brief)))).toEqual(checked.brief);
    expect(briefLine(checked.brief, checked.controls)).not.toContain(approach);
    expect(checked.controls.spendCapUsd).toBeNull();
  });

  test("approach is optional for old briefs and validates without changing the goal", () => {
    for (const approach of [undefined, null, "   "]) {
      const checked = checkBrief({ ...base, approach }, "Find salons", DEFAULTS);
      if (!checked.ok) throw new Error(checked.error);
      expect(checked.brief).not.toHaveProperty("approach");
      expect(readBrief(checked.brief)).toEqual(checked.brief);
    }
    expect(checkBrief({ ...base, approach: { city: "Mumbai" } }, "Find businesses", DEFAULTS).ok).toBe(false);
    const checked = checkBrief({ ...base, approach: ` \n ${"x".repeat(900)} ` }, "Find salons", DEFAULTS);
    expect(checked.ok && checked.brief.approach?.length).toBe(600);
  });
});

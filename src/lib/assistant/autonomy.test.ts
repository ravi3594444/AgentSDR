import { describe, expect, test } from "bun:test";
import { autonomousRules, autoStartProblem, searchCapProblem } from "./autonomy";

const caps = { runsPerDay: 10, leadsPerDay: 300, searchesPerDay: 20 };
const ok = { runsToday: 0, leadsToday: 0, planLeads: 40, busyPeople: 0, approverAllowed: true };

describe("starting a plan on its own", () => {
  test("starts within the caps", () => {
    expect(autoStartProblem(ok, caps)).toBeNull();
    expect(autoStartProblem({ ...ok, runsToday: 9, leadsToday: 260 }, caps)).toBeNull();
  });
  test("waits for the owner past a cap, without an approver, or with leads already contacted elsewhere", () => {
    expect(autoStartProblem({ ...ok, runsToday: 10 }, caps)).toContain("cap is 10");
    expect(autoStartProblem({ ...ok, leadsToday: 280 }, caps)).toContain("cap of 300");
    expect(autoStartProblem({ ...ok, approverAllowed: false }, caps)).toContain("only an owner or admin");
    expect(autoStartProblem({ ...ok, busyPeople: 3 }, caps)).toContain("3 of its leads");
    expect(autoStartProblem({ ...ok, planLeads: 0 }, caps)).toContain("no leads");
  });
});

describe("searches", () => {
  test("stop at the daily cap", () => {
    expect(searchCapProblem(19, caps)).toBeNull();
    expect(searchCapProblem(20, caps)).toContain("cap for Autonomous mode (20)");
  });
});

describe("the assistant's instructions", () => {
  test("say the caps and forbid asking permission", () => {
    const rules = autonomousRules(caps).join("\n");
    expect(rules).toContain("up to 10 plans and 300 leads a day");
    expect(rules).toContain("Never end with 'Want me to…?'");
  });
});

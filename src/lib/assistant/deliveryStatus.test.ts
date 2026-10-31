import { expect, test } from "bun:test";
import { needsOutreachReconciliation, savedOutreachProblem } from "./deliveryStatus";

const saved = { plans: [{ id: "saved-plan", state: "running" }], contacted: 1, checkedAt: "2026-10-31T12:00:00.000Z" };

test("a timed-out plan answer is reconciled against the committed plan", () => {
  const message = "I don’t know yet if the outreach plan was created. Both attempts timed out.";
  expect(needsOutreachReconciliation(message)).toBe(true);
  expect(savedOutreachProblem(message, saved)).toContain("saved-plan (running)");
  expect(savedOutreachProblem(message, saved)).toContain("do not recreate");
});

test("a negative sending claim cannot overwrite recorded contact evidence", () => {
  for (const message of ["Nothing has been sent as far as I can see.", "Nothing is confirmed as sent yet.", "No messages were sent."]) {
    expect(needsOutreachReconciliation(message)).toBe(true);
    expect(savedOutreachProblem(message, saved)).toContain("1 people recorded contacted");
  }
});

test("zero evidence permits an honestly unknown outcome", () => {
  expect(savedOutreachProblem("I don't know if the plan was created.", { ...saved, plans: [], contacted: 0 })).toBeNull();
  expect(savedOutreachProblem("Nothing is confirmed as sent yet.", { ...saved, contacted: 0 })).toBeNull();
});

test("saved sending does not prove delivery, a reply, or a candidate's fit", () => {
  for (const message of ["The plan is running; I can't confirm delivery.", "I don't know if the recipient read the message.", "I don't know whether this candidate fits the plan.", "No new plan was created; I reused the running plan."]) {
    expect(savedOutreachProblem(message, saved)).toBeNull();
  }
  expect(needsOutreachReconciliation("The running plan has six leads.")).toBe(false);
});

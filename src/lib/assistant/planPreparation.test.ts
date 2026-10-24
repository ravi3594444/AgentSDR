import { expect, test } from "bun:test";
import { planPreparationKey } from "./planPreparation";

const input = { requestId: "request-1", threadId: "thread-1", assignments: [{ personId: "ig", channel: "instagram" as const }, { personId: "wa", channel: "whatsapp" as const }], autopilot: true };
test("a repeated preparation identifies the same selection regardless of list or row order", () => {
  expect(planPreparationKey(input)).toBe(planPreparationKey({ ...input, assignments: [...input.assignments].reverse() }));
  // Review/Automatic is chosen on the same card; it is not another campaign.
  expect(planPreparationKey(input)).toBe(planPreparationKey({ ...input, autopilot: false }));
});
test("new requests, recipients, routes and explicit writing choices have separate preparations", () => {
  const first = planPreparationKey(input);
  for (const change of [{ requestId: "request-2" }, { threadId: "other-thread" }, { assignments: input.assignments.slice(0, 1) }, { assignments: [{ personId: "ig", channel: "whatsapp" as const }] }, { instructions: "A different offer" }, { basedOnRunId: "other-run" }]) {
    expect(planPreparationKey({ ...input, ...change })).not.toBe(first);
  }
  expect(planPreparationKey({ ...input, requestId: null })).toBeNull();
});

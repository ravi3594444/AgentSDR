import { expect, test } from "bun:test";
import { observationKey } from "./observation";
test("status reads with equivalent arguments share a snapshot; actions never do", () => {
  expect(observationKey("report", { period: "today", runId: "r" })).toBe(
    observationKey("report", { runId: "r", period: "today" }),
  );
  expect(observationKey("report", { period: "today" })).not.toBe(
    observationKey("report", { period: "all_time" }),
  );
  expect(observationKey("diagnose_delivery", {})).not.toBeNull();
  for (const tool of [
    "find_leads",
    "save_business_info",
    "prepare_outreach",
    "resume_outreach",
  ])
    expect(observationKey(tool, {})).toBeNull();
});

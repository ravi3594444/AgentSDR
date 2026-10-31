import { expect, test } from "bun:test";
import { datedLeadFacts } from "./leadFit";

const now = new Date("2026-10-31T12:00:00.000Z");

test("a September post read today remains 48 days old", () => {
  const original = { postedAt: "2026-09-13T12:00:00Z", retrievedAt: now.toISOString(), quote: "Looking for a website builder" };
  const facts = datedLeadFacts(original, now);
  expect(facts.postAgeDays).toBe("48");
  expect(facts.postedAt).toBe(original.postedAt);
  expect(original).not.toHaveProperty("postAgeDays");
});

test("unknown publication dates never use retrieval time as a recent date", () => {
  const facts = datedLeadFacts({ discussion: "https://example.test/post", retrievedAt: now.toISOString() }, now);
  expect(facts.postAgeDays).toBeUndefined();
  expect(facts.postDateStatus).toContain("recency unconfirmed");
});

test("invalid and future publication dates never become zero-day ages", () => {
  for (const postedAt of ["unknown", "2026-11-01T12:00:00Z"]) {
    const facts = datedLeadFacts({ postedAt, postAgeDays: "0" }, now);
    expect(facts.postAgeDays).toBeUndefined();
    expect(facts.postDateCheckedAt).toBe(now.toISOString());
  }
});

test("publication age handles timezone offsets and is recomputed from the record", () => {
  expect(datedLeadFacts({ postedAt: "2026-10-30T17:30:00+05:30", postAgeDays: "0" }, now).postAgeDays).toBe("1");
  expect(datedLeadFacts({ company: "A bakery", website: "bakery.test" }, now)).toEqual({ company: "A bakery", website: "bakery.test" });
});

import assert from "node:assert/strict";
import test from "node:test";
import { classifiedAsWrongNumber, classifiedIntoDoNotContactSubcategory, detectsExplicitDncIntent } from "./handlers";
import { detectsOptOutWording, detectsWrongNumber } from "./wrongNumber";

test("explicit DNC detection matches direct first-person requests", () => {
  assert.equal(detectsExplicitDncIntent("Please unsubscribe me from these emails."), true);
  assert.equal(detectsExplicitDncIntent("Don't contact me again."), true);
  assert.equal(detectsExplicitDncIntent("Stop messaging me"), true);
  assert.equal(detectsExplicitDncIntent("No more calls please"), true);
});

test("explicit DNC detection avoids ordinary negative sales intent", () => {
  assert.equal(detectsExplicitDncIntent("Not interested right now."), false);
  assert.equal(detectsExplicitDncIntent("Please don't stop sending the monthly report."), false);
  assert.equal(detectsExplicitDncIntent("We selected another vendor."), false);
});

// The seeded "Do Not Contact" subcategory has no assigned sequence. Unlike the
// regex-based `detectsExplicitDncIntent` above (which fires on the raw message
// text), this covers the AI classifier independently steering into that same
// subcategory — the case handleClassificationJob must also suppress outreach for.
test("recognizes an applied classification into the seeded Do Not Contact subcategory", () => {
  const subcategories = [
    { id: "sub-dnc", categoryKey: "not_interested", key: "do_not_contact", name: "Do Not Contact", reviewRequired: false },
    { id: "sub-timing", categoryKey: "not_interested", key: "not_required_now", name: "Not Required Right Now", reviewRequired: false },
  ] as const;

  assert.equal(
    classifiedIntoDoNotContactSubcategory({ applied: true, stale: false }, "sub-dnc", subcategories),
    true,
  );
});

test("does not flag a different subcategory, an unapplied result, a stale result, or a missing id", () => {
  const subcategories = [
    { id: "sub-dnc", categoryKey: "not_interested", key: "do_not_contact", name: "Do Not Contact", reviewRequired: false },
    { id: "sub-timing", categoryKey: "not_interested", key: "not_required_now", name: "Not Required Right Now", reviewRequired: false },
  ] as const;

  assert.equal(
    classifiedIntoDoNotContactSubcategory({ applied: true, stale: false }, "sub-timing", subcategories),
    false,
  );
  assert.equal(
    classifiedIntoDoNotContactSubcategory({ applied: false, stale: false }, "sub-dnc", subcategories),
    false,
  );
  assert.equal(
    classifiedIntoDoNotContactSubcategory({ applied: true, stale: true }, "sub-dnc", subcategories),
    false,
  );
  assert.equal(
    classifiedIntoDoNotContactSubcategory({ applied: true, stale: false }, null, subcategories),
    false,
  );
});

test("explicit DNC detection also catches \"wrong number\" beside a stop", () => {
  // classificationContext treats either as an explicit opt-out.
  assert.equal(detectsExplicitDncIntent("Wrong number, stop messaging me"), true);
  assert.equal(detectsWrongNumber("Wrong number. STOP") && detectsOptOutWording("Wrong number. STOP"), true);
  assert.equal(detectsWrongNumber("Wrong number") && detectsOptOutWording("Wrong number"), false);
});

test("a wrong number closes on a current classification into its subcategory, when clear enough", () => {
  const subcategories = [
    { id: "sub-wrong", categoryKey: "other", key: "wrong_number", name: "Wrong Number", reviewRequired: false },
    { id: "sub-other", categoryKey: "other", key: "other", name: "Other", reviewRequired: false },
  ] as const;
  const sure = { confidence: 0.9, wrongNumberWords: false };
  // "Other" is proposed, not applied, by default: still closed when the reading is clear.
  assert.equal(classifiedAsWrongNumber({ applied: false, stale: false }, "sub-wrong", subcategories, sure), true);
  assert.equal(classifiedAsWrongNumber({ applied: false, stale: false }, "sub-wrong", subcategories, { confidence: 0.3, wrongNumberWords: true }), true);
  assert.equal(classifiedAsWrongNumber({ applied: true, stale: false }, "sub-wrong", subcategories, { confidence: 0.3, wrongNumberWords: false }), true);
  // Unsure, stale, or another subcategory: left for a person (and never a sales draft).
  assert.equal(classifiedAsWrongNumber({ applied: false, stale: false }, "sub-wrong", subcategories, { confidence: 0.3, wrongNumberWords: false }), false);
  assert.equal(classifiedAsWrongNumber({ applied: true, stale: true }, "sub-wrong", subcategories, sure), false);
  assert.equal(classifiedAsWrongNumber({ applied: true, stale: false }, "sub-other", subcategories, sure), false);
  assert.equal(classifiedAsWrongNumber({ applied: true, stale: false }, null, subcategories, sure), false);
});

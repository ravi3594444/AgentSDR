import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isDraftEditableStatus } from "./drafts";

describe("which drafts a person may edit", () => {
  it("allows a draft waiting for review and one whose generation failed", () => {
    // The inbox already offers its editor for both; a generation failure is
    // recovered by the person writing the reply themselves.
    assert.equal(isDraftEditableStatus("awaiting_review"), true);
    assert.equal(isDraftEditableStatus("failed"), true);
  });

  it("never makes an uncertain delivery editable back into a send", () => {
    // delivery_uncertain means the reply may already have arrived; it is
    // reconciled from the record page, never edited and resent blind.
    assert.equal(isDraftEditableStatus("delivery_uncertain"), false);
    assert.equal(isDraftEditableStatus("sending"), false);
    assert.equal(isDraftEditableStatus("sent"), false);
    assert.equal(isDraftEditableStatus("generating"), false);
    assert.equal(isDraftEditableStatus("discarded"), false);
    assert.equal(isDraftEditableStatus("stale"), false);
  });
});

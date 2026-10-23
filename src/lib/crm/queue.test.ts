import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  crmJobClaimRenewIntervalMs,
  crmJobIdentity,
  crmJobRetryDelayMs,
  shouldRetryCrmJob,
} from "./queue";

describe("CRM job identity", () => {
  it("maps every allowed kind to its schema-enforced entity type", () => {
    assert.deepEqual(crmJobIdentity("classification", "m-1"), {
      entityType: "message",
      idempotencyKey: "crm:classification:message:m-1",
    });
    assert.deepEqual(crmJobIdentity("initial_draft", "c-1"), {
      entityType: "classification",
      idempotencyKey: "crm:initial_draft:classification:c-1",
    });
    assert.deepEqual(crmJobIdentity("due_followup_draft", "s-1"), {
      entityType: "sequence_step_run",
      idempotencyKey: "crm:due_followup_draft:sequence_step_run:s-1",
    });
  });

  it("rejects an empty entity ID", () => {
    assert.throws(() => crmJobIdentity("classification", "  "), /entity ID is required/);
  });
});

describe("CRM job retry policy", () => {
  it("uses bounded exponential backoff", () => {
    assert.equal(crmJobRetryDelayMs(1), 2_000);
    assert.equal(crmJobRetryDelayMs(2), 4_000);
    assert.equal(crmJobRetryDelayMs(3), 8_000);
    assert.equal(crmJobRetryDelayMs(100), 5 * 60 * 1_000);
  });

  it("stops at max attempts and never retries permanent failures", () => {
    assert.equal(shouldRetryCrmJob({ attempts: 1, maxAttempts: 3 }), true);
    assert.equal(shouldRetryCrmJob({ attempts: 3, maxAttempts: 3 }), false);
    assert.equal(shouldRetryCrmJob({ attempts: 1, maxAttempts: 3 }, true), false);
  });
});

describe("CRM job claim renewal", () => {
  it("renews three times inside the stale window, capped at a minute", () => {
    assert.equal(crmJobClaimRenewIntervalMs(5 * 60 * 1_000), 60_000);
    assert.equal(crmJobClaimRenewIntervalMs(90 * 1_000), 30_000);
    assert.equal(crmJobClaimRenewIntervalMs(30 * 1_000), 10_000);
    assert.equal(crmJobClaimRenewIntervalMs(3_000), 1_000);
  });

  it("stays inside tiny stale windows and survives bad input", () => {
    assert.equal(crmJobClaimRenewIntervalMs(900), 300);
    assert.equal(crmJobClaimRenewIntervalMs(Number.NaN), 60_000);
  });
});


import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PermanentCrmJobError,
  crmWorkerPositiveInteger,
  isTerminalCrmJobError,
  registerCrmJobHandler,
  registerCrmJobHandlers,
  registeredCrmJobKinds,
} from "./worker";

describe("CRM worker handler registry", () => {
  it("registers all three non-sending job kinds and unregisters safely", () => {
    const handler = async () => {};
    const unregister = registerCrmJobHandlers({
      classification: handler,
      initialDraft: handler,
      dueFollowupDraft: handler,
    });
    assert.deepEqual(new Set(registeredCrmJobKinds()), new Set([
      "classification",
      "initial_draft",
      "due_followup_draft",
    ]));
    unregister();
    assert.deepEqual(registeredCrmJobKinds(), []);
  });

  it("does not let an older registration unregister its replacement", () => {
    const unregisterOld = registerCrmJobHandler("classification", async () => {});
    const unregisterNew = registerCrmJobHandler("classification", async () => {});
    unregisterOld();
    assert.deepEqual(registeredCrmJobKinds(), ["classification"]);
    unregisterNew();
    assert.deepEqual(registeredCrmJobKinds(), []);
  });
});

describe("CRM worker terminal failures (RR4)", () => {
  it("fails a rejected API key once, including when the status is on a nested cause", () => {
    const rejected = Object.assign(new Error("Stand-in provider rejected the key"), { status: 401 });
    assert.equal(isTerminalCrmJobError(rejected), true);
    assert.equal(isTerminalCrmJobError(new Error("completion failed", { cause: rejected })), true);
    assert.equal(isTerminalCrmJobError(Object.assign(new Error("forbidden"), { status: 403 })), true);
  });

  it("keeps transient failures retryable and permanent markers terminal", () => {
    for (const status of [408, 409, 425, 429, 500, 503]) {
      assert.equal(isTerminalCrmJobError(Object.assign(new Error("x"), { status })), false, `status ${status}`);
    }
    assert.equal(isTerminalCrmJobError(new Error("plain failure")), false);
    assert.equal(isTerminalCrmJobError(new PermanentCrmJobError("no handler")), true);
    const exhausted = new Error("budget exhausted");
    exhausted.name = "StructuredBudgetExhaustedError";
    assert.equal(isTerminalCrmJobError(exhausted), true);
  });
});

describe("CRM worker configuration", () => {
  it("accepts bounded integers and falls back for invalid values", () => {
    assert.equal(crmWorkerPositiveInteger("8", 4, 1), 8);
    assert.equal(crmWorkerPositiveInteger("8.9", 4, 1), 8);
    assert.equal(crmWorkerPositiveInteger("invalid", 4, 1), 4);
    assert.equal(crmWorkerPositiveInteger("0", 4, 1), 4);
  });
});

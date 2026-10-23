import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPermanentProviderError, providerHttpStatus } from "./providerErrors";

describe("provider error status", () => {
  it("reads the status off the error itself and off statusCode", () => {
    assert.equal(providerHttpStatus(Object.assign(new Error("nope"), { status: 401 })), 401);
    assert.equal(providerHttpStatus(Object.assign(new Error("nope"), { statusCode: 403 })), 403);
    assert.equal(providerHttpStatus(new Error("no status")), undefined);
  });

  it("follows a nested cause chain to the status", () => {
    const inner = Object.assign(new Error("Stand-in provider rejected the key"), { status: 401 });
    const wrapped = new Error("classification failed after 3 attempts", { cause: inner });
    const doublyWrapped = new Error("job handler failed", { cause: wrapped });
    assert.equal(providerHttpStatus(doublyWrapped), 401);
    assert.equal(isPermanentProviderError(doublyWrapped), true);
  });

  it("treats auth and configuration rejections as permanent, transient statuses as not", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      assert.equal(isPermanentProviderError(Object.assign(new Error("x"), { status })), true, `status ${status}`);
    }
    for (const status of [408, 409, 425, 429, 500, 502, 503]) {
      assert.equal(isPermanentProviderError(Object.assign(new Error("x"), { status })), false, `status ${status}`);
    }
    assert.equal(isPermanentProviderError(new Error("plain failure")), false);
  });
});

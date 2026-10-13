import { describe, expect, test } from "bun:test";
import { watchRegistration } from "./watchRegistration";

describe("watchRegistration", () => {
  test("every mailbox watched is registered", () => {
    expect(watchRegistration([{ emailAddress: "a@x.com", ok: true }])).toMatchObject({ status: "registered", registered: 1, attempted: 1 });
  });

  test("some failures are partial and name the mailbox and error", () => {
    const result = watchRegistration([{ emailAddress: "a@x.com", ok: true }, { emailAddress: "b@x.com", ok: false, error: "Topic not found" }]);
    expect(result).toMatchObject({ status: "partial", registered: 1, attempted: 2, message: "b@x.com: Topic not found" });
  });

  test("all failed, nothing to watch, or skipped with a reason", () => {
    expect(watchRegistration([{ emailAddress: "a@x.com", ok: false, error: "403" }]).status).toBe("failed");
    expect(watchRegistration([])).toMatchObject({ status: "skipped", message: "No connected mailbox to watch." });
    expect(watchRegistration([], "No Gmail Pub/Sub topic is set.")).toMatchObject({ status: "skipped", message: "No Gmail Pub/Sub topic is set." });
  });
});

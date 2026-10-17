import { describe, expect, test } from "bun:test";
import { WhatsappApiError, WhatsappSendRefusedError, type WhatsappSendRefusalReason } from "../errors";
import { PlatformNotConnectedError } from "@/lib/platform/credentials";
import {
  classifySendError,
  planAfterSend,
  planTransientRetry,
  sequenceExhausted,
  uncertainDeliveryMessage,
  withinCampaignSendingHours,
} from "./engineRules";

const steps = [
  { id: "a", body: "hi", delayHours: 0 },
  { id: "b", body: "again", delayHours: 48 },
  { id: "c", body: "last", delayHours: 24 },
];
const refused = (reason: WhatsappSendRefusalReason | null, status: 400 | 409 | 429 = 409) =>
  new WhatsappSendRefusedError("x", status, null, reason);

describe("planAfterSend", () => {
  const at = new Date("2026-01-01T10:00:00Z");
  test("schedules the next step after its own delay", () => {
    expect(planAfterSend(steps, 0, at)).toEqual({ status: "in_sequence", nextSendAt: new Date("2026-01-03T10:00:00Z") });
    expect(planAfterSend(steps, 1, at)).toEqual({ status: "in_sequence", nextSendAt: new Date("2026-01-02T10:00:00Z") });
  });
  test("completes after the last step", () => {
    expect(planAfterSend(steps, 2, at)).toEqual({ status: "completed", nextSendAt: null });
  });
});

test("sequenceExhausted when steps were removed", () => {
  expect(sequenceExhausted(steps, 2)).toBe(false);
  expect(sequenceExhausted(steps, 3)).toBe(true);
  expect(sequenceExhausted([], 0)).toBe(true);
});

describe("classifySendError", () => {
  test("gap and rate limit stop the account", () => {
    expect(classifySendError(refused("send_gap", 429))).toEqual({ kind: "stop_account" });
    expect(classifySendError(refused("rate_limited", 429))).toEqual({ kind: "stop_account" });
  });
  test("new-chat limit and warm-up block first messages", () => {
    expect(classifySendError(refused("new_chat_limit"))).toEqual({ kind: "block_first_messages" });
    expect(classifySendError(refused("warm_up"))).toEqual({ kind: "block_first_messages" });
  });
  test("a disconnected number is skipped", () => {
    expect(classifySendError(refused("not_connected"))).toEqual({ kind: "skip_account" });
  });
  test("Do Not Contact stops the lead", () => {
    expect(classifySendError(refused("do_not_contact"))).toEqual({ kind: "stop_lead", error: "Do Not Contact" });
  });
  test("a recipient refusal fails the lead without guessing registration", () => {
    const action = classifySendError(refused("recipient_unreachable", 400));
    expect(action.kind).toBe("fail_lead");
    expect(action.kind === "fail_lead" && action.error).toContain("registration was not confirmed");
  });
  test("definite 400s fail the lead with the message", () => {
    for (const reason of ["rejected", "invalid_number", "no_phone", "empty", "too_long"] as const) {
      expect(classifySendError(refused(reason, 400))).toEqual({ kind: "fail_lead", error: "x" });
    }
  });
  test("an unclassified refusal waits instead of failing a 409", () => {
    expect(classifySendError(refused(null, 409))).toEqual({ kind: "stop_account" });
  });
  test("platform not connected stops the organization", () => {
    expect(classifySendError(new PlatformNotConnectedError("unipile"))).toEqual({ kind: "stop_organization" });
  });
  test("API and network errors retry later", () => {
    expect(classifySendError(new WhatsappApiError(502, "down"))).toEqual({ kind: "retry_later" });
    expect(classifySendError(new Error("ECONNRESET"))).toEqual({ kind: "retry_later" });
  });
});

describe("planTransientRetry", () => {
  const now = new Date("2026-01-01T10:00:00Z");
  test("backs off 10 minutes for the first two failures", () => {
    expect(planTransientRetry(0, now)).toEqual({ status: "retry", attempts: 1, nextSendAt: new Date("2026-01-01T10:10:00Z") });
    expect(planTransientRetry(1, now).status).toBe("retry");
  });
  test("fails at the third", () => {
    expect(planTransientRetry(2, now)).toEqual({ status: "failed", attempts: 3 });
  });
});

test("uncertainDeliveryMessage numbers the message from 1", () => {
  expect(uncertainDeliveryMessage(0)).toContain("message 1 is uncertain");
});

describe("withinCampaignSendingHours", () => {
  const hours = { timezone: "UTC", days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" };
  test("no hours means any time", () => {
    expect(withinCampaignSendingHours(null, new Date("2026-01-04T03:00:00Z"))).toBe(true);
  });
  test("inside and outside the window", () => {
    expect(withinCampaignSendingHours(hours, new Date("2026-01-05T10:00:00Z"))).toBe(true); // Monday
    expect(withinCampaignSendingHours(hours, new Date("2026-01-05T18:00:00Z"))).toBe(false);
    expect(withinCampaignSendingHours(hours, new Date("2026-01-04T10:00:00Z"))).toBe(false); // Sunday
  });
});

import { describe, expect, test } from "bun:test";
import { newChatRefusal, secondsUntilNextSend, warmUpEndsAt, whatsappGuardrails } from "./guardrails";
import { defaultValues } from "@/lib/channels/rules";

const NOW = new Date("2026-09-30T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DEFAULTS = { warmUpHours: 24, newChatsPerDay: 25, minSecondsBetweenSends: 30 };

describe("whatsappGuardrails", () => {
  const RULES = defaultValues("whatsapp");

  test("the default rules reproduce the old constants", () => {
    expect(whatsappGuardrails(RULES)).toEqual(DEFAULTS);
  });

  test("the organization's rules are used", () => {
    expect(whatsappGuardrails({ warmupHours: 0, newChatsPerDay: 40, secondsBetweenSends: 30 }))
      .toEqual({ warmUpHours: 0, newChatsPerDay: 40, minSecondsBetweenSends: 30 });
  });

  test("a number's own new-chats limit wins; null follows the organization", () => {
    expect(whatsappGuardrails(RULES, { newChatsPerDay: 8 }).newChatsPerDay).toBe(8);
    expect(whatsappGuardrails(RULES, { newChatsPerDay: null }).newChatsPerDay).toBe(25);
  });
});

describe("warmUpEndsAt", () => {
  test("is connectedAt + the warm-up while it lasts, then null", () => {
    expect(warmUpEndsAt(new Date(NOW.getTime() - 2 * HOUR), NOW, 24)).toEqual(new Date(NOW.getTime() + 22 * HOUR));
    expect(warmUpEndsAt(new Date(NOW.getTime() - 24 * HOUR), NOW, 24)).toBeNull();
    expect(warmUpEndsAt(null, NOW, 24)).toBeNull();
    expect(warmUpEndsAt(NOW, NOW, 0)).toBeNull();
  });
});

describe("secondsUntilNextSend", () => {
  test("counts whole seconds up from the last send", () => {
    expect(secondsUntilNextSend(null, NOW, 10)).toBe(0);
    expect(secondsUntilNextSend(new Date(NOW.getTime() - 3_500), NOW, 10)).toBe(7);
    expect(secondsUntilNextSend(new Date(NOW.getTime() - 10_000), NOW, 10)).toBe(0);
    expect(secondsUntilNextSend(new Date(NOW.getTime() - 1), NOW, 10)).toBe(10);
    expect(secondsUntilNextSend(NOW, NOW, 0)).toBe(0);
  });
});

describe("newChatRefusal", () => {
  const linkedLongAgo = new Date(NOW.getTime() - 72 * HOUR);

  test("allows a new chat past the warm-up and under the cap", () => {
    expect(newChatRefusal({ connectedAt: linkedLongAgo, newChatsInWindow: 24, now: NOW, guardrails: DEFAULTS })).toBeNull();
  });

  test("refuses during the warm-up, naming when it ends", () => {
    const refusal = newChatRefusal({ connectedAt: new Date(NOW.getTime() - HOUR), newChatsInWindow: 0, now: NOW, guardrails: DEFAULTS });
    expect(refusal).toContain("2026-10-01T09:00:00.000Z");
  });

  test("refuses at the daily cap", () => {
    expect(newChatRefusal({ connectedAt: linkedLongAgo, newChatsInWindow: 25, now: NOW, guardrails: DEFAULTS })).toContain("daily limit (25)");
  });

  test("refuses an account never seen connected, unless the warm-up is off", () => {
    expect(newChatRefusal({ connectedAt: null, newChatsInWindow: 0, now: NOW, guardrails: DEFAULTS })).toContain("not been seen connected");
    expect(newChatRefusal({ connectedAt: null, newChatsInWindow: 0, now: NOW, guardrails: { ...DEFAULTS, warmUpHours: 0 } })).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import { CHANNEL_RULES, CHANNELS, defaultValues, pickInRange, resolveValues, ruleError, ruleWarning, rulesOf, validateValues } from "./rules";

describe("registry", () => {
  test("every default is valid and inside its own bounds", () => {
    for (const channel of CHANNELS) {
      for (const rule of rulesOf(channel)) {
        expect(ruleError(rule, rule.default)).toBeNull();
        expect(ruleWarning(rule, rule.default)).toBeNull();
      }
    }
  });
  test("keys are unique within a channel", () => {
    for (const channel of CHANNELS) {
      const keys = rulesOf(channel).map((r) => r.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
  test("defaults reproduce today's hardcoded behaviour", () => {
    expect(defaultValues("email")).toMatchObject({ dailySendLimit: 30, sendGapMinutes: [18, 24] });
    expect(defaultValues("linkedin")).toMatchObject({
      invitesPerDayPremium: 30, invitesPerDayFree: 5, invitesPerRun: [3, 4], inviteDelaySeconds: [30, 60],
      runGapMinutes: [30, 60], followUpsPerRun: [3, 6], profileLookupsPerRun: [4, 8], searchLeadsPerDay: 400,
    });
    expect(defaultValues("whatsapp")).toEqual({ sendingHours: null, warmupHours: 24, newChatsPerDay: 25, secondsBetweenSends: 10 });
    // Accounts without their own hours send at any time today.
    expect(defaultValues("linkedin").workingHours).toBeNull();
  });
});

describe("validation", () => {
  const limit = CHANNEL_RULES.linkedin.find((r) => r.key === "invitesPerDayPremium")!;
  const gap = CHANNEL_RULES.email.find((r) => r.key === "sendGapMinutes")!;
  const hours = CHANNEL_RULES.email.find((r) => r.key === "sendingHours")!;
  const country = CHANNEL_RULES.general.find((rule) => rule.key === "defaultPhoneCountry")!;

  test("hard ceilings refuse a typo", () => {
    expect(ruleError(limit, 3000)).toContain("between 1 and 100");
    expect(ruleError(limit, 0)).not.toBeNull();
    expect(ruleError(limit, 12.5)).toContain("whole number");
    expect(ruleError(limit, "30")).not.toBeNull();
  });
  test("ranges must be ordered and bounded", () => {
    expect(ruleError(gap, [10, 20])).toBeNull();
    expect(ruleError(gap, [30, 20])).toContain("lowest value");
    expect(ruleError(gap, [0, 20])).not.toBeNull();
    expect(ruleError(gap, [5])).not.toBeNull();
  });
  test("warnings appear beyond the safe edge but values still save", () => {
    expect(ruleWarning(limit, 30)).toBeNull();
    expect(ruleWarning(limit, 45)).toContain("LinkedIn restricts");
    expect(ruleError(limit, 45)).toBeNull();
    expect(ruleWarning(gap, [5, 8])).toContain("10 minutes");
  });
  test("hours: time zone, days and times", () => {
    expect(ruleError(hours, { timezone: "Europe/London", days: [1], start: "08:30", end: "17:00" })).toBeNull();
    expect(ruleError(hours, { timezone: "Mars/Base", days: [1], start: "08:30", end: "17:00" })).toContain("time zone");
    expect(ruleError(hours, { timezone: "UTC", days: [], start: "08:30", end: "17:00" })).toContain("at least one day");
    expect(ruleError(hours, { timezone: "UTC", days: [1], start: "9", end: "17:00" })).toContain("09:00");
    expect(ruleError(hours, { timezone: "UTC", days: [1], start: "18:00", end: "09:00" })).toContain("after the start");
  });
  test("optional hours accept null (any time); required hours do not", () => {
    const linkedinHours = CHANNEL_RULES.linkedin.find((r) => r.key === "workingHours")!;
    expect(ruleError(linkedinHours, null)).toBeNull();
    expect(ruleError(hours, null)).not.toBeNull();
    expect(validateValues("linkedin", { workingHours: null })).toEqual({ ok: true, values: { workingHours: null } });
  });
  test("country: empty or two capital letters", () => {
    expect(ruleError(country, "")).toBeNull();
    expect(ruleError(country, "IN")).toBeNull();
    expect(ruleError(country, "in")).not.toBeNull();
    expect(ruleError(country, "IND")).not.toBeNull();
  });
  test("validateValues refuses unknown keys and returns clean values", () => {
    expect(validateValues("email", { nope: 1 })).toEqual({ ok: false, error: "Unknown setting: nope" });
    expect(validateValues("email", { dailySendLimit: 500 }).ok).toBe(false);
    const ok = validateValues("email", { sendingHours: { timezone: "UTC", days: [5, 1, 1, 3], start: "09:00", end: "17:00" } });
    expect(ok).toEqual({ ok: true, values: { sendingHours: { timezone: "UTC", days: [1, 3, 5], start: "09:00", end: "17:00" } } });
  });
});

describe("resolveValues", () => {
  test("stored values override defaults; invalid or unknown ones fall back", () => {
    const resolved = resolveValues("whatsapp", { newChatsPerDay: 40, secondsBetweenSends: 1, legacy: true });
    expect(resolved).toEqual({ sendingHours: null, warmupHours: 24, newChatsPerDay: 40, secondsBetweenSends: 10 });
  });
  test("nothing stored means today's defaults", () => {
    expect(resolveValues("email", null)).toEqual(defaultValues("email"));
  });
});

test("pickInRange stays inside the range", () => {
  for (let i = 0; i < 200; i++) {
    const n = pickInRange([3, 6]);
    expect(n >= 3 && n <= 6 && Number.isInteger(n)).toBe(true);
  }
  expect(pickInRange([5, 5])).toBe(5);
});

test("WhatsApp's contract constants (shown by the recorder and the website, kept import-free) match the rule defaults", async () => {
  const contract = await import("@/lib/whatsapp/contract");
  expect(defaultValues("whatsapp")).toEqual({
    sendingHours: null,
    warmupHours: contract.WHATSAPP_NEW_CHAT_WARMUP_HOURS,
    newChatsPerDay: contract.WHATSAPP_NEW_CHATS_PER_DAY,
    secondsBetweenSends: contract.WHATSAPP_MIN_SECONDS_BETWEEN_SENDS,
  });
});

describe("organization day (general.timeZone, general.dayStartsAt)", () => {
  test("defaults to UTC midnight", () => {
    expect(defaultValues("general")).toEqual({ timeZone: "UTC", dayStartsAt: "00:00", defaultPhoneCountry: "", autonomousRunsPerDay: 10, autonomousLeadsPerDay: 300, autonomousSearchesPerDay: 20 });
  });

  test("validates the zone and the time", () => {
    expect(validateValues("general", { timeZone: "Asia/Kolkata", dayStartsAt: "05:30" })).toEqual({ ok: true, values: { timeZone: "Asia/Kolkata", dayStartsAt: "05:30" } });
    expect(validateValues("general", { timeZone: "Mars/Olympus" }).ok).toBe(false);
    expect(validateValues("general", { timeZone: "" }).ok).toBe(false);
    expect(validateValues("general", { dayStartsAt: "24:00" }).ok).toBe(false);
    expect(validateValues("general", { dayStartsAt: "7:00" }).ok).toBe(false);
  });

  test("stores and reads legacy zone names under their current IANA name", () => {
    expect(validateValues("general", { timeZone: "Asia/Calcutta" })).toEqual({ ok: true, values: { timeZone: "Asia/Kolkata" } });
    expect(resolveValues("general", { timeZone: "Europe/Kiev" }).timeZone).toBe("Europe/Kyiv");
    expect(resolveValues("general", { timeZone: "Nowhere/Land", dayStartsAt: "nope" })).toMatchObject({ timeZone: "UTC", dayStartsAt: "00:00" });
  });
});

describe("Autonomous mode caps (general)", () => {
  test("bounded: a typo cannot let the assistant start thousands of plans", () => {
    expect(validateValues("general", { autonomousRunsPerDay: 500 }).ok).toBe(false);
    expect(validateValues("general", { autonomousLeadsPerDay: 5 }).ok).toBe(false);
    expect(validateValues("general", { autonomousSearchesPerDay: 30 })).toEqual({ ok: true, values: { autonomousSearchesPerDay: 30 } });
  });
});

import { describe, expect, test } from "bun:test";
import { CHANNEL_RULES, CHANNELS, defaultValues, GENERAL_RULE_PAGES, mergeStoredRules, pickInRange, resolveValues, RETIRED_RULE_KEYS, ruleError, ruleSubmission, rulesSubset, ruleWarning, rulesOf, validateValues } from "./rules";

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
    expect(defaultValues("email")).toEqual({ dailySendLimit: 30, secondsBetweenSends: 30 });
    expect(defaultValues("linkedin")).toEqual({
      invitesPerDayPremium: 30, invitesPerDayFree: 5, invitesPerRun: [3, 4], inviteDelaySeconds: [30, 60],
      runGapMinutes: [30, 60], followUpsPerRun: [3, 6], profileLookupsPerRun: [4, 8], searchLeadsPerDay: 400,
    });
    expect(defaultValues("whatsapp")).toEqual({ warmupHours: 0, newChatsPerDay: 25, secondsBetweenSends: 30 });
    expect(defaultValues("instagram")).toEqual({ newChatsPerDay: 10, secondsBetweenSends: 30 });
  });
});

describe("sending is always on: no channel has sending hours", () => {
  const hours = { timezone: "Asia/Kolkata", days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" };

  test("no rule is a time window, on any channel", () => {
    for (const channel of CHANNELS) {
      expect(rulesOf(channel).map((rule) => rule.kind as string)).not.toContain("hours");
      for (const key of ["sendingHours", "workingHours"]) expect(rulesOf(channel).map((rule) => rule.key)).not.toContain(key);
    }
  });

  test("a save that still names sending hours is refused, saying why", () => {
    for (const [channel, key] of [["email", "sendingHours"], ["linkedin", "workingHours"], ["whatsapp", "sendingHours"], ["instagram", "sendingHours"]] as const) {
      for (const value of [hours, null]) {
        const result = validateValues(channel, { [key]: value });
        expect(result.ok).toBe(false);
        expect(result.ok ? "" : result.error).toContain("always on");
      }
    }
    expect(RETIRED_RULE_KEYS).toEqual({ email: ["sendingHours", "sendGapMinutes"], linkedin: ["workingHours"], whatsapp: ["sendingHours"], instagram: ["sendingHours", "sendGapMinutes"], general: [] });
  });

  test("stored hours are ignored when read and dropped by the next save", () => {
    expect(resolveValues("email", { sendingHours: hours, dailySendLimit: 40 })).toEqual({ dailySendLimit: 40, secondsBetweenSends: 30 });
    expect(mergeStoredRules("email", { sendingHours: hours, dailySendLimit: 40 }, { secondsBetweenSends: 60 })).toEqual({ dailySendLimit: 40, secondsBetweenSends: 60 });
    expect(mergeStoredRules("linkedin", { workingHours: hours }, {})).toEqual({});
    // A key this version does not know (a later release's) is kept, so a rolling deploy cannot erase it.
    expect(mergeStoredRules("whatsapp", { sendingHours: hours, fromTheFuture: 1 }, {})).toEqual({ fromTheFuture: 1 });
  });
});

describe("validation", () => {
  const limit = CHANNEL_RULES.linkedin.find((r) => r.key === "invitesPerDayPremium")!;
  const gap = CHANNEL_RULES.linkedin.find((r) => r.key === "inviteDelaySeconds")!;
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
    expect(ruleWarning(gap, [5, 8])).toContain("20 seconds");
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
    expect(validateValues("email", { dailySendLimit: 40, secondsBetweenSends: 30 })).toEqual({ ok: true, values: { dailySendLimit: 40, secondsBetweenSends: 30 } });
  });
});

describe("resolveValues", () => {
  test("stored values override defaults; invalid or unknown ones fall back", () => {
    const resolved = resolveValues("whatsapp", { newChatsPerDay: 40, secondsBetweenSends: 1, legacy: true });
    expect(resolved).toEqual({ warmupHours: 0, newChatsPerDay: 40, secondsBetweenSends: 30 });
  });
  test("nothing stored means today's defaults", () => {
    expect(resolveValues("email", null)).toEqual(defaultValues("email"));
  });
});

describe("30-second sender pacing", () => {
  test("all three channels use seconds and ignore old minute-based settings", () => {
    for (const channel of ["email", "whatsapp", "instagram"] as const) {
      expect(defaultValues(channel).secondsBetweenSends).toBe(30);
      expect(validateValues(channel, { secondsBetweenSends: 30 }).ok).toBe(true);
      expect(validateValues(channel, { secondsBetweenSends: 0 }).ok).toBe(false);
    }
    for (const channel of ["email", "instagram"] as const) {
      expect(resolveValues(channel, { sendGapMinutes: [18, 24] }).secondsBetweenSends).toBe(30);
      expect(validateValues(channel, { sendGapMinutes: [18, 24] }).ok).toBe(false);
      expect(mergeStoredRules(channel, { sendGapMinutes: [18, 24] }, {})).toEqual({});
    }
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
    warmupHours: contract.WHATSAPP_NEW_CHAT_WARMUP_HOURS,
    newChatsPerDay: contract.WHATSAPP_NEW_CHATS_PER_DAY,
    secondsBetweenSends: contract.WHATSAPP_MIN_SECONDS_BETWEEN_SENDS,
  });
});

describe("organization day (general.timeZone, general.dayStartsAt)", () => {
  test("defaults to UTC midnight", () => {
    expect(defaultValues("general")).toEqual({ timeZone: "UTC", dayStartsAt: "00:00", defaultPhoneCountry: "", newLeadsPerDay: 200, autonomousRunsPerDay: 10, autonomousLeadsPerDay: 300, autonomousSearchesPerDay: 20, objectiveLeadTarget: 25, objectiveHours: 4, objectiveSpendUsd: 5 });
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

describe("the daily lead limit (general.newLeadsPerDay)", () => {
  const rule = CHANNEL_RULES.general.find((r) => r.key === "newLeadsPerDay")!;

  test("one workspace-wide number: 50 by default, 1 to 1,000, a warning above 200", () => {
    expect(rule).toMatchObject({ kind: "number", label: "Maximum new leads to contact per day", default: 200, min: 1, max: 1000, safe: { above: 200 } });
    expect(ruleError(rule, 0)).toContain("between 1 and 1000");
    expect(ruleError(rule, 1001)).not.toBeNull();
    expect(ruleWarning(rule, 200)).toBeNull();
    expect(ruleWarning(rule, 201)).not.toBeNull();
  });

  test("its help says who counts, once, and what does not count", () => {
    expect(rule.help).toContain("email, LinkedIn, WhatsApp and Instagram together");
    expect(rule.help).toContain("counts once");
    expect(rule.help).toContain("Follow-ups, replies and messages you send yourself do not count");
  });
});

describe("Autonomous mode caps (general)", () => {
  test("bounded: a typo cannot let the assistant start thousands of plans", () => {
    expect(validateValues("general", { autonomousRunsPerDay: 500 }).ok).toBe(false);
    expect(validateValues("general", { autonomousLeadsPerDay: 5 }).ok).toBe(false);
    expect(validateValues("general", { autonomousSearchesPerDay: 30 })).toEqual({ ok: true, values: { autonomousSearchesPerDay: 30 } });
  });
});

describe("a request's research defaults (general)", () => {
  test("a lead target, a time limit and a spend cap, each bounded; 0 spend keeps requests on free sources", () => {
    expect(validateValues("general", { objectiveLeadTarget: 0 }).ok).toBe(false);
    expect(validateValues("general", { objectiveHours: 100 }).ok).toBe(false);
    expect(validateValues("general", { objectiveSpendUsd: 2.5 }).ok).toBe(false);
    expect(validateValues("general", { objectiveLeadTarget: 50, objectiveHours: 2, objectiveSpendUsd: 0 })).toEqual({ ok: true, values: { objectiveLeadTarget: 50, objectiveHours: 2, objectiveSpendUsd: 0 } });
  });
});

describe("the general rules across settings pages", () => {
  test("Sending shows only the daily lead limit; the day and phone country are on Your business; the Autonomous caps are hidden", () => {
    expect(GENERAL_RULE_PAGES.sending).toEqual(["newLeadsPerDay"]);
    expect(GENERAL_RULE_PAGES.business).toEqual(["timeZone", "dayStartsAt", "defaultPhoneCountry"]);
    expect(GENERAL_RULE_PAGES.research).toEqual(["objectiveLeadTarget", "objectiveHours"]);
    expect(GENERAL_RULE_PAGES.hidden).toEqual(["autonomousRunsPerDay", "autonomousLeadsPerDay", "autonomousSearchesPerDay", "objectiveSpendUsd"]);
  });

  test("every general rule is on exactly one page or hidden, in registry order", () => {
    const placed: string[] = [...GENERAL_RULE_PAGES.sending, ...GENERAL_RULE_PAGES.business, ...GENERAL_RULE_PAGES.research, ...GENERAL_RULE_PAGES.hidden];
    expect([...placed].sort()).toEqual(rulesOf("general").map((rule) => rule.key).sort());
    expect(new Set(placed).size).toBe(placed.length);
    expect(rulesSubset("general", GENERAL_RULE_PAGES.business).map((rule) => rule.key)).toEqual(["timeZone", "dayStartsAt", "defaultPhoneCountry"]);
    expect(rulesSubset("email")).toBe(rulesOf("email"));
    expect(() => rulesSubset("general", ["dailySendLimit"])).toThrow("No general rule dailySendLimit");
  });

  test("a page sends only the rules it shows", () => {
    const all = { ...defaultValues("general"), objectiveLeadTarget: 80, timeZone: "Asia/Kolkata", newLeadsPerDay: 20 };
    expect(ruleSubmission(rulesSubset("general", GENERAL_RULE_PAGES.sending), all)).toEqual({ newLeadsPerDay: 20 });
    expect(ruleSubmission(rulesSubset("general", GENERAL_RULE_PAGES.business), all)).toEqual({ timeZone: "Asia/Kolkata", dayStartsAt: "00:00", defaultPhoneCountry: "" });
  });

  test("saving one page's rules keeps what the other pages stored, the hidden caps included", () => {
    const stored = { objectiveLeadTarget: 80, timeZone: "Asia/Kolkata", autonomousRunsPerDay: 4 };
    // Your business saved with the time zone back at its default: dropped from the row; the research target and the hidden cap untouched.
    expect(mergeStoredRules("general", stored, { timeZone: "UTC" })).toEqual({ objectiveLeadTarget: 80, autonomousRunsPerDay: 4 });
    expect(mergeStoredRules("general", stored, { newLeadsPerDay: 20 })).toEqual({ ...stored, newLeadsPerDay: 20 });
    expect(mergeStoredRules("general", stored, {})).toEqual(stored);
  });
});

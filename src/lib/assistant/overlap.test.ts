import { describe, expect, test } from "bun:test";
import { estimateDays, leftOutSentence, noNewLeadsReason, OVERLAP_REASON, planChannels, planWithoutPeople, personalizeCalls } from "./overlap";
import type { OutreachPlan } from "./schema";

const ids = (count: number, prefix = "p") => Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`);

/** A sorted plan as prepareOutreach writes it: 45 LinkedIn leads in two groups, one written to alone. */
function linkedinPlan(): OutreachPlan {
  const people = ids(45);
  return {
    assignments: people.map((personId) => ({ personId, channel: "linkedin" as const })),
    sequences: { linkedin: [{ subject: null, body: "{{p_x_1_body}}", waitDays: 0 }] },
    personalizationKey: "p_x",
    samples: [
      { personId: "p1", name: "Lead 1", channel: "linkedin", groupId: "g1", approach: "standard", messages: [{ subject: null, body: "Hi 1" }] },
      { personId: "p30", name: "Lead 30", channel: "linkedin", groupId: "g2", approach: "standard", messages: [{ subject: null, body: "Hi 30" }] },
      { personId: "p2", name: "Lead 2", channel: "linkedin", groupId: "g1", approach: "personal", messages: [{ subject: null, body: "Just for 2" }] },
    ],
    limits: { maxLeads: 100, emailPerMailboxPerDay: null, whatsappNewChatsPerDay: null },
    excluded: [{ reason: "no LinkedIn profile", count: 4 }],
    // 5 personalization calls (44 standard leads) at $0.002, plus $0.03 already spent writing.
    estimate: { aiCalls: 5, aiCostUsd: 0.04, days: 3, perCallUsd: 0.002 },
    autopilot: true,
    instructions: null,
    requestId: "msg-1",
    groups: [
      { id: "g1", label: "Clinics", count: 29, sequences: {} },
      { id: "g2", label: "Hospitals", count: 16, sequences: {} },
    ],
    leadPlans: Object.fromEntries(people.map((personId, index) => [personId, { groupId: index < 29 ? "g1" : "g2", approach: personId === "p2" ? "personal" as const : "standard" as const, reason: "" }])),
    personal: [{ personId: "p2", name: "Lead 2", channel: "linkedin", groupId: "g1", subject: null, body: "Just for 2", reason: "asked about pricing" }],
    skipped: [{ personId: "p99", name: "Lead 99", reason: "not a fit" }],
  };
}

describe("planWithoutPeople", () => {
  test("a 45-lead plan with 2 already covered keeps the other 43, consistently", () => {
    const plan = linkedinPlan();
    const narrowed = planWithoutPeople(plan, ["p1", "p2"], { perDay: { linkedin: 20 } });
    expect(narrowed.assignments).toHaveLength(43);
    expect(narrowed.assignments.some((assignment) => assignment.personId === "p1" || assignment.personId === "p2")).toBe(false);
    // Samples, single-lead messages and lead plans lose the two; the rest is untouched.
    expect(narrowed.samples.map((sample) => sample.personId)).toEqual(["p30"]);
    expect(narrowed.personal).toEqual([]);
    expect(narrowed.leadPlans?.p1).toBeUndefined();
    expect(narrowed.leadPlans?.p3).toEqual(plan.leadPlans!.p3);
    expect(narrowed.skipped).toEqual(plan.skipped);
    // Groups count who is left; the left-out reasons count them.
    expect(narrowed.groups?.map((group) => [group.id, group.count])).toEqual([["g1", 27], ["g2", 16]]);
    expect(narrowed.excluded).toEqual([{ reason: "no LinkedIn profile", count: 4 }, { reason: OVERLAP_REASON, count: 2 }]);
    // 43 standard leads: still 5 calls, so the cost is unchanged; 43 at 20 a day is 3 days.
    expect(narrowed.estimate).toEqual({ aiCalls: 5, aiCostUsd: 0.04, days: 3, perCallUsd: 0.002 });
    // Everything else stays as approved.
    expect(narrowed.requestId).toBe("msg-1");
    expect(narrowed.sequences).toEqual(plan.sequences);
    expect(narrowed.autopilot).toBe(true);
  });

  test("the estimate follows who is left: fewer calls cost less, fewer leads take fewer days", () => {
    const narrowed = planWithoutPeople(linkedinPlan(), ids(25), { perDay: { linkedin: 10 } });
    // 20 left, all standard: 2 calls instead of 5, so 3 calls × $0.002 less; 20 at 10 a day is 2 days.
    expect(narrowed.estimate).toEqual({ aiCalls: 2, aiCostUsd: 0.034, days: 2, perCallUsd: 0.002 });
    expect(personalizeCalls(narrowed)).toBe(2);
  });

  test("without the cost of one call or the sends a day, the figures stay as upper bounds", () => {
    const plan = { ...linkedinPlan(), estimate: { aiCalls: 5, aiCostUsd: 0.04, days: 3 } };
    const narrowed = planWithoutPeople(plan, ids(25));
    expect(narrowed.estimate).toEqual({ aiCalls: 2, aiCostUsd: 0.04, days: 3 });
  });

  test("a group left empty is dropped; the same reason accumulates", () => {
    const once = planWithoutPeople(linkedinPlan(), ids(16).map((_, index) => `p${index + 30}`));
    expect(once.groups?.map((group) => group.id)).toEqual(["g1"]);
    const twice = planWithoutPeople(once, ["p3"]);
    expect(twice.excluded.find((item) => item.reason === OVERLAP_REASON)?.count).toBe(17);
    const other = planWithoutPeople(twice, ["p4"], { reason: "marked Do Not Contact" });
    expect(other.excluded.at(-1)).toEqual({ reason: "marked Do Not Contact", count: 1 });
  });

  test("people not in the plan are ignored, and a plan none of them is in is returned as it was", () => {
    const plan = linkedinPlan();
    expect(planWithoutPeople(plan, ["someone-else"])).toBe(plan);
    expect(planWithoutPeople(plan, [])).toBe(plan);
    expect(planWithoutPeople(plan, ["p1", "someone-else"]).excluded.at(-1)).toEqual({ reason: OVERLAP_REASON, count: 1 });
  });

  test("an older plan without groups or lead plans loses the people the same way", () => {
    const plan: OutreachPlan = {
      assignments: [{ personId: "a", channel: "email" }, { personId: "b", channel: "whatsapp" }],
      sequences: { email: [], whatsapp: [] },
      personalizationKey: "p_y",
      samples: [{ personId: "b", name: "B", channel: "whatsapp", messages: [] }],
      limits: { maxLeads: 10, emailPerMailboxPerDay: 30, whatsappNewChatsPerDay: 25 },
      excluded: [],
      estimate: { aiCalls: 1, aiCostUsd: null, days: 2 },
      autopilot: false,
      instructions: null,
    };
    const narrowed = planWithoutPeople(plan, ["b"], { perDay: { email: 30, whatsapp: 25 } });
    expect(narrowed.assignments).toEqual([{ personId: "a", channel: "email" }]);
    expect(narrowed.samples).toEqual([]);
    expect(narrowed.groups).toBeUndefined();
    expect(narrowed.leadPlans).toBeUndefined();
    // WhatsApp's extra day goes with its last lead.
    expect(narrowed.estimate).toEqual({ aiCalls: 1, aiCostUsd: null, days: 1 });
    expect(planChannels(narrowed, ["email", "whatsapp"])).toEqual(["email"]);
  });
});

describe("estimateDays", () => {
  test("the slowest channel decides; WhatsApp waits a day first; unknown sends a day give null", () => {
    const assignments = [...ids(41).map((personId) => ({ personId, channel: "email" as const })), { personId: "w", channel: "whatsapp" as const }];
    expect(estimateDays(assignments, { email: 20, whatsapp: 25 })).toBe(3);
    expect(estimateDays(assignments, { email: 50, whatsapp: 25 })).toBe(2);
    expect(estimateDays(assignments, { email: 50 })).toBeNull();
    expect(estimateDays([], { email: 50 })).toBeNull();
  });
});

describe("what the chat is told", () => {
  test("who was left out, and why", () => {
    expect(leftOutSentence({ covered: 2, blocked: [] })).toBe("Left out of this plan: 2 leads are already in other running plans and stay there.");
    expect(leftOutSentence({ covered: 1, blocked: [{ reason: "marked Do Not Contact", count: 1 }] })).toBe("Left out of this plan: 1 lead is already in another running plan and stays there; 1 marked Do Not Contact.");
    expect(leftOutSentence({ covered: 0, blocked: [] })).toBeNull();
  });

  test("a plan with nobody new says so honestly, instead of asking for a Start", () => {
    expect(noNewLeadsReason(45, { covered: 45, blocked: [] })).toBe("no new leads to contact: all 45 are already in other running plans");
    expect(noNewLeadsReason(1, { covered: 1, blocked: [] })).toBe("no new leads to contact: its only lead is already in another running plan");
    expect(noNewLeadsReason(3, { covered: 2, blocked: [{ reason: "opted out", count: 1 }] })).toBe("no new leads to contact: of its 3, 2 already in other running plans, 1 opted out");
  });
});

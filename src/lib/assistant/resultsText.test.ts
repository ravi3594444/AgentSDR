import { describe, expect, test } from "bun:test";

import { localDate, ORGANIZATION_SCOPE, periodFor, scopeIsEmpty, scopeLabel, type ResultsScope } from "./results";
import { resultsText, type Results } from "./results.server";

const closed = { open: false, blockedBy: "nothing_queued" as const, nextOpenAt: null, nextOpenLabel: null, hours: null, queued: 0 };

/** Results with nothing recorded, in `scope`; `patch` fills in what a case needs. */
function results(scope: ResultsScope, patch: Partial<Results> = {}): Results {
  return {
    period: periodFor("today", "Asia/Kolkata", new Date("2026-10-18T20:00:00Z")),
    scope: { kind: scope.kind, label: scopeLabel(scope), runs: scope.runIds.length, jobs: scope.jobIds.length, empty: scopeIsEmpty(scope) },
    leads: { discovered: 0, imported: 0, duplicates: 0, usable: 0, leftOut: 0, leftOutReasons: [], bySource: [] },
    outreach: { peopleContacted: 0, emailsSent: 0, whatsappSent: 0, instagramSent: 0, linkedinInvitations: 0, linkedinMessages: 0, repliesReceived: 0, peopleReplied: 0, interested: 0, automaticReplies: 0, repliesByYou: 0 },
    interestedPeople: [],
    attention: { repliesWaiting: 0, openDecisions: 0, byKind: [], heldByAutopilot: [], plansAwaitingStart: 0, plansAwaiting: [] },
    pending: { emailFollowUps: 0, whatsappFollowUps: 0, linkedinSteps: 0, instagramDms: 0 },
    sending: { email: closed, whatsapp: closed },
    stopped: { optedOut: 0, suppressed: [], runLeadsStopped: 0 },
    failures: [],
    spending: { aiRecordedUsd: 0, aiCalls: 0, aiCallsWithoutCost: 0, byKind: [], researchUsd: 0, dataSources: "" },
    limits: { automaticRepliesLeft24h: 30, emailsLeftToday: null, researchLeftToday: null, whatsappNewChatsLeftToday: null },
    runs: [],
    ...patch,
  };
}

const request: ResultsScope = { kind: "request", runIds: ["r1", "r2"], audienceIds: ["a1"], jobIds: ["j1", "j2", "j3"] };

describe("the day and the scope a report covers", () => {
  test("today is the organization's own day, not UTC's", () => {
    // 20:00 UTC on the 18th is already the 19th in Kolkata (UTC+5:30).
    expect(localDate("Asia/Kolkata", new Date("2026-10-18T20:00:00Z"))).toBe("2026-10-19");
    expect(localDate("UTC", new Date("2026-10-18T20:00:00Z"))).toBe("2026-10-18");
  });

  test("the scope is named in words", () => {
    expect(scopeLabel(ORGANIZATION_SCOPE)).toBe("the whole organization");
    expect(scopeLabel(request)).toBe("this request (2 plans, 3 background jobs)");
    expect(scopeLabel({ kind: "thread", runIds: ["r1"], audienceIds: [], jobIds: [] })).toBe("this chat (1 plan)");
    expect(scopeLabel({ kind: "run", name: "Dentists — Pune", runIds: ["r1"], audienceIds: ["a1"], jobIds: [] })).toBe("the plan “Dentists — Pune”");
  });
});

describe("resultsText", () => {
  test("a request's report says it covers that request only, and that limits are organization-wide", () => {
    const text = resultsText(results(request));
    expect(text.split("\n")[0]).toBe("Results for today (2026-10-19) (Asia/Kolkata), this request (2 plans, 3 background jobs) only:");
    expect(text).toContain("Limits left (organization-wide):");
    expect(text).toContain("AI spending recorded against these plans:");
    expect(resultsText(results(ORGANIZATION_SCOPE)).split("\n")[0]).toBe("Results for today (2026-10-19) (Asia/Kolkata):");
  });

  test("a request with nothing attributed to it says so instead of reporting quiet zeros", () => {
    const text = resultsText(results({ kind: "request", runIds: [], audienceIds: [], jobIds: [] }));
    expect(text).toContain("Nothing is recorded for this request yet: no search or plan of it is saved");
  });

  test("plans waiting for Start are shown apart from reply decisions, never hidden", () => {
    const text = resultsText(results(ORGANIZATION_SCOPE, {
      attention: { repliesWaiting: 1, openDecisions: 2, byKind: [{ kind: "missing_info", count: 2 }], heldByAutopilot: [], plansAwaitingStart: 7, plansAwaiting: [{ id: "a", name: "Dentists — Pune" }, { id: "b", name: "Gyms — Pune" }] },
    }));
    expect(text).toContain("Waiting for you: 1 replies to review, 2 reply decisions (2 missing info); separately, 7 plans waiting for your Start (“Dentists — Pune”, “Gyms — Pune”, …).");
    expect(resultsText(results(ORGANIZATION_SCOPE))).toContain("0 reply decisions; separately, 0 plans waiting for your Start.");
  });

  test("a running plan with nothing recorded sent is not reported as sending", () => {
    const text = resultsText(results(request, {
      runs: [
        { id: "r1", name: "LinkedIn — dentists", status: "running", mode: "Automatic", channels: [] },
        { id: "r2", name: "Email — gyms", status: "running", mode: "Review", channels: [{ channel: "email", contacted: 4, messagesSent: 5, replied: 1, stopped: 0 }] },
      ],
    }));
    expect(text).toContain("Plans started: “LinkedIn — dentists” running, Automatic replies (no campaign launched yet, nothing sent); “Email — gyms” running, Review replies (so far email 4 contacted, 5 sent, 1 replied).");
    expect(text).toContain("0 emails, 0 WhatsApp messages, 0 LinkedIn connection requests");
  });
});

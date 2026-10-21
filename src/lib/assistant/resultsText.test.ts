import { describe, expect, test } from "bun:test";

import { assemblePeriodMetrics, summarizeLeadSources, windowJson, type CurrentCounts } from "@/lib/reporting/metrics";
import { localDate, ORGANIZATION_SCOPE, periodFor, scopeIsEmpty, scopeLabel, type ResultsScope } from "./results";
import { resultsText, type Results } from "./results.server";

const closed = { open: false, blockedBy: "nothing_queued" as const, queued: 0 };

const nothingNow: CurrentCounts = {
  at: "2026-10-18T20:00:00.000Z",
  needsYou: 0,
  openDecisions: 0,
  decisionsByKind: [],
  draftsAwaitingReview: 0,
  actionRequired: 0,
  followUpsDue: 0,
  plansAwaitingStart: 0,
  plansAwaiting: [],
  stillToSend: { email: 0, whatsapp: 0, linkedin: 0, instagram: 0 },
};

/** Results with nothing recorded, in `scope`; `patch` fills in what a case needs. */
function results(scope: ResultsScope, patch: Partial<Results> = {}): Results {
  const period = periodFor("today", "Asia/Kolkata", new Date("2026-10-18T20:00:00Z"));
  return {
    period,
    window: windowJson(period),
    scope: { kind: scope.kind, label: scopeLabel(scope), runs: scope.runIds.length, jobs: scope.jobIds.length, empty: scopeIsEmpty(scope) },
    metrics: assemblePeriodMetrics([]),
    now: nothingNow,
    leads: { found: 0, qualified: 0, contactable: 0, discovered: 0, imported: 0, duplicates: 0, leftOut: 0, leftOutReasons: [], sources: summarizeLeadSources({ combinations: [], unsaved: [] }) },
    outreach: { peopleContacted: 0, emailsSent: 0, whatsappSent: 0, whatsappDelivered: 0, whatsappRead: 0, instagramSent: 0, linkedinInvitations: 0, linkedinMessages: 0, repliesReceived: 0, peopleReplied: 0, contactedWhoReplied: 0, replyRate: null, interested: 0, automaticReplies: 0, repliesByYou: 0 },
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

  test("plans waiting for Start are shown apart from reply decisions, never hidden, and labelled as now", () => {
    const text = resultsText(results(ORGANIZATION_SCOPE, {
      now: { ...nothingNow, needsYou: 2, openDecisions: 2 },
      attention: { repliesWaiting: 1, openDecisions: 2, byKind: [{ kind: "missing_info", count: 2 }], heldByAutopilot: [], plansAwaitingStart: 7, plansAwaiting: [{ id: "a", name: "Dentists — Pune" }, { id: "b", name: "Gyms — Pune" }] },
    }));
    expect(text).toContain("Waiting for you now: 1 replies to review, 2 reply decisions (2 missing info); separately, 7 plans waiting for your Start (“Dentists — Pune”, “Gyms — Pune”, …).");
    expect(resultsText(results(ORGANIZATION_SCOPE))).toContain("0 reply decisions; separately, 0 plans waiting for your Start.");
    expect(text).toContain("Still to send now:");
  });

  test("interested and opt-out reports are decisions, but not ones needing you", () => {
    const text = resultsText(results(ORGANIZATION_SCOPE, {
      now: { ...nothingNow, needsYou: 1, openDecisions: 3 },
      attention: { repliesWaiting: 0, openDecisions: 3, byKind: [{ kind: "interested", count: 2 }, { kind: "missing_info", count: 1 }], heldByAutopilot: [], plansAwaitingStart: 0, plansAwaiting: [] },
    }));
    expect(text).toContain("3 reply decisions (2 interested, 1 missing info), 1 of them needing you (the rest are reports)");
  });

  test("the reply rate is contacted people who replied over people contacted", () => {
    const base = results(ORGANIZATION_SCOPE);
    const text = resultsText({ ...base, outreach: { ...base.outreach, peopleContacted: 8, repliesReceived: 5, peopleReplied: 3, contactedWhoReplied: 2, replyRate: 0.25 } });
    expect(text).toContain("Replies: 5 received from 3 people; 2 of the 8 people contacted replied (reply rate 25%)");
    expect(resultsText(base)).toContain("(reply rate not measured)");
  });

  test("WhatsApp receipts are reported for WhatsApp only", () => {
    const base = results(ORGANIZATION_SCOPE);
    const text = resultsText({ ...base, outreach: { ...base.outreach, whatsappSent: 4, whatsappDelivered: 3, whatsappRead: 1 } });
    expect(text).toContain("WhatsApp reported 3 of them delivered and 1 read; other channels report no receipts.");
    expect(resultsText(base)).not.toContain("WhatsApp reported");
  });

  test("lead sources read source through provider, each person counted once", () => {
    const base = results(ORGANIZATION_SCOPE);
    const sources = summarizeLeadSources({
      combinations: [
        { sources: ["google_maps:scraper"], people: 2, contactable: 1 },
        { sources: ["apify_instagram:apify", "google_maps:scraper"], people: 1, contactable: 1 },
      ],
      unsaved: [],
    });
    const text = resultsText({ ...base, leads: { ...base.leads, found: 3, qualified: 3, contactable: 2, sources } });
    expect(text).toContain("Leads: 3 found, 3 qualified, 2 contactable (each person counted once)");
    expect(text).toContain("Sources: Google Maps through the built-in scraper 3 qualified, 2 contactable; Instagram through Apify 1 qualified, 1 contactable; 1 person found by more than one source, counted once.");
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

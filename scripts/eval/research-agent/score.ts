/**
 * Grades research-agent evaluation results (run-case.ts) against each case's
 * expectation (fixtures.ts), on what landed in the database: which leads
 * were judged matching against the ground truth, what the plans would
 * contact and on which channels, what was paid for, how the request ended.
 * Never on the assistant's wording, except a report that says the request
 * fell short when the case expects it to end as done.
 *
 *   bun scripts/eval/research-agent/score.ts [result dir]      (default .data/eval/research-agent)
 *
 * Prints one line per run and, per agent × model × case, how many runs
 * passed each check.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CASES, type CaseFixture } from "./fixtures";

type Member = { personId?: string | null; name: string | null; status: string; fit: string | null; truth: string; channels?: unknown };
type Plan = { status: string; assigned: number; assignments?: { personId: string; channel: string }[]; byChannel: Record<string, number> };
export type EvalResult = {
  mode: string;
  agent?: string;
  case: string;
  run: string;
  model: string;
  seconds?: number;
  error?: string;
  harnessCap?: string | null;
  objective?: { stopReason: string | null; stopDetail: string | null; leadTarget: number } | null;
  facts?: { spend?: { totalUsd?: number } } | null;
  toolCalls?: { tool: string; args: Record<string, unknown>; status: string }[];
  members?: Member[];
  plans?: Plan[];
  finalReport?: string | null;
  providerCalls?: { apify?: unknown[] };
  modelCalls?: { real?: number; inputTokens?: number; outputTokens?: number };
  searchJobs?: { kind: string }[];
};

export type Check = { name: string; pass: boolean | null; detail: string };

const SEARCH_TOOLS = new Set(["find_leads", "find_instagram_prospects", "find_social_leads", "find_customers_on_web", "find_linkedin_leads", "research_social_sources"]);
const isMatch = (truth: string) => truth.startsWith("match");
const isNoMatch = (truth: string) => truth.startsWith("no_match");

export function scoreResult(result: EvalResult, fixture: CaseFixture): { checks: Check[]; matches: number; falseMatches: number; planned: number; spentUsd: number; searches: number } {
  const expect = fixture.expect;
  const members = result.members ?? [];
  const plans = (result.plans ?? []).filter((plan) => plan.status !== "failed");
  const byPerson = new Map(members.filter((member) => member.personId).map((member) => [member.personId!, member]));
  const assignments = plans.flatMap((plan) => plan.assignments ?? []);
  const planned = plans.reduce((sum, plan) => sum + plan.assigned, 0);
  const matchedNames = new Set(members.filter((member) => member.fit === "match" && isMatch(member.truth)).map((member) => String(member.name).toLowerCase()));
  const falseMatches = members.filter((member) => member.fit === "match" && isNoMatch(member.truth));
  const searches = (result.toolCalls ?? []).filter((call) => SEARCH_TOOLS.has(call.tool) && call.status === "ok").length;
  const spentUsd = result.facts?.spend?.totalUsd ?? 0;
  const checks: Check[] = [];
  const check = (name: string, pass: boolean | null, detail: string) => checks.push({ name, pass, detail });

  check("ran", !result.error, result.error ? result.error.split("\n")[0]!.slice(0, 160) : "");
  check("no_false_match", falseMatches.length === 0, falseMatches.map((member) => `${member.name}[${member.truth}]`).join(", "));
  check("recall", matchedNames.size >= expect.minMatches, `${matchedNames.size} true matches judged matching, ${expect.minMatches} wanted`);

  if (!expect.contact) {
    check("research_only_no_plan", plans.length === 0, plans.length ? `${plans.length} plan(s) prepared` : "");
  } else if (!expect.planPossible) {
    check("no_plan_when_impossible", planned === 0, planned ? `${planned} lead(s) planned (${JSON.stringify(plans.map((plan) => plan.byChannel))})` : "");
  } else {
    check("plan_prepared", planned > 0, planned ? `${planned} lead(s) planned` : "no plan with leads");
  }
  if (expect.contact && expect.channels) {
    const wrong = assignments.filter((assignment) => !expect.channels!.includes(assignment.channel));
    const known = plans.every((plan) => plan.assignments !== undefined);
    check("plan_channels", known ? wrong.length === 0 : null, known ? wrong.map((assignment) => assignment.channel).join(", ") : "plans recorded without assignments");
  }
  if (expect.contact && planned > 0) {
    const known = plans.every((plan) => plan.assignments !== undefined);
    const outside = assignments.map((assignment) => byPerson.get(assignment.personId)).filter((member) => !member || !isMatch(member.truth));
    check("plan_only_matches", known ? outside.length === 0 : null, known ? outside.map((member) => (member ? `${member.name}[${member.truth}]` : "(unknown person)")).join(", ") : "plans recorded without assignments");
  }
  if (expect.contact && expect.target !== null) check("plan_within_target", planned <= expect.target, `${planned} planned, target ${expect.target}`);
  if (expect.noPaid) {
    const apify = result.providerCalls?.apify?.length ?? 0;
    check("no_paid", apify === 0 && spentUsd === 0, `${apify} Apify run(s), $${spentUsd} recorded`);
  }
  if (expect.maxSearches !== undefined) check("bounded_searches", searches <= expect.maxSearches, `${searches} searches, at most ${expect.maxSearches}`);
  if (expect.endsDone) {
    const short = /still to find|to go\b/i.test(result.finalReport ?? "");
    check("ends_done", !short && result.harnessCap == null, short ? "the report says the request fell short" : result.harnessCap ? `the harness had to stop it (${result.harnessCap})` : "");
  }
  return { checks, matches: matchedNames.size, falseMatches: falseMatches.length, planned, spentUsd, searches };
}

if (import.meta.main) {
  const dir = process.argv[2] ?? join(import.meta.dir, "../../../.data/eval/research-agent");
  const files = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  type Row = { key: string; passed: number; graded: number; checks: Check[]; tokens: number; calls: number; seconds: number };
  const rows: Row[] = [];
  for (const name of files) {
    const result = JSON.parse(readFileSync(join(dir, name), "utf8")) as EvalResult;
    const fixture = CASES[result.case];
    if (!fixture || result.mode !== "real") continue;
    const scored = scoreResult(result, fixture);
    const graded = scored.checks.filter((item) => item.pass !== null);
    const passed = graded.filter((item) => item.pass).length;
    const key = `${result.agent ?? "v1"} ${result.model} ${result.case}`;
    rows.push({ key, passed, graded: graded.length, checks: scored.checks, tokens: (result.modelCalls?.inputTokens ?? 0) + (result.modelCalls?.outputTokens ?? 0), calls: result.modelCalls?.real ?? 0, seconds: result.seconds ?? 0 });
    const failed = scored.checks.filter((item) => item.pass === false).map((item) => `${item.name}${item.detail ? ` (${item.detail})` : ""}`);
    console.log(`${name}: ${passed}/${graded.length} | matches ${scored.matches}, false ${scored.falseMatches}, planned ${scored.planned}, searches ${scored.searches}, $${scored.spentUsd} | ${result.modelCalls?.real ?? 0} model calls${failed.length ? ` | FAILED ${failed.join("; ")}` : ""}`);
  }
  const groups = new Map<string, Row[]>();
  for (const row of rows) groups.set(row.key, [...(groups.get(row.key) ?? []), row]);
  console.log("\nagent model case: runs passing every check, checks passed");
  for (const [key, group] of [...groups].sort()) {
    const clean = group.filter((row) => row.passed === row.graded).length;
    const passed = group.reduce((sum, row) => sum + row.passed, 0);
    const graded = group.reduce((sum, row) => sum + row.graded, 0);
    console.log(`${key}: ${clean}/${group.length} runs clean, ${passed}/${graded} checks, ${Math.round(group.reduce((sum, row) => sum + row.calls, 0) / group.length)} model calls/run`);
  }
}

import "server-only";

import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { featureEnabled } from "@/lib/features/flags.server";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { progressBlock, requestBlock, type ProgressSearch } from "./agentV2";
import { addAudienceMembers, createAudience, memberInsights } from "./audiences.server";
import { readBrief, type Brief } from "./brief";
import { personFit } from "./leadFit";
import { objectiveFacts, threadObjectives, type Objective } from "./objective.server";
import { assistantMessages, leadAudienceMembers, outreachRuns } from "./schema";

/**
 * Research agent v2, the server half (agentV2.ts has the pure parts): which
 * request a chat is working on, what the model reads about it every step,
 * its leads with their evidence, the assistant's own verdict on a lead
 * (with the words that prove it), and the one list a request's plan is made
 * from: its matching leads, up to its target.
 */

export async function agentV2Enabled(): Promise<boolean> {
  return featureEnabled("research_agent_v2");
}

/** The chat's current request: its newest objective still active or paused, or null. */
export async function activeRequest(threadId: string): Promise<Objective | null> {
  const [latest] = await threadObjectives(threadId, 1);
  return latest && latest.status !== "stopped" ? latest : null;
}

/** The request a v2 turn serves: the chat's newest one, whatever its state (a stopped one's leads can still be planned), or null. */
export async function currentRequest(threadId: string): Promise<Objective | null> {
  const [latest] = await threadObjectives(threadId, 1);
  return latest ?? null;
}

/** The owner's messages of this chat from the request's first one on, oldest first. */
export async function ownerMessagesSince(threadId: string, requestMessageId: string): Promise<string[]> {
  const [first] = await db.select({ createdAt: assistantMessages.createdAt }).from(assistantMessages)
    .where(and(inOrg(assistantMessages), eq(assistantMessages.id, requestMessageId), eq(assistantMessages.threadId, threadId))).limit(1);
  if (!first) return [];
  const rows = await db.select({ content: assistantMessages.content }).from(assistantMessages)
    .where(and(inOrg(assistantMessages), eq(assistantMessages.threadId, threadId), eq(assistantMessages.role, "user"), gte(assistantMessages.createdAt, first.createdAt)))
    .orderBy(asc(assistantMessages.createdAt)).limit(40);
  return rows.map((row) => row.content).filter((text) => text.trim());
}

export function objectiveBrief(objective: Pick<Objective, "controls"> | null): Brief | null {
  return objective ? readBrief(objective.controls.brief) : null;
}

/** What the model reads first every step: the request and its brief, what was counted, and this chat's plans. */
export async function v2ContextText(input: { threadId: string; requestMessageId: string | null }): Promise<string> {
  // The request the turn serves (the one its tools read), else the chat's active one.
  const served = input.requestMessageId ? (await threadObjectives(input.threadId, 5)).find((row) => row.requestMessageId === input.requestMessageId) ?? null : null;
  const objective = served ?? await activeRequest(input.threadId);
  const requestId = objective?.requestMessageId ?? input.requestMessageId;
  const ownerMessages = requestId ? await ownerMessagesSince(input.threadId, requestId) : [];
  const brief = objectiveBrief(objective);
  const parts = [requestBlock({ ownerMessages, brief, controls: objective, status: objective?.status ?? null })];
  if (objective) {
    const facts = await objectiveFacts(objective);
    const searches: ProgressSearch[] = facts.children.map((job) => {
      const payload = (job.payload ?? {}) as { phrase?: unknown; criteria?: { what?: unknown; where?: unknown; customers?: unknown; platforms?: unknown }; keywords?: unknown };
      const result = (job.result ?? {}) as { found?: unknown; eligible?: unknown };
      const what = typeof payload.phrase === "string" ? payload.phrase
        : typeof payload.keywords === "string" ? payload.keywords
          : [payload.criteria?.what ?? payload.criteria?.customers, payload.criteria?.where].filter((value) => typeof value === "string").join(" in ") || job.kind;
      const done = job.status === "succeeded";
      const running = job.status === "queued" || job.status === "running";
      // A running search's count so far, as its chat card shows it: without it the model says "nothing found yet".
      const foundSoFar = Number((job.progress as { found?: unknown } | null)?.found);
      const found = done ? Number(result.found ?? 0) : running && Number.isFinite(foundSoFar) && foundSoFar > 0 ? foundSoFar : null;
      return { tool: job.kind, what, status: running ? "running" : job.status, found, contactable: done ? Number(result.eligible ?? 0) : null };
    });
    const runs = await db.select({ name: outreachRuns.name, status: outreachRuns.status, plan: outreachRuns.plan }).from(outreachRuns)
      .where(and(inOrg(outreachRuns), eq(outreachRuns.threadId, input.threadId))).orderBy(desc(outreachRuns.createdAt)).limit(5);
    parts.push(progressBlock({
      funnel: facts.funnel,
      sources: facts.sources,
      searches,
      spentUsd: facts.spend.totalUsd,
      spendCapUsd: objective.spendCapUsd,
      msLeft: objective.deadlineAt.getTime() - Date.now(),
      plans: runs.map((run) => ({ name: run.name, status: run.status, leads: ((run.plan ?? {}) as { assignments?: unknown[] }).assignments?.length ?? 0 })),
    }));
  }
  return parts.join("\n");
}

type RequestMember = typeof leadAudienceMembers.$inferSelect;

/** Who a request's plan takes: its leads judged a match, every contactable lead, or exactly the people the model named. */
export type LeadPick = { kind: "match" } | { kind: "all" } | { kind: "people"; ids: string[] };

async function requestMembers(objective: Objective, audienceId: string | null): Promise<RequestMember[]> {
  const audienceIds = audienceId ? [audienceId] : (await objectiveFacts(objective)).audienceIds;
  if (!audienceIds.length) return [];
  return db.select().from(leadAudienceMembers)
    .where(and(inOrg(leadAudienceMembers), inArray(leadAudienceMembers.audienceId, audienceIds)))
    .orderBy(asc(leadAudienceMembers.createdAt)).limit(3_000);
}

export type ReviewFilter = "all" | "match" | "unconfirmed" | "no_match" | "unjudged" | "not_saved";

/** One line per lead (one per person when it is on several lists), with what it was judged on, for the model. */
export async function reviewLeadsText(input: { objective: Objective; audienceId: string | null; filter: ReviewFilter; limit: number }): Promise<{ text: string; shown: number; total: number }> {
  const members = await requestMembers(input.objective, input.audienceId);
  const insights = await memberInsights(members.map((member) => member.id));
  const byPerson = new Map<string, RequestMember[]>();
  const unsaved: RequestMember[] = [];
  for (const member of members) {
    if (member.personId) byPerson.set(member.personId, [...(byPerson.get(member.personId) ?? []), member]);
    else unsaved.push(member);
  }
  const lines: { verdict: string; text: string }[] = [];
  for (const [personId, rows] of byPerson) {
    const verdict = personFit(rows.map((row) => row.fit));
    const first = rows[0]!;
    const reason = rows.find((row) => row.fitReason)?.fitReason ?? "";
    const facts = Object.entries(first.facts ?? {}).filter(([, value]) => value).map(([key, value]) => `${key}: ${String(value).replace(/\s+/g, " ").slice(0, 160)}`).join("; ");
    const why = insights.get(first.id)?.matchReason ?? "";
    lines.push({
      verdict,
      text: `- person ${personId} “${first.name}” — ${verdict === "pending" ? "not judged yet" : verdict}${reason ? ` (${reason.slice(0, 200)})` : ""}; ${first.status === "eligible" ? `reachable by ${first.channels.join(", ") || "nothing"}` : `not contactable: ${first.reason ?? "no route"}`}; ${facts || "no facts"}${why ? `; found: ${why.slice(0, 200)}` : ""}${first.sourceUrl ? `; source ${first.sourceUrl}` : ""}`,
    });
  }
  for (const member of unsaved) {
    lines.push({ verdict: "not_saved", text: `- not saved “${member.name}”: ${member.reason ?? "excluded"}${member.sourceUrl ? `; source ${member.sourceUrl}` : ""}` });
  }
  const wanted = lines.filter((line) => input.filter === "all" || line.verdict === input.filter || (input.filter === "unjudged" && line.verdict === "pending"));
  const shown = wanted.slice(0, input.limit);
  const counts = ["match", "unconfirmed", "no_match", "pending", "not_saved"].map((verdict) => `${lines.filter((line) => line.verdict === verdict).length} ${verdict === "pending" ? "not judged" : verdict.replace("_", " ")}`).join(", ");
  return {
    text: `${lines.length} leads in this request (${counts}).${shown.length < wanted.length ? ` Showing ${shown.length} of ${wanted.length}; pass a filter or a higher limit for more.` : ""}\n${shown.map((line) => line.text).join("\n")}`,
    shown: shown.length,
    total: lines.length,
  };
}

/** Text compared for a quote: HTML entities decoded (a page's "&amp;" is the "&" the model read), quotes and spaces made alike. */
export function quoteText(text: string): string {
  return text
    .replace(/&amp;/gi, "&").replace(/&nbsp;/gi, " ").replace(/&quot;/gi, "\"").replace(/&#0*39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/\\u0026/gi, "&")
    .toLowerCase().replace(/[“”"’‘']/g, "'").replace(/\s+/g, " ").trim();
}
const norm = quoteText;

/**
 * Whether the quote is really in what the server read: a page or search
 * result in this chat, or the lead's own stored facts. The assistant may say
 * a lead matches only with words it can point to.
 */
async function quoteFound(threadId: string, rows: readonly RequestMember[], quote: string): Promise<boolean> {
  const wanted = norm(quote);
  if (rows.some((row) => norm(`${JSON.stringify(row.facts ?? {})} ${JSON.stringify(row.evidence ?? [])} ${row.name}`).includes(wanted))) return true;
  const reads = await db.select({ content: assistantMessages.content, toolResult: assistantMessages.toolResult }).from(assistantMessages)
    .where(and(inOrg(assistantMessages), eq(assistantMessages.threadId, threadId), eq(assistantMessages.role, "tool"), eq(assistantMessages.status, "ok"), inArray(assistantMessages.tool, ["read_webpage", "web_search", "browser_open", "browser_read"])))
    .orderBy(desc(assistantMessages.createdAt)).limit(60);
  return reads.some((row) => norm(`${row.content} ${JSON.stringify(row.toolResult ?? {})}`).includes(wanted));
}

/** The assistant's own verdict on a person of the request, on all their lists; a match needs a quote the server read. */
export async function setLeadFit(input: { objective: Objective; threadId: string; personId: string; fit: "match" | "no_match"; reason: string; quote: string | null; url: string | null }): Promise<{ ok: true; name: string; lists: number } | { ok: false; problem: string }> {
  const rows = (await requestMembers(input.objective, null)).filter((row) => row.personId === input.personId);
  if (!rows.length) return { ok: false, problem: "that person is not one of this request's leads; use a person id from review_leads" };
  // The verdict is the assistant's; a quote, when it gives one, must really be in what was read (the owner sees it as evidence).
  if (input.quote && !(await quoteFound(input.threadId, rows, input.quote))) return { ok: false, problem: "that quote is not in any page read in this chat or in the lead's own profile; quote it exactly, or leave quote out" };
  const evidence = input.quote ? ` (“${input.quote.trim().slice(0, 200)}”${input.url ? ` — ${input.url.slice(0, 200)}` : ""})` : "";
  await db.update(leadAudienceMembers).set({
    fit: input.fit,
    fitReason: `Checked by the assistant: ${input.reason.trim().slice(0, 240)}${evidence}`,
    fitApproach: input.fit === "no_match" ? "skip" : rows[0]!.fitApproach ?? "standard",
    fitRequestId: input.objective.requestMessageId,
    fitAt: new Date(),
    fitClaimedAt: null,
  }).where(and(inOrg(leadAudienceMembers), inArray(leadAudienceMembers.id, rows.map((row) => row.id))));
  return { ok: true, name: rows[0]!.name, lists: rows.length };
}

/**
 * The one list a request's plan is made from: each person of the request
 * who matches it and can be contacted, once, newest verdicts kept, up to
 * `max`. Null when nobody qualifies (the reason says why).
 */
export async function matchingLeadsAudience(input: { objective: Objective; brief: Brief | null; threadId: string; userId: string | null; max: number; audienceId?: string | null; pick?: LeadPick }): Promise<{ audienceId: string; leads: number } | { problem: string }> {
  const pick = input.pick ?? { kind: "match" };
  const members = await requestMembers(input.objective, input.audienceId ?? null);
  const byPerson = new Map<string, RequestMember[]>();
  for (const member of members) if (member.personId) byPerson.set(member.personId, [...(byPerson.get(member.personId) ?? []), member]);
  const wanted = pick.kind === "people" ? new Set(pick.ids) : null;
  const chosen: RequestMember[] = [];
  for (const [personId, rows] of byPerson) {
    if (wanted && !wanted.has(personId)) continue;
    if (pick.kind === "match" && personFit(rows.map((row) => row.fit)) !== "match") continue;
    const reachable = pick.kind === "match"
      ? rows.find((row) => row.status === "eligible" && row.fit === "match")
      : rows.find((row) => row.status === "eligible");
    if (reachable) chosen.push(reachable);
    if (chosen.length >= input.max) break;
  }
  if (!chosen.length) {
    if (pick.kind === "people") return { problem: `none of the ${pick.ids.length} people named is a contactable lead of this request (review_leads lists them, with their ids)` };
    if (pick.kind === "all") return { problem: "no lead of this request can be contacted yet (none has an email, phone or profile to reach)" };
    const matches = [...byPerson.values()].filter((rows) => personFit(rows.map((row) => row.fit)) === "match").length;
    return { problem: matches ? `the ${matches} matching ${matches === 1 ? "lead has" : "leads have"} no contact route yet` : "no lead of this request is judged a match; review_leads, then pass leads all or the personIds you want in the plan" };
  }
  const goal = input.brief?.goal ?? "this request";
  const audienceId = await createAudience({ name: `${pick.kind === "match" ? "Matching leads" : "Leads"}: ${goal.slice(0, 120)}`, source: "list", criteria: { requestId: input.objective.requestMessageId, fromRequest: true }, threadId: input.threadId, userId: input.userId });
  await addAudienceMembers(audienceId, chosen.map((member) => ({
    // One id per (list, person): a retry adds nothing twice.
    id: undefined,
    personId: member.personId!,
    source: member.source,
    sourceUrl: member.sourceUrl,
    evidence: member.evidence,
    facts: member.facts,
    matchReason: member.fitReason,
    signals: [],
  })));
  // Their verdicts come along, so the plan does not judge them again.
  for (const member of chosen) {
    await db.update(leadAudienceMembers).set({ fit: member.fit, fitReason: member.fitReason, fitGroup: member.fitGroup, fitApproach: member.fitApproach, fitRequestId: member.fitRequestId, fitAt: member.fitAt ?? new Date() })
      .where(and(inOrg(leadAudienceMembers), eq(leadAudienceMembers.audienceId, audienceId), eq(leadAudienceMembers.personId, member.personId!)));
  }
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(leadAudienceMembers)
    .where(and(eq(leadAudienceMembers.organizationId, currentOrganizationId()), eq(leadAudienceMembers.audienceId, audienceId), eq(leadAudienceMembers.status, "eligible")));
  return { audienceId, leads: count };
}

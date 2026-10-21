import "server-only";

import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { AIML_PROVIDER_KEY, AIML_PROVIDER_NAME } from "@/lib/ai/aimlapi-types";
import { apifyRuns } from "@/lib/apify/schema";
import { channelRules } from "@/lib/channels/rules.server";
import { isMissingTable } from "@/lib/features/flags.server";
import { providerUsage } from "@/lib/quota/schema";
import { tregCalls } from "@/lib/treg/schema";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { webToolUse } from "./coverage.server";
import {
  formatDuration,
  limitReached,
  objectiveReportKey,
  objectiveReportText,
  outcomeOf,
  parseObjectiveControls,
  spendFromLedgers,
  spendRoom,
  SPEND_CAP_COVERS,
  usd,
  webSearchLedger,
  type ContactRoutes,
  type ControlDefaults,
  type LedgerRow,
  type ObjectiveOutcome,
  type ObjectiveStatus,
  type SourceYield,
  type SpendBreakdown,
  type SpendRoom,
  type StopReason,
  type WebUse,
} from "./objective";
import { assistantJobs, assistantMessages, assistantObjectives, leadAudiences, type ObjectiveProgress } from "./schema";
import { addMessage } from "./threads.server";
import type { AssistantJob, StepOutcome } from "./worker";
import { audienceFunnel } from "./qualify.server";
import type { LeadFunnel } from "./leadFit";

/**
 * Objectives, server side (rules in objective.ts): one row per owner request
 * that started a lead search, with its controls, status and stop reason;
 * what it found (the request's lead lists), what it spent (read from the
 * existing ledgers: its jobs' Apify runs, its Treg calls, its metered
 * provider use), the guards paid work passes before it reserves money, and
 * its one final report. The driver that continues it lives in
 * objectiveDriver.server.ts (it needs the chat turn, which needs the tools,
 * which need this module).
 *
 * Every read and write is in the organization in scope. Code reaching a
 * database whose migration (scripts/add-objectives.ts) has not run finds no
 * objective and behaves exactly as before.
 */

export type Objective = typeof assistantObjectives.$inferSelect;

/** The searches an objective counts (its jobs); outreach starts and the driver itself are not. */
export const SEARCH_JOB_KINDS = ["discovery", "linkedin_search", "web_discovery", "apify_instagram", "social_research"] as const;

type Executor = Pick<typeof db, "select">;

/**
 * Checks paid work against the request's spend cap inside the caller's
 * reservation transaction (serialized per request). `credits`: work priced
 * in credits, not dollars (Tavily), which only a free-only ($0) cap refuses.
 */
export type SpendGuard = (tx: Executor & Pick<typeof db, "execute">, wantUsd: number, options?: { credits?: boolean }) => Promise<SpendRoom>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The driver's first look, after the request's own turn has started its searches. */
const FIRST_LOOK_MS = 30_000;
/** How long a stopped objective waits for searches already running before it reports anyway. */
const SETTLE_MS = 30 * 60_000;

/** The request a job's payload serves, in SQL: the same rule as jobRequestId. */
export function jobRequestSql(): SQL {
  return sql`coalesce(${assistantJobs.payload} ->> 'requestMessageId', ${assistantJobs.payload} -> 'contactAfter' ->> 'requestId')`;
}

/** Whether a job serves the request (jobRequestId): each search serves exactly one. */
function servesRequest(requestId: string): SQL {
  return sql`${jobRequestSql()} = ${requestId}`;
}

/**
 * The one request a job serves, from its payload: the request it was
 * started for (requestMessageId), else, for a job from before that was
 * recorded, the request its "find and contact" plan answers. Spend, leads,
 * coverage and refusals all read it, so a search never counts under two.
 */
export function jobRequestId(job: { payload: unknown }): string | null {
  const payload = (job.payload ?? {}) as { requestMessageId?: unknown; contactAfter?: { requestId?: unknown } | null };
  if (typeof payload.requestMessageId === "string") return payload.requestMessageId;
  return typeof payload.contactAfter?.requestId === "string" ? payload.contactAfter.requestId : null;
}

/** Serializes every paid check of one request (objective or not), inside the caller's transaction. */
async function lockRequestSpend(tx: Pick<typeof db, "execute">, requestId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`request-spend:${currentOrganizationId()}:${requestId}`}, 0))`);
}

async function tolerant<T>(read: () => Promise<T>, missing: T): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (isMissingTable(error)) return missing;
    throw error;
  }
}

export async function objectiveForRequest(requestId: string | null | undefined): Promise<Objective | null> {
  if (!requestId || !UUID.test(requestId)) return null;
  return tolerant(async () => {
    const [row] = await db.select().from(assistantObjectives)
      .where(and(inOrg(assistantObjectives), eq(assistantObjectives.requestMessageId, requestId))).limit(1);
    return row ?? null;
  }, null);
}

export async function getObjective(objectiveId: string): Promise<Objective | null> {
  if (!UUID.test(objectiveId)) return null;
  return tolerant(async () => {
    const [row] = await db.select().from(assistantObjectives)
      .where(and(inOrg(assistantObjectives), eq(assistantObjectives.id, objectiveId))).limit(1);
    return row ?? null;
  }, null);
}

export async function objectiveForJob(job: { payload: unknown }): Promise<Objective | null> {
  return objectiveForRequest(jobRequestId(job));
}

/** What the Requests list needs of an objective: whose request it is, whether it still runs, and why it waits. */
export type ObjectiveState = { id: string; requestMessageId: string; status: ObjectiveStatus; waiting: string | null };

/** The objectives of these requests (by request message id) and these driver jobs' objectives (by id), in one read. */
export async function objectiveStates(input: { requestIds: readonly string[]; objectiveIds: readonly string[] }): Promise<ObjectiveState[]> {
  const requestIds = input.requestIds.filter((id) => UUID.test(id));
  const objectiveIds = input.objectiveIds.filter((id) => UUID.test(id));
  if (!requestIds.length && !objectiveIds.length) return [];
  return tolerant(async () => {
    const rows = await db.select({ id: assistantObjectives.id, requestMessageId: assistantObjectives.requestMessageId, status: assistantObjectives.status, progress: assistantObjectives.progress })
      .from(assistantObjectives)
      .where(and(inOrg(assistantObjectives), or(
        requestIds.length ? inArray(assistantObjectives.requestMessageId, requestIds) : sql`false`,
        objectiveIds.length ? inArray(assistantObjectives.id, objectiveIds) : sql`false`,
      )));
    return rows.map((row) => ({ id: row.id, requestMessageId: row.requestMessageId, status: row.status, waiting: (row.progress as ObjectiveProgress).waiting ?? null }));
  }, []);
}

/** The organization's defaults (Settings → Lead research, the "general" Sending rules). */
export async function objectiveDefaults(): Promise<ControlDefaults> {
  const rules = await channelRules("general");
  return { leadTarget: rules.objectiveLeadTarget, hours: rules.objectiveHours, spendUsd: rules.objectiveSpendUsd };
}

/**
 * The request's objective, created on its first search: its controls read
 * from the owner's words (else the defaults) and its driver job, in one
 * transaction, once per request however many searches start at once. Null
 * when there is no owner request to pursue (no request id, or not an owner
 * message of this chat), or the migration has not run.
 */
export async function ensureObjective(input: { requestMessageId: string | null | undefined; threadId: string | null; userId: string | null }): Promise<{ objective: Objective; created: boolean } | null> {
  const requestId = input.requestMessageId;
  const threadId = input.threadId;
  if (!requestId || !threadId || !UUID.test(requestId)) return null;
  const existing = await objectiveForRequest(requestId);
  if (existing) return { objective: existing, created: false };
  const [message] = await db.select({ content: assistantMessages.content, threadId: assistantMessages.threadId, role: assistantMessages.role })
    .from(assistantMessages).where(and(inOrg(assistantMessages), eq(assistantMessages.id, requestId))).limit(1);
  if (!message || message.role !== "user" || message.threadId !== threadId) return null;
  const controls = parseObjectiveControls(message.content, await objectiveDefaults());
  const now = Date.now();
  return tolerant(() => db.transaction(async (tx) => {
    const [created] = await tx.insert(assistantObjectives).values({
      organizationId: currentOrganizationId(),
      threadId,
      requestMessageId: requestId,
      leadTarget: controls.leadTarget,
      timeLimitMinutes: controls.timeLimitMinutes,
      deadlineAt: new Date(now + controls.timeLimitMinutes * 60_000),
      spendCapUsd: controls.spendCapUsd,
      controls: { named: controls.named },
      status: "active",
      nextEligibleAt: new Date(now + FIRST_LOOK_MS),
      createdBy: input.userId,
      // The time limit counts from this moment exactly.
      createdAt: new Date(now),
    }).onConflictDoNothing({ target: [assistantObjectives.organizationId, assistantObjectives.requestMessageId] }).returning();
    if (!created) {
      // Another search of the same request created it a moment ago.
      const [row] = await tx.select().from(assistantObjectives)
        .where(and(inOrg(assistantObjectives), eq(assistantObjectives.requestMessageId, requestId))).limit(1);
      return row ? { objective: row, created: false } : null;
    }
    await tx.insert(assistantJobs).values({
      organizationId: currentOrganizationId(),
      kind: "objective",
      stage: "watching",
      threadId,
      payload: { objectiveId: created.id },
      progress: { stage: "watching" },
      runAfter: new Date(now + FIRST_LOOK_MS),
      createdBy: input.userId,
    });
    return { objective: created, created: true };
  }), null);
}

/** The controls in a sentence, for the first search's result (the model tells the owner). */
export function controlsSentence(objective: Pick<Objective, "leadTarget" | "timeLimitMinutes" | "spendCapUsd" | "controls">): string {
  const named = objective.controls.named ?? { target: false, time: false, spend: false };
  const tag = (fromOwner: boolean) => (fromOwner ? "" : " (default)");
  const spend = objective.spendCapUsd > 0
    ? `spending at most ${usd(objective.spendCapUsd)}${tag(named.spend)} on paid sources`
    : `on free sources only (a $0 spend cap${tag(named.spend)}: no Apify, Treg, browser, Tavily or AI web research)`;
  return `This request keeps searching on its own until it has ${objective.leadTarget} qualified leads${tag(named.target)}, for up to ${formatDuration(objective.timeLimitMinutes * 60_000)}${tag(named.time)}, ${spend}; the owner can name other limits in a request, or pause or cancel it, and gets one final report. ${SPEND_CAP_COVERS}`;
}

// ── What it found and spent ──────────────────────────────────────────────────

export type ObjectiveChild = Pick<AssistantJob, "id" | "kind" | "status" | "stage" | "payload" | "progress" | "result" | "error" | "audienceId" | "createdAt" | "lockedBy">;

export async function objectiveChildren(objective: Pick<Objective, "requestMessageId">, executor: Executor = db): Promise<ObjectiveChild[]> {
  return executor.select({
    id: assistantJobs.id,
    kind: assistantJobs.kind,
    status: assistantJobs.status,
    stage: assistantJobs.stage,
    payload: assistantJobs.payload,
    progress: assistantJobs.progress,
    result: assistantJobs.result,
    error: assistantJobs.error,
    audienceId: assistantJobs.audienceId,
    createdAt: assistantJobs.createdAt,
    lockedBy: assistantJobs.lockedBy,
  }).from(assistantJobs)
    .where(and(inOrg(assistantJobs), inArray(assistantJobs.kind, [...SEARCH_JOB_KINDS]), servesRequest(objective.requestMessageId)))
    .orderBy(asc(assistantJobs.createdAt))
    .limit(300);
}

const isOpen = (job: Pick<ObjectiveChild, "status">) => job.status === "queued" || job.status === "running";

/**
 * Qualified leads: distinct people with a contact route whom the judging
 * found to match the owner's request (qualify.server.ts), across the
 * request's lead lists — its searches' and the lists the assistant made for
 * it (criteria.requestId). Each person counts once, however many sources
 * found them; a contact route alone is not a match. The funnel keeps the
 * other steps apart (found, contactable, not matching, unconfirmed, not yet
 * judged), and the routes are the qualified people's.
 */
export async function objectiveLeads(objective: Pick<Objective, "requestMessageId">, children: readonly ObjectiveChild[]): Promise<{ leads: number; routes: ContactRoutes; audienceIds: string[]; funnel: LeadFunnel }> {
  const listed = await db.select({ id: leadAudiences.id }).from(leadAudiences)
    .where(and(inOrg(leadAudiences), sql`${leadAudiences.criteria} ->> 'requestId' = ${objective.requestMessageId}`));
  const audienceIds = [...new Set([...children.flatMap((job) => (job.audienceId ? [job.audienceId] : [])), ...listed.map((row) => row.id)])];
  const { routes, ...funnel } = await audienceFunnel(audienceIds);
  return { leads: funnel.qualified, routes, audienceIds, funnel };
}

/**
 * What the request spent, from the existing ledgers: the Apify runs of its
 * jobs (or recorded with its id), the Treg calls made for it, the metered
 * provider use of its jobs (or reserved for it), the AI web research its
 * website searches reported, and their Tavily credits. Open work counts at
 * what it reserved; a lost answer keeps its reservation.
 */
export async function objectiveSpend(objective: Pick<Objective, "requestMessageId">, executor: Executor = db, known?: readonly ObjectiveChild[]): Promise<SpendBreakdown> {
  const children = known ?? await objectiveChildren(objective, executor);
  const ids = children.map((job) => job.id);
  const requestId = objective.requestMessageId;
  const rows: LedgerRow[] = [];
  // One after another: inside a reservation transaction they share its connection.
  const apify = await executor.select({ status: apifyRuns.status, usageUsd: apifyRuns.usageUsd, maxChargeUsd: apifyRuns.maxChargeUsd }).from(apifyRuns)
    .where(and(inOrg(apifyRuns), or(eq(apifyRuns.requestId, requestId), ids.length ? inArray(apifyRuns.jobId, ids) : undefined)));
  for (const row of apify) rows.push({ ledger: "apify", ...row });
  const treg = await executor.select({ status: tregCalls.status, costUsd: tregCalls.costUsd, ceilingUsd: tregCalls.ceilingUsd }).from(tregCalls)
    .where(and(inOrg(tregCalls), eq(tregCalls.requestId, requestId)));
  for (const row of treg) rows.push({ ledger: "treg", ...row });
  const usage = await executor.select({ provider: providerUsage.provider, product: providerUsage.product, status: providerUsage.status, units: providerUsage.units, usedUnits: providerUsage.usedUnits }).from(providerUsage)
    .where(and(inOrg(providerUsage), or(sql`${providerUsage.detail} ->> 'requestId' = ${requestId}`, ids.length ? inArray(providerUsage.jobId, ids) : undefined)));
  for (const row of usage) rows.push({ ledger: "usage", ...row });
  for (const job of children) {
    // Social research finds its X, Instagram and Facebook pages with the same web searches, recorded the same way.
    if (job.kind !== "web_discovery" && job.kind !== "social_research") continue;
    const payload = (job.payload ?? {}) as Parameters<typeof webSearchLedger>[0];
    const result = (job.result ?? {}) as { searches?: unknown };
    rows.push(...webSearchLedger({ ...payload, searches: payload.searches ?? result.searches }));
  }
  return spendFromLedgers(rows);
}

/**
 * The guard paid work for this request passes inside its own reservation
 * transaction (Apify's, Treg's, the quota ledger's), after its provider
 * lock: the objective row is locked, its spend read again with every open
 * reservation, and the work refused, held (others' reservations may come
 * back) or allowed up to what is left. Undefined when the request has no
 * objective: only the organization's own allowances apply then.
 */
export async function objectiveSpendGuard(requestId: string | null | undefined): Promise<SpendGuard | undefined> {
  const objective = await objectiveForRequest(requestId);
  if (!objective) return undefined;
  return async (tx, wantUsd, options) => {
    await lockRequestSpend(tx, objective.requestMessageId);
    const [row] = await tx.select().from(assistantObjectives)
      .where(and(inOrg(assistantObjectives), eq(assistantObjectives.id, objective.id))).for("update");
    if (!row) return { ok: true, maxUsd: Number.POSITIVE_INFINITY };
    if (row.status === "paused") return { ok: false, wait: true, reason: "the owner paused this request's research" };
    if (row.status === "stopped") return { ok: false, wait: false, reason: `this request's research has stopped (${stopText(row)})` };
    if (Date.now() >= row.deadlineAt.getTime()) return { ok: false, wait: false, reason: "this request's time limit has passed" };
    if (options?.credits) return creditRoom(row.spendCapUsd);
    const spend = await objectiveSpend(row, tx);
    return spendRoom({ capUsd: row.spendCapUsd, settledUsd: spend.settledUsd, reservedUsd: spend.reservedUsd, wantUsd });
  };
}

/** Work priced in credits (Tavily): refused only by a free-only cap; the dollars cap does not measure it. */
function creditRoom(capUsd: number): SpendRoom {
  return capUsd > 0 ? { ok: true, maxUsd: Number.POSITIVE_INFINITY } : spendRoom({ capUsd, settledUsd: 0, reservedUsd: 0, wantUsd: 0 });
}

/** The owner message a request is, in this organization: its text and chat. */
async function requestMessage(requestId: string): Promise<{ content: string; threadId: string } | null> {
  const [message] = await db.select({ content: assistantMessages.content, threadId: assistantMessages.threadId, role: assistantMessages.role })
    .from(assistantMessages).where(and(inOrg(assistantMessages), eq(assistantMessages.id, requestId))).limit(1);
  return message?.role === "user" ? message : null;
}

/**
 * The request's spend cap: its objective's, else the budget its own words
 * name (parseObjectiveControls), else the organization's default. Null when
 * the id is not an owner message here.
 */
export async function requestSpendCap(requestId: string | null | undefined): Promise<number | null> {
  if (!requestId || !UUID.test(requestId)) return null;
  const objective = await objectiveForRequest(requestId);
  if (objective) return objective.spendCapUsd;
  const message = await requestMessage(requestId);
  return message ? parseObjectiveControls(message.content, await objectiveDefaults()).spendCapUsd : null;
}

/**
 * The spend guard of paid work a request's turn does itself (a Treg call,
 * the browser), which starts no search and so no objective: the
 * objective's guard when its research has one; otherwise the cap the
 * request names or the default, against the same ledgers, serialized by
 * the same per-request lock. It creates nothing.
 */
export async function requestSpendGuard(requestId: string | null | undefined): Promise<SpendGuard | undefined> {
  const objectiveGuard = await objectiveSpendGuard(requestId);
  if (objectiveGuard) return objectiveGuard;
  const capUsd = await requestSpendCap(requestId);
  if (capUsd === null || !requestId) return undefined;
  return async (tx, wantUsd, options) => {
    await lockRequestSpend(tx, requestId);
    if (options?.credits) return creditRoom(capUsd);
    const spend = await objectiveSpend({ requestMessageId: requestId }, tx);
    return spendRoom({ capUsd, settledUsd: spend.settledUsd, reservedUsd: spend.reservedUsd, wantUsd });
  };
}

/**
 * Why paid work for the request may not go on right now (its research is
 * paused, has stopped, or its time passed), or null. For steps of work
 * already reserved, such as the browser after it opened.
 */
export async function requestHoldReason(requestId: string | null | undefined): Promise<string | null> {
  const objective = await objectiveForRequest(requestId);
  if (!objective) return null;
  if (objective.status === "paused") return "the owner paused this request's research";
  if (objective.status === "stopped") return `this request's research has stopped (${stopText(objective)})`;
  if (Date.now() >= objective.deadlineAt.getTime()) return "this request's time limit has passed";
  return null;
}

function stopText(objective: Pick<Objective, "stopReason" | "stopDetail">): string {
  return objective.stopDetail ?? objective.stopReason?.replace(/_/g, " ") ?? "stopped";
}

// ── Sources ──────────────────────────────────────────────────────────────────

function webProviderName(provider: unknown): string {
  if (provider === "tinyfish") return "TinyFish Search";
  if (provider === "tavily") return "Tavily";
  if (provider === "openrouter") return "OpenRouter web search";
  if (provider === AIML_PROVIDER_KEY) return `${AIML_PROVIDER_NAME} web research`;
  return "web search";
}

/** The source and its provider, as every label names both (CONTEXT.md). */
function childLabel(job: ObjectiveChild): string {
  const payload = (job.payload ?? {}) as { target?: unknown; provider?: unknown; searchProvider?: unknown };
  const result = (job.result ?? {}) as { provider?: unknown };
  if (job.kind === "linkedin_search") return "LinkedIn people search through Unipile";
  if (job.kind === "apify_instagram") return "Instagram through Apify";
  if (job.kind === "social_research") {
    const platforms = ((payload as { criteria?: { platforms?: unknown } }).criteria?.platforms ?? []) as string[];
    const names: Record<string, string> = { reddit: "Reddit", x: "X", instagram: "Instagram", facebook: "Facebook" };
    return `${platforms.map((platform) => names[platform] ?? platform).join(", ") || "Social platforms"} through Bright Data`;
  }
  if (job.kind === "web_discovery") return `Websites and directories through ${webProviderName(payload.searchProvider)}`;
  const source = payload.target === "facebook" ? "Facebook" : payload.target === "linkedin" ? "LinkedIn" : payload.target === "instagram" ? "Instagram" : "Google Maps";
  const provider = result.provider === "apify" || result.provider === "scraper" ? result.provider : payload.provider;
  return provider === "apify" ? `${source} through Apify` : provider === "scraper" ? `${source} through the built-in scraper` : source;
}

/** Each source's yield over the request's searches, in the order they started. */
export function objectiveSources(children: readonly ObjectiveChild[]): SourceYield[] {
  const bySource = new Map<string, SourceYield>();
  for (const job of children) {
    const label = childLabel(job);
    const source = bySource.get(label) ?? { label, searches: 0, found: 0, eligible: 0, judged: 0, matched: 0, notSearched: 0, failed: 0, open: 0, notes: [] };
    bySource.set(label, source);
    source.searches += 1;
    const result = (job.result ?? {}) as { found?: unknown; eligible?: unknown; notSearched?: unknown; handedToJobId?: unknown; note?: unknown; fit?: { contactable?: unknown; qualified?: unknown; pending?: unknown } };
    const note = (text: unknown) => {
      if (typeof text === "string" && text.trim() && source.notes.length < 3) source.notes.push(text.trim());
    };
    if (isOpen(job)) source.open += 1;
    else if (job.status === "failed") {
      source.failed += 1;
      note(job.error);
    } else if (job.status === "cancelled" || result.notSearched === true || result.handedToJobId) {
      source.notSearched += 1;
      note(result.note ?? job.error ?? "cancelled");
    } else {
      source.found += Number(result.found ?? 0);
      source.eligible += Number(result.eligible ?? 0);
      // As judged when the search ended (a lead judged later, by the driver, counts in the request's totals).
      if (result.fit) {
        source.judged += Math.max(0, Number(result.fit.contactable ?? 0) - Number(result.fit.pending ?? 0));
        source.matched += Number(result.fit.qualified ?? 0);
      }
    }
  }
  return [...bySource.values()];
}

// ── Facts, view and report ───────────────────────────────────────────────────

export type ObjectiveFacts = {
  objective: Objective;
  request: string;
  children: ObjectiveChild[];
  leads: number;
  routes: ContactRoutes;
  audienceIds: string[];
  funnel: LeadFunnel;
  spend: SpendBreakdown;
  sources: SourceYield[];
  web: WebUse | null;
  openChildren: number;
  followUpsPending: number;
};

export async function objectiveFacts(objective: Objective): Promise<ObjectiveFacts> {
  const children = await objectiveChildren(objective);
  const [{ leads, routes, audienceIds, funnel }, spend, [message]] = await Promise.all([
    objectiveLeads(objective, children),
    objectiveSpend(objective, db, children),
    db.select({ id: assistantMessages.id, threadId: assistantMessages.threadId, createdAt: assistantMessages.createdAt, content: assistantMessages.content })
      .from(assistantMessages).where(and(inOrg(assistantMessages), eq(assistantMessages.id, objective.requestMessageId))).limit(1),
  ]);
  const web = message ? await webToolUse(message) : null;
  return {
    objective,
    request: message?.content ?? "",
    children,
    leads,
    routes,
    audienceIds,
    funnel,
    spend,
    sources: objectiveSources(children),
    web,
    openChildren: children.filter(isOpen).length,
    followUpsPending: children.filter((job) => {
      const followUp = (job.progress ?? {}) as { followUp?: unknown };
      return job.status === "succeeded" && (followUp.followUp === "owed" || followUp.followUp === "preparing");
    }).length,
  };
}

/** The objective's state, for Activity and the chat (read-only: looking never starts, pauses or stops anything). */
export type ObjectiveView = {
  id: string;
  requestMessageId: string;
  threadId: string;
  request: string;
  status: ObjectiveStatus;
  outcome: ObjectiveOutcome | null;
  stopReason: StopReason | null;
  stopDetail: string | null;
  stoppedAt: string | null;
  leadTarget: number;
  leads: number;
  remaining: number;
  routes: ContactRoutes;
  spendCapUsd: number;
  spentUsd: number;
  reservedUsd: number;
  tavilyCredits: number;
  timeLimitMinutes: number;
  deadlineAt: string;
  msLeft: number;
  nextEligibleAt: string | null;
  waiting: string | null;
  continuations: number;
  named: { target: boolean; time: boolean; spend: boolean };
  sources: SourceYield[];
  openSearches: number;
  reported: boolean;
  createdAt: string;
};

function viewOf(facts: ObjectiveFacts, now = new Date()): ObjectiveView {
  const { objective } = facts;
  return {
    id: objective.id,
    requestMessageId: objective.requestMessageId,
    threadId: objective.threadId,
    request: facts.request,
    status: objective.status,
    outcome: objective.stopReason ? outcomeOf(objective.stopReason) : null,
    stopReason: objective.stopReason ?? null,
    stopDetail: objective.stopDetail ?? null,
    stoppedAt: objective.stoppedAt?.toISOString() ?? null,
    leadTarget: objective.leadTarget,
    leads: facts.leads,
    remaining: Math.max(0, objective.leadTarget - facts.leads),
    routes: facts.routes,
    spendCapUsd: objective.spendCapUsd,
    spentUsd: facts.spend.totalUsd,
    reservedUsd: facts.spend.reservedUsd,
    tavilyCredits: facts.spend.tavilyCredits,
    timeLimitMinutes: objective.timeLimitMinutes,
    deadlineAt: objective.deadlineAt.toISOString(),
    msLeft: objective.status === "stopped" ? 0 : Math.max(0, objective.deadlineAt.getTime() - now.getTime()),
    nextEligibleAt: objective.nextEligibleAt?.toISOString() ?? null,
    waiting: (objective.progress as ObjectiveProgress).waiting ?? null,
    continuations: (objective.progress as ObjectiveProgress).continuation?.n ?? 0,
    named: objective.controls.named ?? { target: false, time: false, spend: false },
    sources: facts.sources,
    openSearches: facts.openChildren,
    reported: Boolean(objective.reportedAt),
    createdAt: objective.createdAt.toISOString(),
  };
}

/** The objective of one owner request (its message id), or null. */
export async function objectiveView(requestMessageId: string): Promise<ObjectiveView | null> {
  const objective = await objectiveForRequest(requestMessageId);
  return objective ? viewOf(await objectiveFacts(objective)) : null;
}

export async function objectiveViewById(objectiveId: string): Promise<ObjectiveView | null> {
  const objective = await getObjective(objectiveId);
  return objective ? viewOf(await objectiveFacts(objective)) : null;
}

/** The objectives of one chat, newest first (the chat's own controls). */
export async function threadObjectives(threadId: string, limit = 5): Promise<Objective[]> {
  return tolerant(() => db.select().from(assistantObjectives)
    .where(and(inOrg(assistantObjectives), eq(assistantObjectives.threadId, threadId)))
    .orderBy(desc(assistantObjectives.createdAt)).limit(limit), []);
}

/** One line on the request's state, for the model (lead_search_status). */
export async function objectiveLine(requestId: string | null | undefined): Promise<string | null> {
  const objective = await objectiveForRequest(requestId);
  if (!objective) return null;
  const view = viewOf(await objectiveFacts(objective));
  const state = view.status === "stopped" ? `stopped: ${view.stopDetail ?? view.stopReason}` : view.status === "paused" ? "paused by the owner" : view.waiting ? `working (${view.waiting})` : "working";
  return `This request: ${view.leads} of ${view.leadTarget} qualified leads, ${usd(view.spentUsd)} of ${usd(view.spendCapUsd)} spent, ${formatDuration(view.msLeft)} left; ${state}.`;
}

// ── Stopping, holding and reporting ──────────────────────────────────────────

/** Searches of the request that have not begun (queued, first stage, nobody working on them). */
async function cancelUnstarted(objective: Pick<Objective, "requestMessageId">, note: string): Promise<number> {
  const rows = await db.update(assistantJobs).set({
    status: "cancelled",
    finishedAt: new Date(),
    error: note.slice(0, 500),
    result: { notSearched: true, found: 0, eligible: 0, note },
  }).where(and(
    inOrg(assistantJobs),
    inArray(assistantJobs.kind, [...SEARCH_JOB_KINDS]),
    servesRequest(objective.requestMessageId),
    eq(assistantJobs.status, "queued"),
    eq(assistantJobs.stage, "queued"),
    isNull(assistantJobs.lockedBy),
  )).returning({ id: assistantJobs.id });
  return rows.length;
}

/**
 * Stops the objective with its reason, once: the reason and the report key
 * are written together, then the searches that have not begun are
 * cancelled. Searches already running finish, and their leads are kept.
 * Null when it was already stopped.
 */
export async function stopObjective(objective: Pick<Objective, "id" | "requestMessageId">, reason: StopReason, detail: string): Promise<Objective | null> {
  // The counts as they stand now, kept so the report can explain what searches still running add after.
  const { funnel } = await objectiveLeads(objective, await objectiveChildren(objective));
  const atStop = { qualified: funnel.qualified, found: funnel.found, contactable: funnel.contactable };
  const [stopped] = await db.update(assistantObjectives).set({
    status: "stopped",
    stopReason: reason,
    stopDetail: detail.slice(0, 500),
    stoppedAt: new Date(),
    reportKey: objectiveReportKey(objective.id, reason),
    reportedAt: null,
    nextEligibleAt: null,
    progress: sql`${assistantObjectives.progress} || jsonb_build_object('waiting', null, 'atStop', ${JSON.stringify(atStop)}::jsonb)`,
    updatedAt: new Date(),
  }).where(and(inOrg(assistantObjectives), eq(assistantObjectives.id, objective.id), ne(assistantObjectives.status, "stopped"))).returning();
  if (stopped) await cancelUnstarted(stopped, `Not searched: the request's research stopped (${detail}) before this search started.`);
  return stopped ?? null;
}

/** Wakes the objective's driver now (a search of it finished, the owner paused, resumed or cancelled). */
export async function nudgeObjective(objectiveId: string): Promise<void> {
  await db.update(assistantJobs).set({ runAfter: new Date() })
    .where(and(inOrg(assistantJobs), eq(assistantJobs.kind, "objective"), eq(assistantJobs.status, "queued"), sql`${assistantJobs.payload} ->> 'objectiveId' = ${objectiveId}`));
}

/**
 * Before a search's first stage: a paused request's search waits (it has
 * started nothing yet), and a stopped request's search ends as not
 * searched. Null to let it run.
 */
export async function objectiveHold(job: AssistantJob): Promise<StepOutcome | null> {
  if (job.stage !== "queued") return null;
  const objective = await objectiveForJob(job);
  if (!objective || objective.status === "active") return null;
  if (objective.status === "paused") {
    return { next: "wait", delayMs: 60_000, progress: { waiting: { kind: "paused", reason: "the owner paused this request's research; it starts when resumed" } } };
  }
  const note = `Not searched: the request's research stopped (${stopText(objective)}) before this search started.`;
  const payload = (job.payload ?? {}) as { phrase?: unknown };
  return { next: "done", progress: { stage: "done" }, result: { audienceId: job.audienceId, phrase: typeof payload.phrase === "string" ? payload.phrase : null, found: 0, eligible: 0, notSearched: true, note } };
}

/**
 * Pauses, resumes or cancels the objective. Pausing and cancelling stop new
 * work (no new search, paid call or continuation starts) and keep every
 * lead already saved; searches already running finish. Resuming lets the
 * driver continue. Returns whether anything changed.
 */
export async function setObjectiveState(objectiveId: string, action: "pause" | "resume" | "cancel", actor: { name: string | null }): Promise<{ changed: boolean; objective: Objective | null }> {
  const objective = await getObjective(objectiveId);
  if (!objective) return { changed: false, objective: null };
  const who = actor.name?.trim() || "The owner";
  let changed = false;
  if (action === "cancel") {
    changed = Boolean(await stopObjective(objective, "cancelled", `cancelled by ${who === "The owner" ? "the owner" : who}`));
  } else {
    const [from, to] = action === "pause" ? (["active", "paused"] as const) : (["paused", "active"] as const);
    const now = new Date();
    const rows = await db.update(assistantObjectives)
      .set({ status: to, updatedAt: now, ...(action === "pause" ? { progress: sql`${assistantObjectives.progress} || jsonb_build_object('pausedAt', ${now.toISOString()}::text)` } : {}) })
      .where(and(inOrg(assistantObjectives), eq(assistantObjectives.id, objectiveId), eq(assistantObjectives.status, from))).returning({ id: assistantObjectives.id });
    changed = rows.length > 0;
    if (changed) {
      const request = await requestText(objective);
      await addMessage({
        threadId: objective.threadId,
        role: "event",
        content: action === "pause"
          ? `${who} paused the research for “${request}”. Searches already running finish and their leads are kept; nothing new starts until it is resumed. The time limit keeps counting.`
          : `${who} resumed the research for “${request}”.`,
      });
      if (action === "resume") {
        // Searches held by the pause start now rather than at their next check.
        await db.update(assistantJobs).set({ runAfter: new Date() })
          .where(and(inOrg(assistantJobs), inArray(assistantJobs.kind, [...SEARCH_JOB_KINDS]), servesRequest(objective.requestMessageId), eq(assistantJobs.status, "queued")));
      }
    }
  }
  if (changed) await nudgeObjective(objectiveId);
  return { changed, objective: await getObjective(objectiveId) };
}

async function requestText(objective: Pick<Objective, "requestMessageId">): Promise<string> {
  const [message] = await db.select({ content: assistantMessages.content }).from(assistantMessages)
    .where(and(inOrg(assistantMessages), eq(assistantMessages.id, objective.requestMessageId))).limit(1);
  return (message?.content ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
}

/** The owner's words that asked for the request, whole (what its leads are judged against). */
export async function objectiveRequest(objective: Pick<Objective, "requestMessageId">): Promise<string> {
  const [message] = await db.select({ content: assistantMessages.content }).from(assistantMessages)
    .where(and(inOrg(assistantMessages), eq(assistantMessages.id, objective.requestMessageId))).limit(1);
  return message?.content ?? "";
}

/** Whether the stopped objective may report now: its running searches have finished, or it has waited long enough for them. */
export function readyToReport(objective: Pick<Objective, "stoppedAt">, openChildren: number, now = new Date()): boolean {
  return openChildren === 0 || !objective.stoppedAt || now.getTime() - objective.stoppedAt.getTime() >= SETTLE_MS;
}

/**
 * Posts the stopped objective's one final report in its chat: claimed and
 * written in one transaction (reported_at set only if it was not), so a
 * restart, the reconciliation or a duplicate call never posts a second.
 * False when it was posted already, or it owes none.
 */
export async function postObjectiveReport(objectiveId: string): Promise<boolean> {
  const objective = await getObjective(objectiveId);
  if (!objective || objective.status !== "stopped" || !objective.stopReason || !objective.reportKey || objective.reportedAt) return false;
  const facts = await objectiveFacts(objective);
  const view = viewOf(facts);
  const content = objectiveReportText({
    request: facts.request,
    reason: objective.stopReason,
    detail: objective.stopDetail ?? "",
    leads: facts.leads,
    leadTarget: objective.leadTarget,
    routes: facts.routes,
    spend: facts.spend,
    spendCapUsd: objective.spendCapUsd,
    sources: facts.sources,
    web: facts.web,
    stillRunning: facts.openChildren,
    funnel: facts.funnel,
    atStop: (objective.progress as ObjectiveProgress).atStop ?? null,
  });
  return db.transaction(async (tx) => {
    const claimed = await tx.update(assistantObjectives).set({ reportedAt: new Date(), updatedAt: new Date() })
      .where(and(inOrg(assistantObjectives), eq(assistantObjectives.id, objective.id), isNotNull(assistantObjectives.reportKey), isNull(assistantObjectives.reportedAt)))
      .returning({ id: assistantObjectives.id });
    if (!claimed.length) return false;
    await addMessage({
      threadId: objective.threadId,
      role: "event",
      content,
      toolResult: {
        reportKey: objective.reportKey,
        objectiveId: objective.id,
        data: {
          objective: view,
          audienceIds: facts.audienceIds,
          links: [
            { label: "Lead lists in this chat", href: `/assistant?thread=${objective.threadId}` },
            { label: "Saved leads", href: "/leads" },
          ],
        },
      },
    }, tx);
    return true;
  });
}

/** Stops the objective as failed when its driver itself failed, and reports it (the driver can no longer). */
export async function failObjective(objectiveId: string, error: string): Promise<void> {
  const objective = await getObjective(objectiveId);
  if (!objective) return;
  if (objective.status !== "stopped") await stopObjective(objective, "failed", `its background work failed: ${error.slice(0, 300)}`);
  await postObjectiveReport(objectiveId);
}

/** Writes part of the objective's progress (merged key by key), its next action time and, optionally, its status. */
export async function saveObjectiveProgress(objectiveId: string, patch: Partial<ObjectiveProgress>, nextEligibleAt?: Date | null): Promise<void> {
  await db.update(assistantObjectives).set({
    progress: sql`${assistantObjectives.progress} || ${JSON.stringify(patch)}::jsonb`,
    ...(nextEligibleAt !== undefined ? { nextEligibleAt } : {}),
    updatedAt: new Date(),
  }).where(and(inOrg(assistantObjectives), eq(assistantObjectives.id, objectiveId)));
}

/** Why a new search may not start for the request now (paused, stopped, or at its target, spend cap or time), or null. */
export async function objectiveStartProblem(requestId: string | null | undefined): Promise<string | null> {
  const objective = await objectiveForRequest(requestId);
  if (!objective) return null;
  if (objective.status === "paused") return "the research for this request is paused; it continues when the owner resumes it";
  if (objective.status === "stopped") return `the research for this request has stopped (${stopText(objective)}); a new request starts new research`;
  const children = await objectiveChildren(objective);
  const { leads } = await objectiveLeads(objective, children);
  const spend = await objectiveSpend(objective, db, children);
  const limit = limitReached({ now: new Date(), deadline: objective.deadlineAt, leadTarget: objective.leadTarget, leads, spendCapUsd: objective.spendCapUsd, spentUsd: spend.settledUsd });
  return limit ? `this request has reached a limit (${limit.detail})` : null;
}

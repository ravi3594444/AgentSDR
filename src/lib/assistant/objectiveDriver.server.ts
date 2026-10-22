import "server-only";

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { inOrg } from "@/lib/tenancy/scope";
import { outreachRequested } from "./agent";
import { runAgentTurn } from "./agent.server";
import { SEARCH_TOOLS } from "./autonomy";
import { continuationNote, nextDriverStep, waitsForOwner, type Continuation, type DriverFacts, type DriverStep, type TurnEnd } from "./objective";
import { getObjective, nudgeObjective, objectiveFacts, objectiveJudgeRequest, postObjectiveReport, readyToReport, saveObjectiveProgress, stopObjective, type Objective, type ObjectiveFacts } from "./objective.server";
import { assistantMessages, assistantObjectives, type ObjectiveProgress } from "./schema";
import { addMessage, claimThread, releaseThread, threadBusy } from "./threads.server";
import type { AssistantJob, StepOutcome } from "./worker";
import type { ChatEvent } from "./chatEvents";
import { assessMembers } from "./qualify.server";
import { savedErrorText } from "@/lib/grid/sanitize";

/**
 * The driver of one objective: an "objective" job the worker steps like any
 * other (claimed, heartbeat, resumed after a restart). Each step reads what
 * is recorded — the request's searches, its lead lists, its ledgers, the
 * latest continuation — and nextDriverStep (objective.ts) decides: wait
 * while work runs or a slot or quota frees, stop at a limit, or continue.
 *
 * Continuing resumes the request's chat turn without an owner message: the
 * driver takes the chat, posts the note (found against target, spend and
 * time left, each source's yield; once per continuation), records the
 * continuation, and leaves the turn to run in the background so the worker
 * moves on. The turn records how it ended before it lets the chat go; a
 * continuation with no recorded end and a free chat had its process stop,
 * and is taken again. The model sees every earlier TOOL line, so a search
 * already started is not started again.
 *
 * Once stopped, the driver waits for searches already running (bounded),
 * then posts the one final report.
 */

const CHAT_BUSY_RETRY_MS = 20_000;
const QUALIFY_RETRY_MS = 60_000;
const TURN_POLL_MS = 15_000;
const SETTLE_POLL_MS = 30_000;

function progressOf(facts: ObjectiveFacts, waiting: string | null): Record<string, unknown> {
  return {
    stage: "watching",
    leads: facts.leads,
    found: facts.funnel.found,
    contactable: facts.funnel.contactable,
    toJudge: facts.funnel.pending,
    leadTarget: facts.objective.leadTarget,
    spentUsd: facts.spend.totalUsd,
    spendCapUsd: facts.objective.spendCapUsd,
    ...(waiting ? { waiting: { kind: "objective", reason: waiting } } : {}),
  };
}

async function driverFacts(objective: Objective, facts: ObjectiveFacts): Promise<DriverFacts> {
  const progress = objective.progress as ObjectiveProgress;
  const turn = progress.continuation ?? null;
  const since = turn ? new Date(turn.startedAt) : null;
  const tried = since
    ? await db.select({ content: assistantMessages.content, toolResult: assistantMessages.toolResult }).from(assistantMessages).where(and(
      inOrg(assistantMessages),
      eq(assistantMessages.threadId, objective.threadId),
      eq(assistantMessages.role, "tool"),
      eq(assistantMessages.status, "error"),
      inArray(assistantMessages.tool, [...SEARCH_TOOLS]),
      gte(assistantMessages.createdAt, since),
    ))
    : [];
  const waiting = (row: { toolResult: Record<string, unknown> | null }) => (row.toolResult?.data as { waiting?: unknown } | undefined)?.waiting === true;
  const v2 = Boolean(objective.controls.brief);
  const [lastWord] = v2
    ? await db.select({ role: assistantMessages.role, content: assistantMessages.content }).from(assistantMessages)
      .where(and(inOrg(assistantMessages), eq(assistantMessages.threadId, objective.threadId), inArray(assistantMessages.role, ["user", "assistant"])))
      .orderBy(desc(assistantMessages.createdAt)).limit(1)
    : [];
  // The turn that asked began at the owner's last message, or at the continuation that ran after it.
  const [lastOwner] = v2 && lastWord?.role === "assistant"
    ? await db.select({ createdAt: assistantMessages.createdAt }).from(assistantMessages)
      .where(and(inOrg(assistantMessages), eq(assistantMessages.threadId, objective.threadId), eq(assistantMessages.role, "user")))
      .orderBy(desc(assistantMessages.createdAt)).limit(1)
    : [];
  const turnStart = Math.max(lastOwner?.createdAt.getTime() ?? 0, since?.getTime() ?? 0);
  return {
    status: objective.status === "paused" ? "paused" : "active",
    now: new Date(),
    deadline: objective.deadlineAt,
    leadTarget: objective.leadTarget,
    leads: facts.leads,
    spendCapUsd: objective.spendCapUsd,
    spentUsd: facts.spend.settledUsd,
    openChildren: facts.openChildren,
    followUpsPending: facts.followUpsPending,
    threadBusy: await threadBusy(objective.threadId),
    continuation: turn,
    newSearches: since ? facts.children.filter((job) => job.createdAt.getTime() >= since.getTime()).length : 0,
    waitRefusals: tried.filter(waiting).map((row) => row.content),
    // Argument mistakes the model corrects itself (hidden) are not a source's limitation.
    refusals: tried.filter((row) => !waiting(row) && row.toolResult?.hidden !== true).map((row) => row.content),
    dry: progress.dry ?? 0,
    pausedAt: progress.pausedAt ?? null,
    pendingMembers: facts.funnel.pendingMembers,
    qualifyFailures: progress.qualifyFailures ?? 0,
    wakeAtLimit: v2,
    waitingForOwner: waitsForOwner({ lastWord, turnStartedSearch: facts.children.some((job) => job.createdAt.getTime() >= turnStart) }),
  };
}

const JUDGING = "judging the leads found against the request";

/** Judges leads left unjudged (qualify.server.ts); a failure is counted, and after MAX_QUALIFY_ATTEMPTS they stay uncounted. */
async function qualifyLeft(objective: Objective, facts: ObjectiveFacts): Promise<StepOutcome> {
  try {
    const { judged } = await assessMembers({ audienceIds: facts.audienceIds, request: await objectiveJudgeRequest(objective), requestId: objective.requestMessageId, maxBatches: 4 });
    // Nothing judged: the rest are claimed by a search judging them now.
    const delay = judged ? 1_000 : TURN_POLL_MS;
    await saveObjectiveProgress(objective.id, { waiting: JUDGING }, new Date(Date.now() + delay));
    return { next: "wait", delayMs: delay, progress: progressOf(facts, JUDGING) };
  } catch (error) {
    const failures = ((objective.progress as ObjectiveProgress).qualifyFailures ?? 0) + 1;
    console.error(`[assistant/objective] judging the leads of ${objective.id} failed (${failures}):`, error);
    await saveObjectiveProgress(objective.id, { qualifyFailures: failures, qualifyError: savedErrorText(error, 200), waiting: JUDGING }, new Date(Date.now() + QUALIFY_RETRY_MS));
    return { next: "wait", delayMs: QUALIFY_RETRY_MS, progress: progressOf(facts, JUDGING) };
  }
}

/** Records the verdict on the latest continuation (merged into it, so the turn's own end is kept). */
async function judge(objective: Objective, step: Extract<DriverStep, { kind: "judge" }>): Promise<void> {
  const patch = JSON.stringify({ judged: step.judged, waitUntil: step.waitUntil?.toISOString() ?? null });
  await db.update(assistantObjectives).set({
    progress: sql`jsonb_set(${assistantObjectives.progress}, '{continuation}', coalesce(${assistantObjectives.progress} -> 'continuation', '{}'::jsonb) || ${patch}::jsonb)`,
    updatedAt: new Date(),
  }).where(and(inOrg(assistantObjectives), eq(assistantObjectives.id, objective.id)));
}

/** Written by the continuation turn before it lets the chat go: how it ended. Only for the continuation it was started as. */
async function endContinuation(objectiveId: string, n: number, end: TurnEnd): Promise<void> {
  const patch = JSON.stringify({ endedAt: new Date().toISOString(), end });
  await db.update(assistantObjectives).set({
    progress: sql`jsonb_set(${assistantObjectives.progress}, '{continuation}', coalesce(${assistantObjectives.progress} -> 'continuation', '{}'::jsonb) || ${patch}::jsonb)`,
    updatedAt: new Date(),
  }).where(and(inOrg(assistantObjectives), eq(assistantObjectives.id, objectiveId), sql`(${assistantObjectives.progress} -> 'continuation' ->> 'n')::int = ${n}`));
  await nudgeObjective(objectiveId);
}

async function runContinuation(objective: Objective, n: number, request: string): Promise<void> {
  try {
    await runAgentTurn({
      threadId: objective.threadId,
      userId: objective.createdBy,
      text: null,
      continuation: {
        requestMessageId: objective.requestMessageId,
        request,
        outreach: outreachRequested(request),
        onEnd: (end) => endContinuation(objective.id, n, end),
      },
    });
  } catch (error) {
    // The turn recorded its end ("failed") and let the chat go in its own finally.
    console.error(`[assistant/objective] continuation ${n} of ${objective.id} failed:`, error);
  }
}

/** Takes the chat, posts the note once, records the continuation, and starts the turn in the background. */
async function continueRequest(objective: Objective, facts: ObjectiveFacts, step: Extract<DriverStep, { kind: "continue" }>): Promise<StepOutcome> {
  if (!(await claimThread(objective.threadId))) {
    await saveObjectiveProgress(objective.id, { waiting: "the chat is busy" }, new Date(Date.now() + CHAT_BUSY_RETRY_MS));
    return { next: "wait", delayMs: CHAT_BUSY_RETRY_MS, progress: progressOf(facts, "the chat is busy") };
  }
  const previous = (objective.progress as ObjectiveProgress).continuation ?? null;
  const retry = previous?.n === step.n ? previous : null;
  try {
    const noteKey = `${objective.id}:${step.n}`;
    const [posted] = await db.select({ id: assistantMessages.id }).from(assistantMessages).where(and(
      inOrg(assistantMessages),
      eq(assistantMessages.threadId, objective.threadId),
      eq(assistantMessages.role, "event"),
      sql`${assistantMessages.toolResult} ->> 'objectiveNote' = ${noteKey}`,
    )).limit(1);
    if (!posted) {
      await addMessage({
        threadId: objective.threadId,
        role: "event",
        content: continuationNote({
          request: facts.request,
          n: step.n,
          leads: facts.leads,
          leadTarget: objective.leadTarget,
          spend: facts.spend,
          spendCapUsd: objective.spendCapUsd,
          msLeft: objective.deadlineAt.getTime() - Date.now(),
          sources: facts.sources,
          web: facts.web,
          funnel: facts.funnel,
          v2: Boolean(objective.controls.brief),
          ...(step.final ? { final: step.final, finalDetail: step.finalDetail } : {}),
        }),
        toolResult: {
          objectiveNote: noteKey,
          objectiveId: objective.id,
          data: { event: { kind: "continuation", n: step.n, leads: facts.leads, target: objective.leadTarget, spentUsd: facts.spend.totalUsd, capUsd: objective.spendCapUsd, minutesLeft: (objective.deadlineAt.getTime() - Date.now()) / 60_000 } satisfies ChatEvent },
        },
      });
    }
    // A retry keeps when the continuation first started: searches its earlier attempt started still count as its own.
    const continuation: Continuation = {
      n: step.n,
      attempt: step.attempt,
      startedAt: retry?.startedAt ?? new Date().toISOString(),
      endedAt: null,
      end: null,
      leadsAtStart: retry?.leadsAtStart ?? facts.leads,
      judged: null,
      waitUntil: null,
      ...(step.final ? { final: step.final, ...(step.finalDetail ? { finalDetail: step.finalDetail } : {}) } : {}),
    };
    await saveObjectiveProgress(objective.id, { continuation, dry: step.dry, waiting: "the assistant is choosing the next source" }, new Date(Date.now() + TURN_POLL_MS));
  } catch (error) {
    await releaseThread(objective.threadId);
    throw error;
  }
  // Not awaited: the turn takes model calls, and the worker moves on. It holds the chat until it ends.
  void runContinuation(objective, step.n, facts.request);
  return { next: "wait", delayMs: TURN_POLL_MS, progress: progressOf(facts, "the assistant is choosing the next source") };
}

/** A stopped objective: wait (bounded) for searches still running, then post the one final report. */
async function report(objective: Objective): Promise<StepOutcome> {
  const facts = await objectiveFacts(objective);
  if (!readyToReport(objective, facts.openChildren)) {
    const waiting = `${facts.openChildren} search${facts.openChildren === 1 ? "" : "es"} still finishing before the report`;
    await saveObjectiveProgress(objective.id, { waiting }, new Date(Date.now() + SETTLE_POLL_MS));
    return { next: "wait", delayMs: SETTLE_POLL_MS, progress: progressOf(facts, waiting) };
  }
  await postObjectiveReport(objective.id);
  return {
    next: "done",
    progress: { ...progressOf(facts, null), stage: "done" },
    result: { objectiveId: objective.id, stopReason: objective.stopReason, leads: facts.leads, leadTarget: objective.leadTarget, spentUsd: facts.spend.totalUsd, spendCapUsd: objective.spendCapUsd },
  };
}

/** One step of the driver (registered for "objective" jobs in register.server.ts). */
export async function runObjectiveStep(job: AssistantJob): Promise<StepOutcome> {
  const objectiveId = typeof job.payload.objectiveId === "string" ? job.payload.objectiveId : null;
  let objective = objectiveId ? await getObjective(objectiveId) : null;
  if (!objective) return { next: "done", result: { note: "The request's objective no longer exists." } };
  for (let round = 0; round < 3; round += 1) {
    if (objective.status === "stopped") return report(objective);
    const facts = await objectiveFacts(objective);
    const step = nextDriverStep(await driverFacts(objective, facts));
    if (step.kind === "judge") {
      await judge(objective, step);
    } else if (step.kind === "qualify") {
      return qualifyLeft(objective, facts);
    } else if (step.kind === "stop") {
      await stopObjective(objective, step.reason, step.detail);
    } else if (step.kind === "wait") {
      await saveObjectiveProgress(objective.id, { waiting: step.reason }, new Date(Date.now() + step.delayMs));
      return { next: "wait", delayMs: step.delayMs, progress: progressOf(facts, step.reason) };
    } else {
      return continueRequest(objective, facts, step);
    }
    // Judged or stopped (or stopped meanwhile by the owner): read it again and go on.
    objective = await getObjective(objective.id);
    if (!objective) return { next: "done", result: { note: "The request's objective no longer exists." } };
  }
  return { next: "wait", delayMs: TURN_POLL_MS };
}

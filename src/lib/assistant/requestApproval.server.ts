import "server-only";

import { and, desc, eq, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { inOrg } from "@/lib/tenancy/scope";
import { userIsMember, userMayAutomate } from "./autonomy.server";
import { brokenChannelsProblem, channelAvailability, claimOutreachStart, getRun, OutreachError, startLockSql } from "./outreach.server";
import { leftOutCount, leftOutSentence, noNewLeadsReason } from "./overlap";
import { blockedPeople, closePlanWithoutLeads, narrowPlan, perDayFrom, proposedRunForStart, saveNarrowedPlan, type NarrowedPlan } from "./overlap.server";
import { approvalProblem, makeRequestApproval, type RequestApproval } from "./requestApproval";
import { outreachRuns } from "./schema";
import { addMessage } from "./threads.server";

/**
 * Request approvals (requestApproval.ts): recorded on the run the owner
 * started (in its plan, `requestApproval`), and applied to the other plans
 * of the same request in the same conversation, now and as later searches
 * finish. Each plan started this way goes through the same claim and
 * launch job as a Start press (outreach.server.ts claimOutreachStart), with
 * the same launch rules, limits and checks, and the chat says so on its
 * card's thread.
 */

type RunRow = NonNullable<Awaited<ReturnType<typeof getRun>>>;

export type AppliedApproval = { started: { runId: string; name: string }[]; skipped: { runId: string; name: string; reason: string; closed?: boolean }[] };

/** Records the approval on the started run, then starts the request's other waiting plans it covers. */
export async function recordRequestApproval(runId: string, input: { autopilot: boolean; approvedBy: string | null }): Promise<AppliedApproval> {
  const run = await getRun(runId);
  if (!run) throw new OutreachError("That outreach plan does not exist.");
  const approval = makeRequestApproval(run.plan, run.channels, { ...input, now: new Date() });
  if (!approval) return { started: [], skipped: [] };
  await db.update(outreachRuns)
    .set({ plan: sql`${outreachRuns.plan} || ${JSON.stringify({ requestApproval: approval })}::jsonb`, updatedAt: new Date() })
    .where(and(inOrg(outreachRuns), eq(outreachRuns.id, runId)));
  const waiting = await siblingPlans(run, "proposed");
  const result: AppliedApproval = { started: [], skipped: [] };
  for (const sibling of waiting) {
    const outcome = await startUnderApproval(sibling, approval, run.id);
    if (outcome.started) result.started.push({ runId: sibling.id, name: sibling.name });
    else result.skipped.push({ runId: sibling.id, name: sibling.name, reason: outcome.reason, ...(outcome.closed ? { closed: true } : {}) });
  }
  return result;
}

/** Runs of the same conversation and request, newest first. */
async function siblingPlans(run: RunRow, status?: string): Promise<RunRow[]> {
  if (!run.threadId || !run.plan.requestId) return [];
  return db.select().from(outreachRuns)
    .where(and(
      inOrg(outreachRuns),
      eq(outreachRuns.threadId, run.threadId),
      ne(outreachRuns.id, run.id),
      sql`${outreachRuns.plan} ->> 'requestId' = ${run.plan.requestId}`,
      ...(status ? [eq(outreachRuns.status, status as RunRow["status"])] : []),
    ))
    .orderBy(desc(outreachRuns.createdAt)).limit(50);
}

type StartOutcome =
  | { started: true; leads: number; leftOut: number }
  | { started: false; reason: string; closed?: boolean };

/**
 * Starts a plan of the request under the approval, when it covers it. As
 * in Autonomous mode, the people other plans already cover stay there and
 * the plan starts with the rest, enrolled under the organization's start
 * lock; people who may no longer be contacted are left out too; a plan
 * with nobody new is closed with the reason. The approver must still be a
 * member, and Automatic replies still need an owner or admin (else the
 * plan starts in Review mode).
 */
async function startUnderApproval(run: RunRow, approval: RequestApproval, approvingRunId: string): Promise<StartOutcome> {
  const approving = await getRun(approvingRunId);
  const problem = approvalProblem(approval, approving?.status ?? "missing", { plan: run.plan, channels: run.channels }, new Date());
  if (problem) return { started: false, reason: problem };
  if (approval.approvedBy && !(await userIsMember(approval.approvedBy))) return { started: false, reason: "the person who approved this request is no longer a member of the organization" };
  // The approving run's mode now: switched to Review, the rest of the request follows.
  const autopilot = approval.autopilot && approving!.autopilot && (!approval.approvedBy || await userMayAutomate(approval.approvedBy));
  const [availability, blocked] = await Promise.all([channelAvailability(), blockedPeople(run.plan.assignments)]);
  type Outcome =
    | { kind: "changed" }
    | { kind: "closed" | "failed"; problem: string; narrowed: NarrowedPlan }
    | { kind: "started"; narrowed: NarrowedPlan };
  const outcome = await db.transaction(async (tx): Promise<Outcome> => {
    await tx.execute(startLockSql());
    const current = await proposedRunForStart(tx, run.id);
    if (!current) return { kind: "changed" };
    const narrowed = await narrowPlan(tx, current, blocked, perDayFrom(availability));
    if (!narrowed.plan.assignments.length) {
      const reason = noNewLeadsReason(narrowed.total, narrowed.left);
      await closePlanWithoutLeads(tx, run.id, reason);
      return { kind: "closed", problem: reason, narrowed };
    }
    const broken = brokenChannelsProblem(narrowed.channels, availability);
    if (broken) {
      await saveNarrowedPlan(tx, run.id, narrowed);
      return { kind: "failed", problem: broken, narrowed };
    }
    // Recorded on the plan: a Start press in the same window must not read as this approval.
    const started = await claimOutreachStart(tx, run.id, { userId: approval.approvedBy, autopilot, plan: { ...narrowed.plan, startedUnder: approvingRunId }, channels: narrowed.channels });
    return started ? { kind: "started", narrowed } : { kind: "changed" };
  });
  if (outcome.kind === "changed") return { started: false, reason: "it was started or changed meanwhile" };
  if (outcome.kind === "failed") return { started: false, reason: outcome.problem };
  const leftOut = leftOutSentence(outcome.narrowed.left);
  if (outcome.kind === "closed") {
    if (run.threadId) {
      await addMessage({
        threadId: run.threadId,
        role: "event",
        content: `“${run.name}” was not started under your approval of this request: ${outcome.problem}. Nothing was sent for it and the plan is closed${outcome.narrowed.left.covered ? "; those people stay in the plans that already cover them" : ""}.`,
      });
    }
    return { started: false, reason: outcome.problem, closed: true };
  }
  const leads = outcome.narrowed.plan.assignments.length;
  if (run.threadId) {
    await addMessage({
      threadId: run.threadId,
      role: "event",
      content: `“${run.name}” started on its own under your approval of this request: ${leads} lead${leads === 1 ? "" : "s"}, ${autopilot ? "Automatic" : "Review"} replies, the same channels and limits.${leftOut ? ` ${leftOut}` : ""} Pause or stop it on its card.`,
    });
  }
  return { started: true, leads, leftOut: leftOutCount(outcome.narrowed.left) };
}

/**
 * A plan a finished search just prepared: started when a request approval
 * of the same request covers it, else left waiting for the owner's Start;
 * `closed` when it had nobody new to contact (the chat was told).
 */
export async function applyRequestApproval(runId: string): Promise<{ started: boolean; reason: string | null; closed?: boolean }> {
  const run = await getRun(runId);
  if (!run || run.status !== "proposed" || !run.plan.requestId) return { started: false, reason: null };
  for (const sibling of await siblingPlans(run)) {
    const approval = sibling.plan.requestApproval;
    if (!approval) continue;
    const outcome = await startUnderApproval(run, approval, sibling.id);
    return outcome.started ? { started: true, reason: null } : { started: false, reason: outcome.reason, ...(outcome.closed ? { closed: true } : {}) };
  }
  return { started: false, reason: null };
}

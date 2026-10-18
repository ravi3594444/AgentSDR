import "server-only";

import { and, count, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { members } from "@/lib/auth/schema";
import { channelRules } from "@/lib/channels/rules.server";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { APPROVER_PROBLEM, autoStartProblem, type AutonomyCaps } from "./autonomy";
import { brokenChannelsProblem, channelAvailability, claimOutreachStart, getRun, startLockSql } from "./outreach.server";
import { leftOutCount, leftOutSentence, noNewLeadsReason } from "./overlap";
import { blockedPeople, closePlanWithoutLeads, narrowPlan, perDayFrom, proposedRunForStart, saveNarrowedPlan, type NarrowedPlan } from "./overlap.server";
import { assistantJobs, assistantMessages, assistantThreads, outreachRuns } from "./schema";
import { addMessage, getThread } from "./threads.server";

/**
 * Autonomous mode, server side (rules in autonomy.ts): the per-chat switch,
 * the organization's daily caps, and starting a prepared plan on its own
 * through the same claim and launch job the Start button uses, so every
 * launch rule, sending limit and Do Not Contact check still applies.
 *
 * The plan is approved in the name of the owner or admin who turned the
 * switch on, checked again at each start (a person later made a member no
 * longer approves anything). Leaving out overlaps, counting the caps,
 * marking and enrolling happen in one transaction under the organization's
 * start lock, so two plans finishing at once can neither both slip under a
 * cap nor both enrol one person.
 */

const DAY_MS = 24 * 60 * 60_000;

export async function autonomyCaps(): Promise<AutonomyCaps> {
  const rules = await channelRules("general");
  return { runsPerDay: rules.autonomousRunsPerDay, leadsPerDay: rules.autonomousLeadsPerDay, searchesPerDay: rules.autonomousSearchesPerDay };
}

export async function threadAutonomy(threadId: string): Promise<{ on: boolean; by: string | null; at: Date | null }> {
  const thread = await getThread(threadId);
  return { on: Boolean(thread?.autonomous), by: thread?.autonomousBy ?? null, at: thread?.autonomousAt ?? null };
}

/** Whether this person is an owner or admin of the organization in scope (who may let replies be answered automatically). */
export async function userMayAutomate(userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const [row] = await db.select({ id: members.id }).from(members)
    .where(and(eq(members.organizationId, currentOrganizationId()), eq(members.userId, userId), sql`string_to_array(${members.role}, ',') && ARRAY['owner', 'admin']`))
    .limit(1);
  return Boolean(row);
}

/** Whether this person is still a member of the organization in scope (any role). */
export async function userIsMember(userId: string): Promise<boolean> {
  const [row] = await db.select({ id: members.id }).from(members)
    .where(and(eq(members.organizationId, currentOrganizationId()), eq(members.userId, userId)))
    .limit(1);
  return Boolean(row);
}

/** Turns the chat's Autonomous mode on (in `userId`'s name) or off; false when the chat does not exist. */
export async function setThreadAutonomous(threadId: string, on: boolean, userId: string | null): Promise<boolean> {
  const rows = await db.update(assistantThreads)
    .set(on ? { autonomous: true, autonomousBy: userId, autonomousAt: new Date() } : { autonomous: false, autonomousBy: null, autonomousAt: null })
    .where(and(inOrg(assistantThreads), eq(assistantThreads.id, threadId)))
    .returning({ id: assistantThreads.id });
  return rows.length > 0;
}

const SEARCH_JOB_KINDS = ["discovery", "linkedin_search", "web_discovery", "apify_instagram"] as const;

/** Lead searches started in the last 24 hours from chats that are in Autonomous mode. */
export async function autonomousSearchesToday(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(assistantJobs)
    .innerJoin(assistantThreads, eq(assistantThreads.id, assistantJobs.threadId))
    .where(and(
      inOrg(assistantJobs),
      inOrg(assistantThreads),
      eq(assistantThreads.autonomous, true),
      inArray(assistantJobs.kind, [...SEARCH_JOB_KINDS]),
      gte(assistantJobs.createdAt, new Date(Date.now() - DAY_MS)),
    ));
  return Number(row?.n ?? 0);
}

/** Who asked for this plan's outreach: the author of the request message, else whoever prepared the plan. */
async function requesterOf(run: NonNullable<Awaited<ReturnType<typeof getRun>>>): Promise<string | null> {
  if (run.plan.requestId) {
    const [message] = await db.select({ createdBy: assistantMessages.createdBy }).from(assistantMessages)
      .where(and(inOrg(assistantMessages), eq(assistantMessages.id, run.plan.requestId))).limit(1);
    if (message?.createdBy) return message.createdBy;
  }
  return run.createdBy ?? null;
}

export type AutoStartOutcome = {
  started: boolean;
  /** Why it did not start (already posted in the chat), or null. */
  reason: string | null;
  /** Autonomous mode is off: the plan waits for Start as usual, and nothing was posted. */
  off?: boolean;
  /** Nobody new to contact: the plan was closed with `reason`, and must not be offered for Start. */
  closed?: boolean;
  /** Leads it started with, and how many were left out (overlap.ts). */
  leads?: number;
  leftOut?: number;
};

/**
 * Starts a plan this chat just prepared, when the chat is in Autonomous
 * mode and the caps allow; posts what happened in the chat. People other
 * plans already cover are left out under the organization's start lock
 * and the plan starts with the rest, in the same transaction that enrols
 * them, so a plan starting at the same moment cannot take them too; so
 * are people who may no longer be contacted (Do Not Contact, opted out).
 * A plan with nobody new to contact is closed, with the reason. Otherwise
 * started false (with the reason, when there is one): the plan then waits
 * for the owner's Start as usual, already without the people left out.
 */
export async function autoStartPlan(threadId: string, runId: string): Promise<AutoStartOutcome> {
  const autonomy = await threadAutonomy(threadId);
  if (!autonomy.on) return { started: false, reason: null, off: true };
  const run = await getRun(runId);
  if (!run || run.status !== "proposed" || run.threadId !== threadId) return { started: false, reason: null };
  if (run.plan.kind === "inquiries") return { started: false, reason: "answering new inquiries always starts with your Start" };
  const caps = await autonomyCaps();
  // Both must be owners or admins: the one who turned Autonomous on, and the one who asked for this
  // outreach (a member writing in an autonomous chat does not start plans in an admin's name).
  const requester = await requesterOf(run);
  const [approverAllowed, requesterAllowed] = await Promise.all([userMayAutomate(autonomy.by), userMayAutomate(requester)]);
  if (!approverAllowed || !requesterAllowed) {
    await addMessage({ threadId, role: "event", content: `“${run.name}” was not started on its own because ${APPROVER_PROBLEM}. Check it and press Start, or leave it.` });
    return { started: false, reason: APPROVER_PROBLEM };
  }
  // Rechecked now, not trusted from when the plan was prepared: the channels' senders, and who may still be contacted.
  const [availability, blocked] = await Promise.all([channelAvailability(), blockedPeople(run.plan.assignments)]);
  type Outcome =
    | { kind: "changed" }
    | { kind: "waiting" | "failed"; problem: string; narrowed: NarrowedPlan }
    | { kind: "closed"; problem: string; narrowed: NarrowedPlan }
    | { kind: "started"; narrowed: NarrowedPlan };
  const outcome = await db.transaction(async (tx): Promise<Outcome> => {
    await tx.execute(startLockSql());
    const current = await proposedRunForStart(tx, runId);
    if (!current) return { kind: "changed" };
    // Read under the lock: people in a running plan, or enrolled by a plan this lock just let start.
    const narrowed = await narrowPlan(tx, current, blocked, perDayFrom(availability));
    if (!narrowed.plan.assignments.length) {
      const problem = noNewLeadsReason(narrowed.total, narrowed.left);
      await closePlanWithoutLeads(tx, runId, problem);
      return { kind: "closed", problem, narrowed };
    }
    const since = new Date(Date.now() - DAY_MS).toISOString();
    const [today] = await tx.select({
      runs: count(),
      leads: sql<number>`coalesce(sum(jsonb_array_length(coalesce(${outreachRuns.plan} -> 'assignments', '[]'::jsonb))), 0)::int`,
    }).from(outreachRuns)
      .where(and(inOrg(outreachRuns), sql`(${outreachRuns.plan} ->> 'autonomous') = 'true'`, sql`(${outreachRuns.plan} ->> 'autonomousAt')::timestamptz >= ${since}::timestamptz`));
    // The caps count the leads it would contact, after the overlaps are left out.
    const problem = autoStartProblem({
      runsToday: Number(today?.runs ?? 0),
      leadsToday: Number(today?.leads ?? 0),
      planLeads: narrowed.plan.assignments.length,
      approverAllowed: true,
    }, caps);
    const broken = problem ? null : brokenChannelsProblem(narrowed.channels, availability);
    if (problem || broken) {
      // It waits for the owner's Start without the people left out: Start enrols only who is left.
      await saveNarrowedPlan(tx, runId, narrowed);
      return problem ? { kind: "waiting", problem, narrowed } : { kind: "failed", problem: broken!, narrowed };
    }
    // Marked inside the lock as it starts, so a plan starting next counts it toward the caps.
    const plan = { ...narrowed.plan, autonomous: true, autonomousAt: new Date().toISOString() };
    const started = await claimOutreachStart(tx, runId, { userId: autonomy.by, autopilot: true, plan, channels: narrowed.channels });
    return started ? { kind: "started", narrowed } : { kind: "changed" };
  });

  if (outcome.kind === "changed") {
    const reason = "it was started or changed meanwhile";
    await addMessage({ threadId, role: "event", content: `“${run.name}” was not started on its own because ${reason}.` });
    return { started: false, reason };
  }
  const leftOut = leftOutSentence(outcome.narrowed.left);
  const leftOutTotal = leftOutCount(outcome.narrowed.left);
  if (outcome.kind === "closed") {
    await addMessage({
      threadId,
      role: "event",
      content: `“${run.name}” was not started: ${outcome.problem}. Nothing was sent for it and the plan is closed${outcome.narrowed.left.covered ? "; those people stay in the plans that already cover them" : ""}.`,
    });
    return { started: false, reason: outcome.problem, closed: true, leads: 0, leftOut: leftOutTotal };
  }
  if (outcome.kind === "waiting") {
    await addMessage({ threadId, role: "event", content: `“${run.name}” was not started on its own because ${outcome.problem}.${leftOut ? ` ${leftOut}` : ""} Check it and press Start, or leave it.` });
    return { started: false, reason: outcome.problem, leftOut: leftOutTotal };
  }
  if (outcome.kind === "failed") {
    await addMessage({ threadId, role: "event", content: `“${run.name}” could not start on its own: ${outcome.problem}${leftOut ? ` ${leftOut}` : ""}` });
    return { started: false, reason: outcome.problem, leftOut: leftOutTotal };
  }
  const leads = outcome.narrowed.plan.assignments.length;
  await addMessage({
    threadId,
    role: "event",
    content: `“${run.name}” started on its own (Autonomous mode): ${leads} lead${leads === 1 ? "" : "s"}, Automatic replies, within each channel's sending hours and daily limits.${leftOut ? ` ${leftOut}` : ""} Pause or stop it on its card.`,
  });
  return { started: true, reason: null, leads, leftOut: leftOutTotal };
}

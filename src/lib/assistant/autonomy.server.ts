import "server-only";

import { and, count, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { members } from "@/lib/auth/schema";
import { channelRules } from "@/lib/channels/rules.server";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { autoStartProblem, type AutonomyCaps } from "./autonomy";
import { getRun, startOutreachRun } from "./outreach.server";
import { peopleInActiveRuns } from "./requestApproval.server";
import { assistantJobs, assistantThreads, outreachRuns } from "./schema";
import { addMessage, getThread } from "./threads.server";

/**
 * Autonomous mode, server side (rules in autonomy.ts): the per-chat switch,
 * the organization's daily caps, and starting a prepared plan on its own
 * through the same startOutreachRun the Start button calls, so every
 * launch rule, sending limit and Do Not Contact check still applies.
 *
 * The plan is approved in the name of the owner or admin who turned the
 * switch on, checked again at each start (a person later made a member no
 * longer approves anything). Counting and marking happen under one
 * advisory lock per organization, so two plans finishing at once cannot
 * both slip under a cap.
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

/**
 * Starts a plan this chat just prepared, when the chat is in Autonomous
 * mode and the caps allow; posts what happened in the chat. Returns
 * started false (with the reason, when there is one) otherwise: the plan
 * then waits for the owner's Start as usual.
 */
export async function autoStartPlan(threadId: string, runId: string): Promise<{ started: boolean; reason: string | null }> {
  const autonomy = await threadAutonomy(threadId);
  if (!autonomy.on) return { started: false, reason: null };
  const run = await getRun(runId);
  if (!run || run.status !== "proposed" || run.threadId !== threadId) return { started: false, reason: null };
  if (run.plan.kind === "inquiries") return { started: false, reason: "answering new inquiries always starts with your Start" };
  const organizationId = currentOrganizationId();
  const caps = await autonomyCaps();
  const [approverAllowed, busyPeople] = await Promise.all([
    userMayAutomate(autonomy.by),
    peopleInActiveRuns(run.plan.assignments.map((assignment) => assignment.personId)),
  ]);
  const claimed = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`autonomous:${organizationId}`}, 0))`);
    const since = new Date(Date.now() - DAY_MS).toISOString();
    const [today] = await tx.select({
      runs: count(),
      leads: sql<number>`coalesce(sum(jsonb_array_length(coalesce(${outreachRuns.plan} -> 'assignments', '[]'::jsonb))), 0)::int`,
    }).from(outreachRuns)
      .where(and(inOrg(outreachRuns), sql`(${outreachRuns.plan} ->> 'autonomous') = 'true'`, sql`(${outreachRuns.plan} ->> 'autonomousAt')::timestamptz >= ${since}::timestamptz`));
    const problem = autoStartProblem({
      runsToday: Number(today?.runs ?? 0),
      leadsToday: Number(today?.leads ?? 0),
      planLeads: run.plan.assignments.length,
      busyPeople,
      approverAllowed,
    }, caps);
    if (problem) return { problem };
    // Marked before the start, inside the lock, so a plan starting at the same moment counts it.
    const marked = await tx.update(outreachRuns)
      .set({ plan: sql`${outreachRuns.plan} || ${JSON.stringify({ autonomous: true, autonomousAt: new Date().toISOString() })}::jsonb`, updatedAt: new Date() })
      .where(and(inOrg(outreachRuns), eq(outreachRuns.id, runId), eq(outreachRuns.status, "proposed")))
      .returning({ id: outreachRuns.id });
    return marked.length ? { problem: null } : { problem: "it was started or changed meanwhile" };
  });
  if (claimed.problem) {
    await addMessage({ threadId, role: "event", content: `“${run.name}” was not started on its own because ${claimed.problem}. Check it and press Start, or leave it.` });
    return { started: false, reason: claimed.problem };
  }
  try {
    await startOutreachRun(runId, autonomy.by, { autopilot: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Not started: it does not count toward the caps.
    await db.update(outreachRuns)
      .set({ plan: sql`(${outreachRuns.plan} - 'autonomous') - 'autonomousAt'`, updatedAt: new Date() })
      .where(and(inOrg(outreachRuns), eq(outreachRuns.id, runId), eq(outreachRuns.status, "proposed")));
    await addMessage({ threadId, role: "event", content: `“${run.name}” could not start on its own: ${reason}` });
    return { started: false, reason };
  }
  await addMessage({
    threadId,
    role: "event",
    content: `“${run.name}” started on its own (Autonomous mode): ${run.plan.assignments.length} leads, Automatic replies, within each channel's sending hours and daily limits. Pause or stop it on its card.`,
  });
  return { started: true, reason: null };
}

import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { loadPersonFacts } from "./audiences.server";
import type { channelAvailability } from "./outreach.server";
import { OVERLAP_REASON, planChannels, planWithoutPeople, type LeftOut, type PlanPerDay } from "./overlap";
import { outreachRunLeads, outreachRuns, type AudienceChannel, type OutreachPlan } from "./schema";

/**
 * Overlaps, server side (overlap.ts): which of a plan's people another plan
 * already covers, which may not be contacted at all any more, and the plan
 * that can start without them. A plan starting on its own (Autonomous
 * mode, a request approval) is narrowed this way under the organization's
 * start lock (outreach.server.ts startLockSql) right before it enrols, so
 * the people it enrols are exactly the ones no other plan holds.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = Pick<typeof db, "selectDistinct">;
type RunRow = typeof outreachRuns.$inferSelect;

/** Which of these people are active in a run that is starting, running or paused. */
export async function peopleInActiveRuns(personIds: readonly string[], executor: Executor = db): Promise<Set<string>> {
  if (!personIds.length) return new Set();
  const rows = await executor.selectDistinct({ personId: outreachRunLeads.personId }).from(outreachRunLeads)
    .innerJoin(outreachRuns, eq(outreachRuns.id, outreachRunLeads.runId))
    .where(and(
      inOrg(outreachRunLeads),
      inArray(outreachRunLeads.personId, [...personIds]),
      eq(outreachRunLeads.status, "active"),
      inArray(outreachRuns.status, ["starting", "running", "paused"]),
    ));
  return new Set(rows.map((row) => row.personId));
}

/**
 * The people of `runId`'s plan another plan already covers: active in a
 * starting, running or paused run, or in another plan already marked to
 * start on its own whose people are not enrolled yet. Read under the start
 * lock, with its transaction.
 */
export async function coveredPeople(tx: Tx, runId: string, personIds: readonly string[]): Promise<Set<string>> {
  if (!personIds.length) return new Set();
  const covered = await peopleInActiveRuns(personIds, tx);
  const pending = Array.from(await tx.execute(sql`
    select distinct a.value ->> 'personId' as person_id
    from outreach_runs r, jsonb_array_elements(coalesce(r.plan -> 'assignments', '[]'::jsonb)) as a(value)
    where r.organization_id = ${currentOrganizationId()} and r.id <> ${runId}
      and (r.plan ->> 'autonomous') = 'true' and r.status = 'proposed'
      and (a.value ->> 'personId') in (${sql.join(personIds.map((id) => sql`${id}`), sql`, `)})`)) as { person_id: string }[];
  for (const row of pending) covered.add(row.person_id);
  return covered;
}

/**
 * Why each of these people may not be contacted now, by person: no longer
 * in this organization's leads, Do Not Contact, opted out of a run, or (on
 * email) on the suppression list. People who may be contacted are absent.
 */
export async function blockedPeople(assignments: OutreachPlan["assignments"]): Promise<Map<string, string>> {
  const blocked = new Map<string, string>();
  if (!assignments.length) return blocked;
  const ids = assignments.map((assignment) => assignment.personId);
  const [facts, optedOut] = await Promise.all([
    loadPersonFacts(ids),
    db.selectDistinct({ personId: outreachRunLeads.personId }).from(outreachRunLeads)
      .where(and(inOrg(outreachRunLeads), inArray(outreachRunLeads.personId, ids), eq(outreachRunLeads.status, "opted_out"))),
  ]);
  const opted = new Set(optedOut.map((row) => row.personId));
  for (const assignment of assignments) {
    const person = facts.get(assignment.personId);
    const reason = !person
      ? "no longer in your leads"
      : person.doNotContact
        ? "marked Do Not Contact"
        : opted.has(assignment.personId) || (assignment.channel === "email" && person.emailSuppressed)
          ? "opted out"
          : null;
    if (reason) blocked.set(assignment.personId, reason);
  }
  return blocked;
}

/** Sends a day per channel across its senders, as prepareOutreach estimates a plan's days. */
export function perDayFrom(availability: Awaited<ReturnType<typeof channelAvailability>>): PlanPerDay {
  const channels: AudienceChannel[] = ["email", "whatsapp", "linkedin", "instagram"];
  return Object.fromEntries(channels.map((channel) => [channel, (availability[channel].senders || 1) * (availability[channel].perSenderPerDay ?? 20)]));
}

export type NarrowedPlan = {
  plan: OutreachPlan;
  channels: AudienceChannel[];
  /** Leads before narrowing. */
  total: number;
  left: LeftOut;
  /** Whether anyone was left out (the plan differs from the stored one). */
  changed: boolean;
};

/**
 * The plan as it can start now, under the start lock: without the people
 * other plans cover (they stay there) and without `blocked` people (read
 * before the lock: Do Not Contact only ever grows meanwhile, and every
 * engine checks it again before each send).
 */
export async function narrowPlan(tx: Tx, run: RunRow, blocked: Map<string, string>, perDay: PlanPerDay): Promise<NarrowedPlan> {
  const total = run.plan.assignments.length;
  const covered = await coveredPeople(tx, run.id, run.plan.assignments.map((assignment) => assignment.personId));
  let plan = planWithoutPeople(run.plan, covered, { reason: OVERLAP_REASON, perDay });
  const byReason = new Map<string, string[]>();
  for (const [personId, reason] of blocked) {
    if (covered.has(personId)) continue;
    byReason.set(reason, [...(byReason.get(reason) ?? []), personId]);
  }
  for (const [reason, personIds] of byReason) plan = planWithoutPeople(plan, personIds, { reason, perDay });
  const inPlan = new Set(run.plan.assignments.map((assignment) => assignment.personId));
  const left: LeftOut = {
    covered: [...covered].filter((personId) => inPlan.has(personId)).length,
    blocked: [...byReason].map(([reason, personIds]) => ({ reason, count: personIds.filter((personId) => inPlan.has(personId)).length })).filter((item) => item.count > 0),
  };
  return { plan, channels: planChannels(plan, run.channels), total, left, changed: plan !== run.plan };
}

/** The run, read under the start lock, while it is still a proposed plan; else null. */
export async function proposedRunForStart(tx: Tx, runId: string): Promise<RunRow | null> {
  const [run] = await tx.select().from(outreachRuns)
    .where(and(inOrg(outreachRuns), eq(outreachRuns.id, runId), eq(outreachRuns.status, "proposed"))).limit(1);
  return run ?? null;
}

/** Keeps a narrowed plan on its run while it waits for the owner's Start, so Start enrols only who is left. */
export async function saveNarrowedPlan(tx: Tx, runId: string, narrowed: NarrowedPlan): Promise<void> {
  if (!narrowed.changed) return;
  await tx.update(outreachRuns)
    .set({ plan: narrowed.plan, channels: narrowed.channels, updatedAt: new Date() })
    .where(and(inOrg(outreachRuns), eq(outreachRuns.id, runId), eq(outreachRuns.status, "proposed")));
}

/**
 * Closes a plan none of whose leads can be contacted any more (every one is
 * covered by another plan or blocked): it is discarded with the reason, so
 * it neither starts nor waits for a Start that would contact nobody new.
 */
export async function closePlanWithoutLeads(tx: Tx, runId: string, reason: string): Promise<void> {
  await tx.update(outreachRuns)
    .set({ status: "cancelled", error: reason.replace(/^./, (c) => c.toUpperCase()), updatedAt: new Date() })
    .where(and(inOrg(outreachRuns), eq(outreachRuns.id, runId), eq(outreachRuns.status, "proposed")));
}

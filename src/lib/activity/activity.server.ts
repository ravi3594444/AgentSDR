import "server-only";

import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { assistantJobs, assistantThreads, outreachRuns } from "@/lib/assistant/schema";
import { displayThreadTitle } from "@/lib/assistant/agent";
import { requestSpendLine } from "@/lib/assistant/objective";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { crmNeedsYouSql, RAW_RECORD_COLUMNS } from "@/lib/crm/actionGroups.server";
import { contactDisplayName } from "@/lib/crm/contactName";
import { activitySeen } from "./schema";
import { diagnoseDelivery } from "@/lib/assistant/deliveryDiagnostics.server";
import { runLeads } from "@/lib/assistant/runLeads.server";
import { CANCELLABLE_JOB_KINDS, canCancelJob, jobState, OPEN_STATES, planCounts, planState, REPLY_STATE_LABELS, replyState, WORK_STATE_LABELS, type ReplyState, type WorkState } from "./status";

/**
 * Activity: the organization's background work and the replies it brought,
 * across every chat — read-only views of the records the work already
 * keeps (assistant_jobs, outreach_runs, CRM conversations). Looking at them
 * never starts, approves, answers or sends anything; the only writes here
 * are a person's "replies seen" time and cancelling a job on request.
 */

const WINDOW_DAYS = 7;

export type WorkItem = {
  id: string;
  type: "job" | "plan";
  kind: string;
  title: string;
  source: string | null;
  state: WorkState;
  stateLabel: string;
  reason: string | null;
  open: boolean;
  threadId: string | null;
  threadTitle: string | null;
  startedAt: string;
  updatedAt: string | null;
  found: number | null;
  eligible: number | null;
  /** Plans: the existing run controls apply (POST /api/assistant/runs/[id]), by the run's own status. */
  runId: string | null;
  runStatus: string | null;
  /** Plans: the earliest time a held sender may send again, shown in the viewer's time. */
  nextAt: string | null;
  /** Plans: their people, those contacted (accepted for sending at least), those who replied and those whose send failed. */
  counts: { leads: number; contacted: number; replied: number; failed: number } | null;
  canCancel: boolean;
  /** The owner request (its message id) this search or plan was started for; null for older work. */
  requestId: string | null;
  /** Plans: the channels they send on. */
  channels: string[] | null;
};

/** Which work to list: the open work and the last `days` days (7 by default), or exactly these jobs and plans. */
export type WorkFilter = { days?: number; jobIds?: readonly string[]; runIds?: readonly string[] };

/** The owner request a search was started for: its own id, or the outreach request it was to contact leads for. */
export function jobRequestId(payload: unknown): string | null {
  const value = (payload ?? {}) as { requestMessageId?: unknown; contactAfter?: { requestId?: unknown } | null };
  return typeof value.requestMessageId === "string" ? value.requestMessageId
    : typeof value.contactAfter?.requestId === "string" ? value.contactAfter.requestId : null;
}

/** Running plans whose senders Activity looks at (the newest), so the list stays a quick read. */
const SENDER_CHECKS = 5;

const JOB_TITLES: Record<string, string> = {
  discovery: "Lead search",
  web_discovery: "Website and directory search",
  linkedin_search: "LinkedIn people search",
  apify_instagram: "Instagram search",
  outreach_start: "Starting outreach",
  objective: "Lead request",
};

/** A lead request's spend against its cap ("$1.20 of $5.00 spent"), from its driver job's progress or result. */
function spendOf(facts: { spentUsd?: unknown; spendCapUsd?: unknown }): string | null {
  return typeof facts.spentUsd === "number" && typeof facts.spendCapUsd === "number" ? requestSpendLine(facts.spentUsd, facts.spendCapUsd) : null;
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/** Open work first, then the window's finished work (or exactly the listed jobs and plans), newest first. */
export async function listWork(now = new Date(), filter: WorkFilter = {}): Promise<WorkItem[]> {
  const since = new Date(now.getTime() - (filter.days ?? WINDOW_DAYS) * 86_400_000);
  const exact = Boolean(filter.jobIds || filter.runIds);
  const jobIds = [...(filter.jobIds ?? [])];
  const runIds = [...(filter.runIds ?? [])];
  const jobs = exact && !jobIds.length ? [] : await db.select({ job: assistantJobs, threadTitle: assistantThreads.title }).from(assistantJobs)
    .leftJoin(assistantThreads, and(eq(assistantThreads.id, assistantJobs.threadId), eq(assistantThreads.organizationId, assistantJobs.organizationId)))
    .where(and(inOrg(assistantJobs), exact ? inArray(assistantJobs.id, jobIds) : or(inArray(assistantJobs.status, ["queued", "running"]), gte(assistantJobs.createdAt, since))))
    .orderBy(desc(assistantJobs.createdAt)).limit(exact ? 200 : 80);
  const runs = exact && !runIds.length ? [] : await db.select({ run: outreachRuns, threadTitle: assistantThreads.title }).from(outreachRuns)
    .leftJoin(assistantThreads, and(eq(assistantThreads.id, outreachRuns.threadId), eq(assistantThreads.organizationId, outreachRuns.organizationId)))
    .where(and(inOrg(outreachRuns), exact ? inArray(outreachRuns.id, runIds) : or(inArray(outreachRuns.status, ["proposed", "starting", "running", "paused"]), gte(outreachRuns.createdAt, since))))
    .orderBy(desc(outreachRuns.createdAt)).limit(exact ? 100 : 40);
  const items: WorkItem[] = [];
  for (const { job, threadTitle } of jobs) {
    const { state, reason: stateReason } = jobState(job, now);
    const payload = (job.payload ?? {}) as { phrase?: unknown; criteria?: { customers?: unknown; where?: unknown } };
    const progress = (job.progress ?? {}) as { source?: unknown; leads?: unknown; spentUsd?: unknown; spendCapUsd?: unknown };
    const result = (job.result ?? {}) as { found?: unknown; eligible?: unknown; spentUsd?: unknown; spendCapUsd?: unknown };
    // A lead request says what it spent of its cap.
    const spent = job.kind === "objective" ? spendOf(result) ?? spendOf(progress) : null;
    const reason = spent ? [stateReason, spent].filter(Boolean).join("; ") : stateReason;
    const phrase = typeof payload.phrase === "string" ? payload.phrase : null;
    items.push({
      id: job.id,
      type: "job",
      kind: job.kind,
      title: `${JOB_TITLES[job.kind] ?? job.kind}${phrase ? `: ${phrase}` : ""}`,
      source: typeof progress.source === "string" ? progress.source : null,
      state,
      stateLabel: WORK_STATE_LABELS[state],
      reason: reason ?? (job.status === "failed" ? job.error : null),
      open: OPEN_STATES.has(state),
      threadId: job.threadId,
      threadTitle: job.threadId ? displayThreadTitle(threadTitle) : null,
      startedAt: job.createdAt.toISOString(),
      updatedAt: iso(job.finishedAt ?? job.heartbeatAt),
      // A lead request counts the qualified leads its searches found so far.
      found: typeof result.found === "number" ? result.found : job.kind === "objective" && typeof progress.leads === "number" ? progress.leads : null,
      eligible: typeof result.eligible === "number" ? result.eligible : null,
      runId: null,
      runStatus: null,
      nextAt: null,
      counts: null,
      canCancel: canCancelJob(job),
      requestId: jobRequestId(job.payload),
      channels: null,
    });
  }
  const started = runs.filter(({ run }) => run.status !== "proposed" && run.status !== "cancelled").map(({ run }) => run.id);
  // Every lead, not the card's first 200, so a large plan's counts are whole.
  const leads = await runLeads(started, Number.POSITIVE_INFINITY);
  const senders = new Map(await Promise.all(runs.filter(({ run }) => run.status === "running").slice(0, SENDER_CHECKS).map(async ({ run }) => {
    // A snapshot that cannot be read leaves the plan's state to its status.
    const snapshot = await diagnoseDelivery(run.id).catch(() => null);
    return [run.id, snapshot?.senders ?? null] as const;
  })));
  for (const { run, threadTitle } of runs) {
    // Its leads say whether anything is left to send; reading them changes nothing.
    const { state, reason, open, nextAt } = planState({ status: run.status, error: run.error, senders: senders.get(run.id) ?? null, leads: started.includes(run.id) ? leads[run.id] ?? null : null });
    items.push({
      id: run.id,
      type: "plan",
      kind: "outreach",
      title: `Outreach plan: ${run.name}`,
      source: null,
      state,
      stateLabel: WORK_STATE_LABELS[state],
      reason,
      open,
      threadId: run.threadId,
      threadTitle: run.threadId ? displayThreadTitle(threadTitle) : null,
      startedAt: run.createdAt.toISOString(),
      updatedAt: null,
      found: null,
      eligible: null,
      runId: run.id,
      runStatus: run.status,
      nextAt,
      counts: started.includes(run.id) ? planCounts(leads[run.id] ?? []) : null,
      canCancel: false,
      requestId: typeof run.plan?.requestId === "string" ? run.plan.requestId : null,
      channels: [...run.channels],
    });
  }
  return items.sort((a, b) => Number(b.open) - Number(a.open) || b.startedAt.localeCompare(a.startedAt));
}

/**
 * Cancels a queued or running search: no further step runs; a step already
 * under way has its outcome discarded. Any other job (starting an outreach
 * plan) is refused: the plan is paused or stopped through its own controls.
 */
export async function cancelJob(jobId: string): Promise<boolean> {
  const [row] = await db.update(assistantJobs)
    .set({ status: "cancelled", lockedBy: null, heartbeatAt: null, finishedAt: new Date(), error: "Cancelled by the owner" })
    .where(and(inOrg(assistantJobs), eq(assistantJobs.id, jobId), inArray(assistantJobs.kind, [...CANCELLABLE_JOB_KINDS]), inArray(assistantJobs.status, ["queued", "running"])))
    .returning({ id: assistantJobs.id });
  return Boolean(row);
}

export type ReplyItem = {
  messageId: string;
  recordId: string;
  personName: string;
  channel: string;
  account: string;
  receivedAt: string;
  /** When AgentSDR recorded it, which is what "new" is judged by (a replayed webhook can record an older message late). */
  recordedAt: string;
  preview: string;
  state: ReplyState;
  stateLabel: string;
  isNew: boolean;
  runId: string | null;
  runName: string | null;
  threadId: string | null;
};

type ReplyRow = {
  id: string; channel: string; account_ref: string; sent_at: Date | string; created_at: Date | string; preview: string; crm_record_id: string;
  workflow_state: string | null; needs_you: boolean; answered: boolean; latest: boolean; run_id: string | null; run_name: string | null; thread_id: string | null;
  full_name: string | null; first_name: string | null; last_name: string | null; email: string | null; phone: string | null;
  linkedin_url: string | null; company: string | null; instagram: string | null;
};

/** Recorded incoming messages on every channel, newest first, with where each stands. */
export async function listReplies(input: { userId: string | null; channel?: string | null; limit?: number }): Promise<{ replies: ReplyItem[]; seenAt: string | null }> {
  const org = currentOrganizationId();
  const seen = input.userId ? await repliesSeenAt(input.userId) : null;
  const since = newSince(seen);
  const rows = await db.execute<ReplyRow>(sql`
    SELECT m.id, m.channel, m.account_ref, m.sent_at, m.created_at, left(m.body_text, 240) AS preview, c.crm_record_id, r.workflow_state,
      ${crmNeedsYouSql(RAW_RECORD_COLUMNS)} AS needs_you,
      p.full_name, p.first_name, p.last_name, p.email, p.phone, p.linkedin_url,
      coalesce(nullif(co.name, ''), p.raw->>'businessName') AS company, p.raw->'instagram'->>'username' AS instagram,
      EXISTS (SELECT 1 FROM crm_conversation_messages o WHERE o.conversation_id = m.conversation_id AND o.direction = 'outbound' AND o.sent_at > m.sent_at) AS answered,
      NOT EXISTS (SELECT 1 FROM crm_conversation_messages n WHERE n.conversation_id = m.conversation_id AND n.direction = 'inbound' AND n.sent_at > m.sent_at) AS latest,
      run.id AS run_id, run.name AS run_name, run.thread_id
    FROM crm_conversation_messages m
    JOIN crm_conversations c ON c.id = m.conversation_id AND c.organization_id = ${org}
    JOIN crm_records r ON r.id = c.crm_record_id AND r.organization_id = ${org}
    JOIN people p ON p.id = m.person_id AND p.organization_id = ${org}
    LEFT JOIN companies co ON co.id = p.company_id AND co.organization_id = ${org}
    LEFT JOIN LATERAL (
      SELECT o.id, o.name, o.thread_id FROM outreach_run_leads l JOIN outreach_runs o ON o.id = l.run_id AND o.organization_id = ${org}
      WHERE l.person_id = m.person_id AND l.organization_id = ${org} AND o.created_at <= m.sent_at
      ORDER BY o.created_at DESC LIMIT 1
    ) run ON true
    WHERE m.direction = 'inbound' ${input.channel ? sql`AND m.channel = ${input.channel}` : sql``}
    ORDER BY m.sent_at DESC
    LIMIT ${Math.min(Math.max(input.limit ?? 60, 1), 200)}`);
  const replies = rows.map((row): ReplyItem => {
    const receivedAt = new Date(row.sent_at);
    const recordedAt = new Date(row.created_at);
    const state = replyState({ answered: Boolean(row.answered), latest: Boolean(row.latest), workflowState: row.workflow_state, needsYou: Boolean(row.needs_you) });
    return {
      messageId: row.id,
      recordId: row.crm_record_id,
      // Their name, else the business and the route they wrote from — never "Unknown contact" alone when either is known.
      personName: contactDisplayName({
        fullName: row.full_name, firstName: row.first_name, lastName: row.last_name, company: row.company,
        email: row.email, phone: row.phone, instagram: row.instagram, linkedin: row.linkedin_url, channel: row.channel,
      }),
      channel: row.channel,
      account: row.account_ref,
      receivedAt: receivedAt.toISOString(),
      recordedAt: recordedAt.toISOString(),
      preview: row.preview.replace(/\s+/g, " ").trim(),
      state,
      stateLabel: REPLY_STATE_LABELS[state],
      // The badge's rule (newRepliesCount), to the millisecond: recorded after the seen time, or within the last week before a first visit.
      isNew: recordedAt.getTime() > since.getTime(),
      runId: row.run_id,
      runName: row.run_name,
      threadId: row.thread_id,
    };
  });
  return { replies, seenAt: seen?.toISOString() ?? null };
}

async function repliesSeenAt(userId: string): Promise<Date | null> {
  const [row] = await db.select({ at: activitySeen.repliesSeenAt }).from(activitySeen)
    .where(and(inOrg(activitySeen), eq(activitySeen.userId, userId))).limit(1);
  return row?.at ?? null;
}

/** Replies recorded after this time are new: the person's seen time, or the last week before their first visit. */
function newSince(seen: Date | null): Date {
  return seen ?? new Date(Date.now() - WINDOW_DAYS * 86_400_000);
}

/**
 * The person has looked at the replies list: what was recorded until `at`
 * (the newest reply the list showed; now, if not given) is no longer new to
 * them. Held to now, and never moved back by an older look.
 */
export async function markRepliesSeen(userId: string, at = new Date()): Promise<void> {
  const until = new Date(Math.min(at.getTime(), Date.now()));
  await db.insert(activitySeen).values({ organizationId: currentOrganizationId(), userId, repliesSeenAt: until })
    .onConflictDoUpdate({
      target: [activitySeen.organizationId, activitySeen.userId],
      set: { repliesSeenAt: sql`greatest(activity_seen.replies_seen_at, excluded.replies_seen_at)` },
    });
}

/** Replies recorded since the person last looked (or in the last week, if never), for the navigation badge. */
export async function newRepliesCount(userId: string | null): Promise<number> {
  if (!userId) return 0;
  const org = currentOrganizationId();
  const since = newSince(await repliesSeenAt(userId));
  // Compared to the millisecond, as listReplies compares the times it returns.
  const [row] = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM crm_conversation_messages m
    JOIN crm_conversations c ON c.id = m.conversation_id AND c.organization_id = ${org}
    WHERE m.direction = 'inbound' AND date_trunc('milliseconds', m.created_at) > ${since.toISOString()}::timestamptz`);
  return Number(row?.n ?? 0);
}

/** Background work still open, for the navigation badge. */
export async function openWorkCount(): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(assistantJobs)
    .where(and(inOrg(assistantJobs), inArray(assistantJobs.status, ["queued", "running"])));
  return Number(row?.n ?? 0);
}

import "server-only";

import { and, desc, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { authContextErrorResponse, can, requireOrgContext, type OrgContext } from "@/lib/auth/context";
import { crmRequestErrorResponse, requireCrmMutationContext } from "@/lib/crm/http";
import { inOrg, runInOrganization } from "@/lib/tenancy/scope";
import { users } from "@/lib/auth/schema";
import { assistantJobs, outreachRuns, ownerDecisions, type AssistantJobKind, type OutreachPlan } from "./schema";
import type { RequestApproval } from "./requestApproval";
import { coveringApproval, runAuthorization, type RunAuthorization } from "./runEvidence";
import { runLeads } from "./runLeads.server";
import { runReplies } from "./runReplies.server";
import { listMessages, listThreads, resolveThread, threadBusy } from "./threads.server";
import { setupSnapshot } from "./tools.server";
import { autonomyCaps } from "./autonomy.server";
import { organizationTimeZone } from "@/lib/reporting/metrics.server";

/**
 * Route plumbing for /api/assistant/*: the signed-in member and their
 * organization (same-origin required for anything that changes state), the
 * scope opened once, and auth failures as the usual JSON errors.
 */
export async function assistantRoute(
  request: Request,
  options: { mutation: boolean },
  handler: (ctx: OrgContext) => Promise<Response>,
): Promise<Response> {
  try {
    const ctx = options.mutation ? await requireCrmMutationContext(request) : await requireOrgContext(request);
    return await runInOrganization(ctx.organizationId, () => handler(ctx));
  } catch (error) {
    const response = crmRequestErrorResponse(error) ?? authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

/** Owners and admins: the reply autopilot is an AI-settings decision. */
export function canManageAutopilot(ctx: OrgContext): boolean {
  return can(ctx, { aiSettings: ["manage"] });
}

const JOB_COLUMNS = {
  id: assistantJobs.id,
  kind: assistantJobs.kind,
  status: assistantJobs.status,
  stage: assistantJobs.stage,
  progress: assistantJobs.progress,
  result: assistantJobs.result,
  error: assistantJobs.error,
  audienceId: assistantJobs.audienceId,
  runId: assistantJobs.runId,
  createdAt: assistantJobs.createdAt,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Jobs that share a list without being its search: a request's driver and the job that starts a plan. */
const NOT_SEARCHES: AssistantJobKind[] = ["objective", "outreach_start"];

/** Ids in a message's data: its job (a search's card) and the lists a final report covers. */
function referencedIds(messages: readonly { toolResult: unknown }[]): { jobIds: string[]; audienceIds: string[] } {
  const jobIds = new Set<string>();
  const audienceIds = new Set<string>();
  for (const message of messages) {
    const data = (message.toolResult as { data?: { jobId?: unknown; audienceIds?: unknown } } | null)?.data;
    if (typeof data?.jobId === "string" && UUID.test(data.jobId)) jobIds.add(data.jobId);
    if (Array.isArray(data?.audienceIds)) for (const id of data.audienceIds) if (typeof id === "string" && UUID.test(id)) audienceIds.add(id);
  }
  return { jobIds: [...jobIds], audienceIds: [...audienceIds] };
}

/** Everything the chat page shows for one thread; `withSetup` adds the (slower) connection status. */
export async function assistantState(threadId: string | null, ctx: OrgContext, withSetup: boolean) {
  const thread = await resolveThread(threadId, ctx.userId);
  const [messages, threads, busy, timeZone, newest] = await Promise.all([
    listMessages(thread.id),
    listThreads(20),
    threadBusy(thread.id),
    // The one zone every time in the chat is written in, on the server and in the browser alike (chatTime.ts).
    organizationTimeZone(),
    db.select(JOB_COLUMNS).from(assistantJobs)
      .where(and(inOrg(assistantJobs), eq(assistantJobs.threadId, thread.id)))
      .orderBy(desc(assistantJobs.createdAt)).limit(20),
  ]);
  // Older jobs the messages still name, so a long chat keeps every search's card and its list after a reload,
  // and a final report's lists their counts: this thread's own, by id or by the list they saved into.
  const referenced = referencedIds(messages);
  const missingJobs = referenced.jobIds.filter((id) => !newest.some((job) => job.id === id));
  const missingLists = referenced.audienceIds.filter((id) => !newest.some((job) => job.audienceId === id && !NOT_SEARCHES.includes(job.kind)));
  const older = missingJobs.length || missingLists.length
    ? await db.select(JOB_COLUMNS).from(assistantJobs)
      .where(and(
        inOrg(assistantJobs),
        eq(assistantJobs.threadId, thread.id),
        newest.length ? notInArray(assistantJobs.id, newest.map((job) => job.id)) : undefined,
        or(
          missingJobs.length ? inArray(assistantJobs.id, missingJobs) : undefined,
          missingLists.length ? and(inArray(assistantJobs.audienceId, missingLists), notInArray(assistantJobs.kind, NOT_SEARCHES)) : undefined,
        ),
      ))
      .orderBy(desc(assistantJobs.createdAt)).limit(300)
    : [];
  const jobs = [...newest, ...older];
  const runIds = messages.flatMap((message) => {
    const data = (message.toolResult as { data?: { runId?: unknown } } | null)?.data;
    return typeof data?.runId === "string" ? [data.runId] : [];
  });
  const decisionIds = messages.flatMap((message) => {
    const data = (message.toolResult as { data?: { decisionId?: unknown } } | null)?.data;
    return message.tool === "owner_decision" && typeof data?.decisionId === "string" ? [data.decisionId] : [];
  });
  const decisions = decisionIds.length
    ? await db.select({ id: ownerDecisions.id, status: ownerDecisions.status, answer: ownerDecisions.answer })
      .from(ownerDecisions).where(and(inOrg(ownerDecisions), inArray(ownerDecisions.id, [...new Set(decisionIds)])))
    : [];
  const runRows = runIds.length
    ? await db.select({
      id: outreachRuns.id, status: outreachRuns.status, autopilot: outreachRuns.autopilot, error: outreachRuns.error, campaigns: outreachRuns.campaigns, plan: outreachRuns.plan,
      approvedAt: outreachRuns.approvedAt, approvedBy: outreachRuns.approvedBy,
      requestId: sql<string | null>`${outreachRuns.plan} ->> 'requestId'`,
      autonomous: sql<boolean>`coalesce((${outreachRuns.plan} ->> 'autonomous') = 'true', false)`,
      requestApproval: sql<RequestApproval | null>`${outreachRuns.plan} -> 'requestApproval'`,
      startedUnder: sql<string | null>`${outreachRuns.plan} ->> 'startedUnder'`,
    })
      .from(outreachRuns).where(and(inOrg(outreachRuns), inArray(outreachRuns.id, [...new Set(runIds)])))
    : [];
  const authorizationOf = await runAuthorizations(thread.id, thread.autonomous, runRows);
  const runs = runRows.map((run) => ({ id: run.id, status: run.status, autopilot: run.autopilot, error: run.error, campaigns: run.campaigns, plan: run.plan, authorization: authorizationOf(run.id) }));
  // The mode chosen on the latest started run: the next plan card starts with it selected.
  // This person's own choice on an outreach plan (not another member's, nor an inquiry run's).
  const [lastStarted] = ctx.userId ? await db.select({ autopilot: outreachRuns.autopilot }).from(outreachRuns)
    .where(and(
      inOrg(outreachRuns),
      eq(outreachRuns.approvedBy, ctx.userId),
      inArray(outreachRuns.status, ["starting", "running", "paused", "stopped", "completed"]),
      sql`coalesce(${outreachRuns.plan} ->> 'kind', 'outreach') <> 'inquiries'`,
    ))
    .orderBy(sql`${outreachRuns.approvedAt} desc nulls last`).limit(1) : [];
  // What became of each lead's reply, for the plan card (answered, due at, waiting for the owner and why).
  const started = runs.filter((run) => run.status !== "proposed" && run.status !== "cancelled").map((run) => run.id);
  const [replies, leads, peers] = await Promise.all([runReplies(started), runLeads(started), requestPeers(thread.id)]);
  return {
    // Autonomous mode and its daily caps, for the switch in the header (autonomy.ts).
    thread: { id: thread.id, title: thread.title, autonomous: thread.autonomous, autonomyCaps: thread.autonomous ? await autonomyCaps() : null },
    viewer: { firstName: ctx.userName?.trim().split(/\s+/)[0] || null },
    threads,
    busy,
    timeZone,
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      tool: message.tool,
      toolInput: message.toolInput,
      toolResult: message.toolResult,
      status: message.status,
      attachments: message.attachments,
      createdAt: message.createdAt.toISOString(),
    })),
    jobs: jobs.map((job) => ({ ...job, createdAt: job.createdAt.toISOString() })),
    runs: Object.fromEntries(runs.map(({ plan, ...run }) => [run.id, { ...run, plan: planCardView(plan), replies: replies[run.id] ?? [], leads: leads[run.id] ?? [], requestPeers: peers(run.id) }])),
    decisions: Object.fromEntries(decisions.map((decision) => [decision.id, { status: decision.status, answer: decision.answer }])),
    setup: withSetup ? { ...(await setupSnapshot()), canManageAutopilot: canManageAutopilot(ctx) } : null,
    lastReplyMode: lastStarted ? (lastStarted.autopilot ? "automatic" : "review") as "automatic" | "review" : null,
  };
}

/**
 * How each plan of this thread was authorized to send (runEvidence.ts): its
 * own Start, a request approval recorded on another plan of the same
 * request, or the chat's Autonomous mode, with the approver's name.
 */
async function runAuthorizations(threadId: string, threadAutonomous: boolean, runs: readonly {
  id: string; status: string; approvedAt: Date | null; approvedBy: string | null; requestId: string | null; autonomous: boolean; requestApproval: RequestApproval | null; startedUnder: string | null;
}[]): Promise<(runId: string) => RunAuthorization> {
  const approvals = await db.select({ id: outreachRuns.id, requestId: sql<string | null>`${outreachRuns.plan} ->> 'requestId'`, approval: sql<RequestApproval>`${outreachRuns.plan} -> 'requestApproval'` })
    .from(outreachRuns).where(and(inOrg(outreachRuns), eq(outreachRuns.threadId, threadId), sql`${outreachRuns.plan} ? 'requestApproval'`));
  const userIds = [...new Set([...runs.map((run) => run.approvedBy), ...approvals.map((row) => row.approval.approvedBy)].filter((id): id is string => Boolean(id)))];
  const names = new Map((userIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds)) : []).map((user) => [user.id, user.name]));
  const byId = new Map(runs.map((run) => [run.id, run]));
  return (runId) => {
    const run = byId.get(runId)!;
    const marked = run.startedUnder ? approvals.find((row) => row.id === run.startedUnder)?.approval ?? null : null;
    const covering = marked ?? null;
    const open = !marked && !run.autonomous && !run.requestApproval && run.requestId
      ? coveringApproval(run.approvedAt, approvals.filter((row) => row.id !== run.id && row.requestId === run.requestId).map((row) => row.approval))
      : null;
    return runAuthorization({
      status: run.status,
      approvedAt: run.approvedAt,
      approverName: run.approvedBy ? names.get(run.approvedBy) ?? null : null,
      autonomous: run.autonomous,
      ownApproval: run.requestApproval,
      coveringApproval: covering ? { approverName: covering.approvedBy ? names.get(covering.approvedBy) ?? null : null, approvedAt: covering.approvedAt, expiresAt: covering.expiresAt } : null,
      mayBeUnderApproval: Boolean(open),
      threadAutonomous,
    });
  };
}

/**
 * What a plan card shows of the plan as stored now: a start that left out
 * people other plans already cover changed its leads, groups, samples and
 * estimate since the prepare_outreach card was written. The messages and
 * per-lead plans stay on the server.
 */
function planCardView(plan: OutreachPlan) {
  return {
    assignments: plan.assignments.map((assignment) => ({ channel: assignment.channel })),
    samples: plan.samples,
    groups: plan.groups?.map((group) => ({ id: group.id, label: group.label, count: group.count })),
    personal: plan.personal?.map((item) => ({ personId: item.personId, name: item.name })),
    skipped: plan.skipped,
    limits: plan.limits,
    excluded: plan.excluded,
    estimate: plan.estimate,
    autopilot: plan.autopilot,
    ownerRequest: plan.ownerRequest ?? null,
    requestId: plan.requestId ?? null,
  };
}

/**
 * For each plan of this thread: how many other plans the same owner request
 * made, plus its searches still running that will make one (contactAfter).
 * The plan card offers "apply to the rest of this request" only when there
 * is such a rest.
 */
async function requestPeers(threadId: string): Promise<(runId: string) => number> {
  const [plans, searches] = await Promise.all([
    db.select({ id: outreachRuns.id, requestId: sql<string | null>`${outreachRuns.plan} ->> 'requestId'` }).from(outreachRuns)
      .where(and(inOrg(outreachRuns), eq(outreachRuns.threadId, threadId), sql`${outreachRuns.status} <> 'cancelled'`, sql`${outreachRuns.plan} ->> 'requestId' is not null`)),
    db.select({ requestId: sql<string | null>`${assistantJobs.payload} -> 'contactAfter' ->> 'requestId'` }).from(assistantJobs)
      .where(and(inOrg(assistantJobs), eq(assistantJobs.threadId, threadId), inArray(assistantJobs.status, ["queued", "running"]))),
  ]);
  const count = new Map<string, number>();
  for (const { requestId } of [...plans, ...searches]) if (requestId) count.set(requestId, (count.get(requestId) ?? 0) + 1);
  const requestOf = new Map(plans.map((plan) => [plan.id, plan.requestId]));
  return (runId) => {
    const requestId = requestOf.get(runId);
    return requestId ? Math.max(0, (count.get(requestId) ?? 0) - 1) : 0;
  };
}

export type AssistantState = Awaited<ReturnType<typeof assistantState>>;

import "server-only";

import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { authContextErrorResponse, can, requireOrgContext, type OrgContext } from "@/lib/auth/context";
import { crmRequestErrorResponse, requireCrmMutationContext } from "@/lib/crm/http";
import { inOrg, runInOrganization } from "@/lib/tenancy/scope";
import { assistantJobs, outreachRuns, ownerDecisions } from "./schema";
import { runLeads } from "./runLeads.server";
import { runReplies } from "./runReplies.server";
import { listMessages, listThreads, resolveThread, threadBusy } from "./threads.server";
import { setupSnapshot } from "./tools.server";

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

/** Everything the chat page shows for one thread; `withSetup` adds the (slower) connection status. */
export async function assistantState(threadId: string | null, ctx: OrgContext, withSetup: boolean) {
  const thread = await resolveThread(threadId, ctx.userId);
  const [messages, threads, busy, jobs] = await Promise.all([
    listMessages(thread.id),
    listThreads(20),
    threadBusy(thread.id),
    db.select({
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
    }).from(assistantJobs)
      .where(and(inOrg(assistantJobs), eq(assistantJobs.threadId, thread.id)))
      .orderBy(desc(assistantJobs.createdAt)).limit(20),
  ]);
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
  const runs = runIds.length
    ? await db.select({ id: outreachRuns.id, status: outreachRuns.status, autopilot: outreachRuns.autopilot, error: outreachRuns.error, campaigns: outreachRuns.campaigns })
      .from(outreachRuns).where(and(inOrg(outreachRuns), inArray(outreachRuns.id, [...new Set(runIds)])))
    : [];
  // What became of each lead's reply, for the plan card (answered, due at, waiting for the owner and why).
  const started = runs.filter((run) => run.status !== "proposed" && run.status !== "cancelled").map((run) => run.id);
  const [replies, leads] = await Promise.all([runReplies(started), runLeads(started)]);
  return {
    thread: { id: thread.id, title: thread.title },
    viewer: { firstName: ctx.userName?.trim().split(/\s+/)[0] || null },
    threads,
    busy,
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
    runs: Object.fromEntries(runs.map((run) => [run.id, { ...run, replies: replies[run.id] ?? [], leads: leads[run.id] ?? [] }])),
    decisions: Object.fromEntries(decisions.map((decision) => [decision.id, { status: decision.status, answer: decision.answer }])),
    setup: withSetup ? { ...(await setupSnapshot()), canManageAutopilot: canManageAutopilot(ctx) } : null,
  };
}

export type AssistantState = Awaited<ReturnType<typeof assistantState>>;

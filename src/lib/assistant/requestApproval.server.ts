import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { inOrg } from "@/lib/tenancy/scope";
import { getRun, OutreachError, startOutreachRun } from "./outreach.server";
import { approvalProblem, makeRequestApproval, requestKey, type RequestApproval } from "./requestApproval";
import { outreachRuns } from "./schema";
import { addMessage } from "./threads.server";

/**
 * Request approvals (requestApproval.ts): recorded on the run the owner
 * started (in its plan, `requestApproval`), and applied to the other plans
 * of the same request in the same conversation, now and as later searches
 * finish. Each plan started this way goes through startOutreachRun — the
 * same launch rules, limits and checks as a Start press — and the chat says
 * so on its card's thread.
 */

type RunRow = NonNullable<Awaited<ReturnType<typeof getRun>>>;

export type AppliedApproval = { started: { runId: string; name: string }[]; skipped: { runId: string; name: string; reason: string }[] };

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
    else result.skipped.push({ runId: sibling.id, name: sibling.name, reason: outcome.reason });
  }
  return result;
}

/** Runs of the same conversation and request, newest first. */
async function siblingPlans(run: RunRow, status?: string): Promise<RunRow[]> {
  if (!run.threadId) return [];
  const rows = await db.select().from(outreachRuns)
    .where(and(inOrg(outreachRuns), eq(outreachRuns.threadId, run.threadId), ...(status ? [eq(outreachRuns.status, status as RunRow["status"])] : [])))
    .orderBy(desc(outreachRuns.createdAt)).limit(50);
  const key = requestKey(run.plan.ownerRequest);
  return rows.filter((row) => row.id !== run.id && requestKey(row.plan.ownerRequest) === key);
}

async function startUnderApproval(run: RunRow, approval: RequestApproval, approvingRunId: string): Promise<{ started: true } | { started: false; reason: string }> {
  const approving = await getRun(approvingRunId);
  const problem = approvalProblem(approval, approving?.status ?? "missing", { plan: run.plan, channels: run.channels }, new Date());
  if (problem) return { started: false, reason: problem };
  try {
    await startOutreachRun(run.id, approval.approvedBy, { autopilot: approval.autopilot });
  } catch (error) {
    return { started: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (run.threadId) {
    await addMessage({
      threadId: run.threadId,
      role: "event",
      content: `“${run.name}” started on its own under your approval of this request (${approval.autopilot ? "Automatic" : "Review"} replies, the same channels and limits). Pause or stop it on its card.`,
    });
  }
  return { started: true };
}

/**
 * A plan a finished search just prepared: started when a request approval
 * of the same request covers it, else left waiting for the owner's Start.
 */
export async function applyRequestApproval(runId: string): Promise<{ started: boolean; reason: string | null }> {
  const run = await getRun(runId);
  if (!run || run.status !== "proposed" || !requestKey(run.plan.ownerRequest)) return { started: false, reason: null };
  for (const sibling of await siblingPlans(run)) {
    const approval = sibling.plan.requestApproval;
    if (!approval) continue;
    const outcome = await startUnderApproval(run, approval, sibling.id);
    return outcome.started ? { started: true, reason: null } : { started: false, reason: outcome.reason };
  }
  return { started: false, reason: null };
}

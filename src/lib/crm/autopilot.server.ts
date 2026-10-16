import "server-only";

import { and, desc, eq, inArray } from "drizzle-orm";
import { outreachRunLeads, outreachRuns } from "@/lib/assistant/schema";
import { inOrg } from "@/lib/tenancy/scope";
import { enqueueCrmJobInTransaction, type CrmJob } from "./queue";
import type { CrmExecutor, CrmTransaction } from "./repository";

/**
 * Queues the reply autopilot's look at a draft (rules: autopilot.ts; the
 * runner: src/lib/assistant/autopilotRun.server.ts). Only drafts for people
 * in an assistant outreach run are queued — in either mode, so a Review
 * run still reports interested leads — and never for any other
 * conversation: there is no organization-wide switch.
 */

/** The run a person belongs to on a channel: the newest started one. */
export async function runMembershipFor(executor: CrmExecutor, personId: string, channel: string) {
  const [row] = await executor.select({
    runId: outreachRuns.id,
    runStatus: outreachRuns.status,
    automatic: outreachRuns.autopilot,
    threadId: outreachRuns.threadId,
    runName: outreachRuns.name,
    leadStatus: outreachRunLeads.status,
  }).from(outreachRunLeads)
    .innerJoin(outreachRuns, eq(outreachRuns.id, outreachRunLeads.runId))
    .where(and(
      inOrg(outreachRunLeads),
      eq(outreachRunLeads.personId, personId),
      eq(outreachRunLeads.channel, channel as "email" | "whatsapp" | "linkedin"),
      inArray(outreachRuns.status, ["starting", "running", "paused", "stopped", "completed"]),
    ))
    .orderBy(desc(outreachRuns.createdAt))
    .limit(1);
  return row ?? null;
}

/** Queues the autopilot for a draft that just became ready, when its person is in an assistant run. */
export async function enqueueAutopilotInTransaction(tx: CrmTransaction, input: { draftId: string; personId: string; channel: string; revision: number }): Promise<void> {
  if (!(await runMembershipFor(tx, input.personId, input.channel))) return;
  await enqueueCrmJobInTransaction(tx, {
    kind: "auto_send",
    entityId: input.draftId,
    payload: { revision: input.revision, readyAt: new Date().toISOString() },
    // A regenerated draft keeps its id: run the job again for the new revision.
    requeueCompleted: true,
    maxAttempts: 3,
    // The queue defaults to now: check the answer as soon as it is ready.
  });
}

export async function handleAutoSendJob(job: CrmJob): Promise<void> {
  // Loaded on use: the runner pulls in the assistant's AI and knowledge code.
  const { runAutopilotForDraft } = await import("@/lib/assistant/autopilotRun.server");
  const revision = typeof job.payload.revision === "number" ? job.payload.revision : null;
  const readyAt = typeof job.payload.readyAt === "string" ? new Date(job.payload.readyAt) : null;
  await runAutopilotForDraft(job.entityId, { revision, readyAt });
}

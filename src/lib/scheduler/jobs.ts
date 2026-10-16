import "server-only";

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { pruneJobHistory } from "@/jobs/resetDailyLimits";
import { replayInstagramWebhooks } from "@/jobs/replayInstagramWebhooks";
import { replayLinkedinWebhooks } from "@/jobs/replayLinkedinWebhooks";
import { runOutreach } from "@/jobs/runOutreach";
import { runSearchQueue } from "@/jobs/runSearchQueue";
import { startTrackedJob } from "@/lib/linkedin/jobTracker";
import { jobRuns } from "@/lib/linkedin/schema";
import { pruneClaims } from "./claims";
import type { PlatformJobName } from "./schedules";

/**
 * What each platform-wide scheduled job does: exactly what its endpoint does
 * when the cron (Bearer CRON_SECRET) calls it — every organization, the same
 * functions, the same JobRun tracking. Used by the in-process scheduler and
 * by those endpoints, so the two cannot drift apart.
 */
export type StartedJob = {
  /** What the endpoint answers. */
  body: Record<string, unknown>;
  /** Settles when the work ends (never rejects): null on success, else the error. */
  done: Promise<string | null>;
};

const finished: Promise<string | null> = Promise.resolve(null);

export async function startPlatformJob(name: PlatformJobName): Promise<StartedJob> {
  switch (name) {
    case "linkedin-run-outreach": {
      const { runId, done } = await startTrackedJob("run-outreach", () => runOutreach({}));
      return { body: { ok: true, runId }, done };
    }
    case "linkedin-run-search-queue": {
      // runSearchQueue refuses to run beside an active run anyway; checking
      // first keeps Job History free of no-op runs. JobRun is shared by every
      // organization, so this lock is global by design.
      const [alreadyRunning] = await db
        .select()
        .from(jobRuns)
        .where(and(eq(jobRuns.job, "run-search-queue"), eq(jobRuns.status, "RUNNING")))
        .limit(1);
      if (alreadyRunning) return { body: { ok: true, runId: alreadyRunning.id, alreadyRunning: true }, done: finished };
      const { runId, done } = await startTrackedJob("run-search-queue", (id) => runSearchQueue(id, { accountIds: undefined }));
      return { body: { ok: true, runId }, done };
    }
    case "linkedin-replay-webhooks": {
      let summary: Awaited<ReturnType<typeof replayLinkedinWebhooks>> | null = null;
      let instagram: Awaited<ReturnType<typeof replayInstagramWebhooks>> | null = null;
      const { runId, done } = await startTrackedJob("replay-linkedin-webhooks", async () => {
        // LinkedIn exactly as before; then the Instagram deliveries of the
        // same ledger (Unipile never retries them: their route answers 200
        // first). A LinkedIn failure does not keep Instagram from running,
        // and is still the job's outcome.
        let linkedinError: unknown = null;
        try {
          summary = await replayLinkedinWebhooks(100, undefined);
        } catch (error) {
          linkedinError = error;
        }
        instagram = await replayInstagramWebhooks(100, undefined);
        if (linkedinError) throw linkedinError;
      });
      return { body: { ok: true, runId, summary, instagram }, done };
    }
    case "history-prune": {
      // Shared history, once a day for the whole platform (it used to ride
      // along with the LinkedIn daily reset, which is now per organization).
      await pruneJobHistory();
      const prunedClaims = await pruneClaims();
      return { body: { ok: true, prunedClaims }, done: finished };
    }
  }
}

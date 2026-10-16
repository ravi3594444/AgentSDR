import { NextRequest, NextResponse } from "next/server";
import { authContextErrorResponse } from "@/lib/auth/context";
import { replayInstagramWebhooks } from "@/jobs/replayInstagramWebhooks";
import { replayLinkedinWebhooks } from "@/jobs/replayLinkedinWebhooks";
import { withJobTracking } from "@/lib/linkedin/jobTracker";
import { resolveJobCaller } from "@/lib/linkedin/organizations.server";
import { runPlatformJobForCron } from "@/lib/scheduler/endpoint";

export async function POST(req: NextRequest) {
  try {
    // The cron replays every organization's deliveries (once per slot, shared
    // with the in-process scheduler); a signed-in member only their own.
    // Instagram deliveries share the ledger and are replayed after LinkedIn's.
    const { organizationId } = await resolveJobCaller(req);
    if (!organizationId) return await runPlatformJobForCron("linkedin-replay-webhooks", req);
    let summary: Awaited<ReturnType<typeof replayLinkedinWebhooks>> | null = null;
    let instagram: Awaited<ReturnType<typeof replayInstagramWebhooks>> | null = null;
    const runId = await withJobTracking("replay-linkedin-webhooks", async () => {
      let linkedinError: unknown = null;
      try {
        summary = await replayLinkedinWebhooks(100, organizationId);
      } catch (error) {
        linkedinError = error;
      }
      instagram = await replayInstagramWebhooks(100, organizationId);
      if (linkedinError) throw linkedinError;
    });
    return NextResponse.json({ ok: true, runId, summary, instagram });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

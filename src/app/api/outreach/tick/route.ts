import { NextRequest, NextResponse } from "next/server";
import { runSchedulerTick } from "@/lib/outreach/scheduler";

// POST /api/outreach/tick — drains one queued send per connected mailbox
// (see outreach_mailbox_queue, built daily by /api/outreach/build-queue).
// The in-process scheduler (see internalScheduler.ts, started from
// instrumentation.ts) already calls runSchedulerTick() every minute
// automatically — this route is a manual/backup trigger only (e.g. to force
// an immediate tick while debugging). Do NOT point an external cron at this
// too, or you'll double-tick. Bypasses cookie auth like the CRM webhooks —
// see proxy.ts — protected instead by OUTREACH_TICK_SECRET, same
// shared-secret pattern used for provider webhooks.
export async function POST(req: NextRequest) {
  const expected = process.env.OUTREACH_TICK_SECRET;
  const provided = req.nextUrl.searchParams.get("secret") ?? req.headers.get("x-tick-secret");
  if (!expected || provided !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const result = await runSchedulerTick({ repair: "auto" });
  return NextResponse.json(result);
}

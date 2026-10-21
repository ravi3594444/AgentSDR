import { NextRequest, NextResponse } from "next/server";
import { buildMailboxQueues } from "@/lib/outreach/buildQueue";
import { cronOrganizationFilter } from "@/lib/scheduler/endpoint";

// POST /api/outreach/build-queue — rebuilds today's per-mailbox send queue:
// wipes yesterday's leftovers, resets daily send counters (idempotent per
// mailbox-local day — safe to call more than once), then fills each
// connected mailbox's queue with due follow-ups first (most-overdue and
// deepest-into-sequence first), and brand-new leads round-robin filling
// whatever capacity is left over. Matches AgentSDR-app's
// make-mailbox-queues cron.
//
// The in-process scheduler already does this for each organization at the
// start of its day (the daily rollover, src/lib/scheduler/dailyRollover.ts).
// This endpoint remains for a manual run or an external cron: while the
// scheduler runs it skips organizations that already rolled over today
// (`?force=1` rebuilds them anyway). Shared-secret auth, like /api/outreach/tick.
export async function POST(req: NextRequest) {
  const expected = process.env.OUTREACH_TICK_SECRET;
  const provided = req.nextUrl.searchParams.get("secret") ?? req.headers.get("x-tick-secret");
  if (!expected || provided !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { organizationIds, alreadyRolledOver } = await cronOrganizationFilter(req);
  const result = await buildMailboxQueues({ organizationIds });
  // An organization whose build failed keeps its previous queue; a cron sees the failure as a 500.
  return NextResponse.json(alreadyRolledOver ? { ...result, alreadyRolledOver } : result, { status: result.failedOrganizations.length ? 500 : 200 });
}

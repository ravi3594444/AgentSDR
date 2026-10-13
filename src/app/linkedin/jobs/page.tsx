import { count, desc, inArray } from "drizzle-orm";
import { isPlatformOperator, requirePageOrgContext } from "@/lib/auth/context";
import { runInOrganization } from "@/lib/tenancy/scope";
import { db } from "@/lib/db";
import { jobLogs, jobRuns } from "@/lib/linkedin/schema";
import { PageHeader } from "@/components/page/PageHeader";
import { JobsClient } from "@/components/linkedin/JobsClient";
import { ListPagination } from "@/components/linkedin/ListPagination";
import { clampPage, pageSlice, parsePageParam } from "@/lib/linkedin/pagination";
import { jobLogSummaryByRunIds } from "@/lib/linkedin/jobLogSummary";
import { BRAND } from "@/lib/brand";

export const dynamic = "force-dynamic";

type Props = {
  searchParams: Promise<{ page?: string }>;
};

export default async function JobsPage({ searchParams }: Props) {
  const ctx = await requirePageOrgContext();
  // Job runs and logs span every organization's accounts: operator only.
  if (!(await isPlatformOperator(ctx))) {
    return (
      <div className="space-y-6">
        <PageHeader title="Jobs" description={`System job runs are visible only to the team running this ${BRAND.name} instance.`} />
      </div>
    );
  }
  return runInOrganization(ctx.organizationId, async () => {
    const { page: pageParam } = await searchParams;
    const [{ totalCount }] = await db.select({ totalCount: count() }).from(jobRuns);
    const page = clampPage(parsePageParam(pageParam), totalCount);
    const { skip, take } = pageSlice(page);

    const runs = await db
      .select({
        id: jobRuns.id,
        job: jobRuns.job,
        status: jobRuns.status,
        startedAt: jobRuns.startedAt,
        finishedAt: jobRuns.finishedAt,
        error: jobRuns.error,
      })
      .from(jobRuns)
      .orderBy(desc(jobRuns.startedAt))
      .limit(take)
      .offset(skip);

    const runIds = runs.map((r) => r.id);

    // Prisma's `_count: { select: { logs: true } }` becomes a grouped count.
    const logCountRows = runIds.length
      ? await db
          .select({ jobRunId: jobLogs.jobRunId, logCount: count() })
          .from(jobLogs)
          .where(inArray(jobLogs.jobRunId, runIds))
          .groupBy(jobLogs.jobRunId)
      : [];
    const logCountByRun: Record<string, number> = {};
    for (const row of logCountRows) logCountByRun[row.jobRunId] = row.logCount;

    const logSummary = await jobLogSummaryByRunIds(runIds);

    const runsForClient = runs.map((r) => ({
      id: r.id,
      job: r.job,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      error: r.error,
      logCount: logCountByRun[r.id] ?? 0,
      warnCount: logSummary[r.id]?.warn ?? 0,
      errorCount: logSummary[r.id]?.error ?? 0,
    }));

    return (
      <div className="mx-auto w-full max-w-[1440px]">
        <PageHeader
          title="Job history"
          description={
            totalCount === 0
              ? "Every outreach job run, with its actions and errors"
              : `${totalCount.toLocaleString("en-US")} job run${totalCount === 1 ? "" : "s"}, newest first`
          }
        />
        <JobsClient runs={runsForClient} footer={<ListPagination basePath="/linkedin/jobs" page={page} totalCount={totalCount} />} />
      </div>
    );
  });
}

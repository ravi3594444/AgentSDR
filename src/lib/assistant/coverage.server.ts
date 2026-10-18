import "server-only";

import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { inOrg } from "@/lib/tenancy/scope";
import { coverageLine, namedPlatforms, requestCoverage, type PlatformCoverage, type WebToolUse } from "./coverage";
import { assistantJobs, assistantMessages } from "./schema";

/**
 * The web searches and page reads that succeeded in the request's chat from
 * the request on. They start no job, so without them a request naming the
 * web would read "not started" however much the assistant searched it.
 */
async function webToolUse(request: { threadId: string; createdAt: Date }): Promise<WebToolUse> {
  const rows = await db.select({ tool: assistantMessages.tool, n: sql<number>`count(*)::int` }).from(assistantMessages)
    .where(and(
      inOrg(assistantMessages),
      eq(assistantMessages.threadId, request.threadId),
      eq(assistantMessages.role, "tool"),
      eq(assistantMessages.status, "ok"),
      inArray(assistantMessages.tool, ["web_search", "read_webpage"]),
      gte(assistantMessages.createdAt, request.createdAt),
    ))
    .groupBy(assistantMessages.tool);
  const count = (tool: string) => Number(rows.find((row) => row.tool === tool)?.n ?? 0);
  return { searches: count("web_search"), pagesRead: count("read_webpage") };
}

/**
 * The per-platform coverage of one owner request (its message id): the
 * platforms the owner named, and the searches started for it, matched by
 * the request id their jobs carry (requestMessageId, or the outreach
 * request id of contactAfter), plus the web searches the assistant ran
 * itself when the request names the web.
 */
export async function requestCoverageFor(requestMessageId: string): Promise<PlatformCoverage[]> {
  const [message] = await db.select({ content: assistantMessages.content, threadId: assistantMessages.threadId, createdAt: assistantMessages.createdAt }).from(assistantMessages)
    .where(and(inOrg(assistantMessages), eq(assistantMessages.id, requestMessageId))).limit(1);
  if (!message) return [];
  const named = namedPlatforms(message.content);
  if (named.length < 2) return [];
  const jobs = await db.select({
    kind: assistantJobs.kind,
    status: assistantJobs.status,
    stage: assistantJobs.stage,
    payload: assistantJobs.payload,
    progress: assistantJobs.progress,
    result: assistantJobs.result,
    error: assistantJobs.error,
  }).from(assistantJobs).where(and(
    inOrg(assistantJobs),
    or(
      sql`${assistantJobs.payload}->>'requestMessageId' = ${requestMessageId}`,
      sql`${assistantJobs.payload}->'contactAfter'->>'requestId' = ${requestMessageId}`,
    ),
  )).orderBy(desc(assistantJobs.createdAt)).limit(40);
  return requestCoverage(named, jobs as Parameters<typeof requestCoverage>[1], named.includes("web") ? await webToolUse(message) : null);
}

/** The coverage line for the request a finished job served, or null when its request named fewer than two platforms. */
export async function coverageLineForJob(job: { payload: unknown }): Promise<string | null> {
  const payload = (job.payload ?? {}) as { requestMessageId?: unknown; contactAfter?: { requestId?: unknown } | null };
  const id = typeof payload.requestMessageId === "string" ? payload.requestMessageId : typeof payload.contactAfter?.requestId === "string" ? payload.contactAfter.requestId : null;
  if (!id) return null;
  return coverageLine(await requestCoverageFor(id));
}

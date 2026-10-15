import "server-only";

import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { currentOrganizationId } from "@/lib/tenancy/scope";
import { summaryDay } from "./results";
import { organizationTimeZone, results, resultsText } from "./results.server";
import { assistantThreads, dailySummaries } from "./schema";
import { addMessage } from "./threads.server";

/**
 * The automatic daily summary: yesterday's results (the organization's
 * own time zone) stored in daily_summaries and posted into the owner's
 * latest assistant conversation. Run by the daily rollover at the start of
 * each organization's day; once per day (unique per organization and day).
 * Organizations that never used the assistant are skipped.
 */
export async function writeDailySummary(now = new Date()): Promise<string | null> {
  const organizationId = currentOrganizationId();
  const [thread] = await db.select({ id: assistantThreads.id }).from(assistantThreads)
    .where(eq(assistantThreads.organizationId, organizationId)).orderBy(desc(assistantThreads.updatedAt)).limit(1);
  if (!thread) return null;
  const timeZone = await organizationTimeZone();
  const { day } = summaryDay(timeZone, now);
  const r = await results("yesterday", now);
  const text = resultsText(r);
  const inserted = await db.insert(dailySummaries)
    .values({ organizationId, day, timeZone, data: { text, results: r as unknown as Record<string, unknown> } })
    .onConflictDoNothing()
    .returning({ id: dailySummaries.id });
  if (!inserted.length) return null;
  await addMessage({
    threadId: thread.id,
    role: "tool",
    tool: "daily_summary",
    toolInput: { day },
    status: "ok",
    content: text,
    toolResult: { summary: `Daily summary for ${day}: ${text}`, data: { day, timeZone } },
  });
  return day;
}

export async function listDailySummaries(limit = 14) {
  return db.select({ day: dailySummaries.day, timeZone: dailySummaries.timeZone, data: dailySummaries.data, createdAt: dailySummaries.createdAt })
    .from(dailySummaries).where(eq(dailySummaries.organizationId, currentOrganizationId()))
    .orderBy(sql`${dailySummaries.day} DESC`).limit(limit);
}

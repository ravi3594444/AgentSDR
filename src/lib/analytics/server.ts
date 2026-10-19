import "server-only";

import { resolveTimeZone } from "@/lib/timeZone";
import { sql, type SQL } from "drizzle-orm";
import { daysWindow, type ReportWindow } from "@/lib/reporting/metrics";
import { inWindow, organizationTimeZone } from "@/lib/reporting/metrics.server";
import { previousRange, type AnalyticsRange } from "./contract";
import { analyticsRange, AnalyticsRangeError } from "./range";

/**
 * Shared server helpers for the analytics queries. Every view file takes an
 * AnalyticsRange and builds its SQL from these, so "in range" and "which day"
 * mean the same thing everywhere — and the same as on Overview: a range is
 * whole local days in the organization's business time zone, turned into
 * [from, to) instants by the shared calendar (src/lib/reporting/metrics.ts).
 */

export { AnalyticsRangeError, resolveTimeZone };

/**
 * ?range= (a preset or from..to) or ?from&to, in the organization's time
 * zone unless ?tz= overrides it. Reads the organization's zone, so it runs
 * inside the organization scope.
 */
export async function parseAnalyticsRange(params: URLSearchParams, now = new Date()): Promise<AnalyticsRange> {
  return analyticsRange(params, await organizationTimeZone(), now);
}

/** The range as the shared window: [from 00:00, to+1 00:00) in its zone, as instants. */
export function rangeWindow(range: Pick<AnalyticsRange, "from" | "to" | "tz">): ReportWindow & { from: Date } {
  return daysWindow(range, range.tz);
}

/** The equally long range just before, as the shared window. */
export function previousWindow(range: Pick<AnalyticsRange, "from" | "to" | "tz">): ReportWindow & { from: Date } {
  return daysWindow(previousRange(range), range.tz);
}

/** `column` (a timestamptz) falls inside [from 00:00, to+1 00:00) in the range's zone. Parameterised. */
export function inRange(column: SQL | SQL.Aliased | unknown, range: Pick<AnalyticsRange, "from" | "to" | "tz">): SQL {
  return inWindow(sql`${column}`, rangeWindow(range));
}

/** The same window for the equally long period just before the range. */
export function inPreviousRange(column: SQL | SQL.Aliased | unknown, range: Pick<AnalyticsRange, "from" | "to" | "tz">): SQL {
  return inRange(column, { ...previousRange(range), tz: range.tz });
}

/** Both periods at once, for queries that compute `value` and `previous` in one pass with FILTER. */
export function inCurrentOrPreviousRange(column: SQL | SQL.Aliased | unknown, range: Pick<AnalyticsRange, "from" | "to" | "tz">): SQL {
  return inRange(column, { from: previousRange(range).from, to: range.to, tz: range.tz });
}

/** YYYY-MM-DD of `column` in the range's zone — group by this, then toSeries() in JS. */
export function localDay(column: SQL | SQL.Aliased | unknown, range: Pick<AnalyticsRange, "tz">): SQL<string> {
  return sql<string>`to_char((${column} AT TIME ZONE ${range.tz})::date, 'YYYY-MM-DD')`;
}

/**
 * Runs query thunks with at most `limit` in flight. The app's pool is small
 * (DB_POOL_MAX, default 8, on a server shared with other deployments — see
 * CLAUDE.md), so a dashboard must not fan out one query per chart at once.
 */
export async function runLimited<T>(tasks: ReadonlyArray<() => Promise<T>>, limit = 3): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/** Runs one query when a slot is free. One limiter shared by several loaders caps them together. */
export type QueryLimiter = <T>(task: () => PromiseLike<T>) => Promise<T>;

/** A limiter with at most `limit` queries in flight; see runLimited for why. */
export function createLimiter(limit = 3): QueryLimiter {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (task) => {
    // A finishing task hands its slot straight to the next waiter, so a new
    // caller can never slip in between and push `active` past the limit.
    if (active < limit) active += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

/** Postgres count/sum values arrive as strings or bigints; this makes them numbers. */
export function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

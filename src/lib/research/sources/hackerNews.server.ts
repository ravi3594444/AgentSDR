import "server-only";

import { retryAfterMs, waitFromRefusal } from "@/lib/quota/quota";
import { blockQuota, reserveQuota, settleQuota } from "@/lib/quota/quota.server";
import { HACKER_NEWS_LIMITS, HACKER_NEWS_PROVIDER, HACKER_NEWS_SCOPE, RESEARCH_API_PRODUCT } from "./catalog";
import { ResearchSourceError, ResearchSourceWaitError } from "./errors";
import { commentIdsToRead, hackerNewsApiUrl, parseHackerNewsItem, type HackerNewsItem, type HackerNewsThread } from "./hackerNews";
import { getJson, mapWithLimit, usageDetail, type ResearchCallContext } from "./http.server";

/**
 * Reads a Hacker News thread through the official API: the item (one
 * request), then its first top-level comments (one request each). Every
 * request is reserved first against this server's own restraint of 60 a
 * minute (scope hackernews:server, shared by every organization on the
 * server) and recorded in the organization's ledger. A 429 or 503 becomes a
 * wait every caller honours.
 */

const SOURCE = "the Hacker News API";
const LABEL = "Hacker News API";

function reserve(units: number, context: ResearchCallContext, detail: Record<string, unknown>) {
  return reserveQuota({
    provider: HACKER_NEWS_PROVIDER, product: RESEARCH_API_PRODUCT, scopeKey: HACKER_NEWS_SCOPE, units,
    limits: HACKER_NEWS_LIMITS, label: LABEL, jobId: context.jobId, threadId: context.threadId, detail: usageDetail(context, detail),
  });
}

/** Records a rate limit or outage as a wait for the whole scope; null when the status is neither. */
async function recordedWait(status: number, retryAfter: string | null): Promise<ResearchSourceWaitError | null> {
  if (status !== 429 && status !== 503) return null;
  const now = new Date();
  const wait = waitFromRefusal({ status, retryAfterMs: retryAfterMs(retryAfter, now) }, now, LABEL);
  if (!wait) return null;
  await blockQuota(HACKER_NEWS_SCOPE, HACKER_NEWS_PROVIDER, RESEARCH_API_PRODUCT, wait.until, wait.reason);
  return new ResearchSourceWaitError(SOURCE, wait.until, wait.reason);
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const ok = (status: number) => status >= 200 && status < 300;

/** The thread, or null when Hacker News has no such item. Throws ResearchSourceWaitError or ResearchSourceError. */
export async function readHackerNewsThread(id: number, context: ResearchCallContext = {}): Promise<HackerNewsThread | null> {
  const reservation = await reserve(1, context, { item: id });
  if (!reservation.ok) throw new ResearchSourceWaitError(SOURCE, reservation.until, reservation.reason);
  let answer: Awaited<ReturnType<typeof getJson>>;
  try {
    answer = await getJson(hackerNewsApiUrl(id));
  } catch (error) {
    // A request counts against the rate whatever became of it.
    await settleQuota(reservation.usageId, { status: "failed", usedUnits: 1, error: message(error) });
    throw new ResearchSourceError(SOURCE, `the Hacker News API could not be reached (${message(error)})`);
  }
  if (!ok(answer.status)) {
    await settleQuota(reservation.usageId, { status: "failed", usedUnits: 1, error: `HTTP ${answer.status}` });
    throw (await recordedWait(answer.status, answer.retryAfter)) ?? new ResearchSourceError(SOURCE, `the Hacker News API answered HTTP ${answer.status}`);
  }
  const item = parseHackerNewsItem(answer.body);
  await settleQuota(reservation.usageId, { status: "settled", usedUnits: 1, detail: { found: Boolean(item) } });
  if (!item) return null;

  const ids = item.deleted ? [] : commentIdsToRead(item);
  if (!ids.length) return { item, comments: [], commentsSkipped: null };
  const more = await reserve(ids.length, context, { item: id, comments: ids.length });
  if (!more.ok) {
    const at = more.until.toISOString().slice(11, 16);
    return { item, comments: [], commentsSkipped: `${more.reason}; they can be read after ${at} UTC` };
  }
  const answers = await mapWithLimit(ids, 5, (kid) => getJson(hackerNewsApiUrl(kid)).catch(() => null));
  const comments = answers
    .map((entry) => (entry && ok(entry.status) ? parseHackerNewsItem(entry.body) : null))
    .filter((comment): comment is HackerNewsItem => comment !== null);
  await settleQuota(more.usageId, { status: "settled", usedUnits: ids.length, detail: { comments: comments.length } });
  const refused = answers.find((entry) => entry && (entry.status === 429 || entry.status === 503));
  if (refused) await recordedWait(refused.status, refused.retryAfter);
  return { item, comments, commentsSkipped: comments.length ? null : "the Hacker News API did not return them" };
}

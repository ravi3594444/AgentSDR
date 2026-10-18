import "server-only";

import { blockQuota, reserveQuota, settleQuota } from "@/lib/quota/quota.server";
import { RESEARCH_API_PRODUCT, STACK_EXCHANGE_CACHE_MS, STACK_EXCHANGE_LIMITS, STACK_EXCHANGE_PROVIDER, STACK_EXCHANGE_SCOPE } from "./catalog";
import { ResearchSourceError, ResearchSourceWaitError } from "./errors";
import { getJson, type JsonAnswer, type ResearchCallContext } from "./http.server";
import { parseStackExchangeAnswer, stackExchangeApiUrl, stackExchangeWait, type StackExchangeQuestion, type StackExchangeRef } from "./stackExchange";

/**
 * Reads a Stack Exchange question through API 2.3 without a key: no key is
 * stored, so the quota is Stack Exchange's 300 requests a day for this
 * server's IP (scope stackexchange:server, shared by every organization on
 * the server). Each request is reserved first; a `backoff`, a throttle
 * violation or a used-up `quota_remaining` becomes a wait every caller
 * honours. Identical requests within a minute are answered from memory and
 * cost nothing.
 */

const SOURCE = "the Stack Exchange API";
const LABEL = "Stack Exchange API";
const CACHE_MAX = 200;

const cache = new Map<string, { at: number; question: StackExchangeQuestion | null }>();

/** Keeps the map in time order (oldest first), so expired and surplus entries are dropped from the front. */
function remember(url: string, question: StackExchangeQuestion | null, at: number): void {
  cache.delete(url);
  for (const [key, entry] of cache) {
    if (at - entry.at >= STACK_EXCHANGE_CACHE_MS || cache.size >= CACHE_MAX) cache.delete(key);
    else break;
  }
  cache.set(url, { at, question });
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The question, or null when the site has no such question. Throws ResearchSourceWaitError or ResearchSourceError. */
export async function readStackExchangeQuestion(ref: StackExchangeRef, context: ResearchCallContext = {}): Promise<StackExchangeQuestion | null> {
  const url = stackExchangeApiUrl(ref);
  const cached = cache.get(url);
  if (cached && Date.now() - cached.at < STACK_EXCHANGE_CACHE_MS) return cached.question;

  const reservation = await reserveQuota({
    provider: STACK_EXCHANGE_PROVIDER, product: RESEARCH_API_PRODUCT, scopeKey: STACK_EXCHANGE_SCOPE, units: 1,
    limits: STACK_EXCHANGE_LIMITS, label: LABEL, jobId: context.jobId, threadId: context.threadId,
    detail: { site: ref.site, question: ref.id },
  });
  if (!reservation.ok) throw new ResearchSourceWaitError(SOURCE, reservation.until, reservation.reason);
  let answer: JsonAnswer;
  try {
    answer = await getJson(url);
  } catch (error) {
    // Counted: Stack Exchange may have counted it too.
    await settleQuota(reservation.usageId, { status: "failed", usedUnits: 1, error: message(error) });
    throw new ResearchSourceError(SOURCE, `the Stack Exchange API could not be reached (${message(error)})`);
  }
  const parsed = parseStackExchangeAnswer(answer.body, ref.site);
  const wait = stackExchangeWait(answer.status, parsed, new Date());
  if (wait) await blockQuota(STACK_EXCHANGE_SCOPE, STACK_EXCHANGE_PROVIDER, RESEARCH_API_PRODUCT, wait.until, wait.reason);
  const detail = { quotaRemaining: parsed.quotaRemaining, backoffSeconds: parsed.backoffSeconds };
  const failed = answer.status < 200 || answer.status >= 300 || parsed.error !== null || answer.body === undefined;
  if (failed) {
    const why = parsed.error ? `${parsed.error.name}: ${parsed.error.message}` : `HTTP ${answer.status}`;
    await settleQuota(reservation.usageId, { status: "failed", usedUnits: 1, error: why, detail });
    if (wait) throw new ResearchSourceWaitError(SOURCE, wait.until, wait.reason);
    throw new ResearchSourceError(SOURCE, `the Stack Exchange API refused the request (${why})`);
  }
  await settleQuota(reservation.usageId, { status: "settled", usedUnits: 1, detail });
  const question = parsed.questions[0] ?? null;
  remember(url, question, Date.now());
  return question;
}

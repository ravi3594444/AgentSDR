import "server-only";

import { createHash } from "node:crypto";
import { getPlatformCredential } from "@/lib/managed/store.server";
import { nativeToolSignal } from "@/lib/ai/claudeCode/nativeToolScope.server";
import { requestHoldReason, requestSpendCap, requestSpendGuard } from "@/lib/assistant/objective.server";
import { blockQuota, reserveQuota, settleQuota } from "@/lib/quota/quota.server";
import { ExaError, exaContents, exaReadCeiling, exaSearch, exaSearchCeiling, exaSearchInput, type ExaResponse, type ExaSearchInput } from "@/services/exa";

export class ExaUnavailableError extends Error {}
type Context = { threadId: string; requestId: string | null; signal?: AbortSignal };

/** One operator key, resolved on the server. Both agent harnesses enter this exact reservation path. */
async function metered(product: "search" | "contents", units: number, ceiling: number, context: Context, run: (key: string) => Promise<ExaResponse>): Promise<ExaResponse & { estimatedCostUsd: number }> {
  context = { ...context, signal: context.signal ?? nativeToolSignal() };
  const held = await requestHoldReason(context.requestId);
  if (held) throw new ExaUnavailableError(`Exa was not used: ${held}.`);
  if (await requestSpendCap(context.requestId) === 0) throw new ExaUnavailableError("Exa was not used: this request explicitly allows free sources only. Exa credits are metered even when the provider grants promotional credits.");
  const credential = await getPlatformCredential("exa");
  if (!credential?.apiKey) throw new ExaUnavailableError("Exa is not connected. The platform operator can store its key in Admin → Providers → Exa. Other connected sources are still available.");
  context.signal?.throwIfAborted();
  const scopeKey = `exa:${createHash("sha256").update(credential.apiKey).digest("hex")}`;
  const spendGuard = await requestSpendGuard(context.requestId);
  const reservation = await reserveQuota({
    provider: "exa", product, scopeKey, units, limits: {}, label: "Exa", credentialSource: "managed", costUsd: ceiling,
    threadId: context.threadId, detail: { requestId: context.requestId, costEstimated: true },
    guard: spendGuard ? async (tx) => { const room = await spendGuard(tx, ceiling); return room.ok ? null : room.reason; } : undefined,
  });
  if (!reservation.ok) throw new ExaUnavailableError(reservation.reason);
  let result: ExaResponse;
  try {
    context.signal?.throwIfAborted();
    result = await run(credential.apiKey);
  } catch (error) {
    const uncertain = error instanceof ExaError ? error.uncertain : !context.signal?.aborted;
    // Unknown responses remain counted. No automatic transport retry can pay twice.
    await settleQuota(reservation.usageId, { status: uncertain ? "uncertain" : "failed", usedUnits: uncertain ? units : 0, costUsd: uncertain ? ceiling : 0, error: error instanceof ExaError ? error.message : "Exa request was interrupted" });
    if (error instanceof ExaError && error.status === 429) await blockQuota(scopeKey, "exa", product, new Date(Date.now() + (error.retryAfterMs ?? 60_000)), error.message);
    throw error;
  }
  const estimatedCostUsd = result.costUsd ?? ceiling;
  // If this write fails, retain the reservation and fail the tool; do not repeat a successful paid call.
  await settleQuota(reservation.usageId, { status: "settled", usedUnits: units, costUsd: estimatedCostUsd, detail: { providerRequestId: result.requestId, costEstimated: true } });
  return { ...result, estimatedCostUsd };
}

export function searchWithExa(input: ExaSearchInput, context: Context) {
  context = { ...context, signal: context.signal ?? nativeToolSignal() };
  const args = exaSearchInput(input);
  return metered("search", 1, exaSearchCeiling(args.numResults), context, (key) => exaSearch(key, args, context.signal));
}

export function readWithExa(urls: string[], context: Context) {
  context = { ...context, signal: context.signal ?? nativeToolSignal() };
  return metered("contents", urls.length, exaReadCeiling(urls.length), context, (key) => exaContents(key, urls, context.signal));
}

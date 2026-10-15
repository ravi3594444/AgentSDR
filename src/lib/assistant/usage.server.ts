import "server-only";

import { db } from "@/lib/db";
import { researchCostUsd } from "@/lib/research/research";
import { currentOrganizationId } from "@/lib/tenancy/scope";
import { assistantUsage, type UsageKind } from "./schema";

/** The cost a provider reported in its response: AI/ML API's meta or cost object, or OpenRouter's usage.cost. */
export function responseCostUsd(response: unknown): number | null {
  const fromResearch = researchCostUsd(response);
  if (fromResearch !== null) return fromResearch;
  const cost = (response as { usage?: { cost?: unknown } } | null)?.usage?.cost;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null;
}

/**
 * Records one of the assistant's model calls: the provider's reported cost
 * when the response carries one (AI/ML API and OpenRouter report it), else
 * null, so reports show recorded spending apart from calls of unknown cost.
 * Never fails the caller.
 */
export async function recordUsage(kind: UsageKind, result: { model?: string; response?: unknown; usage?: { inputTokens?: number; outputTokens?: number } } | null, runId: string | null = null): Promise<number | null> {
  if (!result) return null;
  const cost = responseCostUsd(result.response);
  try {
    await db.insert(assistantUsage).values({
      organizationId: currentOrganizationId(),
      kind,
      model: result.model ?? null,
      costUsd: cost === null ? null : cost.toFixed(6),
      inputTokens: result.usage?.inputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null,
      runId,
    });
  } catch (error) {
    console.error("[assistant/usage] could not record a model call:", error);
  }
  return cost;
}

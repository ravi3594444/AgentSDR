import "server-only";

import { and, count, desc, eq, gte } from "drizzle-orm";
import { db } from "@/lib/db";
import { AIML_PROVIDER_KEY, AIML_PROVIDER_NAME } from "@/lib/ai/aimlapi-types";
import { getByokSettings } from "@/lib/ai/byok";
import { getAiConnection, getAiCredentials } from "@/lib/ai/connections";
import { createAimlClient } from "@/lib/ai/server/aimlapi";
import { isTransientOpenRouterError } from "@/lib/ai/server/openrouter-errors";
import { companies } from "@/lib/leads/schema";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import {
  RESEARCH_SYSTEM_PROMPT,
  researchCostUsd,
  researchOutcome,
  researchPrompt,
  utcDayStart,
  type ResearchOutcome,
} from "./research";
import { leadResearch, type ResearchKind, type ResearchSource, type ResearchStatus } from "./schema";

/**
 * Runs and stores web research about a company (see research.ts for what it
 * is and is not). Every bound is here: one call per run, at most one retry
 * and only for a rate limit or server error (never after a timeout, which
 * the provider may have billed), a 60 s deadline, a short answer, the
 * "low" search context, and a per-organization daily limit that counts
 * failed runs too.
 */

const RESEARCH_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_TOKENS = 800;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 2_000;

export class ResearchError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ResearchError";
  }
}

export type ResearchRecord = {
  id: string;
  companyId: string;
  kind: ResearchKind;
  question: string;
  status: ResearchStatus;
  answer: string | null;
  sources: ResearchSource[];
  model: string | null;
  costUsd: number | null;
  error: string | null;
  createdAt: string;
};

function toRecord(row: typeof leadResearch.$inferSelect): ResearchRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    kind: row.kind,
    question: row.question,
    status: row.status,
    answer: row.answer,
    sources: row.sources ?? [],
    model: row.model,
    costUsd: row.costUsd === null ? null : Number(row.costUsd),
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A query on lead_research before scripts/create-lead-research.ts ran. */
function missingTable(error: unknown): boolean {
  for (let current: unknown = error; current && typeof current === "object"; current = (current as { cause?: unknown }).cause) {
    if ((current as { code?: unknown }).code === "42P01") return true;
  }
  return false;
}

async function withResearchTable<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (missingTable(error)) {
      throw new ResearchError(503, "Web research is not set up on this database yet: run `bun scripts/create-lead-research.ts` once (see docs/product/OWNER_SETUP.md).");
    }
    throw error;
  }
}

/**
 * The organization's research model and key, or why research is unavailable.
 * Website and directory discovery (src/lib/discovery/webSearch.server.ts)
 * searches through the same AI/ML API runtime.
 */
export async function researchRuntime(timeoutMs = RESEARCH_TIMEOUT_MS) {
  const settings = await getByokSettings();
  const connection = settings.connectionId ? await getAiConnection(settings.connectionId) : null;
  if (!connection?.verified) throw new ResearchError(409, "Connect an AI provider in Settings → AI provider before researching.");
  if (connection.providerKey !== AIML_PROVIDER_KEY) {
    throw new ResearchError(409, `Web research runs through ${AIML_PROVIDER_NAME}'s search models in this release. Connect ${AIML_PROVIDER_NAME} in Settings → AI provider.`);
  }
  if (!settings.researchModel) {
    throw new ResearchError(409, "Choose a web research model in Settings → AI provider (step 4) before researching.");
  }
  const credentials = await getAiCredentials(connection.id);
  if (!credentials?.apiKey) throw new ResearchError(409, `Reconnect ${AIML_PROVIDER_NAME} in Settings → AI provider.`);
  return {
    client: createAimlClient(credentials.apiKey, timeoutMs),
    model: settings.researchModel.modelId,
    dailyLimit: settings.researchDailyLimit,
  };
}

/** The slice of the AI/ML client a search uses; web discovery's tests substitute a stand-in. */
export type SearchCompletionsClient = { chat: { completions: { create: (request: never) => Promise<unknown> } } };

export async function askWithSearch(
  client: SearchCompletionsClient,
  model: string,
  question: string,
  options: { systemPrompt?: string; maxTokens?: number } = {},
): Promise<unknown> {
  // AI/ML API's chat-completions search request (checked against its
  // per-model schema): web_search_options, with sources returned as
  // `citations`/`search_results` (Perplexity) or url_citation annotations.
  const request = {
    model,
    messages: [
      { role: "system", content: options.systemPrompt ?? RESEARCH_SYSTEM_PROMPT },
      { role: "user", content: question },
    ],
    max_tokens: options.maxTokens ?? MAX_OUTPUT_TOKENS,
    web_search_options: { search_context_size: "low" },
  };
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await client.chat.completions.create(request as never);
    } catch (error) {
      lastError = error;
      if (attempt === MAX_ATTEMPTS || !isTransientOpenRouterError(error)) break;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  throw lastError;
}

function providerFailure(error: unknown, model: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${AIML_PROVIDER_NAME} could not research this with ${model}: ${message.slice(0, 300)}`;
}

export async function listCompanyResearch(companyId: string): Promise<ResearchRecord[]> {
  const [company] = await db.select({ id: companies.id }).from(companies)
    .where(and(inOrg(companies), eq(companies.id, companyId))).limit(1);
  if (!company) throw new ResearchError(404, "Company not found");
  const rows = await withResearchTable(() => db.select().from(leadResearch)
    .where(and(inOrg(leadResearch), eq(leadResearch.companyId, companyId)))
    .orderBy(desc(leadResearch.createdAt))
    .limit(20));
  return rows.map(toRecord);
}

export async function researchCompany(input: {
  companyId: string;
  kind: ResearchKind;
  question?: string | null;
  userId?: string | null;
}): Promise<ResearchRecord> {
  const [company] = await db.select({ id: companies.id, name: companies.name, domain: companies.domain }).from(companies)
    .where(and(inOrg(companies), eq(companies.id, input.companyId))).limit(1);
  if (!company) throw new ResearchError(404, "Company not found");
  const prompt = researchPrompt(input.kind, company, input.question);
  if (!prompt.ok) throw new ResearchError(400, prompt.error);

  const runtime = await researchRuntime();
  const [today] = await withResearchTable(() => db.select({ n: count() }).from(leadResearch)
    .where(and(inOrg(leadResearch), gte(leadResearch.createdAt, utcDayStart(new Date())))));
  if (Number(today?.n ?? 0) >= runtime.dailyLimit) {
    throw new ResearchError(429, `Today's research limit (${runtime.dailyLimit}) is reached; it resets at 00:00 UTC. Owners and admins can change it in Settings → AI provider.`);
  }

  let outcome: ResearchOutcome;
  let cost: number | null = null;
  try {
    const response = await askWithSearch(runtime.client, runtime.model, prompt.question);
    outcome = researchOutcome(response, runtime.model);
    cost = researchCostUsd(response);
  } catch (error) {
    outcome = { status: "failed", error: providerFailure(error, runtime.model), sources: [] };
  }

  const [row] = await db.insert(leadResearch).values({
    organizationId: currentOrganizationId(),
    companyId: company.id,
    kind: input.kind,
    question: prompt.question,
    status: outcome.status,
    answer: outcome.status === "succeeded" ? outcome.answer : null,
    sources: outcome.sources,
    provider: AIML_PROVIDER_KEY,
    model: runtime.model,
    costUsd: cost === null ? null : cost.toFixed(6),
    error: outcome.status === "failed" ? outcome.error : null,
    createdBy: input.userId ?? null,
  }).returning();
  if (!row) throw new Error("lead_research insert returned no row");
  return toRecord(row);
}

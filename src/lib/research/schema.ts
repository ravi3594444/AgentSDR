import { check, index, jsonb, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "@/lib/auth/schema";
import { companies } from "@/lib/leads/schema";

export const RESEARCH_KINDS = ["company", "website", "parent", "question"] as const;
export type ResearchKind = (typeof RESEARCH_KINDS)[number];
export type ResearchStatus = "succeeded" | "not_found" | "failed";

/** A web page the search provider returned for the answer: never a URL the model wrote. */
export type ResearchSource = { url: string; title: string | null; snippet: string | null };

/**
 * Web research about an imported company (src/lib/research/): the question,
 * the answer, the source URLs the provider's web search returned, and what it
 * cost. Failed runs are kept too, with the reason, so a failure is visible and
 * counts toward the daily limit. Created by scripts/create-lead-research.ts.
 */
export const leadResearch = pgTable(
  "lead_research",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().$type<ResearchKind>(),
    question: text("question").notNull(),
    status: text("status").notNull().$type<ResearchStatus>(),
    answer: text("answer"),
    sources: jsonb("sources").$type<ResearchSource[]>().notNull().default([]),
    provider: text("provider"),
    model: text("model"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    error: text("error"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("lead_research_organization_idx").on(table.organizationId, table.createdAt),
    index("lead_research_company_idx").on(table.companyId, table.createdAt),
    check("lead_research_kind_chk", sql`${table.kind} IN ('company', 'website', 'parent', 'question')`),
    check("lead_research_status_chk", sql`${table.status} IN ('succeeded', 'not_found', 'failed')`),
  ],
);

import type { Metadata } from "next";
import ResultsClient, { type ResultsPayload } from "@/components/assistant/ResultsClient";
import { requirePageOrgContext } from "@/lib/auth/context";
import { listDailySummaries } from "@/lib/assistant/dailySummary.server";
import { listOpenDecisions } from "@/lib/assistant/decisions.server";
import { listNeedsYou } from "@/lib/assistant/handoff.server";
import { results } from "@/lib/assistant/results.server";
import { brandTitle } from "@/lib/brand";
import { runInOrganization } from "@/lib/tenancy/scope";

export const metadata: Metadata = { title: { absolute: brandTitle("Results") } };

export const dynamic = "force-dynamic";

/** The owner's dashboard: leads waiting for a person first (Needs you), then what the assistant's outreach did, from recorded events (src/lib/assistant/results.server.ts). */
export default async function ResultsPage() {
  const ctx = await requirePageOrgContext();
  const payload = await runInOrganization(ctx.organizationId, async () => {
    const needsYou = await listNeedsYou();
    const [data, decisions, summaries] = await Promise.all([results("last_7_days"), listOpenDecisions(50), listDailySummaries(14)]);
    return { results: data, decisions, summaries, needsYou };
  });
  return <ResultsClient initial={JSON.parse(JSON.stringify(payload)) as ResultsPayload} />;
}

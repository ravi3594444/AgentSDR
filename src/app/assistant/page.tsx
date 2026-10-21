import type { Metadata } from "next";
import AssistantClient, { type AssistantStatePayload } from "@/components/assistant/AssistantClient";
import { requirePageOrgContext } from "@/lib/auth/context";
import { assistantState } from "@/lib/assistant/http.server";
import { brandTitle } from "@/lib/brand";
import { runInOrganization } from "@/lib/tenancy/scope";

export const metadata: Metadata = { title: { absolute: brandTitle("Outreach") } };

// Reads this organization's conversation and connections on every visit.
export const dynamic = "force-dynamic";

/**
 * The owner's assistant: the home of the app. One conversation that takes
 * the business information, documents and lists, finds leads, and proposes
 * outreach the owner starts with one button (src/lib/assistant/).
 */
export default async function AssistantPage({ searchParams }: { searchParams: Promise<{ thread?: string }> }) {
  const ctx = await requirePageOrgContext();
  const { thread } = await searchParams;
  const state = await runInOrganization(ctx.organizationId, () => assistantState(thread && /^[0-9a-f-]{36}$/i.test(thread) ? thread : null, ctx, true));
  return (
    <div className="h-full min-h-0">
      <AssistantClient initial={JSON.parse(JSON.stringify(state)) as AssistantStatePayload} />
    </div>
  );
}

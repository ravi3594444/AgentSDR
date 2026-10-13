/**
 * Live web research check through the app's own code (researchCompany), on a
 * LOCAL database with an AI/ML API connection saved for the organization:
 *
 *   ORGANIZATION_ID=<org id> bun run --conditions=react-server scripts/e2e/research-live.ts
 *
 * 1. With a search model (RESEARCH_MODEL, default perplexity/sonar), a
 *    parent-company question about a well-known company must come back
 *    answered, with source URLs the provider returned, and be stored.
 * 2. With a model that answers without returning sources
 *    (UNGROUNDED_MODEL, default openai/gpt-5.4-mini, which AI/ML API lists as
 *    web_search but returned no sources when checked), the run must be
 *    stored as failed and no answer saved.
 *
 * It temporarily enables those models as the research model and restores the
 * organization's AI settings afterwards. Spends a little real AI/ML usage
 * (about one cent). Refuses a non-local DATABASE_URL.
 */
import { and, eq } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}

const { runScriptInOrganization } = await import("../lib/organization");
const { db } = await import("@/lib/db");
const { companies } = await import("@/lib/leads/schema");
const { getByokSettings, saveByokSettings } = await import("@/lib/ai/byok");
const { AIML_PROVIDER_KEY } = await import("@/lib/ai/aimlapi-types");
const { researchCompany } = await import("@/lib/research/research.server");
const { currentOrganizationId } = await import("@/lib/tenancy/scope");

const SEARCH_MODEL = process.env.RESEARCH_MODEL ?? "perplexity/sonar";
const UNGROUNDED_MODEL = process.env.UNGROUNDED_MODEL ?? "openai/gpt-5.4-mini";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

await runScriptInOrganization(async () => {
  const original = await getByokSettings();
  if (!original.providers.includes(AIML_PROVIDER_KEY)) {
    console.error("This organization's AI settings do not use AI/ML API.");
    process.exit(1);
  }
  const useResearchModel = (modelId: string) => saveByokSettings({
    ...original,
    modelsByProvider: { [AIML_PROVIDER_KEY]: [...new Set([...(original.modelsByProvider[AIML_PROVIDER_KEY] ?? []), modelId])] },
    researchModel: { provider: AIML_PROVIDER_KEY, modelId },
  });

  const domain = "stripe.com";
  let [company] = await db.select().from(companies).where(and(eq(companies.organizationId, currentOrganizationId()), eq(companies.domain, domain))).limit(1);
  if (!company) {
    [company] = await db.insert(companies).values({ organizationId: currentOrganizationId(), domain, name: "Stripe", source: "research-live-e2e" }).returning();
  }

  try {
    await useResearchModel(SEARCH_MODEL);
    const started = Date.now();
    const found = await researchCompany({ companyId: company!.id, kind: "parent" });
    console.log(`\n${SEARCH_MODEL} (${Date.now() - started} ms): ${found.status}`);
    console.log(`  answer: ${(found.answer ?? found.error ?? "").replace(/\s+/g, " ").slice(0, 400)}`);
    for (const [index, source] of found.sources.slice(0, 6).entries()) console.log(`  [${index + 1}] ${source.url}${source.title ? ` — ${source.title}` : ""}`);
    check("a search model answers and is stored as a finding", found.status === "succeeded" && Boolean(found.answer));
    check("the finding has provider-returned http(s) sources", found.sources.length > 0 && found.sources.every((s) => /^https?:\/\//.test(s.url)), `${found.sources.length} sources`);
    check("its cost is recorded", found.costUsd !== null && found.costUsd > 0, `$${found.costUsd}`);

    await useResearchModel(UNGROUNDED_MODEL);
    const ungrounded = await researchCompany({ companyId: company!.id, kind: "parent" });
    console.log(`\n${UNGROUNDED_MODEL}: ${ungrounded.status} — ${ungrounded.error ?? ungrounded.answer}`);
    check("an answer without sources is stored as failed, with no answer saved", ungrounded.status === "failed" && ungrounded.answer === null && ungrounded.sources.length === 0);
  } finally {
    await saveByokSettings(original);
    console.log("\nAI settings restored.");
  }
});

console.log(failures ? `\n${failures} check(s) failed.` : "\nLive web research passed.");
process.exit(failures ? 1 : 0);

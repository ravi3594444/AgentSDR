/**
 * The research-only live check: the real research_social_sources tool and
 * the real social_research job against Bright Data's live API, in a
 * throwaway organization on the local disposable database. Reddit only
 * (the native keyword discovery and the authors' profiles); X, Instagram
 * and Facebook need a web search key this environment does not hold.
 * Capped by the organization's own limits (monthly credits, records per
 * search), well under the 100-credit allowance. No outreach: nothing is
 * sent, no plan is prepared (contactAfter is never set). The key comes
 * from BRIGHTDATA_LIVE_KEY for this run only, is saved encrypted like any
 * integration credential, and the settings row is deleted at the end. The
 * key is never printed.
 *
 *   BRIGHTDATA_LIVE_KEY=<key> DATABASE_URL=<local> bun run --conditions=react-server scripts/e2e/brightdata-live.ts
 */
import { and, eq, sql } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}
const key = (process.env.BRIGHTDATA_LIVE_KEY ?? "").trim();
if (!key) throw new Error("BRIGHTDATA_LIVE_KEY is not set (the owner's key, for this run only; it is never stored outside the throwaway organization's encrypted row)");
const MONTHLY = Number(process.env.LIVE_MONTHLY_CREDITS ?? 60);
const PER_SEARCH = Number(process.env.LIVE_RECORDS_PER_SEARCH ?? 30);

const { db } = await import("@/lib/db");
const { organizations } = await import("@/lib/auth/schema");
const { providerUsage } = await import("@/lib/quota/schema");
const { brightdataSettings } = await import("@/lib/brightdata/schema");
const { assistantJobs, leadAudienceMembers } = await import("@/lib/assistant/schema");
const { memberInsights } = await import("@/lib/assistant/audiences.server");
const { runTool } = await import("@/lib/assistant/tools.server");
const { runOneAssistantStep } = await import("@/lib/assistant/worker");
const { registerAssistantJobs } = await import("@/lib/assistant/register.server");
const { createThread, listMessages } = await import("@/lib/assistant/threads.server");
const { saveBrightdataSettings, brightdataSettingsView } = await import("@/lib/brightdata/brightdata.server");
const { setFeature } = await import("@/lib/features/flags.server");
const { runInOrganization, inOrg } = await import("@/lib/tenancy/scope");
registerAssistantJobs();

const stamp = Date.now();
const [org] = await db.insert(organizations).values({ name: `Bright Data live check ${stamp}`, slug: `brightdata-live-${stamp}` }).returning();
const orgId = org!.id;
const redact = (text: string) => text.split(key).join("[key]");
const started = Date.now();
try {
  await runInOrganization(orgId, async () => {
    await setFeature("brightdata", true, null);
    const view = await saveBrightdataSettings({ key, monthlyCredits: MONTHLY, maxRecordsPerSearch: PER_SEARCH, redditEnabled: true }, null);
    console.log("settings:", redact(JSON.stringify({ connected: view.connected, hint: view.keyHint, monthly: view.monthlyCredits, perSearch: view.maxRecordsPerSearch })));
    const thread = await createThread(null);
    const result = await runTool("research_social_sources", {
      platforms: ["reddit"],
      customers: "small dental clinics",
      need: "missed calls at the front desk",
      maxResults: PER_SEARCH,
    }, { threadId: thread.id, userId: null, ownerText: "Research Reddit for dental clinics complaining about missed calls" });
    console.log("tool:", redact(result.summary));
    const data = result.data as { jobId?: string; audienceId?: string } | undefined;
    if (!result.ok || !data?.jobId) throw new Error("the tool did not start a job");
    const jobId = data.jobId;
    const deadline = Date.now() + 25 * 60_000;
    let job = (await db.select().from(assistantJobs).where(eq(assistantJobs.id, jobId)))[0]!;
    let lastStage = "";
    while (Date.now() < deadline) {
      job = (await db.select().from(assistantJobs).where(eq(assistantJobs.id, jobId)))[0]!;
      const line = `${job.status}/${job.stage} ${JSON.stringify(job.progress).slice(0, 200)}`;
      if (line !== lastStage) {
        console.log(`${Math.round((Date.now() - started) / 1000)}s`, line);
        lastStage = line;
      }
      if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") break;
      if (job.runAfter.getTime() > Date.now()) await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, job.runAfter.getTime() - Date.now())));
      await runOneAssistantStep({ jobId });
    }
    const resultData = (job.result ?? {}) as Record<string, unknown>;
    console.log("job:", job.status, job.error ?? "");
    console.log("result:", redact(JSON.stringify({ found: resultData.found, discussions: resultData.discussions, eligible: resultData.eligible, excluded: resultData.excluded, withEmail: resultData.withEmail, withPhoneOnly: resultData.withPhoneOnly, needSignals: resultData.needSignals, creditsUsed: resultData.creditsUsed, costUsd: resultData.costUsd, sources: resultData.sources, failures: resultData.failures, note: resultData.note })));
    const rows = await db.select({ dataset: sql<string>`${providerUsage.detail} ->> 'dataset'`, method: sql<string>`${providerUsage.detail} ->> 'method'`, status: providerUsage.status, units: providerUsage.units, used: providerUsage.usedUnits, records: sql<string>`${providerUsage.detail} ->> 'records'`, errors: sql<string>`${providerUsage.detail} ->> 'errors'`, error: providerUsage.error }).from(providerUsage).where(and(inOrg(providerUsage), eq(providerUsage.provider, "brightdata")));
    console.log("ledger:", JSON.stringify(rows));
    const after = await brightdataSettingsView();
    console.log("card:", JSON.stringify({ used: after.usedThisMonth, reserved: after.reservedThisMonth, datasets: after.datasets.filter((item) => item.state !== "unused") }));
    const members = await db.select().from(leadAudienceMembers).where(and(inOrg(leadAudienceMembers), eq(leadAudienceMembers.audienceId, data.audienceId!)));
    const insights = await memberInsights(members.map((row) => row.id));
    console.log(`members: ${members.length}`);
    for (const row of members) {
      const insight = insights.get(row.id);
      console.log(" -", row.status, "|", (row.name ?? "").slice(0, 40), "|", row.sourceUrl, "|", row.reason ?? `routes: ${row.channels.join(",")}`, "|", (row.evidence ?? []).map((item) => `${item.kind}@${item.sourceUrl}`).join(" "), "|", insight?.signals.map((signal) => `${signal.kind}: ${signal.text.slice(0, 80).replace(/\n/g, " ")}`).join(" / ") ?? "");
    }
    const events = (await listMessages(thread.id, 20)).filter((row) => row.role === "event").map((row) => row.content);
    console.log("chat:", redact(events.join(" | ")));
  });
} finally {
  // The key leaves the database with the settings row; the rest of the throwaway organization stays, like other checks'.
  await db.delete(brightdataSettings).where(eq(brightdataSettings.organizationId, orgId));
  console.log("settings row deleted; organization", orgId);
  process.exit(0);
}

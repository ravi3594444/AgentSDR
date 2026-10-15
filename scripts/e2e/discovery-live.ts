/**
 * Live lead-discovery check against REAL services: the Google Maps scraper
 * at GMAPS_SCRAPER_URL, OpenStreetMap's geocoder, the businesses' own
 * websites and DNS. It runs the assistant's discovery job exactly as the
 * app does (worker stages) for one small search and prints every lead with
 * the page each contact came from, and every business left out with why.
 * It sends nothing to anyone.
 *
 *   GMAPS_SCRAPER_URL=http://127.0.0.1:8080 \
 *   bun run --conditions=react-server scripts/e2e/discovery-live.ts "dental clinics" "Baner, Pune, India" 20
 *
 * Creates its own organization ("Discovery live check …"). Refuses a
 * non-local DATABASE_URL unless DISCOVERY_LIVE_ALLOW_REMOTE_DB=true (on the
 * server, run it inside the app container against the real database only if
 * you accept a throwaway organization there).
 */
import { eq, inArray } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1|db)[:/]/.test(process.env.DATABASE_URL ?? "") && process.env.DISCOVERY_LIVE_ALLOW_REMOTE_DB !== "true") {
  console.error("Refusing to run: DATABASE_URL is not local (set DISCOVERY_LIVE_ALLOW_REMOTE_DB=true to accept a throwaway organization there).");
  process.exit(2);
}
if (!process.env.GMAPS_SCRAPER_URL) {
  console.error("Set GMAPS_SCRAPER_URL to the running scraper.");
  process.exit(2);
}

const [what = "dental clinics", where = "Baner, Pune, India", max = "20"] = process.argv.slice(2);

const { db } = await import("@/lib/db");
const { organizations } = await import("@/lib/auth/schema");
const { people } = await import("@/lib/leads/schema");
const { runInOrganization } = await import("@/lib/tenancy/scope");
const { assistantJobs, leadAudienceMembers } = await import("@/lib/assistant/schema");
const { runOneAssistantStep, registerAssistantJobHandler } = await import("@/lib/assistant/worker");
const { runDiscoveryStep, normalizeCriteria, startDiscovery } = await import("@/lib/discovery/discovery.server");

registerAssistantJobHandler("discovery", runDiscoveryStep);

const stamp = Date.now();
const [org] = await db.insert(organizations).values({ name: `Discovery live check ${stamp}`, slug: `discovery-live-${stamp}` }).returning();
console.log(`Organization ${org!.name} (${org!.id})\nSearching “${what}” in “${where}”, up to ${max}…`);

const started = Date.now();
const { jobId, audienceId } = await runInOrganization(org!.id, async () => {
  const criteria = normalizeCriteria({ what, where, maxResults: Number(max) });
  if ("error" in criteria) throw new Error(criteria.error);
  return startDiscovery(criteria, { threadId: null, userId: null });
});

let job = null;
for (let step = 0; step < 400; step += 1) {
  [job] = await db.select().from(assistantJobs).where(eq(assistantJobs.id, jobId));
  if (!job || job.status === "succeeded" || job.status === "failed") break;
  if (job.runAfter.getTime() > Date.now()) await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, job!.runAfter.getTime() - Date.now())));
  await runOneAssistantStep();
}
console.log(`\nJob ${job?.status} after ${Math.round((Date.now() - started) / 1000)}s${job?.error ? `: ${job.error}` : ""}`);
console.log(`Progress: ${JSON.stringify(job?.progress)}`);
console.log(`Result: ${JSON.stringify(job?.result)}\n`);

const members = await db.select().from(leadAudienceMembers).where(eq(leadAudienceMembers.audienceId, audienceId));
const persons = members.some((m) => m.personId)
  ? await db.select().from(people).where(inArray(people.id, members.flatMap((m) => (m.personId ? [m.personId] : []))))
  : [];
for (const member of members.filter((m) => m.status === "eligible")) {
  const person = persons.find((p) => p.id === member.personId);
  console.log(`✓ ${member.facts.businessName ?? member.name ?? "?"} — email ${person?.email ?? "none"}, phone ${person?.phone ?? "none"}, channels ${member.channels.join("+")}`);
  for (const evidence of member.evidence) console.log(`    ${evidence.kind}: ${evidence.value}  ← ${evidence.sourceUrl ?? "?"} (${evidence.source})`);
}
for (const member of members.filter((m) => m.status === "excluded")) {
  console.log(`✗ ${member.name ?? member.facts.businessName ?? "?"} — ${member.reason}`);
}
const withEmail = persons.filter((p) => p.email).length;
console.log(`\n${members.length} businesses: ${members.filter((m) => m.status === "eligible").length} contactable (${withEmail} with an email from their website, the rest by phone), ${members.filter((m) => m.status === "excluded").length} left out.`);
process.exit(job?.status === "succeeded" ? 0 : 1);

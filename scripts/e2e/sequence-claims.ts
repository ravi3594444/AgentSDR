/**
 * Claims in every step of an outreach sequence (pilot fix F05), end to end on
 * the local database with the real plan writer path, Start and launch.
 * Stand-ins: the model (answers by schema and retries the way
 * completeStructured does: an answer `accept` refuses is asked again with the
 * reason) and a Unipile connection nothing calls. Nothing is sent.
 *
 * - a follow-up the writer keeps giving an unbacked client story is asked
 *   again, then left out of the plan with the reason; the preview and the
 *   launched campaign hold the same steps, without it (that its wait moves
 *   to the next step is in messages.test.ts: WhatsApp allows two steps);
 * - a writer that fixes the claim when told keeps the whole sequence;
 * - a first message that keeps one stops the plan, and no run is created;
 * - a case study saved in the owner's information backs the same story.
 *
 *   bun run --conditions=react-server scripts/e2e/sequence-claims.ts
 *
 * Creates its own organization ("Sequence claims check …") and leaves it.
 * Refuses a non-local DATABASE_URL.
 */
import { mock } from "bun:test";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}

const stamp = Date.now();
const root = join(import.meta.dir, "..", "..");
type Input = { userPrompt: string; schemaName?: string; maxAttempts?: number; accept: (text: string) => void };
const FIRST = "Hello, we answer every buyer enquiry for property firms, day and night. Would a short call this week be useful?";
const STORY = "We recently helped a similar agency cut lead response time by 80%.";
const CLEAN = "Just checking whether answering every enquiry at once would help your team this month.";

/** What the writer answers, by attempt: `mode` says where the client story goes and whether it is fixed when asked again. */
let mode: "follow-up-keeps" | "follow-up-fixed" | "first-keeps" = "follow-up-keeps";
const writerAsked: { attempt: number; prompt: string }[] = [];
function sequences(attempt: number): string {
  const steps = mode === "first-keeps"
    ? [STORY + " Would a short call help?", CLEAN]
    : [FIRST, mode === "follow-up-fixed" && attempt > 1 ? CLEAN : STORY];
  return JSON.stringify({ channels: [{ channel: "whatsapp", messages: steps.map((body, index) => ({ subject: "", body, waitDays: index === 0 ? 0 : 3 })) }] });
}
function answer(input: Input, attempt: number): string {
  switch (input.schemaName) {
    case "outreach_sequences":
      writerAsked.push({ attempt, prompt: input.userPrompt });
      return sequences(attempt);
    case "first_message_review":
      return JSON.stringify({ messages: [{ channel: "whatsapp", wouldReply: 4, reasons: [] }] });
    case "lead_sorting":
      return JSON.stringify({ leads: [...input.userPrompt.matchAll(/^(\d+)(?: \([^)]*\))?: \{.*\}$/gm)].map((match) => ({ index: Number(match[1]), group: "Property firms", approach: "standard", reason: "A property firm.", requestFit: "fits", noWebsiteRequired: false })) });
    case "opening_lines":
      return JSON.stringify({ lines: [...input.userPrompt.matchAll(/^(\d+)(?: \([^)]*\))?: \{.*\}$/gm)].map((match) => ({ index: Number(match[1]), line: "" })) });
    default:
      throw new Error(`unexpected model call ${input.schemaName}`);
  }
}
mock.module(join(root, "src/lib/ai/server/structuredCompletion.ts"), () => ({
  completeStructured: async (input: Input) => {
    let last: unknown = null;
    const attempts = Math.max(1, input.maxAttempts ?? 3);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      // As completeStructured does: a refused answer is asked again with the reason it was refused.
      const asked = last ? { ...input, userPrompt: `${input.userPrompt}\n\nYour previous answer was rejected: ${last instanceof Error ? last.message : String(last)}` } : input;
      const text = answer(asked, attempt);
      try {
        input.accept(text);
        return { text, model: "fixture", provider: "fixture", request: {}, response: {}, usage: {}, attempts: attempt };
      } catch (error) {
        last = error;
      }
    }
    throw new Error(`${input.schemaName} failed after ${attempts} attempts`, { cause: last });
  },
}));

const { db } = await import("@/lib/db");
const { people } = await import("@/lib/leads/schema");
const { organizations, users, members } = await import("@/lib/auth/schema");
const { runInOrganization, currentOrganizationId } = await import("@/lib/tenancy/scope");
const schema = await import("@/lib/assistant/schema");
const { gridProviderCredentials, gridProviders } = await import("@/lib/grid/schema");
const { encryptIntegrationCredentials } = await import("@/lib/integrations/credentials");
const { whatsappAccounts, whatsappCampaigns } = await import("@/lib/whatsapp/schema");
const { createAudience, addAudienceMembers } = await import("@/lib/assistant/audiences.server");
const { updateBusinessProfile } = await import("@/lib/assistant/profile.server");
const { prepareOutreach, startOutreachRun, getRun, OutreachError } = await import("@/lib/assistant/outreach.server");
const { runOneAssistantStep } = await import("@/lib/assistant/worker");
const { registerAssistantJobs } = await import("@/lib/assistant/register.server");
type AssistantJob = typeof schema.assistantJobs.$inferSelect;
registerAssistantJobs();

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const [org] = await db.insert(organizations).values({ name: `Sequence claims check ${stamp}`, slug: `sequence-claims-check-${stamp}` }).returning();
const [owner] = await db.insert(users).values({ name: "Owner Check", email: `owner-${stamp}@sequence-claims-check.test`, emailVerified: true }).returning();
await db.insert(members).values({ organizationId: org!.id, userId: owner!.id, role: "owner" });

async function launch(runId: string): Promise<AssistantJob | null> {
  for (let round = 0; round < 30; round += 1) {
    const [job] = await db.select().from(schema.assistantJobs).where(and(eq(schema.assistantJobs.runId, runId), eq(schema.assistantJobs.kind, "outreach_start")));
    if (!job) return null;
    if (job.status !== "queued" && job.status !== "running") return job;
    await db.update(schema.assistantJobs).set({ runAfter: new Date(Date.now() - 1_000) }).where(and(eq(schema.assistantJobs.id, job.id), eq(schema.assistantJobs.status, "queued")));
    await runOneAssistantStep({ jobId: job.id });
  }
  return null;
}

await runInOrganization(org!.id, async () => {
  const [provider] = await db.insert(gridProviders).values({ organizationId: org!.id, key: "platform-unipile", name: "Unipile (sequence claims check)" }).returning();
  await db.insert(gridProviderCredentials).values({ providerId: provider!.id, encryptedPayload: encryptIntegrationCredentials({ apiKey: "sequence-claims-check", dsn: "https://unipile.invalid" }) });
  await db.insert(whatsappAccounts).values({ organizationId: org!.id, unipileAccountId: `sequence-claims-${stamp}`, name: "Sales", phone: "+919800000099", status: "connected", connectedAt: new Date(Date.now() - 5 * 86_400_000) });
  await updateBusinessProfile({ businessName: "LeadDesk", offer: "an assistant that answers every buyer enquiry for property firms, day and night", senderName: "Ravi" }, owner!.id);
  const leads = await db.insert(people).values([1, 2].map((n) => ({ organizationId: org!.id, source: "list", fullName: `Realty ${n}`, phone: `+91980000020${n}` }))).returning();
  const audienceId = await createAudience({ name: "Property firms", source: "list" });
  await addAudienceMembers(audienceId, leads.map((row) => ({ personId: row.id, source: "list" })));
  const prepare = () => prepareOutreach({ audienceId, ownerRequest: "message these property firms on WhatsApp", threadId: null, userId: owner!.id });

  // ---------------------------------------------------------- 1. a follow-up that keeps the story: asked again, then left out
  mode = "follow-up-keeps";
  writerAsked.length = 0;
  const kept = await prepare();
  const steps = kept.plan.groups?.[0]?.sequences.whatsapp ?? [];
  check("a follow-up with an unbacked client story is sent back to the writer with the reason",
    writerAsked.length >= 2 && /whatsapp message 2: it tells a client story/.test(writerAsked[1]!.prompt), `${writerAsked.length} asks; ${writerAsked[1]?.prompt.slice(-200)}`);
  check("…and when it keeps it, that step is left out of the plan, with the reason",
    steps.length === 1 && !steps.some((step) => step.body.includes("helped a similar agency")) && kept.plan.droppedSteps?.length === 1 && kept.plan.droppedSteps[0]!.step === 2 && /client story/.test(kept.plan.droppedSteps[0]!.problem),
    JSON.stringify({ steps: steps.map((step) => [step.body.slice(0, 40), step.waitDays]), dropped: kept.plan.droppedSteps }));
  check("…and the preview holds no claim either", !JSON.stringify(kept.plan.samples).includes("80%"), JSON.stringify(kept.plan.samples).slice(0, 300));

  // Start: the campaign gets exactly the plan's steps.
  await startOutreachRun(kept.runId, owner!.id, { autopilot: false });
  const launched = await launch(kept.runId);
  const run = await getRun(kept.runId);
  const [campaign] = run?.campaigns.whatsapp ? await db.select().from(whatsappCampaigns).where(eq(whatsappCampaigns.id, run.campaigns.whatsapp)) : [];
  const bodies = JSON.stringify(campaign?.steps ?? []);
  check("the launched campaign holds the same steps as the plan, without the claim",
    launched?.status === "succeeded" && (campaign?.steps.length ?? 0) === 1 && !bodies.includes("80%") && !bodies.includes("helped a similar agency"),
    JSON.stringify({ job: launched?.status, error: launched?.error, steps: campaign?.steps.length, bodies: bodies.slice(0, 300) }));
  // Each lead's own texts, written at Start: the first message only, and no claim in it.
  const texts = (await db.select({ raw: people.raw }).from(people).where(and(eq(people.organizationId, currentOrganizationId()), inArray(people.id, leads.map((row) => row.id)))))
    .map((row) => Object.entries((row.raw ?? {}) as Record<string, unknown>).filter(([field]) => field.startsWith(kept.plan.personalizationKey)).map(([field, value]) => [field, String(value)]));
  check("…and each lead's own texts written at Start hold the first message only, without the claim",
    texts.length === 2 && texts.every((fields) => fields.some(([field, value]) => field.endsWith("_b1") && value.startsWith(FIRST)) && !fields.some(([field, value]) => /_b2$/.test(field) && value) && !fields.some(([, value]) => value.includes("80%"))),
    JSON.stringify(texts).slice(0, 400));
  await db.update(whatsappCampaigns).set({ status: "paused" }).where(and(eq(whatsappCampaigns.organizationId, currentOrganizationId()), eq(whatsappCampaigns.id, run!.campaigns.whatsapp!)));

  // ---------------------------------------------------------- 2. a writer that fixes it when told keeps every step
  mode = "follow-up-fixed";
  const fixed = await prepare();
  const fixedSteps = fixed.plan.groups?.[0]?.sequences.whatsapp ?? [];
  check("a writer that fixes the claim when told keeps both steps, and nothing is left out",
    fixedSteps.length === 2 && fixedSteps[1]!.body.startsWith(CLEAN) && !fixed.plan.droppedSteps?.length, JSON.stringify(fixedSteps.map((step) => step.body.slice(0, 50))));

  // ---------------------------------------------------------- 3. a first message that keeps one stops the plan
  mode = "first-keeps";
  const runsBefore = (await db.select({ id: schema.outreachRuns.id }).from(schema.outreachRuns).where(eq(schema.outreachRuns.organizationId, currentOrganizationId()))).length;
  let refused: unknown = null;
  try {
    await prepare();
  } catch (error) {
    refused = error;
  }
  const runsAfter = (await db.select({ id: schema.outreachRuns.id }).from(schema.outreachRuns).where(eq(schema.outreachRuns.organizationId, currentOrganizationId()))).length;
  check("a first message that keeps an unbacked client story stops the plan, with the reason, and no run is made",
    refused instanceof OutreachError && /first WhatsApp message .* still makes a claim your information does not back/.test(refused.message) && runsAfter === runsBefore,
    refused instanceof Error ? refused.message : String(refused));

  // ---------------------------------------------------------- 4. a saved case study backs the same story
  await updateBusinessProfile({ offer: "an assistant that answers every buyer enquiry for property firms, day and night. Case study: we helped Sunrise Realty cut its lead response time by 80% in a month." }, owner!.id);
  mode = "follow-up-keeps";
  const backed = await prepare();
  const backedSteps = backed.plan.groups?.[0]?.sequences.whatsapp ?? [];
  check("with the case study saved in the owner's information, the same follow-up is kept as written",
    backedSteps.length === 2 && backedSteps[1]!.body.startsWith(STORY) && !backed.plan.droppedSteps?.length, JSON.stringify({ steps: backedSteps.map((step) => step.body.slice(0, 50)), dropped: backed.plan.droppedSteps }));
});

if (failures) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("Sequence claim checks passed");
process.exit(0);

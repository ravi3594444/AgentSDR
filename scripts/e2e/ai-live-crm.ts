/**
 * Live AI check, end to end through the CRM worker: an inbound email reply
 * is ingested, and the RUNNING server's CRM worker classifies it and writes a
 * draft through whichever provider AI Settings selected (OpenRouter or AI/ML
 * API). This script only ingests, waits and checks what was stored.
 *
 *   ORGANIZATION_ID=<org id> bun run --conditions=react-server scripts/e2e/ai-live-crm.ts
 *
 * Needs:
 * - a server running against the same LOCAL database (`bun run dev` starts the
 *   CRM worker), with the same INTEGRATION_CREDENTIALS_KEY;
 * - AI Settings saved for that organization (a connection and a default model).
 *
 * It spends a little real model usage (one classification, one draft) and
 * leaves its fixture Person and CRM record behind, marked
 * source "ai-live-e2e". It never sends anything: the draft must end up
 * awaiting review, with no send attempt. Refuses a non-local DATABASE_URL.
 */
import { eq } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}

const { runScriptInOrganization } = await import("../lib/organization");
const { db } = await import("@/lib/db");
const { people } = await import("@/lib/leads/schema");
const { ingestInboundReply } = await import("@/lib/crm/conversations");
const { crmClassifications, crmDrafts, crmSendAttempts } = await import("@/lib/crm/schema");
const { getByokSettings } = await import("@/lib/ai/byok");
const { getAiConnection } = await import("@/lib/ai/connections");
const { planAiRuntime } = await import("@/lib/ai/runtimePlan");
const { currentOrganizationId } = await import("@/lib/tenancy/scope");

const WAIT_MS = Number(process.env.AI_LIVE_WAIT_MS ?? 180_000);

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function waitFor<T>(label: string, read: () => Promise<T | null>): Promise<T | null> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  console.log(`…gave up waiting for ${label} after ${WAIT_MS / 1000}s (is the server and its CRM worker running?)`);
  return null;
}

await runScriptInOrganization(async () => {
  const settings = await getByokSettings();
  const connection = settings.connectionId ? await getAiConnection(settings.connectionId) : null;
  const planned = planAiRuntime(settings, connection);
  if (!planned.ok) {
    console.error(`AI is not ready in this organization: ${planned.error}`);
    process.exit(1);
  }
  const { plan } = planned;
  console.log(`AI provider: ${plan.providerKey} · model ${plan.selection.modelId} · structured output via ${plan.structuredOutput}`);

  const stamp = Date.now();
  const [person] = await db.insert(people).values({
    organizationId: currentOrganizationId(),
    email: `ai-live+${stamp}@example.test`,
    firstName: "Ana",
    lastName: "Souza",
    fullName: "Ana Souza",
    title: "Head of Sales",
    source: "ai-live-e2e",
  }).returning();

  const inbound = await ingestInboundReply({
    personId: person!.id,
    channel: "email",
    accountRef: "sales@example.test",
    providerThreadId: `ai-live-thread-${stamp}`,
    idempotencyKey: `ai-live-inbound-${stamp}`,
    providerMessageId: `ai-live-provider-${stamp}`,
    subject: "Re: Booking more demos for your sales team",
    bodyText: "Thanks, this looks genuinely useful for us. Could we talk on Tuesday at 10am? Please send a calendar invite and a short overview of pricing beforehand.",
    sentAt: new Date(),
  });
  console.log(`Ingested reply ${inbound.message.id} on CRM record ${inbound.record.id}`);

  const classification = await waitFor("the classification", async () => {
    const [row] = await db.select().from(crmClassifications)
      .where(eq(crmClassifications.messageId, inbound.message.id)).limit(1);
    // The row is written once the worker is done with the job, failed or not.
    return row ?? null;
  });
  check("the worker classified the reply", Boolean(classification) && classification?.status !== "failed", classification?.error ?? classification?.status ?? "no row");
  if (classification) {
    check(`classification used ${plan.providerKey}`, classification.model === plan.selection.modelId, `${classification.provider} / ${classification.model}`);
    const request = classification.request as Record<string, unknown> | null;
    if (plan.structuredOutput === "json_schema") {
      const format = request?.response_format as { type?: string; json_schema?: { strict?: boolean } } | undefined;
      check("classification asked for strict JSON schema, without tools or routing", format?.type === "json_schema" && format.json_schema?.strict === true && !request?.tools && !request?.provider);
    }
    console.log(`      category=${classification.proposedCategoryKey ?? classification.appliedCategoryKey} confidence=${classification.confidence} status=${classification.status}`);
    console.log(`      reasoning: ${String(classification.reasoning ?? "").slice(0, 240)}`);
  }

  const draft = await waitFor("the draft", async () => {
    const [row] = await db.select().from(crmDrafts)
      .where(eq(crmDrafts.crmRecordId, inbound.record.id)).limit(1);
    return row && row.status !== "generating" ? row : null;
  });
  check("the worker wrote a draft that waits for review", draft?.status === "awaiting_review", draft ? `${draft.status}${draft.error ? `: ${draft.error}` : ""}` : "no draft");
  if (draft) {
    check(`draft used ${plan.providerKey}`, draft.model === plan.selection.modelId, `${draft.provider} / ${draft.model}`);
    check("the email draft has a subject and a body", Boolean(draft.subject?.trim() && draft.aiBodyText?.trim()));
    console.log(`      subject: ${draft.subject}`);
    console.log(`      body: ${String(draft.aiBodyText ?? "").replace(/\s+/g, " ").slice(0, 400)}`);
    const sends = await db.select({ id: crmSendAttempts.id }).from(crmSendAttempts).where(eq(crmSendAttempts.draftId, draft.id));
    check("nothing was sent without approval", sends.length === 0, `${sends.length} send attempt(s)`);
  }
});

console.log(failures ? `\n${failures} check(s) failed.` : "\nLive classification and drafting passed.");
process.exit(failures ? 1 : 0);

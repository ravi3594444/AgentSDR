/**
 * Live AI check, end to end through the CRM worker: an inbound email reply
 * is ingested, and the RUNNING server's CRM worker classifies it and writes a
 * draft through whichever provider AI Settings selected (OpenRouter or AI/ML
 * API). This script only ingests, waits and checks what was stored.
 *
 *   ORGANIZATION_ID=<org id> bun run --conditions=react-server scripts/e2e/ai-live-crm.ts
 *
 * Needs:
 * - the CRM worker: a server running against the same LOCAL database
 *   (`bun run dev` starts it), with the same INTEGRATION_CREDENTIALS_KEY; or
 *   AI_LIVE_INLINE_WORKER=1 to start that same worker (startCrmWorker) in this
 *   process instead. Either way it claims every organization's queued jobs.
 * - AI Settings saved for that organization (a connection and a default model).
 *
 * Two replies, each asking for a calendar invite and pricing: one through a
 * mailbox with a display name (the draft must be signed by it) and one through
 * an address with no mailbox (the draft must end without a name, never with a
 * "[Your Name]"). Neither draft may claim an invite was sent or a meeting
 * booked. It spends a little real model usage (two classifications, two
 * drafts and any retries) and leaves its fixture People and CRM records
 * behind, marked source "ai-live-e2e". It never sends anything: each draft
 * must end up awaiting review, with no send attempt. Refuses a non-local
 * DATABASE_URL.
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
const { mailboxes } = await import("@/lib/outreach/schema");
const { draftLeaks, draftPlaceholders, unverifiedActionClaims } = await import("@/lib/crm/ai/grounding");

if (process.env.AI_LIVE_INLINE_WORKER === "1") {
  const { registerDefaultCrmJobHandlers } = await import("@/lib/crm/handlers");
  const { startCrmWorker } = await import("@/lib/crm/worker");
  registerDefaultCrmJobHandlers();
  startCrmWorker();
}

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
  const signedMailbox = `ai-live-mailbox+${stamp}@example.test`;
  // A mailbox with a display name, disabled so nothing could ever send from it.
  await db.insert(mailboxes).values({
    organizationId: currentOrganizationId(),
    emailAddress: signedMailbox,
    displayName: "Asha Rao",
    status: "disabled",
  });

  await runScenario({ label: "signed mailbox", accountRef: signedMailbox, signer: "Asha" });
  await runScenario({ label: "no sender on record", accountRef: `ai-live-unknown+${stamp}@example.test`, signer: null });
  await db.delete(mailboxes).where(eq(mailboxes.emailAddress, signedMailbox));

  async function runScenario(scenario: { label: string; accountRef: string; signer: string | null }) {
    console.log(`\n— ${scenario.label}`);
    const key = `${stamp}-${scenario.signer ?? "unknown"}`;
    const [person] = await db.insert(people).values({
      organizationId: currentOrganizationId(),
      email: `ai-live+${key}@example.test`,
      firstName: "Ana",
      lastName: "Souza",
      fullName: "Ana Souza",
      title: "Head of Sales",
      source: "ai-live-e2e",
    }).returning();

    const inbound = await ingestInboundReply({
      personId: person!.id,
      channel: "email",
      accountRef: scenario.accountRef,
      providerThreadId: `ai-live-thread-${key}`,
      idempotencyKey: `ai-live-inbound-${key}`,
      providerMessageId: `ai-live-provider-${key}`,
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
      const body = String(draft.aiBodyText ?? "");
      check(`draft used ${plan.providerKey}`, draft.model === plan.selection.modelId, `${draft.provider} / ${draft.model}`);
      check("the email draft has a subject and a body", Boolean(draft.subject?.trim() && body.trim()));
      check("the draft has no placeholders", draftPlaceholders(`${draft.subject ?? ""}\n${body}`).length === 0, JSON.stringify(draftPlaceholders(body)));
      check("the draft claims no invite sent or meeting booked", unverifiedActionClaims(body, []).length === 0, JSON.stringify(unverifiedActionClaims(body, [])));
      check("the draft does not talk about its prompt or its own limits", draftLeaks(body).length === 0, JSON.stringify(draftLeaks(body)));
      if (scenario.signer) {
        check(`the draft is signed by the mailbox's name (${scenario.signer})`, body.includes(scenario.signer));
      } else {
        check("with no sender on record the draft names no sender", !/\bAsha\b/.test(body));
      }
      console.log(`      subject: ${draft.subject}`);
      console.log(`      body: ${body.replace(/\s+/g, " ").slice(0, 500)}`);
      const sends = await db.select({ id: crmSendAttempts.id }).from(crmSendAttempts).where(eq(crmSendAttempts.draftId, draft.id));
      check("nothing was sent without approval", sends.length === 0, `${sends.length} send attempt(s)`);
    }
  }
});

console.log(failures ? `\n${failures} check(s) failed.` : "\nLive classification and drafting passed.");
process.exit(failures ? 1 : 0);

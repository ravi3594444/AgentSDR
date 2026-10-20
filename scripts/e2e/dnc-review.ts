/**
 * A Do Not Contact record in Action required (pilot fix F12), end to end on
 * the local database with the real CRM functions:
 *
 * - someone replies and is marked Do Not Contact: the record waits in Action
 *   required, named "Do Not Contact: read their reply", and Needs you says
 *   records wait there instead of "Nobody is waiting";
 * - Mark reviewed moves it to idle with a CRM event; Do Not Contact stays,
 *   and nothing can be drafted for them;
 * - a new reply from them brings the record back to Action required;
 * - Mark reviewed is refused for a record not on Do Not Contact, one not in
 *   Action required, and another organization's record.
 *
 *   bun run --conditions=react-server scripts/e2e/dnc-review.ts
 *
 * Creates its own organizations ("DNC review check …") and leaves them.
 * Refuses a non-local DATABASE_URL.
 */
import { and, eq, sql } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}

const stamp = Date.now();
const { db } = await import("@/lib/db");
const { people } = await import("@/lib/leads/schema");
const { organizations } = await import("@/lib/auth/schema");
const { runInOrganization } = await import("@/lib/tenancy/scope");
const { crmEvents, crmRecords } = await import("@/lib/crm/schema");
const { ingestInboundReply } = await import("@/lib/crm/conversations");
const { setPersonDoNotContact, isPersonDoNotContact } = await import("@/lib/crm/policies");
const { markCrmRecordReviewed, createManualDraft } = await import("@/lib/crm/operations");
const { listCrmActions } = await import("@/lib/crm/queries");
const { listNeedsYou } = await import("@/lib/assistant/handoff.server");
const { withCrmTransaction } = await import("@/lib/crm/repository");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
async function refusal(work: () => Promise<unknown>): Promise<string | null> {
  try {
    await work();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const [a] = await db.insert(organizations).values({ name: `DNC review check A ${stamp}`, slug: `dnc-review-a-${stamp}` }).returning();
const [b] = await db.insert(organizations).values({ name: `DNC review check B ${stamp}`, slug: `dnc-review-b-${stamp}` }).returning();
const ACCOUNT = `sales-${stamp}@dnc-review-check.test`;

const reply = (personId: string, n: number, body: string) => ingestInboundReply({
  personId,
  channel: "email",
  accountRef: ACCOUNT,
  providerThreadId: `dnc-review-thread-${personId}`,
  idempotencyKey: `dnc-review-${stamp}-${personId}-${n}`,
  providerMessageId: `dnc-review-provider-${stamp}-${personId}-${n}`,
  subject: "Re: Hello",
  bodyText: body,
  sentAt: new Date(),
});

const seeded = await runInOrganization(a!.id, async () => {
  const [priya, amit] = await db.insert(people).values([
    { organizationId: a!.id, source: "list", fullName: "Priya Shah", email: `priya-${stamp}@dnc-review-check.test` },
    { organizationId: a!.id, source: "list", fullName: "Amit Rao", email: `amit-${stamp}@dnc-review-check.test` },
  ]).returning();
  await reply(priya!.id, 1, "Please stop emailing me. Remove me from your list.");
  await reply(amit!.id, 1, "What does it cost?");
  await setPersonDoNotContact({ personId: priya!.id, reason: "Asked to be removed", source: "human", actorType: "authenticated_operator" });
  const recordOf = async (personId: string) => (await db.select().from(crmRecords).where(and(eq(crmRecords.organizationId, a!.id), eq(crmRecords.personId, personId))))[0]!;
  return { priya: priya!, amit: amit!, recordOf };
});

await runInOrganization(a!.id, async () => {
  let record = await seeded.recordOf(seeded.priya.id);
  // The classification job is not run here: the record is as a DNC set leaves it.
  if (record.workflowState !== "action_required") {
    await db.update(crmRecords).set({ workflowState: "action_required" }).where(eq(crmRecords.id, record.id));
    record = await seeded.recordOf(seeded.priya.id);
  }
  const queue = await listCrmActions({ scope: "actions", limit: 200 });
  const row = queue.actions.find((item) => item.id === record.id) as { actionType?: string } | undefined;
  check("a Do Not Contact reply waits in Action required, named for what it needs", record.workflowState === "action_required" && row?.actionType === "Do Not Contact: read their reply", `${record.workflowState} / ${row?.actionType}`);
  const before = await listNeedsYou();
  check("Needs you counts it instead of saying nobody is waiting", before.items.length === 0 && before.actionRequired >= 1, JSON.stringify({ items: before.items.length, actionRequired: before.actionRequired }));

  const reviewed = await markCrmRecordReviewed({ recordId: record.id });
  const events = await db.select().from(crmEvents).where(and(eq(crmEvents.crmRecordId, record.id), eq(crmEvents.eventType, "workflow.state_changed")));
  const last = events.at(-1) as { meta?: { reason?: string } | null; toData?: { workflowState?: string } } | undefined;
  check("Mark reviewed: the record goes idle, with a CRM event", reviewed.workflowState === "idle" && last?.toData?.workflowState === "idle" && last.meta?.reason === "do_not_contact_reviewed", JSON.stringify({ state: reviewed.workflowState, event: last?.meta }));
  check("…Do Not Contact stays", await withCrmTransaction((tx) => isPersonDoNotContact(tx, seeded.priya.id)));
  const after = await listCrmActions({ scope: "actions", limit: 200 });
  check("…and it leaves the Action required queue", !after.actions.some((item) => item.id === record.id));
  const draftRefused = await refusal(async () => {
    const [conversation] = await db.execute<{ id: string }>(sql`select id from crm_conversations where crm_record_id = ${record.id} limit 1`);
    return createManualDraft({ recordId: record.id, conversationId: conversation!.id, bodyText: "Sorry to bother you again" });
  });
  check("…and nothing can be drafted for them", Boolean(draftRefused && /Do Not Contact/.test(draftRefused)), draftRefused ?? "drafted");
  check("Mark reviewed again is refused: it is no longer in Action required", /Only a record in Action required/.test((await refusal(() => markCrmRecordReviewed({ recordId: record.id }))) ?? ""));

  await reply(seeded.priya.id, 2, "I said stop.");
  const back = await seeded.recordOf(seeded.priya.id);
  check("a new reply from them brings the record back to Action required", back.workflowState === "action_required", back.workflowState);

  const amitRecord = await seeded.recordOf(seeded.amit.id);
  if (amitRecord.workflowState !== "action_required") await db.update(crmRecords).set({ workflowState: "action_required" }).where(eq(crmRecords.id, amitRecord.id));
  check("Mark reviewed is refused for someone not on Do Not Contact", /asked not to be contacted/.test((await refusal(() => markCrmRecordReviewed({ recordId: amitRecord.id }))) ?? ""));
});

const priyaRecordId = await runInOrganization(a!.id, async () => (await seeded.recordOf(seeded.priya.id)).id);
await runInOrganization(b!.id, async () => {
  const refused = await refusal(() => markCrmRecordReviewed({ recordId: priyaRecordId }));
  check("another organization cannot mark it reviewed", Boolean(refused), refused ?? "changed");
});
const unchanged = await runInOrganization(a!.id, () => seeded.recordOf(seeded.priya.id));
check("…and the record is unchanged", unchanged.workflowState === "action_required", unchanged.workflowState);

if (failures) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("DNC review checks passed");
process.exit(0);

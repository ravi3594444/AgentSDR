/**
 * The Inbox (navigation rework N1), end to end on the local database with the
 * real CRM, decision and run functions:
 *
 * - Needs you rows (scope `attention`) hold a draft awaiting review even when
 *   the record left the queue, a Do Not Contact reply to read, and an error;
 *   an answered conversation is only in All conversations (scope `replies`);
 * - the counts beside the list and the sidebar's Inbox badge agree: rows plus
 *   open owner decisions, reports left out;
 * - the channel filter narrows rows and counts to one channel;
 * - Mark reviewed and resolving a decision each take one item off;
 * - a row names the run that answers it and its reply mode; switching the run
 *   to Automatic shows on the row, and only an owner or admin may do it;
 * - a second organization sees, counts and changes nothing of the first.
 *
 *   bun run --conditions=react-server scripts/e2e/inbox.ts
 *
 * Creates its own organizations ("Inbox check …") and leaves them.
 * Refuses a non-local DATABASE_URL.
 */
import { and, eq } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}

const stamp = Date.now();
const { db } = await import("@/lib/db");
const { people } = await import("@/lib/leads/schema");
const { organizations } = await import("@/lib/auth/schema");
const { runInOrganization } = await import("@/lib/tenancy/scope");
const { crmConversations, crmRecords } = await import("@/lib/crm/schema");
const { ingestInboundReply } = await import("@/lib/crm/conversations");
const { setPersonDoNotContact } = await import("@/lib/crm/policies");
const { markCrmRecordReviewed, createManualDraft } = await import("@/lib/crm/operations");
const { listCrmActions } = await import("@/lib/crm/queries");
const { loadNavBadges } = await import("@/lib/nav/badges.server");
const { listNeedsYou } = await import("@/lib/assistant/handoff.server");
const { resolveDecision } = await import("@/lib/assistant/decisions.server");
const { setRunReplyMode } = await import("@/lib/assistant/outreach.server");
const { canManageAutopilot } = await import("@/lib/assistant/http.server");
const { ownerDecisions, outreachRuns, outreachRunLeads } = await import("@/lib/assistant/schema");
const { createAudience } = await import("@/lib/assistant/audiences.server");

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

const [a] = await db.insert(organizations).values({ name: `Inbox check A ${stamp}`, slug: `inbox-check-a-${stamp}` }).returning();
const [b] = await db.insert(organizations).values({ name: `Inbox check B ${stamp}`, slug: `inbox-check-b-${stamp}` }).returning();
const MAILBOX = `sales-${stamp}@inbox-check.test`;
const NUMBER = `inbox-check-wa-${stamp}`;

const reply = (personId: string, channel: "email" | "whatsapp", n: number, body: string) => ingestInboundReply({
  personId,
  channel,
  accountRef: channel === "email" ? MAILBOX : NUMBER,
  providerThreadId: `inbox-thread-${personId}`,
  idempotencyKey: `inbox-${stamp}-${personId}-${n}`,
  providerMessageId: `inbox-provider-${stamp}-${personId}-${n}`,
  ...(channel === "email" ? { subject: "Re: Hello" } : {}),
  bodyText: body,
  sentAt: new Date(),
});

type Ids = Awaited<ReturnType<typeof seed>>;
async function seed() {
  const orgId = a!.id;
  const [draftLead, dncLead, errorLead, answeredLead] = await db.insert(people).values([
    { organizationId: orgId, source: "list", fullName: "Dana Draft", email: `dana-${stamp}@inbox-check.test` },
    { organizationId: orgId, source: "list", fullName: "Nora Stop", phone: `+1415555${String(stamp % 10_000).padStart(4, "0")}` },
    { organizationId: orgId, source: "list", fullName: "Eli Error", email: `eli-${stamp}@inbox-check.test` },
    { organizationId: orgId, source: "list", fullName: "Ava Answered", phone: `+1415556${String(stamp % 10_000).padStart(4, "0")}` },
  ]).returning();
  await reply(draftLead!.id, "email", 1, "What does it cost for a team of five?");
  await reply(dncLead!.id, "whatsapp", 1, "Please stop messaging me.");
  await reply(errorLead!.id, "email", 1, "Can you call me?");
  await reply(answeredLead!.id, "whatsapp", 1, "Thanks, that answers it.");
  const recordOf = async (personId: string) => (await db.select().from(crmRecords).where(and(eq(crmRecords.organizationId, orgId), eq(crmRecords.personId, personId))))[0]!;
  const conversationOf = async (recordId: string) => (await db.select().from(crmConversations).where(eq(crmConversations.crmRecordId, recordId)))[0]!;

  // A draft awaiting review on a record the queue no longer holds (a Review-mode reply after the record moved on).
  const draftRecord = await recordOf(draftLead!.id);
  await createManualDraft({ recordId: draftRecord.id, conversationId: (await conversationOf(draftRecord.id)).id, subject: "Re: Hello", bodyText: "It is $40 a seat a month." });
  await db.update(crmRecords).set({ workflowState: "waiting", nextActionAt: new Date(Date.now() + 3 * 86_400_000) }).where(eq(crmRecords.id, draftRecord.id));
  // Someone on Do Not Contact replied: read it, then Mark reviewed.
  await setPersonDoNotContact({ personId: dncLead!.id, reason: "Asked to stop", source: "human", actorType: "authenticated_operator" });
  const dncRecord = await recordOf(dncLead!.id);
  await db.update(crmRecords).set({ workflowState: "action_required" }).where(eq(crmRecords.id, dncRecord.id));
  const errorRecord = await recordOf(errorLead!.id);
  await db.update(crmRecords).set({ workflowState: "error" }).where(eq(crmRecords.id, errorRecord.id));
  const answeredRecord = await recordOf(answeredLead!.id);
  await db.update(crmRecords).set({ workflowState: "idle", nextActionAt: null }).where(eq(crmRecords.id, answeredRecord.id));

  // Two decisions only the owner can make (one about a conversation, one about no record), and a report that never counts.
  const answeredConversation = await conversationOf(answeredRecord.id);
  const [decision, loose] = await db.insert(ownerDecisions).values([
    { organizationId: orgId, kind: "missing_info", reason: "They asked about a discount", decision: "Is there a discount for a year?", personId: answeredLead!.id, crmRecordId: answeredRecord.id, conversationId: answeredConversation.id },
    { organizationId: orgId, kind: "meeting", reason: "Wants a call", decision: "Pick a time for a call" },
  ]).returning();
  await db.insert(ownerDecisions).values({ organizationId: orgId, kind: "interested", reason: "Interested", decision: "Reported only", crmRecordId: draftRecord.id });

  // The run answering Dana's email conversation, paused so nothing is queued when it switches.
  const audienceId = await createAudience({ name: `Inbox check ${stamp}`, source: "list" });
  const [run] = await db.insert(outreachRuns).values({ organizationId: orgId, audienceId, name: `Inbox check run ${stamp}`, status: "paused", channels: ["email"], autopilot: false, plan: { assignments: [{ personId: draftLead!.id, channel: "email" }] } as never }).returning();
  await db.insert(outreachRunLeads).values({ organizationId: orgId, runId: run!.id, personId: draftLead!.id, channel: "email" });
  return { orgId, draftRecord, dncRecord, errorRecord, answeredRecord, decision: decision!, loose: loose!, run: run! };
}

const ids: Ids = await runInOrganization(a!.id, seed);
const rowIds = (list: { actions: { id: string }[] }) => new Set(list.actions.map((row) => row.id));

await runInOrganization(a!.id, async () => {
  const attention = await listCrmActions({ scope: "attention", limit: 200 });
  const all = await listCrmActions({ scope: "replies", limit: 200 });
  const queue = await listCrmActions({ scope: "actions", limit: 200 });
  const needs = rowIds(attention);
  check("Needs you holds the draft, the Do Not Contact reply and the error", needs.has(ids.draftRecord.id) && needs.has(ids.dncRecord.id) && needs.has(ids.errorRecord.id), [...needs].join(","));
  check("…including the draft on a record the old queue no longer showed", !rowIds(queue).has(ids.draftRecord.id));
  check("…and not the answered conversation, which is in All conversations", !needs.has(ids.answeredRecord.id) && rowIds(all).has(ids.answeredRecord.id));
  check("All conversations has every conversation a reply arrived on", [ids.draftRecord, ids.dncRecord, ids.errorRecord, ids.answeredRecord].every((record) => rowIds(all).has(record.id)));
  const dncRow = attention.actions.find((row) => row.id === ids.dncRecord.id);
  check("the Do Not Contact row is named for what it needs", dncRow?.actionType === "Do Not Contact: read their reply", String(dncRow?.actionType));

  const counts = attention.scopeCounts!;
  check("the counts beside the list match the lists", counts.attention === attention.total && counts.replies === all.total && attention.total === 3, JSON.stringify(counts));
  const needsYou = await listNeedsYou();
  check("the decisions above the rows: two open, the report left out", needsYou.items.length === 2 && needsYou.items.some((item) => item.id === ids.decision.id) && needsYou.items.some((item) => item.id === ids.loose.id), String(needsYou.items.length));
  const badges = await loadNavBadges();
  check("the Inbox badge is the rows plus the decisions", badges.inbox === counts.attention + needsYou.items.length, `${badges.inbox} vs ${counts.attention}+${needsYou.items.length}`);

  const whatsapp = await listCrmActions({ scope: "attention", channel: "whatsapp", limit: 200 });
  check("the WhatsApp filter keeps only WhatsApp rows", whatsapp.actions.length === 1 && whatsapp.actions[0]!.id === ids.dncRecord.id && whatsapp.scopeCounts!.attention === 1, whatsapp.actions.map((row) => row.channel).join(","));
  const email = await listCrmActions({ scope: "replies", channel: "email", limit: 200 });
  check("…and the email filter on All conversations only email ones", email.actions.length === 2 && email.actions.every((row) => row.channel === "email"));

  await markCrmRecordReviewed({ recordId: ids.dncRecord.id });
  const afterReview = await listCrmActions({ scope: "attention", limit: 200 });
  check("Mark reviewed takes the Do Not Contact reply off Needs you", !rowIds(afterReview).has(ids.dncRecord.id) && afterReview.scopeCounts!.attention === 2);
  check("…and it stays in All conversations", rowIds(await listCrmActions({ scope: "replies", limit: 200 })).has(ids.dncRecord.id));
  await resolveDecision(ids.loose.id, { takeover: false, userId: null });
  check("resolving a decision takes one off the badge", (await loadNavBadges()).inbox === 2 + 1, String((await loadNavBadges()).inbox));

  const draftRow = afterReview.actions.find((row) => row.id === ids.draftRecord.id);
  const run = draftRow?.summary?.run;
  check("a row names the run that answers it, in Review", run?.id === ids.run.id && run.automatic === false && draftRow?.summary?.replyMode === "review", JSON.stringify(run));
  await setRunReplyMode(ids.run.id, true);
  const switched = await listCrmActions({ scope: "attention", recordId: ids.draftRecord.id, limit: 1 });
  check("switching the run to Automatic shows on the row", switched.actions[0]?.summary?.run?.automatic === true);
  check("only an owner or admin may switch a run to Automatic", canManageAutopilot({ roles: ["owner"] } as never) && canManageAutopilot({ roles: ["admin"] } as never) && !canManageAutopilot({ roles: ["member"] } as never));
  await setRunReplyMode(ids.run.id, false);
});

await runInOrganization(b!.id, async () => {
  const attention = await listCrmActions({ scope: "attention", limit: 200 });
  const all = await listCrmActions({ scope: "replies", limit: 200 });
  check("another organization sees no rows of the first", attention.total === 0 && all.total === 0 && attention.scopeCounts!.attention === 0);
  check("…counts nothing in its badge or decisions", (await loadNavBadges()).inbox === 0 && (await listNeedsYou()).items.length === 0);
  check("…cannot mark the first one's record reviewed", Boolean(await refusal(() => markCrmRecordReviewed({ recordId: ids.errorRecord.id }))));
  check("…nor switch its run's reply mode", Boolean(await refusal(() => setRunReplyMode(ids.run.id, true))));
  check("…nor resolve its decision", Boolean(await refusal(() => resolveDecision(ids.decision.id, { takeover: false, userId: null }))));
});
const [runAfter] = await db.select().from(outreachRuns).where(eq(outreachRuns.id, ids.run.id));
check("…and the run kept its mode", runAfter?.autopilot === false);

if (failures) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("Inbox checks passed");
process.exit(0);

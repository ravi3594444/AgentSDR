import { and, eq, inArray, sql } from "drizzle-orm";
import { outreachRunLeads, ownerDecisions } from "@/lib/assistant/schema";
import type { CrmTransaction } from "@/lib/crm/repository";
import { people } from "@/lib/leads/schema";
import { leads as linkedinLeads } from "@/lib/linkedin/schema";
import { outreachLeads, outreachMailboxQueue, suppressionList } from "@/lib/outreach/schema";
import { currentOrganizationId } from "@/lib/tenancy/scope";
import { whatsappCampaignLeads } from "@/lib/whatsapp/schema";

/**
 * Everything a Do Not Contact request stops, in the transaction that sets
 * it (called by setPersonDoNotContactInTransaction for every source: an
 * inbound "stop", the AI's classification, a person marking it, a call):
 * - the email address joins the suppression list (no campaign may mail it);
 * - every open email, WhatsApp and LinkedIn campaign enrollment stops;
 * - the person's assistant run memberships become opted_out, so the reply
 *   autopilot never answers them again;
 * - the owner gets a report (not a question) that outreach stopped.
 * The send paths still check DNC themselves; this makes the stop visible
 * and durable even if a campaign is later resumed.
 */
export async function stopOutreachForPersonInTransaction(tx: CrmTransaction, input: { personId: string; reason: string }): Promise<void> {
  const organizationId = currentOrganizationId();
  const now = new Date();
  const [person] = await tx.select({ email: people.email, fullName: people.fullName, firstName: people.firstName })
    .from(people).where(and(eq(people.organizationId, organizationId), eq(people.id, input.personId))).limit(1);
  if (!person) return;

  if (person.email) {
    await tx.insert(suppressionList)
      .values({ organizationId, email: person.email.trim().toLowerCase(), reason: "unsubscribed", note: `Do Not Contact: ${input.reason}`.slice(0, 500) })
      .onConflictDoNothing({ target: [suppressionList.organizationId, suppressionList.email] });
  }

  const openEmailLeads = await tx.select({ id: outreachLeads.id }).from(outreachLeads)
    .where(and(eq(outreachLeads.personId, input.personId), inArray(outreachLeads.sequenceStatus, ["pending", "initial_sent", "in_follow_up", "reply_processing"])));
  if (openEmailLeads.length) {
    const ids = openEmailLeads.map((lead) => lead.id);
    await tx.delete(outreachMailboxQueue).where(inArray(outreachMailboxQueue.leadId, ids));
    await tx.update(outreachLeads).set({ sequenceStatus: "suppressed", nextSendAt: null, updatedAt: now }).where(inArray(outreachLeads.id, ids));
  }
  await tx.update(whatsappCampaignLeads)
    .set({ status: "stopped", nextSendAt: null, updatedAt: now })
    .where(and(eq(whatsappCampaignLeads.personId, input.personId), inArray(whatsappCampaignLeads.status, ["queued", "in_sequence"])));
  await tx.update(linkedinLeads)
    .set({ status: "CANCELLED", updatedAt: now })
    .where(and(
      eq(linkedinLeads.organizationId, organizationId),
      eq(linkedinLeads.personId, input.personId),
      inArray(linkedinLeads.status, ["PENDING", "REQUEST_SENT", "CONNECTED", "ACCEPT_MESSAGE_SENT", "FOLLOW_UP_1_SENT", "FOLLOW_UP_2_SENT"]),
    ));

  const memberships = await tx.update(outreachRunLeads)
    .set({ status: "opted_out", stopReason: input.reason.slice(0, 500), updatedAt: now })
    .where(and(eq(outreachRunLeads.organizationId, organizationId), eq(outreachRunLeads.personId, input.personId), sql`${outreachRunLeads.status} <> 'opted_out'`))
    .returning({ runId: outreachRunLeads.runId });
  if (memberships.length) {
    const name = person.fullName || person.firstName || person.email || "A lead";
    await tx.insert(ownerDecisions).values({
      organizationId,
      kind: "opt_out",
      status: "resolved",
      reason: `${name} asked not to be contacted (${input.reason}).`,
      decision: "Nothing to do: every campaign and automatic reply to them is stopped, and their email address is suppressed.",
      personId: input.personId,
      runId: memberships[0]!.runId,
    });
  }
}

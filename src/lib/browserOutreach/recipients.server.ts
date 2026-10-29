import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { isEmailDoNotContact, isPersonDoNotContact } from "@/lib/crm/policies";
import { crmConversationMessages, crmConversations } from "@/lib/crm/schema";
import { people } from "@/lib/leads/schema";
import { inOrg } from "@/lib/tenancy/scope";
import type { RecipientRef } from "./routes";

/**
 * The saved person a recipient names, if any: by email, by a LinkedIn
 * profile, or by a social handle the leads database holds (people.raw
 * instagram.username). Unknown people are not refused:
 * a message the owner asked for to someone not saved is still theirs to send.
 */
export async function recipientPersonId(recipient: RecipientRef): Promise<string | null> {
  if (recipient.email) {
    const [row] = await db.select({ id: people.id }).from(people).where(and(inOrg(people), sql`lower(${people.email}) = ${recipient.email}`)).limit(1);
    return row?.id ?? null;
  }
  const route = recipient.route;
  if (!route) return null;
  if (route.site === "linkedin") {
    const [row] = await db.select({ id: people.id }).from(people)
      .where(and(inOrg(people), sql`lower(rtrim(${people.linkedinUrl}, '/')) like ${`%/in/${route.handle}`}`)).limit(1);
    if (row) return row.id;
  }
  if (route.site === "instagram") {
    const [row] = await db.select({ id: people.id }).from(people)
      .where(and(inOrg(people), sql`lower(${people.raw}->'instagram'->>'username') = ${route.handle}`)).limit(1);
    if (row) return row.id;
  }
  return null;
}

/** Whether the recipient is someone the workspace must not contact (Do Not Contact, on every channel). */
export async function recipientDoNotContact(recipient: RecipientRef): Promise<boolean> {
  if (recipient.email && await isEmailDoNotContact(db, recipient.email)) return true;
  const personId = await recipientPersonId(recipient);
  return personId ? isPersonDoNotContact(db, personId) : false;
}

/** Whether the recipient has written to the workspace before, on any channel: a message to them is a reply. */
export async function recipientWroteBefore(recipient: RecipientRef): Promise<boolean> {
  const personId = await recipientPersonId(recipient);
  if (!personId) return false;
  const [row] = await db.select({ id: crmConversationMessages.id }).from(crmConversationMessages)
    .innerJoin(crmConversations, eq(crmConversations.id, crmConversationMessages.conversationId))
    .where(and(inOrg(crmConversations), eq(crmConversationMessages.personId, personId), eq(crmConversationMessages.direction, "inbound")))
    .limit(1);
  return Boolean(row);
}

import { and, eq } from "drizzle-orm";
import { organizations } from "@/lib/auth/schema";
import { linkedInAccounts } from "@/lib/linkedin/schema";
import { mailboxes } from "@/lib/outreach/schema";
import { whatsappAccounts } from "@/lib/whatsapp/schema";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { signatureText, type DraftSender } from "./ai/grounding";
import type { CrmExecutor } from "./repository";
import type { CrmChannel } from "./schema";

/**
 * Who a reply draft is written as: the account the conversation runs
 * through (the mailbox's display name and signature, the LinkedIn profile,
 * the WhatsApp number's name) and the organization. Anything not on record
 * stays null, and the draft prompt then leaves it out rather than writing a
 * "[Your Name]" for the reviewer to notice.
 */
export async function resolveDraftSender(
  executor: CrmExecutor,
  conversation: { channel: CrmChannel; accountRef: string },
): Promise<DraftSender> {
  let name: string | null = null;
  let signature: string | null = null;
  if (conversation.channel === "email") {
    const [mailbox] = await executor
      .select({ displayName: mailboxes.displayName, signatureHtml: mailboxes.signatureHtml })
      .from(mailboxes)
      .where(and(inOrg(mailboxes), eq(mailboxes.emailAddress, conversation.accountRef)))
      .limit(1);
    name = mailbox?.displayName?.trim() || null;
    signature = signatureText(mailbox?.signatureHtml);
  } else if (conversation.channel === "linkedin") {
    const [account] = await executor
      .select({ name: linkedInAccounts.name })
      .from(linkedInAccounts)
      .where(and(inOrg(linkedInAccounts), eq(linkedInAccounts.linkedinId, conversation.accountRef)))
      .limit(1);
    name = account?.name?.trim() || null;
  } else {
    const [account] = await executor
      .select({ name: whatsappAccounts.name })
      .from(whatsappAccounts)
      .where(and(inOrg(whatsappAccounts), eq(whatsappAccounts.unipileAccountId, conversation.accountRef)))
      .limit(1);
    name = account?.name?.trim() || null;
  }
  const [organization] = await executor
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, currentOrganizationId()))
    .limit(1);
  return { name, company: organization?.name?.trim() || null, signature };
}

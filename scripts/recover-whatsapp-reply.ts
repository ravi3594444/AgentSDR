/** Queue only a selected contact's latest saved inbound through the normal CRM guards. No direct send. */
import { and, desc, eq } from "drizzle-orm";
import { db } from "../src/lib/db";
import { runInOrganization, inOrg } from "../src/lib/tenancy/scope";
import { runMembershipFor } from "../src/lib/crm/autopilot.server";
import { whatsappAccounts, whatsappChats, whatsappMessages } from "../src/lib/whatsapp/schema";
import { recoverWhatsappCrmHandoff } from "../src/lib/whatsapp/messages";

async function main() {
  const args = process.argv.slice(2);
  const phone = args[args.indexOf("--phone") + 1];
  if (!args.includes("--phone") || !/^\+[1-9]\d{7,14}$/.test(phone ?? "")) throw new Error("Use --phone +<country code><number> [--apply]");
  // Operator CLI: resolve scope from the selected stored account, never from
  // an arbitrary organization fallback. Refuse an ambiguous phone across workspaces.
  const owners = await db.selectDistinct({ organizationId: whatsappAccounts.organizationId })
    .from(whatsappChats).innerJoin(whatsappAccounts, eq(whatsappAccounts.id, whatsappChats.accountId))
    .where(eq(whatsappChats.phone, phone));
  if (owners.length !== 1) throw new Error(`Found ${owners.length} workspaces for this phone; no reply was recovered`);
  return runInOrganization(owners[0]!.organizationId, async () => {
    const [row] = await db.select({ message: whatsappMessages, chat: whatsappChats })
      .from(whatsappMessages).innerJoin(whatsappChats, eq(whatsappChats.id, whatsappMessages.chatId))
      .innerJoin(whatsappAccounts, eq(whatsappAccounts.id, whatsappChats.accountId))
      .where(and(inOrg(whatsappAccounts), eq(whatsappChats.phone, phone), eq(whatsappMessages.direction, "inbound"), eq(whatsappMessages.origin, "lead")))
      .orderBy(desc(whatsappMessages.sentAt), desc(whatsappMessages.createdAt)).limit(1);
    if (!row?.chat.personId) throw new Error("No saved incoming message with a linked contact was found");
    const membership = await runMembershipFor(db, row.chat.personId, "whatsapp");
    if (!membership || membership.runStatus !== "running" || membership.leadStatus !== "active") throw new Error("This contact has no active, started WhatsApp plan; no reply was recovered");
    const snapshot = { phone, message: row.message.body.slice(0, 160), receivedAt: row.message.sentAt.toISOString(), mode: membership.automatic ? "Automatic" : "Review" };
    const result = args.includes("--apply") ? await recoverWhatsappCrmHandoff(row.message.id) : { repaired: false, reason: "read-only preview; use --apply to queue the latest message" };
    console.log(JSON.stringify({ ...snapshot, ...result, note: "The normal reply worker handles the queued message under the plan's mode and guards." }, null, 2));
  });
}

if (import.meta.main) {
  main().then(() => process.exit(0)).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
}

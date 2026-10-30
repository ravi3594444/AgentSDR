/**
 * One-shot backfill: records each Person's already-sent outreach (the
 * initial email/LinkedIn pitch and any follow-ups) as outbound
 * crm_conversation_messages on their existing CRM conversation.
 *
 * src/lib/crm/outreachHistory.ts now does this inline from
 * ingestInboundReplyInTransaction for every new reply, so this script only
 * matters for conversations that were created before that landed — without
 * it, their classifier/drafter context starts at the reply with no memory
 * of what was pitched.
 *
 * Idempotent — safe to re-run. Every insert goes through the same
 * insertConversationMessageInTransaction upsert the live path uses, so a
 * conversation that already has some or all of this history is left alone
 * for the rows that already exist.
 *
 * Run with: bun --conditions=react-server scripts/backfill-crm-outreach-history.ts
 * (conversations.ts reaches a `server-only` import, so the flag is required.)
 * Bun loads .env.local automatically; override DATABASE_URL if that file
 * points at a retired host.
 *
 * Runs in ORGANIZATION_ID, or the initial organization when it is unset.
 */
import { runScriptInOrganization } from "./lib/organization";
import { db } from "@/lib/db";
import { backfillOutreachHistoryInTransaction } from "@/lib/crm/outreachHistory";
import { withCrmTransaction } from "@/lib/crm/repository";
import { crmConversations, type CrmChannel } from "@/lib/crm/schema";

type ChannelTotals = { conversations: number; inserted: number };

async function main() {
  const conversations = await db
    .select({
      id: crmConversations.id,
      personId: crmConversations.personId,
      channel: crmConversations.channel,
      accountRef: crmConversations.accountRef,
    })
    .from(crmConversations);

  const totals: Record<CrmChannel, ChannelTotals> = {
    email: { conversations: 0, inserted: 0 },
    linkedin: { conversations: 0, inserted: 0 },
    whatsapp: { conversations: 0, inserted: 0 },
    instagram: { conversations: 0, inserted: 0 },
    browser: { conversations: 0, inserted: 0 },
  };

  for (const conversation of conversations) {
    const { inserted } = await withCrmTransaction((tx) =>
      backfillOutreachHistoryInTransaction(tx, {
        conversationId: conversation.id,
        personId: conversation.personId,
        channel: conversation.channel,
        accountRef: conversation.accountRef,
      }),
    );
    totals[conversation.channel].conversations += 1;
    totals[conversation.channel].inserted += inserted;
    if (inserted > 0) {
      console.log(`${conversation.channel} conversation ${conversation.id}: inserted ${inserted}`);
    }
  }

  console.log("\nDone.");
  for (const [channel, summary] of Object.entries(totals)) {
    console.log(`${channel}: ${summary.conversations} conversations checked, ${summary.inserted} messages inserted`);
  }
}

runScriptInOrganization(main).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

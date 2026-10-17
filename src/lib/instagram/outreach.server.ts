import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { channelRules } from "@/lib/channels/rules.server";
import { pickInRange } from "@/lib/channels/rules";
import { featureEnabled, isMissingTable } from "@/lib/features/flags.server";
import { isPlatformConnected } from "@/lib/platform/credentials";
import {
  currentOrganizationId,
  inOrg,
  runInOrganization,
} from "@/lib/tenancy/scope";
import {
  isWithinWorkingHours,
  mailboxHoursFromWeekly,
} from "@/lib/outreach/workingHours";
import { isMigrationControlPaused } from "@/lib/migration/controls";
import { people } from "@/lib/leads/schema";
import { outreachRuns } from "@/lib/assistant/schema";
import {
  resolveInstagramOutreachRecipient,
  startInstagramOutreachChat,
} from "@/services/unipile.instagram-outreach";
import { deliverInitialInstagramDm } from "./outreach";
import { applyMessageToChat, upsertInstagramChat } from "./messages";
import {
  instagramAccounts,
  instagramChats,
  instagramMessages,
  instagramOutreachQueue,
} from "./schema";

export async function instagramOutreachReady(): Promise<boolean> {
  const rows = await db.execute(
    sql`select to_regclass('public.instagram_outreach_queue') is not null as ready`,
  );
  return Boolean(rows[0]?.ready);
}

/** Called only by the existing approved-run launch stage; never sends here. */
export async function queueInstagramOutreach(
  runId: string,
  leads: { personId: string; username: string; body: string }[],
  accountIds: string[],
) {
  if (!accountIds.length || !(await instagramOutreachReady()))
    throw new Error(
      "Instagram outreach needs a connected account and the outbound migration",
    );
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select()
      .from(outreachRuns)
      .where(and(inOrg(outreachRuns), eq(outreachRuns.id, runId)))
      .for("update");
    if (
      !run ||
      run.status !== "starting" ||
      !run.approvedAt ||
      !run.approvedBy ||
      !run.channels.includes("instagram")
    )
      throw new Error("This Instagram plan has not been approved for launch");
    const allowed = new Set(
      run.plan.assignments
        .filter((row) => row.channel === "instagram")
        .map((row) => row.personId),
    );
    if (leads.some((lead) => !allowed.has(lead.personId)))
      throw new Error("An Instagram recipient is outside the approved plan");
    const accounts = await tx
      .select({ id: instagramAccounts.id })
      .from(instagramAccounts)
      .where(
        and(
          inOrg(instagramAccounts),
          inArray(instagramAccounts.id, accountIds),
          eq(instagramAccounts.status, "connected"),
        ),
      );
    if (!accounts.length)
      throw new Error("No approved Instagram sender is connected");
    for (const [index, lead] of leads.entries()) {
      await tx
        .insert(instagramOutreachQueue)
        .values({
          organizationId: currentOrganizationId(),
          runId,
          personId: lead.personId,
          username: lead.username,
          body: lead.body,
          accountId: accounts[index % accounts.length]!.id,
        })
        .onConflictDoNothing({
          target: [
            instagramOutreachQueue.runId,
            instagramOutreachQueue.personId,
          ],
        });
    }
    return leads.length;
  });
}

/** Durable claim and account limits are shared by every app instance. */
async function runForOrganization(): Promise<void> {
  if (isMigrationControlPaused("instagramOutbound")) return;
  if (
    !(await featureEnabled("instagram")) ||
    !(await isPlatformConnected("unipile"))
  )
    return;
  const rules = await channelRules("instagram");
  const now = new Date();
  const org = currentOrganizationId();
  // Resolving only reads a profile and is safe to reclaim. Sending crossed the
  // network boundary: retain uncertainty instead of automatically resending.
  await db.execute(sql`update instagram_outreach_queue set status = case when attempted_at is null then 'queued' else 'uncertain' end,
    locked_by = null, locked_until = null, error = case when attempted_at is null then error else 'The sender restarted before delivery was confirmed; no automatic resend' end, updated_at = now()
    where organization_id = ${org} and status in ('resolving','sending') and locked_until < now()`);
  if (
    rules.sendingHours &&
    !isWithinWorkingHours(mailboxHoursFromWeekly(rules.sendingHours), now)
  )
    return;
  const token = randomUUID();
  const job = await db.transaction(async (tx) => {
    const rows = await tx.execute<{
      id: string;
      account_id: string;
    }>(sql`select q.id,q.account_id from instagram_outreach_queue q
      join outreach_runs r on r.id=q.run_id and r.organization_id=q.organization_id
      join instagram_accounts a on a.id=q.account_id and a.organization_id=q.organization_id
      where q.organization_id=${org} and q.status='queued' and r.status='running' and r.approved_at is not null and r.approved_by is not null
        and a.status='connected' and (a.outreach_next_send_at is null or a.outreach_next_send_at <= now())
        and (select count(*) from instagram_outreach_queue used where used.organization_id=q.organization_id
          and used.account_id=q.account_id and used.attempted_at>now()-interval '24 hours') < least(${rules.newChatsPerDay},
            coalesce((r.plan->'limits'->>'instagramNewChatsPerDay')::int,${rules.newChatsPerDay}))
      order by q.created_at for update of q skip locked limit 1`);
    const row = rows[0];
    if (!row) return null;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`instagram-send:${row.account_id}`},0))`,
    );
    const [account] = await tx
      .select()
      .from(instagramAccounts)
      .where(
        and(inOrg(instagramAccounts), eq(instagramAccounts.id, row.account_id)),
      )
      .for("update");
    if (
      !account ||
      account.status !== "connected" ||
      (account.outreachNextSendAt && account.outreachNextSendAt > now)
    )
      return null;
    const used = await tx.execute<{
      n: number;
    }>(sql`select count(*)::int as n from instagram_outreach_queue
      where organization_id=${org} and account_id=${account.id} and attempted_at > now()-interval '24 hours'`);
    if (Number(used[0]?.n ?? 0) >= rules.newChatsPerDay) return null;
    const [claimed] = await tx
      .update(instagramOutreachQueue)
      .set({
        status: "resolving",
        lockedBy: token,
        lockedUntil: new Date(Date.now() + 180_000),
        updatedAt: now,
      })
      .where(
        and(
          inOrg(instagramOutreachQueue),
          eq(instagramOutreachQueue.id, row.id),
          eq(instagramOutreachQueue.status, "queued"),
        ),
      )
      .returning();
    return claimed
      ? { ...claimed, unipileAccountId: account.unipileAccountId }
      : null;
  });
  if (!job) return;
  const owned = and(
    inOrg(instagramOutreachQueue),
    eq(instagramOutreachQueue.id, job.id),
    eq(instagramOutreachQueue.lockedBy, token),
  );
  await deliverInitialInstagramDm(
    {
      id: job.id,
      username: job.username,
      text: job.body,
      unipileAccountId: job.unipileAccountId,
    },
    {
      resolve: resolveInstagramOutreachRecipient,
      reserve: async (recipient) => {
        const liveRules = await channelRules("instagram");
        const enabled = await featureEnabled("instagram");
        return db.transaction(async (tx) => {
          if (
            liveRules.sendingHours &&
            !isWithinWorkingHours(
              mailboxHoursFromWeekly(liveRules.sendingHours),
              new Date(),
            )
          ) {
            await tx
              .update(instagramOutreachQueue)
              .set({
                status: "queued",
                lockedBy: null,
                lockedUntil: null,
                updatedAt: new Date(),
              })
              .where(owned);
            return false;
          }
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`instagram-send:${job.accountId}`},0))`,
          );
          const rows = await tx.execute<{
            id: string;
            approved_limit: number | null;
          }>(sql`select q.id,(r.plan->'limits'->>'instagramNewChatsPerDay')::int as approved_limit from instagram_outreach_queue q
        join outreach_runs r on r.id=q.run_id and r.organization_id=q.organization_id
        join outreach_run_leads l on l.run_id=r.id and l.person_id=q.person_id and l.organization_id=q.organization_id
        join instagram_accounts a on a.id=q.account_id and a.organization_id=q.organization_id
        where q.id=${job.id} and q.organization_id=${org} and q.status='resolving' and q.locked_by=${token}
          and r.status='running' and r.approved_at is not null and r.approved_by is not null and l.status='active' and l.channel='instagram' and a.status='connected'
          and lower(coalesce(a.username,''))<>${recipient.username}
          and not exists(select 1 from crm_person_contact_policies p where p.person_id=q.person_id and p.do_not_contact)
          and not exists(select 1 from instagram_chats c join instagram_messages m on m.chat_id=c.id where c.person_id=q.person_id and c.account_id=q.account_id and m.direction='inbound' and m.sent_at>=q.created_at)
          and not exists(select 1 from instagram_chats c where c.account_id=q.account_id and c.provider_id=${recipient.messagingId} and c.person_id is not null and c.person_id<>q.person_id)
        for update of r,l,a`);
          if (
            !rows.length ||
            isMigrationControlPaused("instagramOutbound") ||
            !enabled
          ) {
            await tx
              .update(instagramOutreachQueue)
              .set({
                status: "cancelled",
                error:
                  "The run/account stopped, the person replied, or contact/identity checks refused this DM",
                lockedBy: null,
                lockedUntil: null,
                updatedAt: new Date(),
              })
              .where(owned);
            return false;
          }
          const used = await tx.execute<{ n: number }>(
            sql`select count(*)::int as n from instagram_outreach_queue where organization_id=${org} and account_id=${job.accountId} and attempted_at>now()-interval '24 hours'`,
          );
          const [account] = await tx
            .select()
            .from(instagramAccounts)
            .where(
              and(
                inOrg(instagramAccounts),
                eq(instagramAccounts.id, job.accountId),
              ),
            );
          const cap = Math.min(
            liveRules.newChatsPerDay,
            rows[0]?.approved_limit ?? liveRules.newChatsPerDay,
          );
          if (
            Number(used[0]?.n ?? 0) >= cap ||
            (account?.outreachNextSendAt &&
              account.outreachNextSendAt > new Date())
          ) {
            await tx
              .update(instagramOutreachQueue)
              .set({ status: "queued", lockedBy: null, lockedUntil: null })
              .where(owned);
            return false;
          }
          await tx
            .update(people)
            .set({
              raw: sql`jsonb_set(coalesce(${people.raw},'{}'::jsonb),'{instagram}',coalesce(${people.raw}->'instagram','{}'::jsonb) || ${JSON.stringify({ username: recipient.username, providerId: recipient.messagingId })}::jsonb)`,
              updatedAt: new Date(),
            })
            .where(and(inOrg(people), eq(people.id, job.personId)));
          await tx
            .update(instagramOutreachQueue)
            .set({
              status: "sending",
              messagingId: recipient.messagingId,
              attemptedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(owned);
          await tx
            .update(instagramAccounts)
            .set({
              outreachNextSendAt: new Date(
                Date.now() + pickInRange(liveRules.sendGapMinutes) * 60_000,
              ),
            })
            .where(
              and(
                inOrg(instagramAccounts),
                eq(instagramAccounts.id, job.accountId),
              ),
            );
          return true;
        });
      },
      send: startInstagramOutreachChat,
      sent: async (recipient, response) => {
        const chat = await upsertInstagramChat({
          accountId: job.accountId,
          unipileChatId: response.chatId,
          providerId: recipient.messagingId,
          username: recipient.username,
          name: null,
          firstSeenVia: "send",
        });
        if (chat.personId && chat.personId !== job.personId)
          throw new Error(
            "The returned Instagram chat belongs to a different Person; delivery needs review",
          );
        await db
          .update(instagramChats)
          .set({ personId: job.personId })
          .where(eq(instagramChats.id, chat.id));
        await db
          .insert(instagramMessages)
          .values({
            id: job.id,
            chatId: chat.id,
            unipileMessageId: response.messageId,
            direction: "outbound",
            origin: "agentsdr",
            body: job.body,
            attachments: [],
            sentAt: new Date(),
            historical: false,
          })
          .onConflictDoNothing();
        await applyMessageToChat(chat.id, {
          sentAt: new Date(),
          body: job.body,
          attachments: [],
          direction: "outbound",
          countUnread: false,
        });
        await db
          .update(instagramOutreachQueue)
          .set({
            status: "sent",
            chatId: response.chatId,
            messageId: response.messageId,
            sentAt: new Date(),
            error: null,
            lockedBy: null,
            lockedUntil: null,
            updatedAt: new Date(),
          })
          .where(owned);
      },
      failed: async (reason, uncertain) => {
        await db
          .update(instagramOutreachQueue)
          .set({
            status: uncertain ? "uncertain" : "failed",
            error: reason.slice(0, 800),
            lockedBy: null,
            lockedUntil: null,
            updatedAt: new Date(),
          })
          .where(owned);
      },
    },
  );
}

export async function runInstagramOutreachTick(): Promise<void> {
  const rows = await db
    .selectDistinct({ organizationId: instagramOutreachQueue.organizationId })
    .from(instagramOutreachQueue)
    .where(
      inArray(instagramOutreachQueue.status, [
        "queued",
        "resolving",
        "sending",
      ]),
    );
  for (const row of rows) {
    try {
      await runInOrganization(row.organizationId, runForOrganization);
    } catch (error) {
      console.error(
        "[instagram/outreach] organization tick failed",
        row.organizationId,
        error,
      );
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let working = false;
export function startInstagramOutreachWorker(): void {
  if (timer || process.env.NODE_ENV !== "production") return;
  const tick = async () => {
    if (working) return;
    working = true;
    try {
      await runInstagramOutreachTick();
    } catch (error) {
      if (!isMissingTable(error))
        console.error("[instagram/outreach] tick failed", error);
    } finally {
      working = false;
    }
  };
  timer = setInterval(() => void tick(), 30_000);
  timer.unref();
  void tick();
}

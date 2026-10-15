import "server-only";

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { currentOrganizationId } from "@/lib/tenancy/scope";
import { replyState, type ReplyState } from "./runReplies";

export type RunReply = { id: string; who: string; channel: string; receivedAt: string; preview: string; state: ReplyState };

type Row = {
  runId: string;
  messageId: string;
  receivedAt: string;
  channel: string;
  preview: string | null;
  who: string | null;
  autopilot: boolean;
  draftStatus: string | null;
  autoStatus: string | null;
  autoReason: string | null;
  jobStatus: string | null;
  sendAfter: string | null;
};

/** The latest replies from each run's leads since it was approved, with what became of each. */
export async function runReplies(runIds: readonly string[], perRun = 5): Promise<Record<string, RunReply[]>> {
  if (!runIds.length) return {};
  const organizationId = currentOrganizationId();
  const rows = await db.execute(sql`
    select l.run_id::text as "runId", m.id::text as "messageId", to_char(m.sent_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "receivedAt",
      m.channel, left(m.body_text, 160) as "preview", coalesce(p.full_name, p.phone, p.email) as "who", r.autopilot,
      d.status as "draftStatus", a.status as "autoStatus", a.reason as "autoReason",
      j.status as "jobStatus", to_char(j.run_after at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "sendAfter"
    from outreach_run_leads l
    join outreach_runs r on r.id = l.run_id and r.organization_id = l.organization_id
    join people p on p.id = l.person_id and p.organization_id = l.organization_id
    join crm_conversations c on c.person_id = l.person_id and c.organization_id = l.organization_id
    join crm_conversation_messages m on m.conversation_id = c.id and m.direction = 'inbound' and m.sent_at >= coalesce(r.approved_at, r.created_at)
    left join lateral (select id, status from crm_drafts where reply_for_message_id = m.id order by created_at desc limit 1) d on true
    left join lateral (select status, reason from autopilot_replies where draft_id = d.id and organization_id = l.organization_id order by created_at desc limit 1) a on true
    left join lateral (select status, run_after from crm_jobs where kind = 'auto_send' and entity_id = d.id and organization_id = l.organization_id order by created_at desc limit 1) j on true
    where l.organization_id = ${organizationId}
      and l.run_id in (${sql.join(runIds.map((id) => sql`${id}::uuid`), sql`, `)})
    order by m.sent_at desc
    limit ${perRun * runIds.length * 4}
  `);
  const out: Record<string, RunReply[]> = {};
  for (const row of Array.from(rows) as unknown as Row[]) {
    const list = (out[row.runId] ??= []);
    if (list.length >= perRun || list.some((item) => item.id === row.messageId)) continue;
    list.push({
      id: row.messageId,
      who: row.who ?? "A lead",
      channel: row.channel,
      receivedAt: row.receivedAt,
      preview: (row.preview ?? "").replace(/\s+/g, " ").trim(),
      state: replyState(row, row.autopilot),
    });
  }
  return out;
}

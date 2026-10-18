import "server-only";

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { currentOrganizationId } from "@/lib/tenancy/scope";
import { leadProgress, type LeadProgress, type LeadProgressInput } from "./runLeads";

export type RunLead = { personId: string; who: string; channel: string; progress: LeadProgress };

type Row = LeadProgressInput & { runId: string; personId: string; who: string | null };

/** Every lead of the given runs and where it stands (at most `perRun` each, replied and interested first). */
export async function runLeads(runIds: readonly string[], perRun = 200): Promise<Record<string, RunLead[]>> {
  if (!runIds.length) return {};
  const organizationId = currentOrganizationId();
  const rows = await db.execute(sql`
    select l.run_id::text as "runId", l.person_id::text as "personId", l.channel, l.status as "runStatus",
      coalesce(p.full_name, p.phone, p.email, p.raw->'instagram'->>'username') as "who",
      e.sequence_status as "emailStatus",
      w.status as "whatsappStatus", w.last_sent_at::text as "whatsappSentAt", left(w.last_error, 120) as "whatsappError",
      wm.delivered_at::text as "whatsappDeliveredAt", wm.read_at::text as "whatsappReadAt",
      li.status::text as "linkedinStatus",
      case when ig.status='sent' and exists (
        select 1 from instagram_messages im join instagram_chats ic on ic.id=im.chat_id
        join instagram_accounts ia on ia.id=ic.account_id
        where ia.organization_id=l.organization_id and ic.person_id=l.person_id
          and im.direction='inbound' and not im.historical and im.sent_at>=ig.attempted_at
      ) then 'replied' else ig.status end as "instagramStatus", left(ig.error, 160) as "instagramError",
      rec.category_key as "category", sc.name as "subcategory"
    from outreach_run_leads l
    join outreach_runs r on r.id = l.run_id and r.organization_id = l.organization_id
    join people p on p.id = l.person_id and p.organization_id = l.organization_id
    left join outreach_leads e on l.channel = 'email' and e.person_id = l.person_id and e.campaign_id::text = r.campaigns ->> 'email'
    left join whatsapp_campaign_leads w on l.channel = 'whatsapp' and w.person_id = l.person_id and w.campaign_id::text = r.campaigns ->> 'whatsapp'
    left join lateral (
      select m.delivered_at, m.read_at from whatsapp_campaign_sends s join whatsapp_messages m on m.id = s.whatsapp_message_id
      where s.lead_id = w.id and s.status = 'sent' order by s.step desc limit 1
    ) wm on w.id is not null
    left join "Lead" li on l.channel = 'linkedin' and li."personId" = l.person_id and li."campaignId" = r.campaigns ->> 'linkedin'
    left join instagram_outreach_queue ig on l.channel = 'instagram' and ig.person_id=l.person_id and ig.run_id=r.id and ig.organization_id=l.organization_id
    left join lateral (
      select category_key, subcategory_id from crm_records
      where person_id = l.person_id and organization_id = l.organization_id and last_inbound_at >= coalesce(r.approved_at, r.created_at)
      order by updated_at desc limit 1
    ) rec on true
    left join crm_subcategories sc on sc.id = rec.subcategory_id
    where l.organization_id = ${organizationId}
      and l.run_id in (${sql.join(runIds.map((id) => sql`${id}::uuid`), sql`, `)})
  `);
  const order = { good: 0, replied: 1, failed: 2, sent: 3, waiting: 4, stopped: 5 } as const;
  const out: Record<string, RunLead[]> = {};
  for (const row of Array.from(rows) as unknown as Row[]) {
    (out[row.runId] ??= []).push({ personId: row.personId, who: row.who ?? "A lead", channel: row.channel, progress: leadProgress(row) });
  }
  for (const list of Object.values(out)) {
    list.sort((a, b) => order[a.progress.tone] - order[b.progress.tone] || a.who.localeCompare(b.who));
    list.splice(perRun);
  }
  return out;
}

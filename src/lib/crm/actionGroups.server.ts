import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { CrmActionGroup } from "./actionGroups";
import { REPORT_KINDS } from "@/lib/assistant/handoff";

/** The crm_records columns the grouping reads — Drizzle columns, or raw `r.<column>` under an alias. */
export type CrmRecordColumns = { id: SQLWrapper; workflowState: SQLWrapper; nextActionAt: SQLWrapper };

/**
 * The Action required condition: a draft or classification to review, an
 * error to clear, or a follow-up that has come due. Records mid-flight
 * (classifying, waiting on a future step) are not actionable yet.
 */
export function crmActionableSql(r: CrmRecordColumns): SQL {
  return sql`(${r.workflowState} in ('action_required', 'error')
    or (${r.workflowState} = 'waiting' and ${r.nextActionAt} <= now()))`;
}

/**
 * The record's CrmActionGroup, or NULL when it is not in the queue. Mirrors the
 * precedence listCrmActions uses to name each row's action — error, then a
 * proposed classification, then the newest open draft, then the schedule — so
 * a count or filter on a group agrees with the labels the rows show. Only the
 * newest open draft counts, and a failed one falls through to the schedule.
 *
 * Follow-ups are the drafted ones awaiting approval plus those past their
 * time with nothing drafted. Counting only `waiting` records past due, as the
 * Follow-ups due figure once did, read 0 while 96 sat in the queue: a record
 * holding a follow-up draft is `action_required`, not `waiting`.
 */
export function crmActionGroupSql(r: CrmRecordColumns): SQL<CrmActionGroup | null> {
  return sql<CrmActionGroup | null>`case when ${crmActionableSql(r)} then
    case when ${r.workflowState} = 'error' then 'problem'
      when (select c.status from crm_classifications c where c.crm_record_id = ${r.id}
             order by c.created_at desc limit 1) = 'proposed' then 'classification'
      else coalesce(
        (select case when d.status = 'delivery_uncertain' then 'problem'
                     when d.status = 'awaiting_review' then case when st.step_type = 'follow_up' then 'follow_up' else 'reply' end
                end
           from crm_drafts d
           left join crm_sequence_step_runs sr on sr.id = d.sequence_step_run_id
           left join crm_sequence_steps st on st.id = sr.sequence_step_id
          where d.crm_record_id = ${r.id} and d.status in ('awaiting_review', 'failed', 'delivery_uncertain')
          order by d.updated_at desc limit 1),
        case when ${r.nextActionAt} <= now() then 'follow_up' else 'next_step' end)
    end
  end`;
}

/** The crm_records columns crmNeedsYouSql reads — Drizzle columns, or raw `r.<column>` under an alias. */
export type CrmRecordScopeColumns = { id: SQLWrapper; organizationId: SQLWrapper };

/**
 * Needs you: an open owner decision on the record that is a handoff (missing
 * information, a complaint, a negotiation, a meeting, …), or a draft awaiting
 * review. Interested and opt-out reports are shown but never count
 * (handoff.ts REPORT_KINDS). Independent of the workflow state: a handoff
 * stays the owner's after the assistant's holding reply took the record out
 * of Action required. describeConversation's `needsYou` is the same rule.
 */
export function crmNeedsYouSql(r: CrmRecordScopeColumns): SQL<boolean> {
  const reports = sql.join(REPORT_KINDS.map((kind) => sql`${kind}`), sql`, `);
  return sql<boolean>`(exists (
      select 1 from owner_decisions od
       where od.crm_record_id = ${r.id} and od.organization_id = ${r.organizationId}
         and od.status = 'open' and od.kind not in (${reports}))
    or exists (
      select 1 from crm_drafts nd
       where nd.crm_record_id = ${r.id} and nd.status = 'awaiting_review'))`;
}

/**
 * The Inbox's Needs you rows: the Action required queue plus every draft
 * awaiting review, whatever the record's state (a Review-mode reply can wait
 * on a record the queue no longer holds). Owner decisions are listed beside
 * these rows (listNeedsYou), not as rows, so one lead's question is not
 * shown twice.
 */
export function crmAttentionSql(r: CrmRecordColumns): SQL<boolean> {
  return sql<boolean>`(${crmActionableSql(r)} or exists (
      select 1 from crm_drafts attention_draft
       where attention_draft.crm_record_id = ${r.id} and attention_draft.status = 'awaiting_review'))`;
}

/** Raw-SQL record columns under the alias `r`, for statements written by hand (badges, Activity). */
export const RAW_RECORD_COLUMNS = {
  id: sql.raw("r.id"),
  organizationId: sql.raw("r.organization_id"),
  workflowState: sql.raw("r.workflow_state"),
  nextActionAt: sql.raw("r.next_action_at"),
} as const;

/**
 * The Action required count for an organization: exactly the queue
 * listCrmActions lists (crmActionableSql), counted. The navigation badge
 * reads it, so the badge and the list cannot disagree.
 */
export function crmActionQueueCountSql(organizationId: string): SQL<number> {
  return sql<number>`(SELECT count(*) FROM crm_records r WHERE r.organization_id = ${organizationId} AND ${crmActionableSql(RAW_RECORD_COLUMNS)})::int`;
}

/**
 * The Inbox badge: every Needs you row (crmAttentionSql) plus every open
 * owner decision, which the Inbox lists above the rows. Interested and
 * opt-out reports are not decisions and never count.
 */
export function crmInboxCountSql(organizationId: string): SQL<number> {
  const reports = sql.join(REPORT_KINDS.map((kind) => sql`${kind}`), sql`, `);
  return sql<number>`((SELECT count(*) FROM crm_records r WHERE r.organization_id = ${organizationId} AND ${crmAttentionSql(RAW_RECORD_COLUMNS)})
    + (SELECT count(*) FROM owner_decisions od WHERE od.organization_id = ${organizationId} AND od.status = 'open' AND od.kind NOT IN (${reports})))::int`;
}

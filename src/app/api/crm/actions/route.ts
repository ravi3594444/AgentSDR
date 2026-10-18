import type { NextRequest } from "next/server";
import { crmOperationErrorResponse } from "@/lib/crm/api";
import { CRM_ACTION_GROUPS, isCrmActionGroup } from "@/lib/crm/actionGroups";
import { CRM_CHANNELS, isCrmChannel } from "@/lib/crm/channels";
import { CRM_ACTION_SCOPES, CRM_PIPELINE_STAGES, listCrmActions, type CrmActionScope, type CrmPipelineStage } from "@/lib/crm/queries";
import type { CrmCategoryKey, CrmWorkflowState } from "@/lib/crm/schema";
import { withOrgContext } from "@/lib/auth/context";

export async function GET(request: NextRequest) {
  try {
    return await withOrgContext(request, async () => {
      const query = request.nextUrl.searchParams;
      const parseDate = (name: string) => {
        const raw = query.get(name);
        if (!raw) return undefined;
        const value = new Date(raw);
        if (Number.isNaN(value.getTime())) throw new Error(`${name} must be a valid ISO timestamp`);
        return value;
      };
      const stage = query.get("stage");
      if (stage && !CRM_PIPELINE_STAGES.includes(stage as CrmPipelineStage)) throw new Error(`stage must be one of ${CRM_PIPELINE_STAGES.join(", ")}`);
      const rawChannel = query.get("channel");
      const channel = rawChannel && isCrmChannel(rawChannel) ? rawChannel : undefined;
      if (rawChannel && !channel) throw new Error(`channel must be one of ${CRM_CHANNELS.join(", ")}`);
      // ?scope=needs_you|replies are the Needs you and All replies views; no scope is the Action required queue.
      const rawScope = query.get("scope");
      if (rawScope && !CRM_ACTION_SCOPES.includes(rawScope as CrmActionScope)) throw new Error(`scope must be one of ${CRM_ACTION_SCOPES.join(", ")}`);
      const rawActionGroup = query.get("actionGroup");
      const actionGroup = rawActionGroup && isCrmActionGroup(rawActionGroup) ? rawActionGroup : undefined;
      if (rawActionGroup && !actionGroup) throw new Error(`actionGroup must be one of ${CRM_ACTION_GROUPS.join(", ")}`);
      return Response.json(await listCrmActions({
        recordId: query.get("recordId") ?? undefined,
        scope: (rawScope || "actions") as CrmActionScope,
        stage: (stage || undefined) as CrmPipelineStage | undefined,
        potentialOnly: query.get("potentialOnly") === "true" || undefined,
        categoryKey: (query.get("categoryKey") ?? query.get("category")) as CrmCategoryKey | undefined,
        subcategoryId: query.get("subcategoryId") ?? undefined,
        channel,
        workflowState: query.get("workflowState") as CrmWorkflowState | undefined,
        classificationReview: query.has("classificationReview") ? query.get("classificationReview") === "true" : undefined,
        sequenceId: query.get("sequenceId") ?? undefined,
        actionGroup,
        error: query.get("error") === "true" || undefined,
        overdue: query.get("overdue") === "true" || undefined,
        dueAfter: parseDate("dueAfter"),
        dueBefore: parseDate("dueBefore"),
        limit: query.get("limit") ? Number(query.get("limit")) : undefined,
        offset: query.get("offset") ? Number(query.get("offset")) : undefined,
      }));
    });
  } catch (error) {
    return crmOperationErrorResponse(error);
  }
}

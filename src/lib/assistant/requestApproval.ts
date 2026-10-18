import type { AudienceChannel, OutreachPlan } from "./schema";

/**
 * One Start for a whole request. When the owner asks to find and contact
 * leads ("find dentists in Pune, Mumbai and Nagpur and contact them"), every
 * search of that request prepares its own plan when it finishes. Pressing
 * Start on one of them with "apply to the rest of this request" records a
 * request approval on that run: the other plans the same request prepares —
 * already waiting or ready later — start by themselves with the same reply
 * mode, provided they stay inside what was approved. Pure; the server side
 * is requestApproval.server.ts.
 *
 * A request is one owner message: the plans share its message id
 * (`requestId`), recorded when the owner asked, so two requests worded the
 * same — two "yes" answers — are never one request.
 *
 * What an approval never covers: another request, another conversation, a
 * channel the approved plan did not use, a plan of more than 100 leads (or
 * the approved plan's size, when larger), an inquiry run, or anything once
 * the approving run is paused, stopped or 24 hours old. The reply mode is
 * the approving run's at the moment each plan starts (switching it to
 * Review covers the rest of the request too). Leads already in another
 * running plan do not stop a plan: they stay where they are and the plan
 * starts with the rest (overlap.ts).
 */

export type RequestApproval = {
  /** The id of the owner's message that asked (the plans' requestId). */
  requestId: string;
  /** The owner's words that asked, for the record. */
  ownerRequest: string | null;
  autopilot: boolean;
  approvedBy: string | null;
  approvedAt: string;
  expiresAt: string;
  channels: AudienceChannel[];
  maxLeadsPerPlan: number;
};

export const REQUEST_APPROVAL_HOURS = 24;
const DEFAULT_PLAN_SIZE = 100;

export function makeRequestApproval(plan: Pick<OutreachPlan, "ownerRequest" | "requestId" | "assignments">, channels: AudienceChannel[], input: { autopilot: boolean; approvedBy: string | null; now: Date }): RequestApproval | null {
  if (!plan.requestId) return null;
  return {
    requestId: plan.requestId,
    ownerRequest: plan.ownerRequest ?? null,
    autopilot: input.autopilot,
    approvedBy: input.approvedBy,
    approvedAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + REQUEST_APPROVAL_HOURS * 60 * 60 * 1000).toISOString(),
    channels: [...channels],
    maxLeadsPerPlan: Math.max(DEFAULT_PLAN_SIZE, plan.assignments.length),
  };
}

/** Why `approval` does not cover starting this plan, or null when it does. */
export function approvalProblem(
  approval: RequestApproval,
  approvingRunStatus: string,
  candidate: { plan: Pick<OutreachPlan, "requestId" | "assignments" | "kind">; channels: AudienceChannel[] },
  now: Date,
): string | null {
  if (candidate.plan.kind === "inquiries") return "an inquiry run is always started by itself";
  if (approvingRunStatus !== "running" && approvingRunStatus !== "starting") return `the approved run is ${approvingRunStatus}`;
  if (now.getTime() > new Date(approval.expiresAt).getTime()) return "the approval is more than a day old";
  if (!candidate.plan.requestId || candidate.plan.requestId !== approval.requestId) return "it comes from another request";
  const extra = candidate.channels.filter((channel) => !approval.channels.includes(channel));
  if (extra.length) return `it uses ${extra.join(" and ")}, which the approved plan did not`;
  if (candidate.plan.assignments.length > approval.maxLeadsPerPlan) return `it has ${candidate.plan.assignments.length} leads, more than the ${approval.maxLeadsPerPlan} one approval covers per plan`;
  return null;
}

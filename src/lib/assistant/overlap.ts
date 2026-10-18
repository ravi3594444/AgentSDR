import type { AudienceChannel, OutreachPlan } from "./schema";

/**
 * Overlap (CONTEXT.md): a person in a plan about to start who is already
 * active in another running plan, or in another plan starting at the same
 * moment. They stay in the campaign that already covers them and are taken
 * out of the new plan, which starts with everyone else: they never block
 * it, and they are never reached again through another channel of the new
 * plan. People who may not be contacted at all any more (Do Not Contact,
 * opted out) are taken out the same way. Pure; overlap.server.ts finds
 * them under the organization's start lock.
 */

/** Leads one personalization call writes opening lines for (outreach.server.ts). */
export const PERSONALIZE_BATCH = 10;

export const OVERLAP_REASON = "already in another running plan";

/** Sends a day per channel, across its senders: what a plan's "takes about N days" is computed from. */
export type PlanPerDay = Partial<Record<AudienceChannel, number>>;

/** The plan's estimate of days for these assignments, or null when a channel's sends a day are unknown. */
export function estimateDays(assignments: OutreachPlan["assignments"], perDay: PlanPerDay): number | null {
  const counts = new Map<AudienceChannel, number>();
  for (const assignment of assignments) counts.set(assignment.channel, (counts.get(assignment.channel) ?? 0) + 1);
  let days = 0;
  for (const [channel, leads] of counts) {
    const daily = perDay[channel];
    if (!daily || daily <= 0) return null;
    days = Math.max(days, Math.ceil(leads / daily) + (channel === "whatsapp" ? 1 : 0));
  }
  return days || null;
}

/** Personalization calls a plan's start makes: one per batch of leads that get the group's messages. */
export function personalizeCalls(plan: Pick<OutreachPlan, "assignments" | "leadPlans">): number {
  const standard = plan.assignments.filter((assignment) => plan.leadPlans?.[assignment.personId]?.approach !== "personal").length;
  return Math.ceil(standard / PERSONALIZE_BATCH);
}

/**
 * The plan without these people. Their assignments, sample messages,
 * single-lead messages and lead plans go; each group's count is what is
 * left of it (a group left empty is dropped); the left-out reasons count
 * them under `reason`; and the estimate is recomputed for who is left: AI
 * calls always, their cost when the plan recorded the cost of one call,
 * days when `perDay` is given. Otherwise a figure is kept, as an upper
 * bound. People not in the plan are ignored; a plan none of them is in is
 * returned unchanged.
 */
export function planWithoutPeople(
  plan: OutreachPlan,
  personIds: Iterable<string>,
  options: { reason?: string; perDay?: PlanPerDay } = {},
): OutreachPlan {
  const inPlan = new Set(plan.assignments.map((assignment) => assignment.personId));
  const remove = new Set([...personIds].filter((personId) => inPlan.has(personId)));
  if (!remove.size) return plan;
  const keep = <T extends { personId: string }>(items: T[]) => items.filter((item) => !remove.has(item.personId));

  const assignments = keep(plan.assignments);
  const leadPlans = plan.leadPlans
    ? Object.fromEntries(Object.entries(plan.leadPlans).filter(([personId]) => !remove.has(personId)))
    : undefined;
  const groups = plan.groups && leadPlans
    ? plan.groups
      .map((group) => ({ ...group, count: assignments.filter((assignment) => leadPlans[assignment.personId]?.groupId === group.id).length }))
      .filter((group) => group.count > 0)
    : plan.groups;

  const reason = options.reason ?? OVERLAP_REASON;
  const excluded = plan.excluded.some((item) => item.reason === reason)
    ? plan.excluded.map((item) => (item.reason === reason ? { ...item, count: item.count + remove.size } : item))
    : [...plan.excluded, { reason, count: remove.size }];

  const aiCalls = personalizeCalls({ assignments, leadPlans });
  const perCall = plan.estimate.perCallUsd;
  const aiCostUsd = plan.estimate.aiCostUsd !== null && typeof perCall === "number"
    ? Number(Math.max(0, plan.estimate.aiCostUsd - perCall * (plan.estimate.aiCalls - aiCalls)).toFixed(4))
    : plan.estimate.aiCostUsd;
  const days = options.perDay ? estimateDays(assignments, options.perDay) ?? plan.estimate.days : plan.estimate.days;

  return {
    ...plan,
    assignments,
    samples: keep(plan.samples),
    ...(plan.personal ? { personal: keep(plan.personal) } : {}),
    ...(leadPlans ? { leadPlans } : {}),
    ...(groups ? { groups } : {}),
    excluded,
    estimate: { ...plan.estimate, aiCalls, aiCostUsd, days },
  };
}

/** The run's channels this plan still uses, in their order. */
export function planChannels(plan: Pick<OutreachPlan, "assignments">, channels: readonly AudienceChannel[]): AudienceChannel[] {
  return channels.filter((channel) => plan.assignments.some((assignment) => assignment.channel === channel));
}

/** Who a start left out of a plan: people covered by other plans, and people who may not be contacted, by reason. */
export type LeftOut = { covered: number; blocked: { reason: string; count: number }[] };

export function leftOutCount(left: LeftOut): number {
  return left.covered + left.blocked.reduce((sum, item) => sum + item.count, 0);
}

/** One sentence for the chat, or null when nobody was left out. */
export function leftOutSentence(left: LeftOut): string | null {
  const parts: string[] = [];
  if (left.covered) {
    parts.push(left.covered === 1
      ? "1 lead is already in another running plan and stays there"
      : `${left.covered} leads are already in other running plans and stay there`);
  }
  for (const item of left.blocked) parts.push(`${item.count} ${item.reason}`);
  return parts.length ? `Left out of this plan: ${parts.join("; ")}.` : null;
}

/** Why a plan whose every lead was left out starts nothing (`total` is its leads before). */
export function noNewLeadsReason(total: number, left: LeftOut): string {
  if (left.covered >= total) {
    return total === 1
      ? "no new leads to contact: its only lead is already in another running plan"
      : `no new leads to contact: all ${total} are already in other running plans`;
  }
  const parts = [
    ...(left.covered ? [`${left.covered} already in other running plans`] : []),
    ...left.blocked.map((item) => `${item.count} ${item.reason}`),
  ];
  return `no new leads to contact: of its ${total}, ${parts.join(", ")}`;
}

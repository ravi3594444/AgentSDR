/**
 * Autonomous mode for one chat: the owner lets the assistant work without
 * asking. Plans it prepares start on their own (Automatic replies), it does
 * not stop to ask permission, and it keeps working across many steps and
 * background searches. What still bounds it lives in code, not in the
 * prompt: the organization's daily caps (Settings → Organization, the
 * "general" Sending rules), every channel's own sending limits, Do Not
 * Contact, opt-outs and the reply agent's checks.
 *
 * Pure: the decisions are unit-tested; autonomy.server.ts reads the counts.
 */

/** Model steps one turn may take in Autonomous mode (a normal turn takes agent.ts MAX_STEPS). */
export const AUTONOMOUS_MAX_STEPS = 16;

/** The tools that start a lead search (each counts toward the daily search cap). */
export const SEARCH_TOOLS = new Set(["find_leads", "find_linkedin_leads", "find_customers_on_web", "find_instagram_prospects"]);

export type AutonomyCaps = { runsPerDay: number; leadsPerDay: number; searchesPerDay: number };

export type AutoStartFacts = {
  /** Plans started on their own in the last 24 hours. */
  runsToday: number;
  /** Leads in those plans. */
  leadsToday: number;
  /** Leads in this plan. */
  planLeads: number;
  /** This plan's leads already in another running or paused plan. */
  busyPeople: number;
  /** The person who turned Autonomous on may still let replies be answered automatically (owner or admin). */
  approverAllowed: boolean;
};

/** Why a plan must wait for the owner's Start instead of starting on its own, or null. */
export function autoStartProblem(facts: AutoStartFacts, caps: AutonomyCaps): string | null {
  if (!facts.approverAllowed) return "the person who turned Autonomous on is no longer an owner or admin";
  if (facts.planLeads <= 0) return "the plan has no leads to contact";
  if (facts.runsToday >= caps.runsPerDay) return `${facts.runsToday} plans already started on their own in the last 24 hours (your cap is ${caps.runsPerDay})`;
  if (facts.leadsToday + facts.planLeads > caps.leadsPerDay) {
    return `its ${facts.planLeads} leads would pass your cap of ${caps.leadsPerDay} leads contacted on its own in 24 hours (${facts.leadsToday} so far)`;
  }
  if (facts.busyPeople > 0) return `${facts.busyPeople} of its leads are already in another running plan`;
  return null;
}

/** Why another search may not start on its own today, or null. */
export function searchCapProblem(searchesToday: number, caps: AutonomyCaps): string | null {
  return searchesToday >= caps.searchesPerDay
    ? `${searchesToday} lead searches already started in the last 24 hours, your cap for Autonomous mode (${caps.searchesPerDay}); it resets as the oldest ones pass 24 hours`
    : null;
}

/** The rules that replace "wait for the owner" in the assistant's instructions while Autonomous is on. */
export function autonomousRules(caps: AutonomyCaps): string[] {
  return [
    "AUTONOMOUS MODE IS ON for this chat: the owner lets you work without asking permission.",
    `- A plan you prepare (prepare_outreach, or a search with contactAfter) starts by itself in Automatic mode, unless a cap stops it: up to ${caps.runsPerDay} plans and ${caps.leadsPerDay} leads a day started this way, and ${caps.searchesPerDay} searches a day. The TOOL and event lines say whether it started; never claim it did otherwise.`,
    "- Do not ask the owner whether to do the next step. Decide, do it, and report in one or two sentences what you did and what happens next. Never end with 'Want me to…?' or 'Shall I…?'.",
    "- Work toward the owner's goal until it is met: when they asked to find and contact people, contact what you find (contactAfter true) and, while searches return leads and the caps allow, start the next searches (more cities or kinds of business) without being asked. Stop when the goal is reached, the caps stop you, or more searching would only repeat what was found.",
    "- Ask the owner only for facts you cannot find or infer (what they sell, the sender's name); then continue.",
    "- Everything else in the rules still applies: only the business information as facts, no invented contacts, and the channels' limits, opt-outs and Do Not Contact are enforced for you.",
  ];
}

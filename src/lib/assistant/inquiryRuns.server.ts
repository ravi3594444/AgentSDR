import "server-only";

import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { featureState, isMissingTable } from "@/lib/features/flags.server";
import { instagramAccounts } from "@/lib/instagram/schema";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { addAudienceMembers, createAudience } from "./audiences.server";
import { inquiryRunProblem, type InquiryAccount } from "./inquiryRuns";
import { outreachRunLeads, outreachRuns, type OutreachPlan } from "./schema";

/**
 * Inquiry runs: the explicit scope for answering inbound inquiries
 * automatically. An inquiry run sends nothing first. While it is running,
 * each person whose *fresh* Instagram inquiry arrives (a new chat on an
 * account with inquiry intake on — never imported or late history) becomes
 * a member on channel "instagram", so the existing reply autopilot treats
 * their conversation exactly like a reply to outreach: the run's
 * Automatic/Review mode, Pause/Resume/Stop, Do Not Contact, takeovers,
 * stale-draft checks, the per-conversation and daily limits and the
 * handoffs all apply unchanged. Nobody else is ever answered by it:
 * Instagram chats with people who wrote before the run started, or with
 * people AgentSDR already knew, wait for review as before.
 *
 * Like outreach, it is proposed by the assistant and started only by the
 * owner's Start button (startOutreachRun), where the mode is chosen.
 */

export class InquiryRunError extends Error {}

/** Connected Instagram accounts that turn new messages into inquiries. */
export async function inquiryAccounts(): Promise<InquiryAccount[]> {
  try {
    const rows = await db.select({ unipileAccountId: instagramAccounts.unipileAccountId, username: instagramAccounts.username, status: instagramAccounts.status, inquiryIntake: instagramAccounts.inquiryIntake })
      .from(instagramAccounts).where(inOrg(instagramAccounts));
    return rows;
  } catch (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
}

/** The organization's inquiry run that is running or paused (at most one), or null. */
export async function activeInquiryRun(executor: Pick<typeof db, "select"> = db) {
  const [run] = await executor.select().from(outreachRuns)
    .where(and(inOrg(outreachRuns), inArray(outreachRuns.status, ["running", "paused"]), sql`${outreachRuns.plan} ->> 'kind' = 'inquiries'`))
    .orderBy(desc(outreachRuns.createdAt)).limit(1);
  return run ?? null;
}

/** Serializes proposing and starting inquiry runs in one organization, so at most one is ever active. */
export function inquiryRunLockSql() {
  return sql`select pg_advisory_xact_lock(hashtextextended(${`inquiry-run:${currentOrganizationId()}`}, 0))`;
}

/** Why an inquiry run cannot be proposed or started now, or null. */
export async function inquiryRunReadiness(): Promise<string | null> {
  const [features, accounts] = await Promise.all([featureState(), inquiryAccounts()]);
  return inquiryRunProblem({ features, accounts });
}

export type InquiryRunProposal = { runId: string; name: string; plan: OutreachPlan; accounts: InquiryAccount[] };

/** Proposes an inquiry run; nothing happens until the owner presses Start on its card. */
export async function prepareInquiryReplies(input: { autopilot?: boolean; ownerRequest: string | null; threadId: string | null; userId: string | null }): Promise<InquiryRunProposal> {
  const problem = await inquiryRunReadiness();
  if (problem) throw new InquiryRunError(problem);
  const running = await activeInquiryRun();
  if (running) throw new InquiryRunError(`New inquiries are already being answered by “${running.name}” (${running.status}). Pause, resume or stop it from its card.`);
  const accounts = (await inquiryAccounts()).filter((account) => account.status === "connected" && account.inquiryIntake);
  const today = new Date().toISOString().slice(0, 10);
  const name = `New Instagram inquiries (from ${today})`;
  const audienceId = await createAudience({ name, source: "list", criteria: { source: "inquiry_run", channels: ["instagram"] }, threadId: input.threadId, userId: input.userId });
  const plan: OutreachPlan = {
    kind: "inquiries",
    inquiry: { channels: ["instagram"], accounts: accounts.map((account) => ({ unipileAccountId: account.unipileAccountId, username: account.username })) },
    assignments: [],
    sequences: {},
    personalizationKey: "",
    samples: [],
    limits: { maxLeads: 0, emailPerMailboxPerDay: null, whatsappNewChatsPerDay: null },
    excluded: [],
    estimate: { aiCalls: 0, aiCostUsd: null, days: null },
    autopilot: input.autopilot ?? false,
    instructions: null,
    ownerRequest: input.ownerRequest,
  };
  const [run] = await db.insert(outreachRuns).values({
    organizationId: currentOrganizationId(),
    threadId: input.threadId,
    audienceId,
    name,
    status: "proposed",
    channels: [],
    plan,
    autopilot: false,
    createdBy: input.userId,
  }).returning({ id: outreachRuns.id });
  return { runId: run!.id, name, plan, accounts };
}

/**
 * Adds a person whose fresh inquiry just arrived to the running (or paused)
 * inquiry run, before their message reaches the CRM, so the draft written
 * for it is looked at by the autopilot under that run's mode. Returns the
 * run id, or null when no inquiry run is active (the reply then waits for
 * review as usual).
 */
export async function attachInquiryToRun(personId: string, channel: "instagram", unipileAccountId: string): Promise<string | null> {
  const run = await activeInquiryRun();
  if (!run || !run.plan.inquiry?.channels.includes(channel)) return null;
  // Only the accounts the owner saw on the card when starting it.
  if (!run.plan.inquiry.accounts.some((account) => account.unipileAccountId === unipileAccountId)) return null;
  await db.insert(outreachRunLeads).values({ organizationId: currentOrganizationId(), runId: run.id, personId, channel }).onConflictDoNothing();
  await addAudienceMembers(run.audienceId, [{ personId, source: `inquiry:${channel}` }]);
  return run.id;
}

/** How many people an inquiry run has answered for so far (its members). */
export async function inquiryRunMembers(runId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(outreachRunLeads).where(and(inOrg(outreachRunLeads), eq(outreachRunLeads.runId, runId)));
  return Number(row?.n ?? 0);
}

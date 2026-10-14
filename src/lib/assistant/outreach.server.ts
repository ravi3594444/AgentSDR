import "server-only";

import { randomUUID } from "node:crypto";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { channelRules } from "@/lib/channels/rules.server";
import { addPeopleToEmailCampaign, addPeopleToLinkedinCampaign } from "@/lib/leads/campaignAssignments";
import { companies, people } from "@/lib/leads/schema";
import { personVariables } from "@/lib/leads/variables";
import { campaignAccounts, campaigns as linkedinCampaigns, leads as linkedinLeads, linkedInAccounts } from "@/lib/linkedin/schema";
import { normalizeLinkedinSequence, linkedinSequenceError } from "@/lib/linkedin/campaignSequence";
import { buildMailboxQueues } from "@/lib/outreach/buildQueue";
import { createCampaign, emailLaunchFacts, setCampaignStatus, updateCampaignSequence } from "@/lib/outreach/campaigns";
import { parseSequence, emailLaunchProblems } from "@/lib/outreach/launch";
import { mailboxProviderConnected } from "@/lib/outreach/mailboxProviders";
import { fillTemplate } from "@/lib/outreach/render";
import { mailboxes, outreachCampaigns, outreachEmails, outreachLeads } from "@/lib/outreach/schema";
import { isPlatformConnected } from "@/lib/platform/credentials";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { addPeopleToWhatsappCampaign, createWhatsappCampaign, getWhatsappCampaignDetail, updateWhatsappCampaign } from "@/lib/whatsapp/campaigns/campaigns.server";
import { whatsappAccounts } from "@/lib/whatsapp/schema";
import { setAutopilot } from "@/lib/crm/autopilot.server";
import { eligibleAudienceMembers, summarizeAudience } from "./audiences.server";
import { countReasons } from "./audiences";
import { personalizationKey } from "./messages";
import { getBusinessProfile } from "./profile.server";
import { missingForOutreach } from "./profile";
import {
  assistantJobs,
  outreachRuns,
  type AudienceChannel,
  type OutreachPlan,
  type PlannedStep,
} from "./schema";
import type { AssistantJob, StepOutcome } from "./worker";
import { businessContext, writePersonalLines, writeSequences, type WriterCost } from "./writer.server";

/**
 * Outreach runs: what the owner approves once and the assistant then runs.
 * prepareOutreach writes the messages and works out who gets which channel
 * and what it will cost, without touching any campaign. startOutreachRun is
 * the owner's approval; a background job then writes each lead's opening
 * line and hands everyone to the existing email, WhatsApp and LinkedIn
 * engines through the same functions and launch rules their pages use, so
 * every sending rule, limit and Do Not Contact check still applies.
 */

const DEFAULT_MAX_LEADS = 100;
const HARD_MAX_LEADS = 1_000;
const PERSONALIZE_BATCH = 10;
const CHANNEL_ORDER: AudienceChannel[] = ["email", "whatsapp", "linkedin"];

export class OutreachError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutreachError";
  }
}

export type ChannelStatus = { available: boolean; reason: string | null; senders: number; perSenderPerDay: number | null };

/** Which channels can send right now, how many senders each has, and their daily allowance. */
export async function channelAvailability(): Promise<Record<AudienceChannel, ChannelStatus> & { signatureAppended: boolean; whatsappAccountIds: string[]; linkedinAccountIds: string[] }> {
  const connectedMailboxes = await db.select({ provider: mailboxes.provider, limit: mailboxes.dailySendLimit, signature: mailboxes.signatureHtml })
    .from(mailboxes).where(and(inOrg(mailboxes), eq(mailboxes.status, "connected")));
  const sendable = [];
  for (const mailbox of connectedMailboxes) if (await mailboxProviderConnected(mailbox.provider)) sendable.push(mailbox);
  const unipile = await isPlatformConnected("unipile");
  const whatsapp = unipile
    ? await db.select({ id: whatsappAccounts.id }).from(whatsappAccounts).where(and(inOrg(whatsappAccounts), eq(whatsappAccounts.status, "connected")))
    : [];
  const linkedin = unipile
    ? await db.select({ id: linkedInAccounts.id }).from(linkedInAccounts).where(and(inOrg(linkedInAccounts), eq(linkedInAccounts.status, "CONNECTED")))
    : [];
  const [whatsappRules, linkedinRules] = await Promise.all([channelRules("whatsapp"), channelRules("linkedin")]);
  return {
    email: {
      available: sendable.length > 0,
      reason: sendable.length ? null : connectedMailboxes.length ? "the mailboxes' sending account (Google Workspace or Unipile) is not connected" : "no sending mailbox is connected (Settings → Email → Mailboxes)",
      senders: sendable.length,
      perSenderPerDay: sendable.length ? Math.round(sendable.reduce((sum, mailbox) => sum + mailbox.limit, 0) / sendable.length) : null,
    },
    whatsapp: {
      available: whatsapp.length > 0,
      reason: whatsapp.length ? null : unipile ? "no WhatsApp number is linked (Settings → WhatsApp → Numbers)" : "Unipile is not connected",
      senders: whatsapp.length,
      perSenderPerDay: whatsapp.length ? Number(whatsappRules.newChatsPerDay) : null,
    },
    linkedin: {
      available: linkedin.length > 0,
      reason: linkedin.length ? null : unipile ? "no LinkedIn account is connected (Settings → LinkedIn → Accounts)" : "Unipile is not connected",
      senders: linkedin.length,
      perSenderPerDay: linkedin.length ? Number(linkedinRules.invitesPerDayFree ?? 20) : null,
    },
    signatureAppended: sendable.some((mailbox) => Boolean(mailbox.signature?.trim())),
    whatsappAccountIds: whatsapp.map((row) => row.id),
    linkedinAccountIds: linkedin.map((row) => row.id),
  };
}

type PersonRow = { person: typeof people.$inferSelect; company: typeof companies.$inferSelect | null };

async function loadPeople(personIds: string[]): Promise<Map<string, PersonRow>> {
  if (!personIds.length) return new Map();
  const rows = await db.select({ person: people, company: companies }).from(people)
    .leftJoin(companies, and(eq(companies.id, people.companyId), inOrg(companies)))
    .where(and(inOrg(people), inArray(people.id, personIds)));
  return new Map(rows.map((row) => [row.person.id, row]));
}

function leadVariables(row: PersonRow, key: string, line: string): Record<string, string> {
  const variables = personVariables(row.person, row.company);
  const raw = (row.person.raw ?? {}) as Record<string, unknown>;
  variables.company ??= typeof raw.businessName === "string" ? raw.businessName : variables.companyName ?? "";
  if (!variables.company) variables.company = variables.companyName ?? "";
  variables[key] = line;
  return variables;
}

function render(step: PlannedStep, variables: Record<string, string>): { subject: string | null; body: string } {
  return {
    subject: step.subject ? fillTemplate(step.subject, variables) : null,
    body: fillTemplate(step.body, variables).replace(/\n{3,}/g, "\n\n").trim(),
  };
}

export type PrepareInput = {
  audienceId: string;
  channels?: AudienceChannel[];
  maxLeads?: number;
  autopilot?: boolean;
  instructions?: string | null;
  threadId: string | null;
  userId: string | null;
};

export type Proposal = {
  runId: string;
  name: string;
  audience: { id: string; name: string; eligible: number; total: number };
  plan: OutreachPlan;
};

/** Writes the messages and plans the run. Creates no campaign and sends nothing. */
export async function prepareOutreach(input: PrepareInput): Promise<Proposal> {
  const profile = await getBusinessProfile();
  const missing = missingForOutreach(profile);
  if (missing.length) throw new OutreachError(`Before writing outreach I need ${missing.join(", ")}.`);
  const audience = await summarizeAudience(input.audienceId);
  if (!audience) throw new OutreachError("That audience does not exist.");
  if (!audience.eligible) throw new OutreachError(`No lead in “${audience.name}” can be contacted: ${audience.excluded.map((e) => `${e.count} × ${e.reason}`).join("; ") || "it is empty"}.`);

  const availability = await channelAvailability();
  const wanted = (input.channels?.length ? input.channels : profile.preferredChannels?.length ? profile.preferredChannels : CHANNEL_ORDER)
    .filter((channel, index, all) => CHANNEL_ORDER.includes(channel) && all.indexOf(channel) === index);
  const usable = wanted.filter((channel) => availability[channel].available);
  if (!usable.length) {
    throw new OutreachError(`None of the chosen channels can send yet: ${wanted.map((channel) => `${channel} — ${availability[channel].reason}`).join("; ")}.`);
  }

  const maxLeads = Math.min(HARD_MAX_LEADS, Math.max(1, Math.round(input.maxLeads ?? Math.min(DEFAULT_MAX_LEADS, audience.eligible))));
  const members = await eligibleAudienceMembers(input.audienceId);
  const assignments: OutreachPlan["assignments"] = [];
  const unassigned: string[] = [];
  for (const member of members) {
    if (!member.personId) continue;
    const channel = usable.find((candidate) => member.channels.includes(candidate));
    if (!channel) {
      unassigned.push(`reachable only by ${member.channels.join(" or ")}, which ${member.channels.length > 1 ? "are" : "is"} not used in this run`);
      continue;
    }
    if (assignments.length < maxLeads) assignments.push({ personId: member.personId, channel });
  }
  if (!assignments.length) throw new OutreachError(`No lead in this audience can be reached on ${usable.join(" or ")}.`);
  const channels = usable.filter((channel) => assignments.some((assignment) => assignment.channel === channel));

  const runId = randomUUID();
  const key = personalizationKey(runId);
  const cost: WriterCost = { calls: 0, usd: null };
  const context = await businessContext(profile);
  const audienceDescription = `${audience.name}${typeof audience.criteria.what === "string" ? ` (${audience.criteria.what} in ${String(audience.criteria.where ?? "")})` : ""}; ${assignments.length} leads, mostly businesses rather than named people`;
  const sequences = await writeSequences({
    profile,
    context,
    channels,
    personalizationKey: key,
    signatureAppended: availability.signatureAppended,
    instructions: input.instructions?.trim() || null,
    audienceDescription,
    cost,
  });

  // A sample per channel, with real opening lines, as the leads will get them.
  const sampleAssignments = channels.flatMap((channel) => assignments.filter((assignment) => assignment.channel === channel).slice(0, channel === channels[0] ? 2 : 1));
  const factsByPerson = new Map(members.map((member) => [member.personId, member.facts]));
  const peopleRows = await loadPeople(sampleAssignments.map((assignment) => assignment.personId));
  const lines = await writePersonalLines({
    context,
    leads: sampleAssignments.map((assignment, index) => ({ index, facts: { ...factsByPerson.get(assignment.personId), name: peopleRows.get(assignment.personId)?.person.fullName ?? "" } })),
    cost,
  });
  const samples: OutreachPlan["samples"] = sampleAssignments.flatMap((assignment, index) => {
    const row = peopleRows.get(assignment.personId);
    if (!row) return [];
    const variables = leadVariables(row, key, lines.get(index) ?? "");
    return [{
      personId: assignment.personId,
      name: members.find((member) => member.personId === assignment.personId)?.name ?? "Lead",
      channel: assignment.channel,
      messages: (sequences[assignment.channel] ?? []).map((step) => render(step, variables)),
    }];
  });

  const perChannel = (channel: AudienceChannel) => assignments.filter((assignment) => assignment.channel === channel).length;
  const days = Math.max(0, ...channels.map((channel) => {
    const status = availability[channel];
    const perDay = (status.senders || 1) * (status.perSenderPerDay ?? 20);
    return Math.ceil(perChannel(channel) / perDay) + (channel === "whatsapp" ? 1 : 0);
  }));
  const personalizeCalls = Math.ceil(assignments.length / PERSONALIZE_BATCH);
  const perCall = cost.usd !== null && cost.calls ? cost.usd / cost.calls : null;
  const plan: OutreachPlan = {
    assignments,
    sequences,
    personalizationKey: key,
    samples,
    limits: {
      maxLeads,
      emailPerMailboxPerDay: availability.email.available ? availability.email.perSenderPerDay : null,
      whatsappNewChatsPerDay: availability.whatsapp.available ? availability.whatsapp.perSenderPerDay : null,
    },
    excluded: [...audience.excluded, ...countReasons(unassigned)],
    estimate: {
      aiCalls: personalizeCalls,
      aiCostUsd: perCall !== null ? Number((perCall * personalizeCalls + (cost.usd ?? 0)).toFixed(4)) : null,
      days: days || null,
    },
    autopilot: Boolean(input.autopilot),
    instructions: input.instructions?.trim() || null,
  };
  const name = `${audience.name}`.slice(0, 120);
  await db.insert(outreachRuns).values({
    organizationId: currentOrganizationId(),
    id: runId,
    threadId: input.threadId,
    audienceId: audience.id,
    name,
    status: "proposed",
    channels,
    plan,
    autopilot: plan.autopilot,
    createdBy: input.userId,
  });
  return { runId, name, audience: { id: audience.id, name: audience.name, eligible: audience.eligible, total: audience.total }, plan };
}

export async function getRun(runId: string) {
  const [run] = await db.select().from(outreachRuns).where(and(inOrg(outreachRuns), eq(outreachRuns.id, runId))).limit(1);
  return run ?? null;
}

/**
 * The owner's approval. Only a person calls this (the Start button), never
 * the assistant's model: a proposal becomes a running campaign only here.
 */
export async function startOutreachRun(runId: string, userId: string | null, options: { autopilot?: boolean } = {}): Promise<{ jobId: string }> {
  const run = await getRun(runId);
  if (!run) throw new OutreachError("That outreach plan does not exist.");
  if (run.status !== "proposed") throw new OutreachError(`This plan is already ${run.status}.`);
  const availability = await channelAvailability();
  const broken = run.channels.filter((channel) => !availability[channel].available);
  if (broken.length) throw new OutreachError(`Cannot start: ${broken.map((channel) => `${channel} — ${availability[channel].reason}`).join("; ")}.`);
  const autopilot = options.autopilot ?? run.autopilot;
  const claimed = await db.update(outreachRuns)
    .set({ status: "starting", approvedBy: userId, approvedAt: new Date(), autopilot, updatedAt: new Date() })
    .where(and(inOrg(outreachRuns), eq(outreachRuns.id, runId), eq(outreachRuns.status, "proposed")))
    .returning({ id: outreachRuns.id });
  if (!claimed.length) throw new OutreachError("This plan was started already.");
  const [job] = await db.insert(assistantJobs).values({
    organizationId: currentOrganizationId(),
    kind: "outreach_start",
    stage: "personalizing",
    threadId: run.threadId,
    audienceId: run.audienceId,
    runId,
    payload: { personalizeIndex: 0 },
    progress: { stage: "personalizing", personalized: 0, total: run.plan.assignments.length },
    createdBy: userId,
  }).returning({ id: assistantJobs.id });
  return { jobId: job!.id };
}

async function writeLines(runId: string, key: string, personIds: string[], startIndex: number): Promise<number> {
  const run = await getRun(runId);
  if (!run) throw new OutreachError("The run disappeared.");
  const members = await eligibleAudienceMembers(run.audienceId);
  const facts = new Map(members.map((member) => [member.personId, member.facts]));
  const rows = await loadPeople(personIds);
  const cost: WriterCost = { calls: 0, usd: null };
  const lines = await writePersonalLines({
    context: await businessContext(await getBusinessProfile()),
    leads: personIds.map((personId, index) => ({ index: startIndex + index, facts: { ...facts.get(personId), name: rows.get(personId)?.person.fullName ?? "" } })),
    cost,
  });
  for (const [index, personId] of personIds.entries()) {
    const line = lines.get(startIndex + index) ?? "";
    await db.update(people)
      .set({ raw: sql`coalesce(${people.raw}, '{}'::jsonb) || ${JSON.stringify({ [key]: line })}::jsonb`, updatedAt: new Date() })
      .where(and(inOrg(people), eq(people.id, personId)));
  }
  return personIds.length;
}

function emailSequence(steps: PlannedStep[]) {
  const parsed = parseSequence(steps.map((step, index) => ({ stepNumber: index + 1, subject: step.subject ?? "", body: step.body, waitDays: index === 0 ? 0 : step.waitDays })));
  if (!parsed.ok) throw new OutreachError(parsed.error);
  return parsed.sequence;
}

type ChannelLaunch = { channel: AudienceChannel; campaignId: string | null; added: number; skipped: number; problem: string | null };

async function launchEmail(name: string, steps: PlannedStep[], personIds: string[]): Promise<ChannelLaunch> {
  const campaign = await createCampaign({ name: `${name} · email` });
  const sequence = emailSequence(steps);
  await updateCampaignSequence(campaign.id, sequence);
  const added = await addPeopleToEmailCampaign(campaign.id, personIds);
  const problems = emailLaunchProblems(await emailLaunchFacts({ id: campaign.id, sequence }));
  if (problems.length) return { channel: "email", campaignId: campaign.id, added: added.added, skipped: added.requested - added.added, problem: problems.join(" ") };
  await setCampaignStatus(campaign.id, "active");
  await buildMailboxQueues({ organizationIds: [currentOrganizationId()] }).catch((error) => console.error("[assistant/outreach] queue build failed:", error));
  return { channel: "email", campaignId: campaign.id, added: added.added, skipped: added.requested - added.added, problem: null };
}

async function launchWhatsapp(name: string, steps: PlannedStep[], personIds: string[], accountIds: string[]): Promise<ChannelLaunch> {
  const campaign = await createWhatsappCampaign({
    name: `${name} · WhatsApp`,
    accountIds,
    steps: steps.map((step, index) => ({ id: randomUUID(), body: step.body, delayHours: index === 0 ? 0 : Math.max(1, step.waitDays * 24) })),
  });
  const added = await addPeopleToWhatsappCampaign(campaign.id, personIds);
  try {
    await updateWhatsappCampaign(campaign.id, { status: "active" });
  } catch (error) {
    return { channel: "whatsapp", campaignId: campaign.id, added: added.added, skipped: personIds.length - added.added, problem: error instanceof Error ? error.message : String(error) };
  }
  return { channel: "whatsapp", campaignId: campaign.id, added: added.added, skipped: personIds.length - added.added, problem: null };
}

/**
 * LinkedIn's campaign API creates and launches in its route handlers; this
 * applies the same rules (src/app/api/linkedin/campaigns/[id]/route.ts PATCH):
 * a valid sequence, connected senders, and a workable lead before ACTIVE.
 */
async function launchLinkedin(name: string, steps: PlannedStep[], personIds: string[], accountIds: string[]): Promise<ChannelLaunch> {
  const sequence = normalizeLinkedinSequence({
    invitationMessage: steps[0]?.body ?? "",
    acceptanceMessage: steps[1]?.body ?? "",
    followUp1Message: steps[2]?.body ?? "",
  });
  const sequenceError = linkedinSequenceError(sequence);
  if (sequenceError) return { channel: "linkedin", campaignId: null, added: 0, skipped: personIds.length, problem: sequenceError };
  const created = await db.transaction(async (tx) => {
    const [campaign] = await tx.insert(linkedinCampaigns).values({
      organizationId: currentOrganizationId(),
      name: `${name} · LinkedIn`,
      type: "REGULAR",
      status: "PAUSED",
      invitationMessage: sequence.invitationMessage || null,
      acceptanceMessage: sequence.acceptanceMessage || null,
      followUp1Message: sequence.followUp1Message || null,
      updatedAt: new Date(),
    }).returning();
    if (accountIds.length) await tx.insert(campaignAccounts).values(accountIds.map((linkedinAccountId) => ({ campaignId: campaign!.id, linkedinAccountId })));
    return campaign!;
  });
  const added = await addPeopleToLinkedinCampaign(created.id, personIds);
  const [workable] = await db.select({ value: count() }).from(linkedinLeads)
    .where(and(inOrg(linkedinLeads), eq(linkedinLeads.campaignId, created.id), eq(linkedinLeads.status, "PENDING")));
  if (!accountIds.length || !Number(workable?.value ?? 0)) {
    return { channel: "linkedin", campaignId: created.id, added: added.added, skipped: added.requested - added.added, problem: accountIds.length ? "no lead could be added" : "no connected LinkedIn account" };
  }
  await db.update(linkedinCampaigns).set({ status: "ACTIVE", updatedAt: new Date() }).where(and(inOrg(linkedinCampaigns), eq(linkedinCampaigns.id, created.id)));
  return { channel: "linkedin", campaignId: created.id, added: added.added, skipped: added.requested - added.added, problem: null };
}

/** The outreach_start job: personalize in batches, then launch every channel. */
export async function runOutreachStartStep(job: AssistantJob, heartbeat: () => Promise<void>): Promise<StepOutcome> {
  if (!job.runId) return { next: "failed", error: "The job lost its run." };
  const run = await getRun(job.runId);
  if (!run) return { next: "failed", error: "The run no longer exists." };
  if (run.status === "cancelled") return { next: "failed", error: "The run was cancelled before it started." };
  const plan = run.plan;

  if (job.stage === "personalizing") {
    const start = Number(job.payload.personalizeIndex ?? 0);
    const batch = plan.assignments.slice(start, start + PERSONALIZE_BATCH).map((assignment) => assignment.personId);
    if (batch.length) {
      await writeLines(run.id, plan.personalizationKey, batch, start);
      await heartbeat();
    }
    const next = start + batch.length;
    if (next < plan.assignments.length) {
      return { next: "stage", stage: "personalizing", payload: { personalizeIndex: next }, progress: { stage: "personalizing", personalized: next, total: plan.assignments.length } };
    }
    return { next: "stage", stage: "launching", progress: { stage: "launching", personalized: plan.assignments.length, total: plan.assignments.length } };
  }

  if (job.stage === "launching") {
    const availability = await channelAvailability();
    const launches: ChannelLaunch[] = [];
    for (const channel of run.channels) {
      const personIds = plan.assignments.filter((assignment) => assignment.channel === channel).map((assignment) => assignment.personId);
      const steps = plan.sequences[channel] ?? [];
      if (!personIds.length || !steps.length) continue;
      try {
        if (channel === "email") launches.push(await launchEmail(run.name, steps, personIds));
        else if (channel === "whatsapp") launches.push(await launchWhatsapp(run.name, steps, personIds, availability.whatsappAccountIds));
        else launches.push(await launchLinkedin(run.name, steps, personIds, availability.linkedinAccountIds));
      } catch (error) {
        launches.push({ channel, campaignId: null, added: 0, skipped: personIds.length, problem: error instanceof Error ? error.message : String(error) });
      }
      await heartbeat();
    }
    const launched = launches.filter((launch) => launch.campaignId && !launch.problem);
    const campaigns = Object.fromEntries(launches.filter((launch) => launch.campaignId).map((launch) => [launch.channel, launch.campaignId!]));
    if (launched.length && run.autopilot) await setAutopilot(true);
    await db.update(outreachRuns).set({
      status: launched.length ? "running" : "failed",
      campaigns,
      error: launches.filter((launch) => launch.problem).map((launch) => `${launch.channel}: ${launch.problem}`).join(" ") || null,
      updatedAt: new Date(),
    }).where(and(inOrg(outreachRuns), eq(outreachRuns.id, run.id)));
    return {
      next: launched.length ? "done" : "failed",
      ...(launched.length
        ? { result: { runId: run.id, launches, autopilot: run.autopilot } }
        : { error: `Nothing could be launched: ${launches.map((launch) => `${launch.channel}: ${launch.problem}`).join(" ")}` }),
      progress: { stage: launched.length ? "running" : "failed", launches },
    } as StepOutcome;
  }
  return { next: "failed", error: `Unknown outreach stage ${job.stage}` };
}

/** Pauses or resumes every campaign of a run. */
export async function setRunPaused(runId: string, paused: boolean): Promise<{ status: string; changed: AudienceChannel[]; problems: string[] }> {
  const run = await getRun(runId);
  if (!run) throw new OutreachError("That outreach run does not exist.");
  if (paused ? run.status !== "running" : run.status !== "paused") throw new OutreachError(`This run is ${run.status}; only a ${paused ? "running" : "paused"} run can be ${paused ? "paused" : "resumed"}.`);
  const changed: AudienceChannel[] = [];
  const problems: string[] = [];
  for (const [channel, campaignId] of Object.entries(run.campaigns) as [AudienceChannel, string][]) {
    try {
      if (channel === "email") {
        if (!paused) {
          const [campaign] = await db.select({ sequence: outreachCampaigns.sequence }).from(outreachCampaigns)
            .where(and(inOrg(outreachCampaigns), eq(outreachCampaigns.id, campaignId))).limit(1);
          const launchProblems = emailLaunchProblems(await emailLaunchFacts({ id: campaignId, sequence: campaign?.sequence }));
          if (launchProblems.length) {
            problems.push(`email: ${launchProblems.join(" ")}`);
            continue;
          }
        }
        await setCampaignStatus(campaignId, paused ? "paused" : "active");
        if (!paused) await buildMailboxQueues({ organizationIds: [currentOrganizationId()] }).catch(() => undefined);
      } else if (channel === "whatsapp") {
        await updateWhatsappCampaign(campaignId, { status: paused ? "paused" : "active" });
      } else {
        await db.update(linkedinCampaigns).set({ status: paused ? "PAUSED" : "ACTIVE", updatedAt: new Date() })
          .where(and(inOrg(linkedinCampaigns), eq(linkedinCampaigns.id, campaignId)));
      }
      changed.push(channel);
    } catch (error) {
      problems.push(`${channel}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const status = changed.length ? (paused ? "paused" : "running") : run.status;
  await db.update(outreachRuns).set({ status, updatedAt: new Date() }).where(and(inOrg(outreachRuns), eq(outreachRuns.id, runId)));
  return { status, changed, problems };
}

export type RunReport = {
  runId: string;
  name: string;
  status: string;
  autopilot: boolean;
  leads: number;
  /** messagesSent is null where the engine keeps no per-message count (LinkedIn). */
  channels: { channel: AudienceChannel; campaignId: string; contacted: number; messagesSent: number | null; replied: number; finished: number; stopped: number }[];
  error: string | null;
};

/** What a run has done so far, from the campaign engines' own records. */
export async function reportRun(runId: string): Promise<RunReport | null> {
  const run = await getRun(runId);
  if (!run) return null;
  const channels: RunReport["channels"] = [];
  for (const [channel, campaignId] of Object.entries(run.campaigns) as [AudienceChannel, string][]) {
    if (channel === "email") {
      const statuses = await db.select({ status: outreachLeads.sequenceStatus, n: count() }).from(outreachLeads)
        .where(eq(outreachLeads.campaignId, campaignId)).groupBy(outreachLeads.sequenceStatus);
      const [sent] = await db.select({ n: count() }).from(outreachEmails)
        .innerJoin(outreachLeads, eq(outreachLeads.id, outreachEmails.leadId))
        .where(and(eq(outreachLeads.campaignId, campaignId), eq(outreachEmails.status, "sent")));
      const by = (names: string[]) => statuses.filter((row) => names.includes(row.status)).reduce((sum, row) => sum + Number(row.n), 0);
      channels.push({ channel, campaignId, contacted: by(["initial_sent", "in_follow_up", "reply_received", "sequence_completed"]), messagesSent: Number(sent?.n ?? 0), replied: by(["reply_received"]), finished: by(["sequence_completed"]), stopped: by(["bounced", "suppressed", "unsubscribed"]) });
    } else if (channel === "whatsapp") {
      const { stats } = await getWhatsappCampaignDetail(campaignId);
      channels.push({ channel, campaignId, contacted: stats.in_sequence + stats.replied + stats.completed, messagesSent: stats.messagesSent, replied: stats.replied, finished: stats.completed, stopped: stats.failed + stats.stopped });
    } else {
      const statuses = await db.select({ status: linkedinLeads.status, n: count() }).from(linkedinLeads)
        .where(and(inOrg(linkedinLeads), eq(linkedinLeads.campaignId, campaignId))).groupBy(linkedinLeads.status);
      const by = (names: string[]) => statuses.filter((row) => names.includes(row.status)).reduce((sum, row) => sum + Number(row.n), 0);
      const reached = ["REQUEST_SENT", "CONNECTED", "ACCEPT_MESSAGE_SENT", "FOLLOW_UP_1_SENT", "FOLLOW_UP_2_SENT", "FOLLOW_UP_3_SENT", "REPLIED", "COMPLETED"];
      channels.push({ channel, campaignId, contacted: by(reached), messagesSent: null, replied: by(["REPLIED"]), finished: by(["COMPLETED"]), stopped: by(["FAILED", "CANCELLED"]) });
    }
  }
  return { runId: run.id, name: run.name, status: run.status, autopilot: run.autopilot, leads: run.plan.assignments.length, channels, error: run.error };
}

export async function listRuns(limit = 10) {
  return db.select({ id: outreachRuns.id, name: outreachRuns.name, status: outreachRuns.status, channels: outreachRuns.channels, autopilot: outreachRuns.autopilot, createdAt: outreachRuns.createdAt })
    .from(outreachRuns).where(inOrg(outreachRuns)).orderBy(desc(outreachRuns.createdAt)).limit(limit);
}

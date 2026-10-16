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
import { mailboxes, outreachCampaigns, outreachEmails, outreachLeads, outreachMailboxQueue } from "@/lib/outreach/schema";
import { isPlatformConnected } from "@/lib/platform/credentials";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { addPeopleToWhatsappCampaign, createWhatsappCampaign, getWhatsappCampaignDetail, updateWhatsappCampaign } from "@/lib/whatsapp/campaigns/campaigns.server";
import { whatsappAccounts, whatsappCampaignLeads } from "@/lib/whatsapp/schema";
import { requeueRunAutopilot } from "./autopilotRun.server";
import { eligibleAudienceMembers, summarizeAudience } from "./audiences.server";
import { countReasons } from "./audiences";
import { availableTokens, leadTextKey, MAX_PERSONAL, perLeadSteps, personalizationKey, settleGroups, templateTokens, type LeadApproach } from "./messages";
import { displayBusinessName, pitchProblems } from "./pitch";
import { getBusinessProfile } from "./profile.server";
import { effectiveBusinessProfile } from "./businessContext.server";
import { activeInquiryRun, inquiryRunLockSql, inquiryRunMembers, inquiryRunReadiness } from "./inquiryRuns.server";
import { missingForOutreach } from "./profile";
import {
  assistantJobs,
  outreachRunLeads,
  outreachRuns,
  type AudienceChannel,
  type RunLeadChannel,
  type OutreachPlan,
  type PlanGroup,
  type PlannedStep,
} from "./schema";
import type { AssistantJob, StepOutcome } from "./worker";
import { businessContext, sortLeads, writePersonalLines, writePersonalMessages, writeSequences, type WriterCost } from "./writer.server";

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
/** Leads sorted per model call, and first messages written per call. */
const SORT_BATCH = 25;
const PERSONAL_BATCH = 5;
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
  // The name as people say it in a greeting: "Sold By Tereza", not "Sold By Tereza Inc.".
  variables.company = displayBusinessName(variables.company);
  variables[key] = line;
  return variables;
}

/** What the sorting and writing models may know of a lead: its public facts, title, company and short own fields. */
function leadFacts(memberFacts: Record<string, string>, row: PersonRow | undefined): Record<string, string> {
  const out: Record<string, string> = { ...memberFacts };
  if (!row) return out;
  if (row.person.fullName && !out.name) out.name = row.person.fullName;
  if (row.person.title) out.title ??= row.person.title;
  if (row.company?.name) out.company ??= row.company.name;
  if (out.company) out.company = displayBusinessName(out.company);
  if (row.company?.domain) out.website ??= row.company.domain;
  for (const [field, value] of Object.entries((row.person.raw ?? {}) as Record<string, unknown>)) {
    if (Object.keys(out).length >= 14) break;
    if (typeof value !== "string" || !value.trim() || value.length > 200) continue;
    if (/^p_[0-9a-f]{8}/.test(field) || ["addedVia", "discoveredVia"].includes(field)) continue;
    out[field] ??= value;
  }
  return out;
}

/** The lead's first message as it will read after their opening line: what the line must not repeat. */
function firstMessageAfterLine(step: PlannedStep | undefined, row: PersonRow | undefined, key: string): string {
  if (!step) return "";
  return row ? render(step, leadVariables(row, key, "")).body : step.body;
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
  /** Reuse this earlier run's messages (a follow-on plan, approved again). */
  basedOnRunId?: string | null;
  /** The owner's words that asked for this outreach. */
  ownerRequest?: string | null;
  /** The id of the owner's message that asked (requestApproval.ts). */
  requestId?: string | null;
  /** Sort the leads into kinds and approaches (default true when they have facts to sort by). */
  sortLeads?: boolean;
  /** Contact leads the sorting would leave out, too. */
  includeSkipped?: boolean;
  threadId: string | null;
  userId: string | null;
};

/** An earlier run's messages for the channels wanted, with its per-lead merge key swapped for the new run's. */
function reuseSequences(source: Partial<Record<AudienceChannel, PlannedStep[]>>, baseKey: string, key: string, channels: AudienceChannel[], tokens: readonly string[]): Partial<Record<AudienceChannel, PlannedStep[]>> {
  const out: Partial<Record<AudienceChannel, PlannedStep[]>> = {};
  const token = new RegExp(`\\{\\{\\s*${baseKey}\\s*\\}\\}`, "g");
  const allowed = new Set([...tokens, baseKey].map((name) => name.toLowerCase()));
  for (const channel of channels) {
    const steps = source[channel];
    // Messages using a field these leads lack are written afresh instead.
    if (steps?.some((step) => templateTokens(`${step.subject ?? ""} ${step.body}`).some((name) => !allowed.has(name.toLowerCase())))) continue;
    // Messages that would be skipped by busy readers (pitch.ts) are written afresh rather than reused.
    if (steps?.some((step, index) => pitchProblems(channel, step.body, { first: index === 0 }).length)) continue;
    if (steps?.length) out[channel] = steps.map((step) => ({ ...step, subject: step.subject?.replace(token, `{{${key}}}`) ?? null, body: step.body.replace(token, `{{${key}}}`) }));
  }
  return out;
}

export type Proposal = {
  runId: string;
  name: string;
  audience: { id: string; name: string; eligible: number; total: number };
  plan: OutreachPlan;
};

/** Writes the messages and plans the run. Creates no campaign and sends nothing. */
export async function prepareOutreach(input: PrepareInput): Promise<Proposal> {
  // The saved profile, signed with the name the connected accounts already use when it names no sender.
  const profile = await effectiveBusinessProfile();
  const missing = missingForOutreach(profile);
  if (missing.length) throw new OutreachError(`Before writing outreach I need ${missing.join(", ")}.`);
  const audience = await summarizeAudience(input.audienceId);
  if (!audience) throw new OutreachError("That audience does not exist.");
  if (!audience.eligible) throw new OutreachError(`No lead in “${audience.name}” can be contacted: ${audience.excluded.map((e) => `${e.count} × ${e.reason}`).join("; ") || "it is empty"}.`);

  const base = input.basedOnRunId ? await getRun(input.basedOnRunId) : null;
  if (input.basedOnRunId && !base) throw new OutreachError("That earlier run does not exist.");
  const availability = await channelAvailability();
  const wanted = (input.channels?.length ? input.channels : base ? base.channels : profile.preferredChannels?.length ? profile.preferredChannels : CHANNEL_ORDER)
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

  const runId = randomUUID();
  const key = personalizationKey(runId);
  const cost: WriterCost = { calls: 0, usd: null, runId };
  const context = await businessContext(profile);
  const instructions = input.instructions?.trim() || null;
  const memberByPerson = new Map(members.map((member) => [member.personId, member]));
  const leadRows = await loadPeople(assignments.map((assignment) => assignment.personId));
  const nameOf = (personId: string) => memberByPerson.get(personId)?.name ?? leadRows.get(personId)?.person.fullName ?? "Lead";

  // 1. Sort the leads: what kind each is, and whether it gets its group's
  // message, one written for it alone, or nothing (with the reason).
  const facts = assignments.map((assignment) => leadFacts(memberByPerson.get(assignment.personId)?.facts ?? {}, leadRows.get(assignment.personId)));
  const sortable = input.sortLeads !== false && facts.some((item) => Object.keys(item).some((name) => name !== "name"));
  const sorting = new Map<number, { group: string; approach: LeadApproach; reason: string }>();
  if (sortable) {
    const known: string[] = [];
    for (let start = 0; start < assignments.length; start += SORT_BATCH) {
      const batch = facts.slice(start, start + SORT_BATCH).map((item, offset) => ({ index: start + offset, facts: item }));
      for (const [index, value] of await sortLeads({ context, leads: batch, knownGroups: known, cost })) {
        sorting.set(index, value);
        if (!known.some((label) => label.toLowerCase() === value.group.toLowerCase())) known.push(value.group);
      }
    }
  }
  const fallbackGroup = typeof audience.criteria.what === "string" && audience.criteria.what.trim() ? audience.criteria.what.trim().replace(/^./, (c) => c.toUpperCase()) : "Your leads";
  const skipped: NonNullable<OutreachPlan["skipped"]> = [];
  const kept: { assignment: OutreachPlan["assignments"][number]; facts: Record<string, string>; group: string; approach: "standard" | "personal"; reason: string }[] = [];
  assignments.forEach((assignment, index) => {
    const sort = sorting.get(index) ?? { group: fallbackGroup, approach: "standard" as LeadApproach, reason: "" };
    if (sort.approach === "skip" && !input.includeSkipped) {
      skipped.push({ personId: assignment.personId, name: nameOf(assignment.personId), reason: sort.reason || "not a fit for your offer" });
    } else {
      kept.push({ assignment, facts: facts[index]!, group: sort.group, approach: sort.approach === "personal" ? "personal" : "standard", reason: sort.reason });
    }
  });
  if (!kept.length) {
    throw new OutreachError(`I sorted these ${assignments.length} leads and none fits your offer (${[...new Set(skipped.map((item) => item.reason))].slice(0, 3).join("; ")}). Say "include them anyway" to contact them.`);
  }
  kept.filter((lead) => lead.approach === "personal").slice(MAX_PERSONAL).forEach((lead) => { lead.approach = "standard"; });
  const finalAssignments = kept.map((lead) => lead.assignment);
  const channels = usable.filter((channel) => finalAssignments.some((assignment) => assignment.channel === channel));

  // 2. Messages per kind of lead, using only merge fields all its leads have.
  const groups: PlanGroup[] = [];
  const leadPlans: NonNullable<OutreachPlan["leadPlans"]> = {};
  for (const [groupIndex, settled] of settleGroups(kept.map((lead) => lead.group)).entries()) {
    const id = `g${groupIndex + 1}`;
    const groupLeads = settled.members.map((index) => kept[index]!);
    const groupChannels = channels.filter((channel) => groupLeads.some((lead) => lead.assignment.channel === channel));
    const tokens = availableTokens(groupLeads.map((lead) => {
      const row = leadRows.get(lead.assignment.personId);
      return row ? leadVariables(row, key, "") : {};
    }));
    const baseSequences = base
      ? base.plan.groups
        ? base.plan.groups.find((group) => group.label.toLowerCase() === settled.label.toLowerCase())?.sequences
        : base.plan.sequences
      : undefined;
    const reused = base && baseSequences ? reuseSequences(baseSequences, base.plan.personalizationKey, key, groupChannels, tokens) : {};
    const toWrite = groupChannels.filter((channel) => !reused[channel]);
    const written = toWrite.length ? await writeSequences({
      profile,
      context,
      channels: toWrite,
      personalizationKey: key,
      signatureAppended: availability.signatureAppended,
      instructions,
      audienceDescription: `${settled.label}: ${groupLeads.length} lead${groupLeads.length === 1 ? "" : "s"}, for example ${groupLeads.slice(0, 3).map((lead) => nameOf(lead.assignment.personId)).join(", ")}`,
      tokens,
      cost,
    }) : {};
    groups.push({ id, label: settled.label, count: groupLeads.length, sequences: { ...reused, ...written } });
    for (const lead of groupLeads) leadPlans[lead.assignment.personId] = { groupId: id, approach: lead.approach, reason: lead.reason };
  }

  // 3. First messages written for single leads, in their group's voice; one that fails its checks falls back to the group's.
  const personalLeads = kept.filter((lead) => lead.approach === "personal");
  const personal: NonNullable<OutreachPlan["personal"]> = [];
  for (let start = 0; start < personalLeads.length; start += PERSONAL_BATCH) {
    const batch = personalLeads.slice(start, start + PERSONAL_BATCH);
    const written = await writePersonalMessages({
      context,
      profile,
      signatureAppended: availability.signatureAppended,
      instructions,
      leads: batch.map((lead, offset) => {
        const group = groups.find((item) => item.id === leadPlans[lead.assignment.personId]!.groupId)!;
        return { index: start + offset, channel: lead.assignment.channel, facts: lead.facts, groupMessage: group.sequences[lead.assignment.channel]?.[0]?.body ?? "" };
      }),
      cost,
    });
    batch.forEach((lead, offset) => {
      const message = written.get(start + offset);
      const plan = leadPlans[lead.assignment.personId]!;
      if (!message) {
        plan.approach = "standard";
        return;
      }
      personal.push({ personId: lead.assignment.personId, name: nameOf(lead.assignment.personId), channel: lead.assignment.channel, groupId: plan.groupId, subject: message.subject, body: message.body, reason: lead.reason });
    });
  }

  // 4. The campaigns send each lead its own texts (written at Start).
  const sequences: Partial<Record<AudienceChannel, PlannedStep[]>> = Object.fromEntries(
    channels.map((channel) => [channel, perLeadSteps(key, channel, groups.map((group) => group.sequences[channel] ?? []))]),
  );

  // 5. A sample per kind of lead and channel, with a real opening line, as it will be sent.
  const sampleLeads = groups.flatMap((group) => channels.flatMap((channel) => {
    const lead = kept.find((item) => item.assignment.channel === channel && leadPlans[item.assignment.personId]?.groupId === group.id && leadPlans[item.assignment.personId]?.approach === "standard");
    return lead ? [{ lead, group, channel }] : [];
  })).slice(0, 6);
  const lines = await writePersonalLines({
    context,
    leads: sampleLeads.map((sample, index) => ({
      index,
      facts: { ...sample.lead.facts, name: nameOf(sample.lead.assignment.personId) },
      channel: sample.channel,
      messageAfter: firstMessageAfterLine(sample.group.sequences[sample.channel]?.[0], leadRows.get(sample.lead.assignment.personId), key),
    })),
    cost,
  });
  const samples: OutreachPlan["samples"] = sampleLeads.flatMap((sample, index) => {
    const row = leadRows.get(sample.lead.assignment.personId);
    if (!row) return [];
    const variables = leadVariables(row, key, lines.get(index) ?? "");
    const steps = (sample.group.sequences[sample.channel] ?? []).slice(0, sequences[sample.channel]?.length ?? 0);
    return [{ personId: sample.lead.assignment.personId, name: nameOf(sample.lead.assignment.personId), channel: sample.channel, groupId: sample.group.id, approach: "standard" as const, messages: steps.map((step) => render(step, variables)) }];
  });
  // Every lead written to alone, with the group's follow-ups it will get after its own first message.
  for (const message of personal) {
    const row = leadRows.get(message.personId);
    const group = groups.find((item) => item.id === message.groupId);
    if (!row || !group) continue;
    const steps = (group.sequences[message.channel] ?? []).slice(0, sequences[message.channel]?.length ?? 0);
    const followUps = steps.slice(1).map((step) => render(step, leadVariables(row, key, "")));
    samples.push({ personId: message.personId, name: message.name, channel: message.channel, groupId: group.id, approach: "personal", messages: [{ subject: message.subject, body: message.body }, ...followUps] });
  }

  const perChannel = (channel: AudienceChannel) => finalAssignments.filter((assignment) => assignment.channel === channel).length;
  const days = Math.max(0, ...channels.map((channel) => {
    const status = availability[channel];
    const perDay = (status.senders || 1) * (status.perSenderPerDay ?? 20);
    return Math.ceil(perChannel(channel) / perDay) + (channel === "whatsapp" ? 1 : 0);
  }));
  const personalizeCalls = Math.ceil(kept.filter((lead) => leadPlans[lead.assignment.personId]?.approach === "standard").length / PERSONALIZE_BATCH);
  const perCall = cost.usd !== null && cost.calls ? cost.usd / cost.calls : null;
  const plan: OutreachPlan = {
    assignments: finalAssignments,
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
    instructions,
    basedOnRunId: base?.id ?? null,
    ownerRequest: input.ownerRequest?.trim() || null,
    requestId: input.requestId ?? null,
    groups,
    leadPlans,
    personal,
    skipped,
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
 * The owner's approval: a proposal becomes a running campaign only here.
 * Called by the Start button, by a request approval the owner gave for
 * the rest of a request (requestApproval.server.ts), and in a chat the
 * owner put in Autonomous mode (autonomy.server.ts, in the name of the
 * owner or admin who turned it on, within the daily caps). Never by the
 * assistant's model directly: no tool starts outreach.
 */
export async function startOutreachRun(runId: string, userId: string | null, options: { autopilot?: boolean } = {}): Promise<{ jobId: string }> {
  const run = await getRun(runId);
  if (!run) throw new OutreachError("That outreach plan does not exist.");
  if (run.status !== "proposed") throw new OutreachError(`This plan is already ${run.status}.`);
  if (run.plan.kind === "inquiries") throw new OutreachError("This plan answers inquiries; start it with startInquiryRun.");
  const availability = await channelAvailability();
  const broken = run.channels.filter((channel) => !availability[channel].available);
  if (broken.length) throw new OutreachError(`Cannot start: ${broken.map((channel) => `${channel} — ${availability[channel].reason}`).join("; ")}.`);
  const autopilot = options.autopilot ?? run.autopilot;
  const claimed = await db.update(outreachRuns)
    .set({ status: "starting", approvedBy: userId, approvedAt: new Date(), autopilot, updatedAt: new Date() })
    .where(and(inOrg(outreachRuns), eq(outreachRuns.id, runId), eq(outreachRuns.status, "proposed")))
    .returning({ id: outreachRuns.id });
  if (!claimed.length) throw new OutreachError("This plan was started already.");
  // The approved audience, per channel: what the run (and its reply mode) covers.
  const assignments = run.plan.assignments;
  for (let index = 0; index < assignments.length; index += 500) {
    await db.insert(outreachRunLeads).values(assignments.slice(index, index + 500).map((assignment) => ({
      organizationId: currentOrganizationId(),
      runId,
      personId: assignment.personId,
      channel: assignment.channel,
    }))).onConflictDoNothing();
  }
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

/**
 * Starting an inquiry run (inquiryRuns.server.ts) sends nothing and launches
 * no campaign: it begins answering people whose fresh inquiries arrive from
 * now on, in the mode the owner chose. Re-checked here, because features or
 * accounts may have changed since the plan was proposed.
 */
export async function startInquiryRun(runId: string, userId: string | null, autopilot: boolean): Promise<void> {
  const run = await getRun(runId);
  if (!run || run.plan.kind !== "inquiries") throw new OutreachError("That inquiry plan does not exist.");
  if (run.status !== "proposed") throw new OutreachError(`This plan is already ${run.status}.`);
  const problem = await inquiryRunReadiness();
  if (problem) throw new OutreachError(`Cannot start: ${problem}`);
  // Checked and claimed under the organization's inquiry-run lock: two Starts at once cannot both win.
  await db.transaction(async (tx) => {
    await tx.execute(inquiryRunLockSql());
    const active = await activeInquiryRun(tx);
    if (active) throw new OutreachError(`New inquiries are already answered by “${active.name}”. Stop it first.`);
    const claimed = await tx.update(outreachRuns)
      .set({ status: "running", approvedBy: userId, approvedAt: new Date(), autopilot, updatedAt: new Date() })
      .where(and(inOrg(outreachRuns), eq(outreachRuns.id, run.id), eq(outreachRuns.status, "proposed")))
      .returning({ id: outreachRuns.id });
    if (!claimed.length) throw new OutreachError("This plan was started already.");
  });
}

async function writeLines(runId: string, key: string, personIds: string[], startIndex: number): Promise<number> {
  const run = await getRun(runId);
  if (!run) throw new OutreachError("The run disappeared.");
  const members = await eligibleAudienceMembers(run.audienceId);
  const facts = new Map(members.map((member) => [member.personId, member.facts]));
  const rows = await loadPeople(personIds);
  const cost: WriterCost = { calls: 0, usd: null, runId };
  const lines = await writePersonalLines({
    context: await businessContext(await getBusinessProfile()),
    leads: personIds.map((personId, index) => {
      const channel = run.plan.assignments.find((item) => item.personId === personId)?.channel;
      return {
        index: startIndex + index,
        facts: { ...facts.get(personId), name: rows.get(personId)?.person.fullName ?? "" },
        channel,
        messageAfter: channel ? firstMessageAfterLine(run.plan.sequences[channel]?.[0], rows.get(personId), key) : "",
      };
    }),
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

/**
 * A sorted plan's leads get their texts at Start: the group's messages with
 * the lead's fields and a fresh opening line, or for a lead written to alone
 * its own first message and the group's follow-ups. Stored on the person
 * (leadTextKey), where every channel's sender reads them.
 */
async function writeLeadTexts(run: NonNullable<Awaited<ReturnType<typeof getRun>>>, personIds: string[], startIndex: number): Promise<number> {
  const plan = run.plan;
  const key = plan.personalizationKey;
  const members = await eligibleAudienceMembers(run.audienceId);
  const facts = new Map(members.map((member) => [member.personId, member.facts]));
  const rows = await loadPeople(personIds);
  const standard = personIds.filter((personId) => plan.leadPlans?.[personId]?.approach !== "personal");
  const cost: WriterCost = { calls: 0, usd: null, runId: run.id };
  const lines = await writePersonalLines({
    context: await businessContext(await getBusinessProfile()),
    leads: standard.map((personId, index) => {
      const channel = plan.assignments.find((item) => item.personId === personId)?.channel;
      const group = plan.groups?.find((item) => item.id === plan.leadPlans?.[personId]?.groupId) ?? plan.groups?.[0];
      return {
        index: startIndex + index,
        facts: { ...facts.get(personId), name: rows.get(personId)?.person.fullName ?? "" },
        channel,
        messageAfter: channel ? firstMessageAfterLine(group?.sequences[channel]?.[0], rows.get(personId), key) : "",
      };
    }),
    cost,
  });
  for (const personId of personIds) {
    const row = rows.get(personId);
    const assignment = plan.assignments.find((item) => item.personId === personId);
    if (!row || !assignment) continue;
    const stepCount = plan.sequences[assignment.channel]?.length ?? 0;
    const group = plan.groups?.find((item) => item.id === plan.leadPlans?.[personId]?.groupId) ?? plan.groups?.[0];
    const groupSteps = (group?.sequences[assignment.channel] ?? []).slice(0, stepCount);
    if (groupSteps.length < stepCount) throw new OutreachError(`The messages for ${row.person.fullName ?? "a lead"} are missing; prepare the plan again.`);
    const index = standard.indexOf(personId);
    const line = index >= 0 ? lines.get(startIndex + index) ?? "" : "";
    const texts = groupSteps.map((step) => render(step, leadVariables(row, key, line)));
    const own = plan.personal?.find((message) => message.personId === personId);
    if (own && texts[0]) texts[0] = { subject: own.subject ?? texts[0].subject, body: own.body };
    const patch: Record<string, string> = { [key]: line };
    texts.forEach((text, step) => {
      patch[leadTextKey(key, step + 1, "body")] = text.body;
      patch[leadTextKey(key, step + 1, "subject")] = text.subject ?? "";
    });
    await db.update(people)
      .set({ raw: sql`coalesce(${people.raw}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`, updatedAt: new Date() })
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
      if (plan.groups?.length) await writeLeadTexts(run, batch, start);
      else await writeLines(run.id, plan.personalizationKey, batch, start);
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
export async function setRunPaused(runId: string, paused: boolean): Promise<{ status: string; changed: RunLeadChannel[]; problems: string[] }> {
  const run = await getRun(runId);
  if (!run) throw new OutreachError("That outreach run does not exist.");
  if (paused ? run.status !== "running" : run.status !== "paused") throw new OutreachError(`This run is ${run.status}; only a ${paused ? "running" : "paused"} run can be ${paused ? "paused" : "resumed"}.`);
  if (run.plan.kind === "inquiries") {
    // No campaigns: pausing holds its automatic replies (the autopilot gate
    // reads the run's status); resuming looks at the held ones again.
    const status = paused ? "paused" : "running";
    await db.update(outreachRuns).set({ status, pausedAt: paused ? new Date() : null, updatedAt: new Date() })
      .where(and(inOrg(outreachRuns), eq(outreachRuns.id, runId)));
    const problems: string[] = [];
    if (!paused && run.autopilot) await requeueRunAutopilot(runId).catch((error) => problems.push(`automatic replies: ${error instanceof Error ? error.message : String(error)}`));
    return { status, changed: run.plan.inquiry?.channels ?? ["instagram"], problems };
  }
  const changed: RunLeadChannel[] = [];
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
  await db.update(outreachRuns).set({ status, ...(changed.length ? { pausedAt: paused ? new Date() : null } : {}), updatedAt: new Date() })
    .where(and(inOrg(outreachRuns), eq(outreachRuns.id, runId)));
  // Replies the autopilot held while paused are looked at again, with every check.
  if (!paused && changed.length && run.autopilot) await requeueRunAutopilot(runId).catch((error) => problems.push(`automatic replies: ${error instanceof Error ? error.message : String(error)}`));
  return { status, changed, problems };
}

/**
 * Ends a run for good: its campaigns stop (email campaigns are marked
 * completed and their queue cleared; open WhatsApp and LinkedIn
 * enrollments are stopped, so resuming a campaign by hand cannot restart
 * them), its members are stopped, and the autopilot never answers for it
 * again. A stopped run cannot be resumed; a new plan can be started.
 */
export async function stopRun(runId: string): Promise<{ stopped: AudienceChannel[]; problems: string[] }> {
  const run = await getRun(runId);
  if (!run) throw new OutreachError("That outreach run does not exist.");
  if (!["running", "paused", "starting"].includes(run.status)) throw new OutreachError(`This run is ${run.status}; only a running or paused run can be stopped.`);
  const now = new Date();
  await db.update(outreachRuns).set({ status: "stopped", stoppedAt: now, updatedAt: now }).where(and(inOrg(outreachRuns), eq(outreachRuns.id, runId)));
  await db.update(outreachRunLeads).set({ status: "stopped", stopReason: "the run was stopped", updatedAt: now })
    .where(and(inOrg(outreachRunLeads), eq(outreachRunLeads.runId, runId), eq(outreachRunLeads.status, "active")));
  const stopped: AudienceChannel[] = [];
  const problems: string[] = [];
  for (const [channel, campaignId] of Object.entries(run.campaigns) as [AudienceChannel, string][]) {
    try {
      if (channel === "email") {
        await setCampaignStatus(campaignId, "completed");
        const leadIds = db.select({ id: outreachLeads.id }).from(outreachLeads).where(eq(outreachLeads.campaignId, campaignId));
        await db.delete(outreachMailboxQueue).where(inArray(outreachMailboxQueue.leadId, leadIds));
      } else if (channel === "whatsapp") {
        await updateWhatsappCampaign(campaignId, { status: "paused" });
        await db.update(whatsappCampaignLeads).set({ status: "stopped", nextSendAt: null, updatedAt: now })
          .where(and(eq(whatsappCampaignLeads.campaignId, campaignId), inArray(whatsappCampaignLeads.status, ["queued", "in_sequence"])));
      } else {
        await db.update(linkedinCampaigns).set({ status: "PAUSED", updatedAt: now }).where(and(inOrg(linkedinCampaigns), eq(linkedinCampaigns.id, campaignId)));
        await db.update(linkedinLeads).set({ status: "CANCELLED", updatedAt: now })
          .where(and(inOrg(linkedinLeads), eq(linkedinLeads.campaignId, campaignId), inArray(linkedinLeads.status, ["PENDING", "REQUEST_SENT", "CONNECTED", "ACCEPT_MESSAGE_SENT", "FOLLOW_UP_1_SENT", "FOLLOW_UP_2_SENT"])));
      }
      stopped.push(channel);
    } catch (error) {
      problems.push(`${channel}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { stopped, problems };
}

/**
 * Switches a run between Review and Automatic replies. To Review is always
 * allowed (less automation); to Automatic is an expansion the caller must
 * have confirmed with an owner or admin (the route checks).
 */
export async function setRunReplyMode(runId: string, automatic: boolean): Promise<void> {
  const run = await getRun(runId);
  if (!run) throw new OutreachError("That outreach run does not exist.");
  if (["stopped", "completed", "failed", "cancelled"].includes(run.status)) throw new OutreachError(`This run is ${run.status}.`);
  await db.update(outreachRuns).set({ autopilot: automatic, updatedAt: new Date() }).where(and(inOrg(outreachRuns), eq(outreachRuns.id, runId)));
  if (automatic && run.status === "running") await requeueRunAutopilot(runId);
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
  const leads = run.plan.kind === "inquiries" ? await inquiryRunMembers(run.id) : run.plan.assignments.length;
  return { runId: run.id, name: run.name, status: run.status, autopilot: run.autopilot, leads, channels, error: run.error };
}

export async function listRuns(limit = 10) {
  return db.select({ id: outreachRuns.id, name: outreachRuns.name, status: outreachRuns.status, channels: outreachRuns.channels, autopilot: outreachRuns.autopilot, createdAt: outreachRuns.createdAt })
    .from(outreachRuns).where(inOrg(outreachRuns)).orderBy(desc(outreachRuns.createdAt)).limit(limit);
}

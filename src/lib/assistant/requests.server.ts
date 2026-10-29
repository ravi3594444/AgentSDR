import "server-only";

import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { assistantJobs, assistantMessages, assistantThreads, outreachRuns } from "@/lib/assistant/schema";
import { outreachCampaigns } from "@/lib/outreach/schema";
import { whatsappCampaigns } from "@/lib/whatsapp/schema";
import { campaigns as linkedinCampaigns } from "@/lib/linkedin/schema";
import { listWork, type WorkItem } from "@/lib/activity/activity.server";
import { NOT_PREPARED } from "@/lib/activity/status";
import { reportRun } from "@/lib/assistant/outreach.server";
import { objectiveStates, objectiveView, threadObjectives, type ObjectiveView } from "@/lib/assistant/objective.server";
import { requestScope, runScope } from "@/lib/assistant/results.server";
import { currentCounts, organizationTimeZone, periodMetrics, reportFilter } from "@/lib/reporting/metrics.server";
import type { ReportScope } from "@/lib/reporting/metrics";
import { crmAttentionSql, RAW_RECORD_COLUMNS } from "@/lib/crm/actionGroups.server";
import { displayTime } from "@/lib/assistant/displayTime";
import { displayThreadTitle } from "@/lib/assistant/agent";
import { formatRequestKey, nextActionFor, parseRequestKey, requestState, type CampaignChannel, type NextStep, type RequestKey, type RequestNumbers, type RequestStateFacts } from "./requests";

/**
 * Requests (requests.ts): every piece of outreach work, grouped by what
 * started it, with one summary each — the figures, what blocks it and the
 * one next step. Every figure is read from a source the rest of the app
 * already uses, never kept as a second counter:
 *
 * - matching: the objective's qualified leads, else the searches' or plans' own counts;
 * - contacted, replied: the shared send and reply ledgers (periodMetrics,
 *   all time), which a Stop does not erase;
 * - interested: classifications applied as Interested, among its people;
 * - failed: the campaign engines' own failures (reportRun, or the campaign's leads);
 * - waiting: the Inbox's Needs you rule (crmAttentionSql) and open decisions, among its people;
 * - blocker, children: Activity's work list (planState, diagnoseDelivery);
 * - open, state: requestState (requests.ts): an open plan or search, else
 *   the objective while it runs, so a request between two searches reads
 *   as researching, not as its finished child.
 *
 * Reading never starts, sends or changes anything.
 */

const LIST_DAYS = 30;

export type RequestRow = {
  key: string;
  kind: RequestKey["kind"];
  title: string;
  channels: string[];
  state: string;
  stateLabel: string;
  open: boolean;
  threadId: string | null;
  threadTitle: string | null;
  startedAt: string;
  /** Plans' people, contacted, replied and failed, summed; null when it has no started plan. */
  counts: { leads: number; contacted: number; replied: number; failed: number } | null;
  plans: number;
  searches: number;
};

export type CampaignChild = { channel: CampaignChannel; id: string; name: string; status: string; href: string };

export type RequestSummary = {
  key: string;
  kind: RequestKey["kind"];
  title: string;
  threadId: string | null;
  open: boolean;
  stateLabel: string;
  numbers: RequestNumbers;
  /** The lead target the owner named; null when they named none (the default target is not shown as wanted). */
  target: number | null;
  blocker: string | null;
  nextAction: NextStep;
  children: { searches: WorkItem[]; plans: WorkItem[]; campaigns: CampaignChild[] };
  /** The research behind it (sources, spend, time), for a chat request with an objective. */
  objective: ObjectiveView | null;
  /** The organization's time zone, which the reasons write their times in. */
  timeZone: string;
};

const CAMPAIGN_HREF: Record<CampaignChannel, (id: string) => string> = {
  email: (id) => `/outreach/campaigns/${id}`,
  whatsapp: (id) => `/whatsapp/campaigns/${id}`,
  linkedin: (id) => `/linkedin/campaigns/${id}`,
};

/** The work item's request key: its request, else the plan or search itself. */
function keyOf(item: WorkItem): string {
  if (item.requestId) return formatRequestKey({ kind: "request", id: item.requestId });
  return item.type === "plan" ? formatRequestKey({ kind: "run", id: item.runId ?? item.id }) : formatRequestKey({ kind: "job", id: item.id });
}

/** A plan's launch job is the plan's own machinery, not a piece of work of its own. */
const isOwnWork = (item: WorkItem) => !(item.type === "job" && item.kind === "outreach_start");

/** A request's driver (the "objective" job) is its research, read through the objective row, not a search of its own. */
const isDriver = (item: WorkItem) => item.type === "job" && item.kind === "objective";

function firstLine(text: string, max = 110): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line || "Request";
}

function sumCounts(items: readonly WorkItem[]): RequestRow["counts"] {
  const counted = items.flatMap((item) => (item.counts ? [item.counts] : []));
  if (!counted.length) return null;
  return counted.reduce((sum, c) => ({ leads: sum.leads + c.leads, contacted: sum.contacted + c.contacted, replied: sum.replied + c.replied, failed: sum.failed + c.failed }), { leads: 0, contacted: 0, replied: 0, failed: 0 });
}

/** The state a group shows (requestState): its open plan or search, else its objective while that runs, else its newest item. */
function groupState(items: readonly WorkItem[], objective: RequestStateFacts["objective"]): { state: string; stateLabel: string; open: boolean } {
  return requestState({ items, objective });
}

/**
 * The organization's requests, open first then newest: the last 30 days and
 * anything still open, optionally on one channel or in one state. Campaigns
 * made by hand that no run owns are listed apart, so older work stays findable.
 * `timeZone` is the organization's, which the page writes its times in.
 */
export async function listRequests(input: { channel?: string | null; state?: "open" | "done" | null; days?: number; now?: Date } = {}): Promise<{ requests: RequestRow[]; manualCampaigns: RequestRow[]; timeZone: string }> {
  const now = input.now ?? new Date();
  const days = input.days ?? LIST_DAYS;
  const listed = (await listWork(now, { days })).filter(isOwnWork);
  // A driver job carries its objective's id, and the objective its request: the driver is filed under that request.
  const drivers = listed.filter(isDriver);
  const driverObjectiveIds = drivers.length
    ? new Map((await db.select({ id: assistantJobs.id, objectiveId: sql<string | null>`${assistantJobs.payload} ->> 'objectiveId'` }).from(assistantJobs)
      .where(and(inOrg(assistantJobs), inArray(assistantJobs.id, drivers.map((item) => item.id))))).map((row) => [row.id, row.objectiveId]))
    : new Map<string, string | null>();
  const work = listed.filter((item) => !isDriver(item));
  // An older search with no request id belongs with the older plan that used its lead list (runScope reads it so too).
  const planOfList = new Map(work.filter((item) => item.type === "plan" && !item.requestId && item.audienceId).map((item) => [item.audienceId!, keyOf(item)]));
  const groupOf = (item: WorkItem) => (item.type === "job" && !item.requestId && item.audienceId && planOfList.get(item.audienceId)) || keyOf(item);
  const groups = new Map<string, WorkItem[]>();
  for (const item of work) groups.set(groupOf(item), [...(groups.get(groupOf(item)) ?? []), item]);

  const requestIds = [...groups.keys()].flatMap((key) => {
    const parsed = parseRequestKey(key);
    return parsed?.kind === "request" ? [parsed.id] : [];
  });
  // The requests' objectives (open while active or paused), and the drivers' requests, which get a group of their own when nothing else of theirs is listed.
  const objectives = await objectiveStates({ requestIds, objectiveIds: [...driverObjectiveIds.values()].filter((id): id is string => Boolean(id)) });
  const objectiveOf = new Map(objectives.map((objective) => [objective.requestMessageId, objective]));
  for (const driver of drivers) {
    const objective = objectives.find((row) => row.id === driverObjectiveIds.get(driver.id));
    if (!objective) continue;
    const key = formatRequestKey({ kind: "request", id: objective.requestMessageId });
    if (!groups.has(key)) {
      groups.set(key, []);
      requestIds.push(objective.requestMessageId);
    }
  }
  const messages = requestIds.length
    ? await db.select({ id: assistantMessages.id, content: assistantMessages.content, threadId: assistantMessages.threadId, threadTitle: assistantThreads.title, createdAt: assistantMessages.createdAt })
      .from(assistantMessages)
      .leftJoin(assistantThreads, and(eq(assistantThreads.id, assistantMessages.threadId), eq(assistantThreads.organizationId, assistantMessages.organizationId)))
      .where(and(inOrg(assistantMessages), inArray(assistantMessages.id, requestIds)))
    : [];
  const messageOf = new Map(messages.map((message) => [message.id, message]));

  const requests: RequestRow[] = [];
  for (const [key, items] of groups) {
    const parsed = parseRequestKey(key)!;
    const message = parsed.kind === "request" ? messageOf.get(parsed.id) : undefined;
    const objective = parsed.kind === "request" ? objectiveOf.get(parsed.id) ?? null : null;
    if (!message && !items.length) continue;
    const plans = items.filter((item) => item.type === "plan");
    const searches = items.filter((item) => item.type === "job");
    const first = items[items.length - 1];
    requests.push({
      key,
      kind: parsed.kind,
      title: message ? firstLine(message.content) : plans[0] ? plans[0].title.replace(/^Outreach plan: /, "") : first?.title ?? "Request",
      channels: [...new Set(plans.flatMap((plan) => plan.channels ?? []))],
      ...groupState(items, objective),
      threadId: message?.threadId ?? first?.threadId ?? null,
      threadTitle: message ? (message.threadId ? displayThreadTitle(message.threadTitle) : null) : first?.threadTitle ?? null,
      startedAt: (message?.createdAt.toISOString() ?? items.map((item) => item.startedAt).sort()[0] ?? now.toISOString())!,
      counts: sumCounts(plans),
      plans: plans.length,
      searches: searches.length,
    });
  }
  const keep = (row: RequestRow) => (!input.channel || row.channels.includes(input.channel))
    && (!input.state || (input.state === "open" ? row.open : !row.open));
  const order = (a: RequestRow, b: RequestRow) => Number(b.open) - Number(a.open) || b.startedAt.localeCompare(a.startedAt);
  const [manual, timeZone] = await Promise.all([listManualCampaigns(now, days), organizationTimeZone()]);
  return { requests: requests.filter(keep).sort(order), manualCampaigns: manual.filter(keep).sort(order), timeZone };
}

/** Email, WhatsApp and LinkedIn campaigns no outreach run owns: active or paused, or touched in the window. */
async function listManualCampaigns(now: Date, days: number): Promise<RequestRow[]> {
  const org = currentOrganizationId();
  const since = new Date(now.getTime() - days * 86_400_000);
  // Every campaign a run launched, on any channel, whatever the run's state.
  const owned = sql`(SELECT r.campaigns ->> ch FROM outreach_runs r, unnest(ARRAY['email', 'whatsapp', 'linkedin']) ch WHERE r.organization_id = ${org} AND r.campaigns ->> ch IS NOT NULL)`;
  const [email, whatsapp, linkedin] = await Promise.all([
    db.select({ id: outreachCampaigns.id, name: outreachCampaigns.name, status: outreachCampaigns.status, createdAt: outreachCampaigns.createdAt }).from(outreachCampaigns)
      .where(and(inOrg(outreachCampaigns), sql`${outreachCampaigns.id}::text NOT IN ${owned}`, or(inArray(outreachCampaigns.status, ["active", "paused"]), gte(outreachCampaigns.updatedAt, since))))
      .orderBy(desc(outreachCampaigns.createdAt)).limit(50),
    db.select({ id: whatsappCampaigns.id, name: whatsappCampaigns.name, status: whatsappCampaigns.status, createdAt: whatsappCampaigns.createdAt }).from(whatsappCampaigns)
      .where(and(inOrg(whatsappCampaigns), isNull(whatsappCampaigns.archivedAt), sql`${whatsappCampaigns.id}::text NOT IN ${owned}`))
      .orderBy(desc(whatsappCampaigns.createdAt)).limit(50),
    db.select({ id: linkedinCampaigns.id, name: linkedinCampaigns.name, status: linkedinCampaigns.status, createdAt: linkedinCampaigns.createdAt }).from(linkedinCampaigns)
      .where(and(eq(linkedinCampaigns.organizationId, org), sql`${linkedinCampaigns.id} NOT IN ${owned}`))
      .orderBy(desc(linkedinCampaigns.createdAt)).limit(50),
  ]);
  const row = (channel: CampaignChannel, campaign: { id: string; name: string; status: string; createdAt: Date | null }): RequestRow => {
    const status = campaign.status.toLowerCase();
    return {
      key: formatRequestKey({ kind: "campaign", channel, id: campaign.id }),
      kind: "campaign",
      title: campaign.name,
      channels: [channel],
      state: status,
      stateLabel: status === "active" ? "Sending" : status.charAt(0).toUpperCase() + status.slice(1),
      open: status === "active" || status === "paused",
      threadId: null,
      threadTitle: null,
      startedAt: (campaign.createdAt ?? now).toISOString(),
      counts: null,
      plans: 0,
      searches: 0,
    };
  };
  return [...email.map((c) => row("email", c)), ...whatsapp.map((c) => row("whatsapp", c)), ...linkedin.map((c) => row("linkedin", c))];
}

type Resolved = {
  title: string;
  threadId: string | null;
  scope: ReportScope;
  objective: ObjectiveView | null;
  campaign: CampaignChild | null;
};

/** What a key covers, or null when it is not this organization's (a 404 for the caller). */
async function resolve(key: RequestKey): Promise<Resolved | null> {
  switch (key.kind) {
    case "request": {
      const [[message], scope, objective] = await Promise.all([
        db.select({ content: assistantMessages.content, threadId: assistantMessages.threadId }).from(assistantMessages)
          .where(and(inOrg(assistantMessages), eq(assistantMessages.id, key.id))).limit(1),
        requestScope(key.id),
        objectiveView(key.id),
      ]);
      if (!message && !scope.runIds.length && !scope.jobIds.length && !objective) return null;
      return { title: message ? firstLine(message.content) : "Request", threadId: message?.threadId ?? objective?.threadId ?? null, scope, objective, campaign: null };
    }
    case "run": {
      const scope = await runScope(key.id);
      if (!scope) return null;
      const [run] = await db.select({ threadId: outreachRuns.threadId }).from(outreachRuns).where(and(inOrg(outreachRuns), eq(outreachRuns.id, key.id))).limit(1);
      return { title: scope.name ?? "Outreach plan", threadId: run?.threadId ?? null, scope, objective: null, campaign: null };
    }
    case "job": {
      const [job] = await db.select({ id: assistantJobs.id, audienceId: assistantJobs.audienceId, threadId: assistantJobs.threadId, kind: assistantJobs.kind, payload: assistantJobs.payload })
        .from(assistantJobs).where(and(inOrg(assistantJobs), eq(assistantJobs.id, key.id))).limit(1);
      if (!job) return null;
      const phrase = (job.payload as { phrase?: unknown } | null)?.phrase;
      return { title: typeof phrase === "string" ? phrase : "Lead search", threadId: job.threadId, scope: { kind: "request", runIds: [], audienceIds: job.audienceId ? [job.audienceId] : [], jobIds: [job.id] }, objective: null, campaign: null };
    }
    case "campaign": {
      const campaign = await campaignOf(key.channel, key.id);
      if (!campaign) return null;
      return { title: campaign.name, threadId: null, scope: { kind: "campaign", runIds: [], audienceIds: [], jobIds: [], campaigns: { [key.channel]: [key.id] } }, objective: null, campaign };
    }
  }
}

async function campaignOf(channel: CampaignChannel, id: string): Promise<CampaignChild | null> {
  const found = channel === "email"
    ? (await db.select({ name: outreachCampaigns.name, status: outreachCampaigns.status }).from(outreachCampaigns).where(and(inOrg(outreachCampaigns), eq(outreachCampaigns.id, id))).limit(1))[0]
    : channel === "whatsapp"
    ? (await db.select({ name: whatsappCampaigns.name, status: whatsappCampaigns.status }).from(whatsappCampaigns).where(and(inOrg(whatsappCampaigns), eq(whatsappCampaigns.id, id))).limit(1))[0]
    : (await db.select({ name: linkedinCampaigns.name, status: linkedinCampaigns.status }).from(linkedinCampaigns).where(and(eq(linkedinCampaigns.organizationId, currentOrganizationId()), eq(linkedinCampaigns.id, id))).limit(1))[0];
  return found ? { channel, id, name: found.name, status: String(found.status).toLowerCase(), href: CAMPAIGN_HREF[channel](id) } : null;
}

/** Leads of a campaign counted directly that its engine marked failed. */
async function campaignFailures(campaign: CampaignChild): Promise<{ leads: number; failed: number }> {
  const org = currentOrganizationId();
  const [row] = campaign.channel === "email"
    ? await db.execute<{ leads: number; failed: number }>(sql`SELECT count(*)::int AS leads, count(*) FILTER (WHERE l.sequence_status = 'bounced')::int AS failed
        FROM outreach_leads l JOIN outreach_campaigns c ON c.id = l.campaign_id WHERE c.organization_id = ${org} AND c.id = ${campaign.id}`)
    : campaign.channel === "whatsapp"
    ? await db.execute<{ leads: number; failed: number }>(sql`SELECT count(*)::int AS leads, count(*) FILTER (WHERE l.status = 'failed')::int AS failed
        FROM whatsapp_campaign_leads l JOIN whatsapp_campaigns c ON c.id = l.campaign_id WHERE c.organization_id = ${org} AND c.id = ${campaign.id}`)
    : await db.execute<{ leads: number; failed: number }>(sql`SELECT count(*)::int AS leads, count(*) FILTER (WHERE l.status = 'FAILED')::int AS failed
        FROM "Lead" l WHERE l."organizationId" = ${org} AND l."campaignId" = ${campaign.id}`);
  return { leads: Number(row?.leads ?? 0), failed: Number(row?.failed ?? 0) };
}

/** One request's summary, or null when the key is not this organization's. */
export async function requestSummary(keyText: string, now = new Date()): Promise<RequestSummary | null> {
  const key = parseRequestKey(keyText);
  if (!key) return null;
  const resolved = await resolve(key);
  if (!resolved) return null;
  const { scope, objective, campaign } = resolved;
  const org = currentOrganizationId();

  const [work, filter, timeZone] = await Promise.all([
    scope.runIds.length || scope.jobIds.length ? listWork(now, { runIds: scope.runIds, jobIds: scope.jobIds }) : Promise.resolve([] as WorkItem[]),
    reportFilter(scope),
    organizationTimeZone(),
  ]);
  const children = work.filter(isOwnWork);
  const plans = children.filter((item) => item.type === "plan");
  const searches = children.filter((item) => item.type === "job");

  const [metrics, waiting, [interested], [attention], runReports, campaignCounts, runCampaigns] = await Promise.all([
    periodMetrics({ from: null, to: now }, filter),
    currentCounts(filter),
    db.execute<{ n: number }>(sql`SELECT count(DISTINCT cl.crm_record_id)::int AS n FROM crm_classifications cl JOIN crm_records r ON r.id = cl.crm_record_id
      WHERE r.organization_id = ${org} AND cl.applied_category_key = 'interested' AND cl.status IN ('auto_applied', 'accepted') AND r.person_id IN ${filter.runPeople}`),
    db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM crm_records r WHERE r.organization_id = ${org} AND ${crmAttentionSql(RAW_RECORD_COLUMNS)} AND r.person_id IN ${filter.runPeople}`),
    Promise.all(plans.filter((plan) => plan.runStatus && !["proposed", "cancelled"].includes(plan.runStatus)).map((plan) => reportRun(plan.runId!))),
    campaign ? campaignFailures(campaign) : Promise.resolve(null),
    scope.runIds.length
      ? db.select({ campaigns: outreachRuns.campaigns }).from(outreachRuns).where(and(inOrg(outreachRuns), inArray(outreachRuns.id, [...scope.runIds])))
      : Promise.resolve([]),
  ]);

  const failed = campaignCounts ? campaignCounts.failed : runReports.reduce((sum, report) => sum + (report?.channels.reduce((n, channel) => n + channel.failed, 0) ?? 0), 0);
  const searched = searches.filter((item) => item.kind !== "objective");
  const total = (pick: (item: WorkItem) => number | null) => {
    const values = searched.map(pick).filter((value): value is number => value !== null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  };
  // A request with an objective counts each person once across its lists (its funnel); older searches add up their own results.
  const numbers: RequestNumbers = {
    found: objective ? objective.found : total((item) => item.found),
    contactable: objective ? objective.contactable : total((item) => item.eligible),
    matching: objective ? objective.leads : total((item) => item.matching),
    contacted: metrics.peopleContacted.total,
    replied: metrics.contactedWhoReplied.total,
    interested: Number(interested?.n ?? 0),
    failed,
  };

  const openPlans = plans.filter((plan) => plan.open);
  const held = openPlans.find((plan) => (plan.state === "waiting_send" || plan.state === "daily_lead_limit") && plan.nextAt);
  // A due message not prepared yet is prepared again on its own: not something for the owner to fix.
  const senderProblem = openPlans.find((plan) => plan.state === "waiting_send" && !plan.nextAt && !(plan.reason ?? "").includes(NOT_PREPARED))?.reason ?? null;
  const waitingUntil = held?.nextAt ? { at: held.nextAt, label: displayTime(new Date(held.nextAt), now, timeZone), reason: held.reason } : null;
  // Every open plan waiting on a follow-up: the earliest, unless another plan is still sending.
  const scheduled = openPlans.filter((plan) => plan.state === "scheduled" && plan.nextAt).sort((a, b) => Date.parse(a.nextAt!) - Date.parse(b.nextAt!))[0];
  const followUpAt = scheduled?.nextAt && !openPlans.some((plan) => plan.state === "executing")
    ? { at: scheduled.nextAt, label: displayTime(new Date(scheduled.nextAt), now, timeZone) }
    : null;
  const paused = openPlans.find((plan) => plan.runStatus === "paused");
  const researching = searches.some((item) => item.open) || objective?.status === "active";
  const lastPlan = plans[0];
  const outcome = objective?.stopDetail ?? (objective?.stopReason ? objective.stopReason.replace(/_/g, " ") : null)
    ?? (lastPlan && !lastPlan.open ? lastPlan.reason ?? lastPlan.stateLabel : null)
    ?? (campaign && !["active", "paused"].includes(campaign.status) ? `Campaign ${campaign.status}` : null)
    ?? (searches.length && !searches.some((item) => item.open) ? searches[0]!.reason ?? searches[0]!.stateLabel : null);
  // Its own work and its objective decide its state; a campaign key reads its campaign's.
  const state = requestState({ items: children, objective: objective ? { status: objective.status, waiting: objective.waiting } : null });
  const campaignOpen = Boolean(campaign && ["active", "paused"].includes(campaign.status));
  const nextAction = nextActionFor({
    waitingInInbox: Number(attention?.n ?? 0) + waiting.needsYou,
    awaitingStart: plans.filter((plan) => plan.runStatus === "proposed").map((plan) => ({ name: plan.title.replace(/^Outreach plan: /, ""), threadId: plan.threadId })),
    senderProblem,
    waitingUntil,
    followUpAt,
    paused: paused ? { name: paused.title.replace(/^Outreach plan: /, "") } : null,
    // Paused research is open while nothing else of it is, so its next step is to resume it, never "Done".
    researchPaused: objective?.status === "paused" ? { threadId: objective.threadId } : null,
    researching,
    open: state.open || campaignOpen,
    outcome,
  });
  // Only what keeps it from going on is a blocker: the objective's waiting reason ("searches still running") is
  // its ordinary progress, and is in its state label instead.
  const blocker = openPlans.find((plan) => ["waiting_send", "partial", "failed"].includes(plan.state))?.reason
    ?? searches.find((item) => item.state === "failed")?.reason
    ?? null;

  const campaigns: CampaignChild[] = campaign ? [campaign] : [];
  for (const run of runCampaigns) {
    for (const [channel, id] of Object.entries(run.campaigns ?? {}) as [string, string][]) {
      if ((channel === "email" || channel === "whatsapp" || channel === "linkedin") && id && !campaigns.some((c) => c.id === id)) {
        const child = await campaignOf(channel, id);
        if (child) campaigns.push(child);
      }
    }
  }
  return {
    key: formatRequestKey(key),
    kind: key.kind,
    title: resolved.title,
    threadId: resolved.threadId,
    open: state.open || campaignOpen,
    stateLabel: campaign && !state.open ? (campaign.status === "active" ? "Sending" : campaign.status) : state.stateLabel,
    numbers,
    // Only a number the owner named is a target; the organization's default is not something they asked for.
    target: objective?.targetNamed ? objective.leadTarget : null,
    blocker,
    nextAction,
    children: { searches, plans, campaigns },
    objective,
    timeZone,
  };
}

/**
 * The requests a chat started, newest first: its objectives (open while
 * active or paused) and plans carrying a request id, then its older plans
 * and searches. The objective's driver job is never listed as a search of
 * its own: the objective row stands for it.
 */
export async function threadRequests(threadId: string, limit = 10): Promise<{ key: string; title: string; open: boolean; startedAt: string }[]> {
  const [thread] = await db.select({ id: assistantThreads.id }).from(assistantThreads).where(and(inOrg(assistantThreads), eq(assistantThreads.id, threadId))).limit(1);
  if (!thread) return [];
  const [jobs, runs, objectives] = await Promise.all([
    db.select({ id: assistantJobs.id, kind: assistantJobs.kind, payload: assistantJobs.payload, status: assistantJobs.status, createdAt: assistantJobs.createdAt }).from(assistantJobs)
      .where(and(inOrg(assistantJobs), eq(assistantJobs.threadId, threadId))).orderBy(desc(assistantJobs.createdAt)).limit(100),
    db.select({ id: outreachRuns.id, name: outreachRuns.name, plan: outreachRuns.plan, status: outreachRuns.status, createdAt: outreachRuns.createdAt }).from(outreachRuns)
      .where(and(inOrg(outreachRuns), eq(outreachRuns.threadId, threadId))).orderBy(desc(outreachRuns.createdAt)).limit(50),
    threadObjectives(threadId, 100),
  ]);
  const found = new Map<string, { key: string; title: string; open: boolean; startedAt: string }>();
  const add = (key: string, title: string, open: boolean, at: Date) => {
    const current = found.get(key);
    if (!current) found.set(key, { key, title, open, startedAt: at.toISOString() });
    else found.set(key, { ...current, open: current.open || open, startedAt: current.startedAt < at.toISOString() ? current.startedAt : at.toISOString() });
  };
  for (const objective of objectives) add(`r:${objective.requestMessageId}`, "", objective.status !== "stopped", objective.createdAt);
  for (const job of jobs) {
    if (job.kind === "outreach_start" || job.kind === "objective") continue;
    const value = (job.payload ?? {}) as { requestMessageId?: unknown; contactAfter?: { requestId?: unknown } | null; phrase?: unknown };
    const requestId = typeof value.requestMessageId === "string" ? value.requestMessageId : typeof value.contactAfter?.requestId === "string" ? value.contactAfter.requestId : null;
    const open = job.status === "queued" || job.status === "running";
    if (requestId) add(`r:${requestId}`, "", open, job.createdAt);
    else add(`job:${job.id}`, typeof value.phrase === "string" ? value.phrase : "Lead search", open, job.createdAt);
  }
  for (const run of runs) {
    if (run.status === "cancelled") continue;
    const open = ["proposed", "starting", "running", "paused"].includes(run.status);
    if (typeof run.plan?.requestId === "string") add(`r:${run.plan.requestId}`, "", open, run.createdAt);
    else add(`run:${run.id}`, run.name, open, run.createdAt);
  }
  const requestIds = [...found.keys()].flatMap((key) => (key.startsWith("r:") ? [key.slice(2)] : []));
  const messages = requestIds.length
    ? await db.select({ id: assistantMessages.id, content: assistantMessages.content, createdAt: assistantMessages.createdAt }).from(assistantMessages)
      .where(and(inOrg(assistantMessages), inArray(assistantMessages.id, requestIds)))
    : [];
  for (const message of messages) {
    const current = found.get(`r:${message.id}`);
    if (current) found.set(current.key, { ...current, title: firstLine(message.content, 80), startedAt: message.createdAt.toISOString() });
  }
  return [...found.values()].map((row) => ({ ...row, title: row.title || "Request" }))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
}

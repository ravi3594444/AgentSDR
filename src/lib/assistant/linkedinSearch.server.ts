import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { importPeopleRows } from "@/lib/leads/peopleImport.server";
import type { ImportRow } from "@/lib/leads/importRows";
import { linkedInAccounts, searchQueries } from "@/lib/linkedin/schema";
import { createSearchBatch, getSearchBatchDetail, startSearchBatchRun } from "@/lib/linkedin/searchBatches";
import { isMigrationControlPaused } from "@/lib/migration/controls";
import { isPlatformConnected } from "@/lib/platform/credentials";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { addAudienceMembers, createAudience } from "./audiences.server";
import { assistantJobs, type AudienceChannel } from "./schema";
import type { AssistantJob, StepOutcome } from "./worker";

/**
 * Lead search on LinkedIn through the existing Unipile search (SearchBatch
 * and runSearchQueue, src/lib/linkedin/searchBatches.ts): a people search
 * by keywords with the organization's own connected LinkedIn account and
 * its daily search allowance. The profiles found become People (by their
 * LinkedIn URL, through the People import) in an audience reachable on
 * LinkedIn. No email or phone is invented; LinkedIn gives only the profile.
 */

const POLL_MS = 20_000;
const MAX_WAIT_MS = 45 * 60_000;

type Payload = {
  keywords: string;
  maxResults: number;
  url: string;
  accountId: string;
  batchId?: string;
  startedAt?: string;
  contactAfter?: { channels: AudienceChannel[] | null; ownerRequest?: string; requestId?: string } | null;
  /** The owner's message this search serves: its coverage and its objective are told from it. */
  requestMessageId?: string | null;
};

export async function linkedinSearchAvailability(): Promise<{ available: boolean; reason: string | null; accountId: string | null }> {
  if (!(await isPlatformConnected("unipile"))) return { available: false, reason: "Unipile is not connected (Settings → LinkedIn → Connection).", accountId: null };
  const [account] = await db.select({ id: linkedInAccounts.id }).from(linkedInAccounts)
    .where(and(inOrg(linkedInAccounts), eq(linkedInAccounts.status, "CONNECTED"))).limit(1);
  if (!account) return { available: false, reason: "No LinkedIn account is connected (Settings → LinkedIn → Accounts).", accountId: null };
  if (isMigrationControlPaused("linkedinSearch")) return { available: false, reason: "LinkedIn search is paused on this server (PAUSE_LINKEDIN_SEARCH).", accountId: null };
  return { available: true, reason: null, accountId: account.id };
}

export function linkedinPeopleSearchUrl(keywords: string): string {
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords.trim())}`;
}

export async function startLinkedinSearch(
  input: { keywords: string; maxResults: number },
  context: { threadId: string | null; userId: string | null },
  options: { contactAfter?: Payload["contactAfter"]; requestMessageId?: string | null } = {},
): Promise<{ jobId: string; audienceId: string; url: string }> {
  const availability = await linkedinSearchAvailability();
  if (!availability.available) throw new Error(availability.reason ?? "LinkedIn search is not available.");
  const url = linkedinPeopleSearchUrl(input.keywords);
  const audienceId = await createAudience({
    name: `LinkedIn: ${input.keywords}`.slice(0, 200),
    source: "discovery",
    criteria: { source: "linkedin", keywords: input.keywords, url },
    threadId: context.threadId,
    userId: context.userId,
  });
  const payload: Payload = { keywords: input.keywords, maxResults: input.maxResults, url, accountId: availability.accountId!, contactAfter: options.contactAfter ?? null, requestMessageId: options.requestMessageId ?? null };
  const [job] = await db.insert(assistantJobs).values({
    organizationId: currentOrganizationId(),
    kind: "linkedin_search",
    threadId: context.threadId,
    audienceId,
    payload: payload as unknown as Record<string, unknown>,
    progress: { stage: "queued", found: 0 },
    createdBy: context.userId,
  }).returning({ id: assistantJobs.id });
  return { jobId: job!.id, audienceId, url };
}

async function cancelQueries(batchId: string): Promise<void> {
  await db.update(searchQueries).set({ status: "CANCELLED" })
    .where(and(eq(searchQueries.batchId, batchId), inArray(searchQueries.status, ["QUEUED", "RUNNING", "PAUSED_LIMIT"])));
}

export async function runLinkedinSearchStep(job: AssistantJob): Promise<StepOutcome> {
  const payload = job.payload as unknown as Payload;
  if (job.stage === "queued") {
    let batchId = payload.batchId;
    if (!batchId) {
      batchId = (await createSearchBatch({ name: `Assistant: ${payload.keywords}`.slice(0, 120), kind: "SINGLE", accountIds: [payload.accountId], rows: [{ url: payload.url, companyName: null }] })).id;
      // Saved on the job at once, not only with the step's result: a step that runs again reuses this search, never makes a second.
      await db.update(assistantJobs).set({ payload: sql`${assistantJobs.payload} || jsonb_build_object('batchId', ${batchId}::text)` })
        .where(and(inOrg(assistantJobs), eq(assistantJobs.id, job.id)));
    }
    const started = await startSearchBatchRun(batchId, [payload.accountId]);
    if (!started.started) {
      // One LinkedIn search runs at a time on this server: wait for the other.
      return { next: "wait", delayMs: 60_000, payload: { batchId }, progress: { stage: "queued", note: "waiting for another LinkedIn search to finish" } };
    }
    return { next: "stage", stage: "searching", payload: { batchId, startedAt: new Date().toISOString() }, progress: { stage: "searching", found: 0 } };
  }

  if (job.stage === "searching") {
    const detail = await getSearchBatchDetail(payload.batchId!);
    if (!detail) return { next: "failed", error: "The LinkedIn search disappeared." };
    const query = detail.queries[0];
    const found = detail.leads.length;
    const finished = !query || ["COMPLETED", "FAILED", "CANCELLED", "PAUSED_LIMIT"].includes(query.status);
    const enough = found >= payload.maxResults;
    const tooLong = payload.startedAt ? Date.now() - new Date(payload.startedAt).getTime() > MAX_WAIT_MS : false;
    if (!finished && !enough && !tooLong) return { next: "wait", delayMs: POLL_MS, progress: { stage: "searching", found, total: query?.totalCount ?? null } };
    if (!finished) await cancelQueries(payload.batchId!);
    if (!found) {
      const reason = query?.status === "PAUSED_LIMIT" ? "the LinkedIn account's daily search allowance is used up" : query?.lastError ?? "LinkedIn returned no profiles for these words";
      return { next: "done", result: { audienceId: job.audienceId, phrase: payload.keywords, found: 0, eligible: 0, excluded: 0, duplicates: 0, withEmail: 0, withPhoneOnly: 0, note: `The LinkedIn search for “${payload.keywords}” found nobody: ${reason}.` }, progress: { stage: "done" } };
    }
    const leads = detail.leads.slice(0, payload.maxResults);
    const rows: ImportRow[] = leads.flatMap((lead, index) => lead.profileUrl
      ? [{ rowNumber: index + 2, linkedinUrl: lead.profileUrl, fullName: lead.name, title: lead.headline, companyName: lead.companyName, customFields: { ...(lead.location ? { location: lead.location } : {}), discoveredVia: "LinkedIn search" } }]
      : []);
    const imported = await importPeopleRows(rows);
    const added = job.audienceId && imported.personIds.length
      ? await addAudienceMembers(job.audienceId, imported.personIds.map((personId) => ({ personId, source: "linkedin_search" })))
      : { eligible: 0, excluded: 0, added: 0 };
    return {
      next: "done",
      progress: { stage: "done", found: leads.length, saved: imported.personIds.length },
      result: {
        audienceId: job.audienceId,
        phrase: payload.keywords,
        found: leads.length,
        eligible: added.eligible,
        excluded: added.excluded + (leads.length - rows.length),
        duplicates: imported.updated,
        withEmail: 0,
        withPhoneOnly: 0,
        note: rows.length < leads.length ? `${leads.length - rows.length} profiles had no usable link and were left out.` : null,
      },
    };
  }
  return { next: "failed", error: `Unknown LinkedIn search stage ${job.stage}` };
}

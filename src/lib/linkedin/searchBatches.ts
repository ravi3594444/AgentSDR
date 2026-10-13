/**
 * Server-side queries for search batches — the "one search = one named group of
 * LinkedIn search URLs" model. Both the /linkedin/search pages (initial render)
 * and the /api/linkedin/search/batches routes (polling, mutations) go through
 * here so they agree on shape.
 *
 * Imports `db`, so client components may only `import type` from this file.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import * as XLSX from "xlsx";
import { readSpreadsheet } from "@/lib/spreadsheet/read";
import { db } from "@/lib/db";
import { runSearchQueue } from "@/jobs/runSearchQueue";
import { withJobTracking } from "@/lib/linkedin/jobTracker";
import { normalizeSpreadsheetHeader } from "@/lib/linkedin/importLeads";
import {
  jobRuns,
  linkedInAccounts,
  searchBatches,
  searchQueries,
  searchResults,
  type SearchBatchKind,
  type SearchQueryStatus,
} from "@/lib/linkedin/schema";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";

/* -------------------------------------------------------------------------
 * Shapes shared with the UI
 * ---------------------------------------------------------------------- */

export type SearchBatchSummary = {
  id: string;
  name: string;
  kind: SearchBatchKind;
  accountIds: string[];
  createdAt: string;
  queryCount: number;
  /** Distinct leads across the batch's URLs. */
  leadCount: number;
  statusCounts: Partial<Record<SearchQueryStatus, number>>;
};

export type SearchBatchQueryRow = {
  id: string;
  url: string;
  companyName: string | null;
  status: SearchQueryStatus;
  totalCount: number | null;
  leadsFetched: number;
  lastError: string | null;
  currentAccount: { id: string; username: string; name: string | null } | null;
  createdAt: string;
};

export type SearchBatchLeadRow = {
  id: string;
  /** Unipile's member id — what the rest of the app keys a lead on, not a link. */
  linkedinUrl: string;
  /** Browsable profile link, dug out of `raw`. Null when the payload had none. */
  profileUrl: string | null;
  sourceLinkedinApi: string | null;
  companyName: string | null;
  name: string | null;
  headline: string | null;
  location: string | null;
  profilePictureUrl: string | null;
  networkDistance: string | null;
  followersCount: number | null;
  sharedConnectionsCount: number | null;
  /** The search URL this lead came from (first one, when several surfaced it). */
  searchQueryId: string;
};

export type SearchBatchDetail = {
  batch: {
    id: string;
    name: string;
    kind: SearchBatchKind;
    accountIds: string[];
    createdAt: string;
  };
  queries: SearchBatchQueryRow[];
  leads: SearchBatchLeadRow[];
};

/**
 * `SearchResult.linkedinUrl` holds whatever identifier the search returned, and in
 * practice that is Unipile's member id ("ACoAA...") rather than a URL — putting it in
 * an href makes a relative link to the current page. The browsable URL is in `raw`.
 */
function profileUrlFromRaw(raw: unknown, fallbackIdentifier: string): string | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const direct = [r.public_profile_url, r.profile_url].find((v): v is string => typeof v === "string" && v.startsWith("http"));
  if (direct) return direct;
  const slug = typeof r.public_identifier === "string" && r.public_identifier ? r.public_identifier : null;
  if (slug) return `https://www.linkedin.com/in/${slug}`;
  // LinkedIn resolves a member id under /in/ too, so this still lands on the profile.
  return fallbackIdentifier.startsWith("http") ? fallbackIdentifier : `https://www.linkedin.com/in/${fallbackIdentifier}`;
}

/* -------------------------------------------------------------------------
 * Ownership
 *
 * SearchQuery and SearchResult have no organization of their own; they belong
 * to the organization of their SearchBatch, so every query below starts from
 * a batch that has been matched with inOrg(searchBatches).
 * ---------------------------------------------------------------------- */

/** Whether the batch exists in the current organization. */
export async function searchBatchExists(batchId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: searchBatches.id })
    .from(searchBatches)
    .where(and(inOrg(searchBatches), eq(searchBatches.id, batchId)))
    .limit(1);
  return Boolean(row);
}

/** The ids, out of `ids`, that are not LinkedIn accounts of the current organization. */
export async function unknownAccountIds(ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const rows = await db
    .select({ id: linkedInAccounts.id })
    .from(linkedInAccounts)
    .where(and(inOrg(linkedInAccounts), inArray(linkedInAccounts.id, unique)));
  const known = new Set(rows.map((row) => row.id));
  return unique.filter((id) => !known.has(id));
}

/* -------------------------------------------------------------------------
 * Reads
 * ---------------------------------------------------------------------- */

export async function listSearchBatches(): Promise<SearchBatchSummary[]> {
  const batches = await db.select().from(searchBatches).where(inOrg(searchBatches)).orderBy(desc(searchBatches.createdAt));
  if (batches.length === 0) return [];
  const ids = batches.map((b) => b.id);

  const [statusRows, leadRows] = await Promise.all([
    db
      .select({ batchId: searchQueries.batchId, status: searchQueries.status, n: sql<number>`count(*)::int` })
      .from(searchQueries)
      .where(inArray(searchQueries.batchId, ids))
      .groupBy(searchQueries.batchId, searchQueries.status),
    db
      .select({
        batchId: searchQueries.batchId,
        n: sql<number>`count(distinct ${searchResults.linkedinUrl})::int`,
      })
      .from(searchResults)
      .innerJoin(searchQueries, eq(searchResults.searchQueryId, searchQueries.id))
      .where(inArray(searchQueries.batchId, ids))
      .groupBy(searchQueries.batchId),
  ]);

  const statusByBatch: Record<string, Partial<Record<SearchQueryStatus, number>>> = {};
  const queryCountByBatch: Record<string, number> = {};
  for (const r of statusRows) {
    (statusByBatch[r.batchId] ??= {})[r.status] = r.n;
    queryCountByBatch[r.batchId] = (queryCountByBatch[r.batchId] ?? 0) + r.n;
  }
  const leadCountByBatch: Record<string, number> = {};
  for (const r of leadRows) leadCountByBatch[r.batchId] = r.n;

  return batches.map((b) => ({
    id: b.id,
    name: b.name,
    kind: b.kind,
    accountIds: b.accountIds,
    createdAt: b.createdAt.toISOString(),
    queryCount: queryCountByBatch[b.id] ?? 0,
    leadCount: leadCountByBatch[b.id] ?? 0,
    statusCounts: statusByBatch[b.id] ?? {},
  }));
}

export async function getSearchBatchDetail(id: string): Promise<SearchBatchDetail | null> {
  const [batch] = await db.select().from(searchBatches).where(and(inOrg(searchBatches), eq(searchBatches.id, id))).limit(1);
  if (!batch) return null;

  const [queryRows, resultRows] = await Promise.all([
    db
      .select({
        query: searchQueries,
        account: { id: linkedInAccounts.id, username: linkedInAccounts.username, name: linkedInAccounts.name },
      })
      .from(searchQueries)
      .leftJoin(linkedInAccounts, eq(searchQueries.currentAccountId, linkedInAccounts.id))
      .where(eq(searchQueries.batchId, id))
      .orderBy(asc(searchQueries.createdAt)),
    db
      .select({ result: searchResults, companyName: searchQueries.companyName })
      .from(searchResults)
      .innerJoin(searchQueries, eq(searchResults.searchQueryId, searchQueries.id))
      .where(eq(searchQueries.batchId, id))
      .orderBy(asc(searchResults.createdAt)),
  ]);

  // The same person can surface from more than one URL in a batch — keep the first.
  const leadsByUrl = new Map<string, SearchBatchLeadRow>();
  for (const { result: r, companyName } of resultRows) {
    if (leadsByUrl.has(r.linkedinUrl)) continue;
    leadsByUrl.set(r.linkedinUrl, {
      id: r.id,
      linkedinUrl: r.linkedinUrl,
      profileUrl: profileUrlFromRaw(r.raw, r.linkedinUrl),
      sourceLinkedinApi: r.sourceLinkedinApi,
      companyName,
      name: r.name,
      headline: r.headline,
      location: r.location,
      profilePictureUrl: r.profilePictureUrl,
      networkDistance: r.networkDistance,
      followersCount: r.followersCount,
      sharedConnectionsCount: r.sharedConnectionsCount,
      searchQueryId: r.searchQueryId,
    });
  }

  return {
    batch: {
      id: batch.id,
      name: batch.name,
      kind: batch.kind,
      accountIds: batch.accountIds,
      createdAt: batch.createdAt.toISOString(),
    },
    queries: queryRows.map(({ query: q, account }) => ({
      id: q.id,
      url: q.url,
      companyName: q.companyName,
      status: q.status,
      totalCount: q.totalCount,
      leadsFetched: q.leadsFetched,
      lastError: q.lastError,
      currentAccount: account?.id ? account : null,
      createdAt: q.createdAt.toISOString(),
    })),
    leads: [...leadsByUrl.values()],
  };
}

/* -------------------------------------------------------------------------
 * Writes
 * ---------------------------------------------------------------------- */

export type SearchUrlInput = { url: string; companyName: string | null };

/** Trim, drop blanks, and dedupe by URL (first company name wins). */
export function cleanSearchUrls(rows: SearchUrlInput[]): SearchUrlInput[] {
  const seen = new Map<string, SearchUrlInput>();
  for (const r of rows) {
    const url = r.url.trim();
    if (!url || seen.has(url)) continue;
    const companyName = r.companyName?.trim() || null;
    seen.set(url, { url, companyName });
  }
  return [...seen.values()];
}

const SHEET_HEADER_MAP: Record<string, "url" | "companyName"> = {
  companyname: "companyName",
  company: "companyName",
  searchurl: "url",
  url: "url",
  linkedinsearchurl: "url",
  linkedinurl: "url",
};

/**
 * Parses the "Company Name + Search URL" sheet (xlsx/xls/csv). Rows without a URL
 * are counted in `skipped` rather than failing the upload. Throws SpreadsheetReadError
 * for an unreadable file.
 */
export function parseSearchSheet(buffer: ArrayBuffer | Uint8Array): { rows: SearchUrlInput[]; skipped: number } {
  const workbook = readSpreadsheet(buffer);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const raw: Record<string, string>[] = sheet ? XLSX.utils.sheet_to_json(sheet, { defval: "" }) : [];

  const rows: SearchUrlInput[] = [];
  let skipped = 0;
  for (const row of raw) {
    const mapped: Partial<Record<"url" | "companyName", string>> = {};
    for (const [key, val] of Object.entries(row)) {
      const field = SHEET_HEADER_MAP[normalizeSpreadsheetHeader(key)];
      if (field) mapped[field] = String(val).trim();
    }
    if (!mapped.url) {
      skipped++;
      continue;
    }
    rows.push({ url: mapped.url, companyName: mapped.companyName || null });
  }
  return { rows: cleanSearchUrls(rows), skipped };
}

export async function createSearchBatch(input: {
  name: string;
  kind: SearchBatchKind;
  accountIds: string[];
  rows: SearchUrlInput[];
}): Promise<{ id: string; queryCount: number }> {
  const rows = cleanSearchUrls(input.rows);
  if (rows.length === 0) throw new Error("No valid search URLs");
  if ((await unknownAccountIds(input.accountIds)).length > 0) throw new Error("Unknown account");

  return db.transaction(async (tx) => {
    const [batch] = await tx
      .insert(searchBatches)
      .values({ organizationId: currentOrganizationId(), name: input.name.trim(), kind: input.kind, accountIds: input.accountIds, updatedAt: new Date() })
      .returning({ id: searchBatches.id });
    await tx.insert(searchQueries).values(rows.map((r) => ({ ...r, batchId: batch.id, updatedAt: new Date() })));
    return { id: batch.id, queryCount: rows.length };
  });
}

/** Append URLs to an existing batch. Returns how many were new (dupes of existing URLs are skipped). */
export async function addSearchUrls(batchId: string, rows: SearchUrlInput[]): Promise<number> {
  const cleaned = cleanSearchUrls(rows);
  if (cleaned.length === 0) return 0;
  if (!(await searchBatchExists(batchId))) throw new Error("Search not found");
  const existing = await db
    .select({ url: searchQueries.url })
    .from(searchQueries)
    .where(eq(searchQueries.batchId, batchId));
  const have = new Set(existing.map((e) => e.url));
  const fresh = cleaned.filter((r) => !have.has(r.url));
  if (fresh.length === 0) return 0;
  await db.insert(searchQueries).values(fresh.map((r) => ({ ...r, batchId, updatedAt: new Date() })));
  return fresh.length;
}

/**
 * Deletes a batch with its queries and their results. Refuses while any of its
 * URLs is RUNNING — cancel first so the job loop can stop cleanly.
 */
export async function deleteSearchBatch(id: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!(await searchBatchExists(id))) return { ok: false, reason: "Search not found" };
  const [running] = await db
    .select({ id: searchQueries.id })
    .from(searchQueries)
    .where(and(eq(searchQueries.batchId, id), eq(searchQueries.status, "RUNNING")))
    .limit(1);
  if (running) return { ok: false, reason: "This search is still running — cancel its URLs first" };

  await db.transaction(async (tx) => {
    const queryIds = (
      await tx.select({ id: searchQueries.id }).from(searchQueries).where(eq(searchQueries.batchId, id))
    ).map((q) => q.id);
    if (queryIds.length > 0) {
      await tx.delete(searchResults).where(inArray(searchResults.searchQueryId, queryIds));
    }
    // Queries go with the batch via ON DELETE CASCADE.
    await tx.delete(searchBatches).where(and(inOrg(searchBatches), eq(searchBatches.id, id)));
  });
  return { ok: true };
}

/**
 * Removes search URLs from a batch, with the leads they found.
 *
 * `SearchResult` has no foreign key to `SearchQuery` (Prisma never made one), so the
 * results have to be deleted explicitly or they linger as rows nothing can reach.
 * A RUNNING URL is marked CANCELLED instead of deleted — the job loop checks the
 * status between pages and stops on its own; deleting the row mid-page would make
 * its next write fail.
 */
export async function deleteSearchQueries(
  batchId: string,
  ids: string[]
): Promise<{ deleted: number; cancelled: number; leadsDeleted: number }> {
  if (ids.length === 0 || !(await searchBatchExists(batchId))) return { deleted: 0, cancelled: 0, leadsDeleted: 0 };

  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: searchQueries.id, status: searchQueries.status })
      .from(searchQueries)
      .where(and(eq(searchQueries.batchId, batchId), inArray(searchQueries.id, ids)));
    if (rows.length === 0) return { deleted: 0, cancelled: 0, leadsDeleted: 0 };

    const running = rows.filter((r) => r.status === "RUNNING").map((r) => r.id);
    const removable = rows.filter((r) => r.status !== "RUNNING").map((r) => r.id);

    if (running.length > 0) {
      await tx.update(searchQueries).set({ status: "CANCELLED" }).where(inArray(searchQueries.id, running));
    }

    let leadsDeleted = 0;
    if (removable.length > 0) {
      const gone = await tx
        .delete(searchResults)
        .where(inArray(searchResults.searchQueryId, removable))
        .returning({ id: searchResults.id });
      leadsDeleted = gone.length;
      await tx.delete(searchQueries).where(inArray(searchQueries.id, removable));
    }

    return { deleted: removable.length, cancelled: running.length, leadsDeleted };
  });
}

/**
 * Removes leads from a batch by LinkedIn identifier — the key the Leads tab de-duplicates
 * on, so deleting there removes every copy rather than leaving one to reappear from
 * another URL in the same batch. Each affected URL's `leadsFetched` is recounted so the
 * Search URLs tab keeps matching what is actually stored.
 */
export async function deleteSearchLeads(batchId: string, linkedinUrls: string[]): Promise<number> {
  if (linkedinUrls.length === 0 || !(await searchBatchExists(batchId))) return 0;

  return db.transaction(async (tx) => {
    const queryIds = (
      await tx.select({ id: searchQueries.id }).from(searchQueries).where(eq(searchQueries.batchId, batchId))
    ).map((q) => q.id);
    if (queryIds.length === 0) return 0;

    const gone = await tx
      .delete(searchResults)
      .where(
        and(inArray(searchResults.searchQueryId, queryIds), inArray(searchResults.linkedinUrl, linkedinUrls))
      )
      .returning({ searchQueryId: searchResults.searchQueryId });
    if (gone.length === 0) return 0;

    for (const affected of new Set(gone.map((g) => g.searchQueryId))) {
      const [{ n }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(searchResults)
        .where(eq(searchResults.searchQueryId, affected));
      await tx.update(searchQueries).set({ leadsFetched: n }).where(eq(searchQueries.id, affected));
    }

    return gone.length;
  });
}

/**
 * Clears out what a set of search URLs found and puts them back in the queue, so the
 * next run fetches them from scratch. Their leads are deleted first — a rerun is for
 * when the stored results are wrong or stale, and keeping them would mean the new run
 * merges into the old ones rather than replacing them (results are inserted with
 * onConflictDoNothing on [searchQueryId, linkedinUrl]).
 *
 * A RUNNING URL is left alone: resetting the row under the job would have it write its
 * next page against state that no longer matches. Those ids come back in `skipped`.
 */
export async function resetSearchQueries(
  batchId: string,
  ids: string[]
): Promise<{ reset: number; skipped: number; leadsDeleted: number }> {
  if (ids.length === 0 || !(await searchBatchExists(batchId))) return { reset: 0, skipped: 0, leadsDeleted: 0 };

  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: searchQueries.id, status: searchQueries.status })
      .from(searchQueries)
      .where(and(eq(searchQueries.batchId, batchId), inArray(searchQueries.id, ids)));
    if (rows.length === 0) return { reset: 0, skipped: 0, leadsDeleted: 0 };

    const resettable = rows.filter((r) => r.status !== "RUNNING").map((r) => r.id);
    const skipped = rows.length - resettable.length;
    if (resettable.length === 0) return { reset: 0, skipped, leadsDeleted: 0 };

    const gone = await tx
      .delete(searchResults)
      .where(inArray(searchResults.searchQueryId, resettable))
      .returning({ id: searchResults.id });

    await tx
      .update(searchQueries)
      .set({
        status: "QUEUED",
        cursor: null,
        currentAccountId: null,
        leadsFetched: 0,
        totalCount: null,
        lastError: null,
        startedAt: null,
        completedAt: null,
      })
      .where(inArray(searchQueries.id, resettable));

    return { reset: resettable.length, skipped, leadsDeleted: gone.length };
  });
}

/* -------------------------------------------------------------------------
 * Running
 * ---------------------------------------------------------------------- */

export type StartBatchRunResult =
  | { started: true; runId: string }
  | { started: false; reason: "already_running"; runId: string };

/**
 * Starts the search job restricted to this batch. Only one search job may run at a
 * time (see runSearchQueue), so if another is in flight this returns its run id and
 * `started: false` — the batch keeps its QUEUED URLs and can be run once that finishes.
 *
 * When `accountIds` is given it is saved on the batch as the new default; otherwise the
 * batch's stored allowlist is used (empty = every connected account).
 */
export async function startSearchBatchRun(
  batchId: string,
  accountIds?: string[],
  queryIds?: string[]
): Promise<StartBatchRunResult> {
  const [batch] = await db
    .select({ accountIds: searchBatches.accountIds })
    .from(searchBatches)
    .where(and(inOrg(searchBatches), eq(searchBatches.id, batchId)))
    .limit(1);
  if (!batch) throw new Error("Search not found");

  let allowlist = batch.accountIds;
  if (accountIds) {
    if ((await unknownAccountIds(accountIds)).length > 0) throw new Error("Unknown account");
    allowlist = accountIds;
    await db.update(searchBatches).set({ accountIds }).where(and(inOrg(searchBatches), eq(searchBatches.id, batchId)));
  }

  const [alreadyRunning] = await db
    .select({ id: jobRuns.id })
    .from(jobRuns)
    .where(and(eq(jobRuns.job, "run-search-queue"), eq(jobRuns.status, "RUNNING")))
    .limit(1);
  if (alreadyRunning) return { started: false, reason: "already_running", runId: alreadyRunning.id };

  const runId = await withJobTracking("run-search-queue", (id) =>
    runSearchQueue(id, {
      batchId,
      accountIds: allowlist.length > 0 ? allowlist : undefined,
      queryIds: queryIds?.length ? queryIds : undefined,
    })
  );
  return { started: true, runId };
}

/** Whether a search job is in flight right now (any batch). */
export async function isSearchJobRunning(): Promise<boolean> {
  const [row] = await db
    .select({ id: jobRuns.id })
    .from(jobRuns)
    .where(and(eq(jobRuns.job, "run-search-queue"), eq(jobRuns.status, "RUNNING")))
    .limit(1);
  return Boolean(row);
}

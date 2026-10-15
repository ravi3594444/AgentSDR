import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { CrmExecutor } from "./repository";
import { currentOrganizationId } from "@/lib/tenancy/scope";
import {
  crmKnowledgeDocumentVersions,
  crmKnowledgeDocuments,
  type CrmKnowledgeKind,
} from "./schema";

/** Knowledge is budgeted using the same deliberately conservative estimate as context. */
export const KNOWLEDGE_CHARS_PER_TOKEN = 4;
export const DEFAULT_KNOWLEDGE_TOKENS = 2_000;
const TRUNCATION_MARKER = "…[truncated]";

export type KnowledgeCandidate = {
  documentId: string;
  documentVersionId: string;
  title: string;
  kind: CrmKnowledgeKind;
  tags: readonly string[];
  alwaysInclude: boolean;
  content: string;
  /** PostgreSQL ts_rank_cd score. A string is accepted for driver numeric compatibility. */
  rank: number | string;
  /** Number of step tags matching this document's tags, when supplied by the query. */
  tagOverlapCount?: number;
};

/** The only fields that are persisted for a draft citation. Keep this payload exact and immutable. */
export type KnowledgeCitation = Readonly<{
  documentVersionId: string;
  excerpt: string;
  excerptHash: string;
  rank: number;
}>;

export type KnowledgeSelectionEntry = Readonly<{
  documentId: string;
  documentVersionId: string;
  title: string;
  kind: CrmKnowledgeKind;
  tags: readonly string[];
  alwaysInclude: boolean;
  excerpt: string;
  excerptHash: string;
  rank: number;
  tagOverlapCount: number;
  citation: KnowledgeCitation;
}>;

export type KnowledgeSelection = Readonly<{
  entries: readonly KnowledgeSelectionEntry[];
  /** Draft-generator-compatible view; each item carries the exact citation fields. */
  knowledge: readonly KnowledgeSelectionEntry[];
  citations: readonly KnowledgeCitation[];
  estimatedTokens: number;
  maxTokens: number;
  truncated: boolean;
}>;

export type KnowledgeRetrievalInput = {
  query?: string | null;
  knowledgeTags?: readonly string[] | null;
  /** Alias useful to callers that already call these "step tags". */
  tags?: readonly string[] | null;
  maxTokens?: number;
  limit?: number;
};

type KnowledgeQueryRow = {
  documentId: string;
  documentVersionId: string;
  title: string;
  kind: string;
  tags: string[] | null;
  alwaysInclude: boolean;
  content: string;
  rank: number | string;
  tagOverlapCount: number | string;
};

function normalizedTags(tags: readonly string[] | null | undefined): string[] {
  return [...new Set((tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean))].sort();
}

function normalizedText(value: string): string {
  return value.trim();
}

function numericRank(value: number | string | null | undefined): number {
  const rank = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(rank) && rank > 0 ? rank : 0;
}

function overlapCount(candidateTags: readonly string[], requestedTags: readonly string[]): number {
  const wanted = new Set(normalizedTags(requestedTags));
  return normalizedTags(candidateTags).filter((tag) => wanted.has(tag)).length;
}

function compareCandidates(
  left: KnowledgeCandidate & { resolvedTagOverlapCount: number },
  right: KnowledgeCandidate & { resolvedTagOverlapCount: number },
): number {
  if (left.alwaysInclude !== right.alwaysInclude) return left.alwaysInclude ? -1 : 1;
  if (left.resolvedTagOverlapCount !== right.resolvedTagOverlapCount) {
    return right.resolvedTagOverlapCount - left.resolvedTagOverlapCount;
  }
  const rankDifference = numericRank(right.rank) - numericRank(left.rank);
  if (rankDifference !== 0) return rankDifference;
  const documentDifference = left.documentId.localeCompare(right.documentId);
  if (documentDifference !== 0) return documentDifference;
  return left.documentVersionId.localeCompare(right.documentVersionId);
}

function truncateExcerpt(content: string, maxCharacters: number): string {
  if (content.length <= maxCharacters) return content;
  if (maxCharacters <= TRUNCATION_MARKER.length) return content.slice(0, maxCharacters);
  return `${content.slice(0, maxCharacters - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

/** Stable, non-secret hash used as the citation primary-key component. */
export function hashKnowledgeExcerpt(excerpt: string): string {
  return createHash("sha256").update(excerpt, "utf8").digest("hex");
}

/** Alias kept short for draft-generation call sites. */
export const hashExcerpt = hashKnowledgeExcerpt;

export function estimateKnowledgeTokens(text: string): number {
  return Math.ceil(text.length / KNOWLEDGE_CHARS_PER_TOKEN);
}

/**
 * Selects already-ranked latest-version candidates without doing I/O. Always-included
 * documents win first, then step-tag overlap, then PostgreSQL rank, with id tie-breakers.
 * The excerpt is the exact text used to build the prompt and citation.
 */
export function selectKnowledgeCandidates(
  candidates: readonly KnowledgeCandidate[],
  options: { knowledgeTags?: readonly string[] | null; tags?: readonly string[] | null; maxTokens?: number } = {},
): KnowledgeSelection {
  const maxTokens = Math.floor(options.maxTokens ?? DEFAULT_KNOWLEDGE_TOKENS);
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    throw new Error("Knowledge maxTokens must be a positive finite integer");
  }

  const requestedTags = options.knowledgeTags ?? options.tags ?? [];
  const byVersion = new Map<string, KnowledgeCandidate & { resolvedTagOverlapCount: number }>();
  for (const candidate of candidates) {
    const content = normalizedText(candidate.content);
    const documentVersionId = candidate.documentVersionId.trim();
    const documentId = candidate.documentId.trim();
    if (!documentVersionId || !documentId || !content) continue;
    const normalized: KnowledgeCandidate & { resolvedTagOverlapCount: number } = {
      ...candidate,
      documentId,
      documentVersionId,
      title: candidate.title.trim(),
      tags: [...candidate.tags],
      content,
      rank: numericRank(candidate.rank),
      resolvedTagOverlapCount: candidate.tagOverlapCount === undefined
        ? overlapCount(candidate.tags, requestedTags)
        : Math.max(0, Math.floor(Number(candidate.tagOverlapCount) || 0)),
    };
    const existing = byVersion.get(documentVersionId);
    if (!existing || compareCandidates(normalized, existing) < 0) byVersion.set(documentVersionId, normalized);
  }

  const ordered = [...byVersion.values()].sort(compareCandidates);
  const maxCharacters = maxTokens * KNOWLEDGE_CHARS_PER_TOKEN;
  let remainingCharacters = maxCharacters;
  let truncated = false;
  const entries: KnowledgeSelectionEntry[] = [];

  for (const candidate of ordered) {
    const separatorCharacters = entries.length ? 2 : 0;
    if (remainingCharacters <= separatorCharacters) {
      truncated = true;
      break;
    }
    const excerpt = truncateExcerpt(candidate.content, remainingCharacters - separatorCharacters);
    if (!excerpt) continue;
    if (excerpt !== candidate.content) truncated = true;
    const rank = numericRank(candidate.rank);
    const citation: KnowledgeCitation = Object.freeze({
      documentVersionId: candidate.documentVersionId,
      excerpt,
      excerptHash: hashKnowledgeExcerpt(excerpt),
      rank,
    });
    entries.push(Object.freeze({
      documentId: candidate.documentId,
      documentVersionId: candidate.documentVersionId,
      title: candidate.title,
      kind: candidate.kind,
      tags: Object.freeze([...candidate.tags]),
      alwaysInclude: candidate.alwaysInclude,
      excerpt,
      excerptHash: citation.excerptHash,
      rank,
      tagOverlapCount: candidate.resolvedTagOverlapCount,
      citation,
    }));
    remainingCharacters -= excerpt.length + separatorCharacters;
    if (excerpt !== candidate.content) break;
  }

  if (entries.length < ordered.length) truncated = true;

  const citations = Object.freeze(entries.map((entry) => entry.citation));
  return Object.freeze({
    entries: Object.freeze(entries),
    knowledge: Object.freeze(entries),
    citations,
    estimatedTokens: estimateKnowledgeTokens(entries.map((entry) => entry.excerpt).join("\n\n")),
    maxTokens,
    truncated,
  });
}

/** More descriptive alias for callers assembling a draft context. */
export const selectKnowledge = selectKnowledgeCandidates;

const SEARCH_STOPWORDS = new Set([
  "the", "and", "for", "you", "your", "are", "was", "were", "with", "that", "this", "have", "has", "had", "not", "but", "can",
  "could", "would", "should", "will", "what", "when", "where", "which", "who", "how", "why", "our", "ours", "they", "them",
  "their", "there", "here", "from", "into", "about", "also", "just", "any", "some", "all", "more", "most", "very", "much",
  "many", "one", "two", "its", "it's", "i'm", "hi", "hello", "thanks", "thank", "dear", "regards", "please", "subject",
]);

/**
 * The search a query becomes: its significant words, any of which may match
 * (ranked by ts_rank_cd, so documents matching more of them come first).
 * Requiring every word, as plain websearch syntax does, matched almost no
 * document for a sentence like a lead's question.
 */
export function knowledgeSearchText(query: string | null | undefined): string {
  const words = (query ?? "").toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  const significant = [...new Set(words.filter((word) => !SEARCH_STOPWORDS.has(word)))].slice(0, 40);
  return significant.join(" or ");
}

/**
 * Query only active documents and the version explicitly declared by latest_version.
 * No mutation is performed; pass a transaction executor when this read participates
 * in a larger draft-generation transaction.
 */
export async function queryKnowledgeCandidates(
  executor: CrmExecutor,
  input: Pick<KnowledgeRetrievalInput, "query" | "knowledgeTags" | "tags" | "limit"> = {},
): Promise<KnowledgeCandidate[]> {
  const searchText = knowledgeSearchText(input.query);
  const tags = normalizedTags(input.knowledgeTags ?? input.tags);
  const limit = Math.floor(input.limit ?? 100);
  if (!Number.isFinite(limit) || limit <= 0 || limit > 500) {
    throw new Error("Knowledge query limit must be between 1 and 500");
  }
  const tagArray = tags.length
    ? sql`ARRAY[${sql.join(tags.map((tag) => sql`${tag}`), sql`, `)}]::text[]`
    : sql`ARRAY[]::text[]`;

  const rows = await executor.execute(sql<KnowledgeQueryRow>`
    SELECT
      d.id AS "documentId",
      v.id AS "documentVersionId",
      d.title AS "title",
      d.kind AS "kind",
      d.tags AS "tags",
      d.always_include AS "alwaysInclude",
      v.content AS "content",
      ts_rank_cd(
        to_tsvector('simple', concat_ws(' ', d.title, v.content)),
        websearch_to_tsquery('simple', ${searchText})
      ) AS "rank",
      (
        SELECT count(*)::int
        FROM unnest(d.tags) AS document_tag(tag)
        WHERE document_tag.tag = ANY(${tagArray})
      ) AS "tagOverlapCount"
    FROM ${crmKnowledgeDocuments} AS d
    INNER JOIN ${crmKnowledgeDocumentVersions} AS v
      ON v.document_id = d.id
      AND v.version = d.latest_version
    WHERE d.organization_id = ${currentOrganizationId()}
      AND d.active IS TRUE
      AND length(btrim(v.content)) > 0
      AND (
        d.always_include IS TRUE
        OR d.tags && ${tagArray}
        OR to_tsvector('simple', concat_ws(' ', d.title, v.content))
          @@ websearch_to_tsquery('simple', ${searchText})
      )
    ORDER BY "alwaysInclude" DESC, "tagOverlapCount" DESC, "rank" DESC,
      "documentId" ASC, "documentVersionId" ASC
    LIMIT ${limit}
  `);

  return (Array.from(rows) as unknown as KnowledgeQueryRow[]).map((row) => ({
    documentId: row.documentId,
    documentVersionId: row.documentVersionId,
    title: row.title,
    kind: row.kind as CrmKnowledgeKind,
    tags: row.tags ?? [],
    alwaysInclude: Boolean(row.alwaysInclude),
    content: row.content,
    rank: numericRank(row.rank),
    tagOverlapCount: Number(row.tagOverlapCount) || 0,
  }));
}

/** Search and apply the deterministic application-side token budget. */
export async function retrieveKnowledge(
  executor: CrmExecutor,
  input: KnowledgeRetrievalInput = {},
): Promise<KnowledgeSelection> {
  const candidates = await queryKnowledgeCandidates(executor, input);
  return selectKnowledgeCandidates(candidates, input);
}

export const searchKnowledge = retrieveKnowledge;

import type { QuotaLimits } from "@/lib/quota/quota";

/**
 * Research sources: public discussion sites the assistant may read as
 * evidence of a stated need or problem, never of buying intent. Client-safe
 * constants and shapes; the readers are in hackerNews.server.ts and
 * stackExchange.server.ts, the Reddit gate in reddit.ts.
 *
 * Both readers use keyless public APIs, so their quota scope is this
 * server's IP ("…:server"), shared by every organization on it.
 */

export const HACKER_NEWS_PROVIDER = "hackernews";
export const HACKER_NEWS_SCOPE = "hackernews:server";
/** About one request a second; the API publishes no limit, so this is our own restraint. */
export const HACKER_NEWS_LIMITS = { perMinute: 60 } as const satisfies QuotaLimits;
/** Top-level comments read with a story (one request each). */
export const HACKER_NEWS_MAX_COMMENTS = 15;

export const STACK_EXCHANGE_PROVIDER = "stackexchange";
export const STACK_EXCHANGE_SCOPE = "stackexchange:server";
/** Stack Exchange's allowance for requests without a key: 300 a day per IP. */
export const STACK_EXCHANGE_LIMITS = { perDay: 300 } as const satisfies QuotaLimits;
/** Identical requests within this time are answered from memory. */
export const STACK_EXCHANGE_CACHE_MS = 60_000;

/** Both readers count one unit per API request under this product. */
export const RESEARCH_API_PRODUCT = "api";

export const REDDIT_NOTE_MAX = 500;

/** One piece of evidence a reader returns: what was written, where and when. */
export type ResearchEvidence = {
  source: "Hacker News" | "Stack Exchange";
  url: string;
  /** A pseudonymous username on that site, never a person to contact. */
  author: string | null;
  postedAt: string | null;
  /** What the evidence can show. */
  shows: "a stated need or opinion" | "a stated problem";
};

/** A thread read through a source's API, ready for read_webpage. */
export type ResearchPage = {
  url: string;
  title: string;
  body: string;
  links: string[];
  /** Which reader read it, e.g. "the Hacker News API". */
  via: string;
  evidence: ResearchEvidence[];
};

export type ResearchSourceUsage = {
  /** This organization's requests today (UTC). */
  usedToday: number;
  /** Requests from this server today, every organization together (the quota is per IP). */
  serverUsedToday: number;
  waitingUntil: string | null;
  waitingReason: string | null;
};

export type ResearchSourcesView = {
  hackerNews: ResearchSourceUsage & { perMinute: number };
  stackExchange: ResearchSourceUsage & { perDay: number };
  reddit: {
    /** Always false: no Reddit reader exists, approval or not. */
    readerBuilt: false;
    approvalRecordedAt: string | null;
    approvalNote: string | null;
    /** The last characters of the approved app's client id, never the whole id. */
    clientHint: string | null;
    updatedAt: string | null;
  };
};

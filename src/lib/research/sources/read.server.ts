import "server-only";

import type { ResearchPage } from "./catalog";
import { ResearchSourceError, ResearchSourceWaitError } from "./errors";
import { hackerNewsPage } from "./hackerNews";
import { readHackerNewsThread } from "./hackerNews.server";
import type { ResearchCallContext } from "./http.server";
import { researchSourceOf } from "./sources";
import { stackExchangePage } from "./stackExchange";
import { readStackExchangeQuestion } from "./stackExchange.server";

export type SourceRead =
  /** Read through the source's API. */
  | { kind: "page"; page: ResearchPage }
  /** The source says there is no such item: nothing to read. */
  | { kind: "missing"; summary: string }
  /** The API is waiting or failed: the page may be read the ordinary way, saying why. */
  | { kind: "fallback"; note: string };

/**
 * A Hacker News item or Stack Exchange question read through its API (the
 * caller has already refused private addresses); null for any other address.
 */
export async function readResearchSource(url: URL, context: ResearchCallContext = {}): Promise<SourceRead | null> {
  const ref = researchSourceOf(url);
  if (!ref) return null;
  try {
    if (ref.kind === "hackernews") {
      const thread = await readHackerNewsThread(ref.id, context);
      return thread ? { kind: "page", page: hackerNewsPage(thread) } : { kind: "missing", summary: `Hacker News has no item ${ref.id}.` };
    }
    const question = await readStackExchangeQuestion(ref, context);
    return question
      ? { kind: "page", page: stackExchangePage(question) }
      : { kind: "missing", summary: `${ref.site} has no question ${ref.id} (it may have been deleted).` };
  } catch (error) {
    if (error instanceof ResearchSourceWaitError) {
      return { kind: "fallback", note: `${error.source} is waiting until ${error.until.toISOString().slice(0, 16).replace("T", " ")} UTC: ${error.reason}` };
    }
    if (error instanceof ResearchSourceError) return { kind: "fallback", note: error.message };
    throw error;
  }
}

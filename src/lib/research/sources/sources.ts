import { hackerNewsItemId, isHackerNewsHost } from "./hackerNews";
import { stackExchangeQuestion, stackExchangeSite, type StackExchangeRef } from "./stackExchange";

/**
 * Which research source an address belongs to, and the rule the assistant
 * reads with every page from a discussion site, however it was read. Pure.
 */

export type ResearchSourceRef = { kind: "hackernews"; id: number } | ({ kind: "stackexchange" } & StackExchangeRef);

/** A Hacker News item or Stack Exchange question address, read through its API; null for anything else. */
export function researchSourceOf(url: string | URL): ResearchSourceRef | null {
  const id = hackerNewsItemId(url);
  if (id !== null) return { kind: "hackernews", id };
  const question = stackExchangeQuestion(url);
  return question ? { kind: "stackexchange", ...question } : null;
}

/**
 * For a page on Hacker News or a Stack Exchange site: what it is evidence
 * of, and that its authors are pseudonymous and not leads. Null elsewhere.
 * Such a page's contacts are not offered as leads either.
 */
export function discussionNote(hostname: string): string | null {
  if (isHackerNewsHost(hostname)) {
    return "Evidence: what is written on Hacker News shows a stated need or opinion, not buying intent. Its authors are pseudonymous usernames: not leads to contact, and never to be matched to people or accounts elsewhere.";
  }
  const site = stackExchangeSite(hostname);
  if (site) {
    return `Evidence: a question on ${site} shows a stated problem, not buying intent. The asker and answerers are pseudonymous ${site} users: not leads to contact, and never to be matched to people or accounts elsewhere.`;
  }
  return null;
}

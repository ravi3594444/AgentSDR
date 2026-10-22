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
 * For a page on Hacker News or a Stack Exchange site: what it holds, and
 * that its authors are pseudonymous and not leads. Null elsewhere. Such a
 * page's contacts are not offered as leads either.
 */
export function discussionNote(hostname: string): string | null {
  if (isHackerNewsHost(hostname)) {
    return "Hacker News: posts and comments with their authors' usernames and dates, evidence of what people say they need or think. Its authors are pseudonymous: not leads unless their own page publishes a contact, and a username is never matched to people or accounts elsewhere.";
  }
  const site = stackExchangeSite(hostname);
  if (site) {
    return `${site}: the question and answers with their authors and dates, evidence of a stated problem. The asker and answerers are pseudonymous ${site} users: not leads unless their own page publishes a contact, and a username is never matched to people or accounts elsewhere.`;
  }
  return null;
}

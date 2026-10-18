import { publicLinks } from "@/lib/discovery/contacts";
import { HACKER_NEWS_MAX_COMMENTS, type ResearchPage } from "./catalog";
import { clip, excerpt, htmlToText } from "./text";

/**
 * Hacker News threads read through the official API
 * (https://github.com/HackerNews/API): an item and its first top-level
 * comments. The API has no keyword search, so the assistant finds threads
 * with web_search and opens them with read_webpage. Pure; the calls are in
 * hackerNews.server.ts.
 *
 * Authors are pseudonymous usernames. A thread is evidence of a stated need
 * or opinion; its authors are never people to contact or to match to
 * identities elsewhere.
 */

export const HACKER_NEWS_API = "https://hacker-news.firebaseio.com/v0";

const HOST = /^news\.ycombinator\.com$/i;

function parsed(raw: string | URL): URL | null {
  if (raw instanceof URL) return raw;
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
}

/** Whether the address is on Hacker News's own site. */
export function isHackerNewsHost(hostname: string): boolean {
  return HOST.test(hostname.replace(/\.$/, ""));
}

/** The item id of a news.ycombinator.com/item?id=N address, or null. */
export function hackerNewsItemId(raw: string | URL): number | null {
  const url = parsed(raw);
  if (!url || !/^https?:$/.test(url.protocol) || !isHackerNewsHost(url.hostname) || url.pathname !== "/item") return null;
  const id = url.searchParams.get("id") ?? "";
  if (!/^\d{1,10}$/.test(id)) return null;
  const value = Number(id);
  return value > 0 && Number.isSafeInteger(value) ? value : null;
}

export function hackerNewsItemUrl(id: number): string {
  return `https://news.ycombinator.com/item?id=${id}`;
}

export function hackerNewsApiUrl(id: number): string {
  return `${HACKER_NEWS_API}/item/${id}.json`;
}

export type HackerNewsItem = {
  id: number;
  /** story, comment, job, poll or pollopt. */
  type: string;
  by: string | null;
  /** ISO time it was posted. */
  time: string | null;
  title: string | null;
  url: string | null;
  /** The item's text as plain text ("" when it has none). */
  text: string;
  /** The text as the API gave it (HTML), for its links. */
  html: string;
  score: number | null;
  descendants: number | null;
  kids: number[];
  deleted: boolean;
  dead: boolean;
};

const positiveInteger = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null);
const nonNegative = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null);
const shortText = (value: unknown, max: number): string | null => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);

/** One item from the API's answer; null for "no such item" (the API answers null) or anything malformed. */
export function parseHackerNewsItem(body: unknown): HackerNewsItem | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const id = positiveInteger(record.id);
  if (!id) return null;
  const html = typeof record.text === "string" ? record.text : "";
  const seconds = typeof record.time === "number" && Number.isFinite(record.time) ? record.time : null;
  const link = shortText(record.url, 2_000);
  return {
    id,
    type: shortText(record.type, 20) ?? "story",
    by: shortText(record.by, 80),
    time: seconds === null ? null : new Date(seconds * 1000).toISOString(),
    // Titles are plain text in this API ("Why <canvas>?" is a title, not a tag); only `text` is HTML.
    title: shortText(record.title, 300),
    url: link && /^https?:\/\//i.test(link) ? link : null,
    text: htmlToText(html),
    html,
    score: nonNegative(record.score),
    descendants: nonNegative(record.descendants),
    kids: Array.isArray(record.kids) ? record.kids.map(positiveInteger).filter((kid): kid is number => kid !== null) : [],
    deleted: record.deleted === true,
    dead: record.dead === true,
  };
}

/** The top-level comments worth reading: the first ones the API lists (its ranking), at most `max`. */
export function commentIdsToRead(item: HackerNewsItem, max = HACKER_NEWS_MAX_COMMENTS): number[] {
  return item.kids.slice(0, max);
}

export type HackerNewsThread = {
  item: HackerNewsItem;
  /** Readable top-level comments, in the API's order. */
  comments: HackerNewsItem[];
  /** Why comments were not read, when they were not (a throttle wait). */
  commentsSkipped: string | null;
};

const visible = (item: HackerNewsItem) => !item.deleted && !item.dead;
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "unknown date");

/** The thread as a page for read_webpage: the item, then its comments with authors, times and their own URLs. */
export function hackerNewsPage(thread: HackerNewsThread): ResearchPage {
  const { item } = thread;
  const url = hackerNewsItemUrl(item.id);
  const kind = item.type === "comment" ? "comment" : item.type;
  const facts = [
    `Hacker News ${kind} by ${item.by ?? "an unknown user"} (a pseudonymous username), posted ${day(item.time)}`,
    item.score !== null ? `${item.score} points` : null,
    item.descendants !== null ? `${item.descendants} comments in all` : null,
  ].filter(Boolean).join("; ");
  const comments = thread.comments.filter((comment) => visible(comment) && comment.text);
  const lines = [
    `${facts}.`,
    item.url ? `Link: ${item.url}` : null,
    item.title ? `Title: ${item.title}` : null,
    visible(item) ? (item.text ? clip(item.text, 2_000) : null) : "(This item was deleted or flagged.)",
    comments.length
      ? `Top comments (${comments.length} of ${item.kids.length}):\n${comments.map((comment, index) => `[${index + 1}] ${comment.by ?? "unknown"}, ${day(comment.time)} — ${hackerNewsItemUrl(comment.id)}\n${excerpt(comment.text, 500)}`).join("\n")}`
      : item.kids.length
        ? `Comments not read${thread.commentsSkipped ? `: ${thread.commentsSkipped}` : ""}.`
        : null,
  ].filter((line): line is string => Boolean(line));
  const links = [
    ...(item.url ? [item.url] : []),
    ...publicLinks([item, ...comments].map((entry) => entry.html).join(" "), url, 40),
  ];
  return {
    url,
    title: item.title ?? excerpt(item.text, 80),
    body: lines.join("\n\n"),
    links: [...new Set(links)].slice(0, 40),
    via: "the Hacker News API",
    evidence: [item, ...comments].filter(visible).map((entry) => ({
      source: "Hacker News" as const,
      url: hackerNewsItemUrl(entry.id),
      author: entry.by,
      postedAt: entry.time,
      shows: "a stated need or opinion" as const,
    })),
  };
}

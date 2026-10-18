import { publicLinks } from "@/lib/discovery/contacts";
import { waitFromRefusal } from "@/lib/quota/quota";
import type { ResearchPage } from "./catalog";
import { clip, decodeEntities, htmlToText } from "./text";

/**
 * Stack Exchange questions read through API 2.3 without a key (300 requests
 * a day per IP): stackoverflow.com, superuser.com, serverfault.com,
 * askubuntu.com and *.stackexchange.com. A question is evidence of a stated
 * problem, not of buying intent; the asker's display name is pseudonymous.
 * Pure; the call is in stackExchange.server.ts.
 */

export const STACK_EXCHANGE_API = "https://api.stackexchange.com/2.3";

// stackoverflow.com and its language and meta sites; Super User, Server
// Fault and Ask Ubuntu with their metas; every *.stackexchange.com Q&A site.
const SITE_HOST = /^(?:(?:[a-z]{2}\.)?(?:meta\.)?stackoverflow\.com|(?:meta\.)?(?:superuser|serverfault|askubuntu)\.com|[a-z0-9-]+(?:\.meta)?\.stackexchange\.com)$/i;
/** stackexchange.com hosts that are not Q&A sites. */
const NOT_A_SITE = /^(?:api|chat|data|openid|stackauth)\./i;

export type StackExchangeRef = { site: string; id: number };

/** The site (its domain, which the API accepts as `site`) of a Stack Exchange address, or null. */
export function stackExchangeSite(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  return SITE_HOST.test(host) && !NOT_A_SITE.test(host) ? host : null;
}

/** The site and question id of a …/questions/N/… (or /q/N) address, or null. */
export function stackExchangeQuestion(raw: string | URL): StackExchangeRef | null {
  let url: URL;
  try {
    url = raw instanceof URL ? raw : new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  const site = stackExchangeSite(url.hostname);
  const match = /^\/(?:questions|q)\/(\d{1,10})(?:\/|$)/.exec(url.pathname);
  if (!site || !match) return null;
  const id = Number(match[1]);
  return id > 0 && Number.isSafeInteger(id) ? { site, id } : null;
}

export function stackExchangeApiUrl(ref: StackExchangeRef): string {
  return `${STACK_EXCHANGE_API}/questions/${ref.id}?site=${encodeURIComponent(ref.site)}&filter=withbody`;
}

export type StackExchangeQuestion = {
  id: number;
  site: string;
  title: string;
  /** The body as plain text. */
  body: string;
  /** The body as the API gave it (HTML), for its links. */
  html: string;
  tags: string[];
  /** The asker's display name: pseudonymous. */
  asker: string | null;
  createdAt: string | null;
  link: string;
  score: number | null;
  answerCount: number | null;
  isAnswered: boolean;
  closedReason: string | null;
};

export type StackExchangeAnswer = {
  questions: StackExchangeQuestion[];
  quotaRemaining: number | null;
  quotaMax: number | null;
  /** Seconds the API asked us to wait before calling again. */
  backoffSeconds: number | null;
  error: { id: number | null; name: string; message: string } | null;
};

const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null);
const textOf = (value: unknown, max: number): string | null => (typeof value === "string" && value.trim() ? decodeEntities(value.trim()).slice(0, max) : null);

function question(item: unknown, site: string): StackExchangeQuestion | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  const id = count(record.question_id);
  if (!id || id <= 0) return null;
  const html = typeof record.body === "string" ? record.body : "";
  const owner = record.owner && typeof record.owner === "object" ? (record.owner as Record<string, unknown>) : {};
  const created = count(record.creation_date);
  const link = typeof record.link === "string" && /^https:\/\//i.test(record.link) ? record.link : `https://${site}/questions/${id}`;
  return {
    id,
    site,
    // Titles and display names come HTML-encoded ("&quot;", "&#39;").
    title: textOf(record.title, 300) ?? `Question ${id}`,
    body: htmlToText(html),
    html,
    tags: Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 10) : [],
    asker: textOf(owner.display_name, 80),
    createdAt: created !== null && created > 0 ? new Date(created * 1000).toISOString() : null,
    link,
    score: count(record.score),
    answerCount: count(record.answer_count),
    isAnswered: record.is_answered === true,
    closedReason: textOf(record.closed_reason, 80),
  };
}

/** The API's answer (it is JSON for errors too). */
export function parseStackExchangeAnswer(body: unknown, site: string): StackExchangeAnswer {
  const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const items = Array.isArray(record.items) ? record.items : [];
  const backoff = count(record.backoff);
  const hasError = typeof record.error_name === "string" || typeof record.error_id === "number";
  return {
    questions: items.map((item) => question(item, site)).filter((entry): entry is StackExchangeQuestion => entry !== null),
    quotaRemaining: count(record.quota_remaining),
    quotaMax: count(record.quota_max),
    backoffSeconds: backoff !== null && backoff > 0 ? backoff : null,
    error: hasError
      ? { id: count(record.error_id), name: typeof record.error_name === "string" ? record.error_name : "error", message: typeof record.error_message === "string" ? record.error_message.slice(0, 300) : "" }
      : null,
  };
}

const DAY = 86_400_000;
const nextUtcDay = (now: Date) => new Date(now.getTime() - (now.getTime() % DAY) + DAY);

/**
 * How long Stack Exchange asked this server to wait, or null: a `backoff`
 * (seconds, per the API's rules, before calling that method again), a
 * throttle violation ("more requests available in N seconds"), a used-up
 * daily quota, or an HTTP 429/503. The longest one wins.
 */
export function stackExchangeWait(status: number, answer: StackExchangeAnswer, now: Date): { until: Date; reason: string } | null {
  const waits: { until: Date; reason: string }[] = [];
  if (answer.backoffSeconds) {
    waits.push({ until: new Date(now.getTime() + answer.backoffSeconds * 1000), reason: `Stack Exchange asked for a ${answer.backoffSeconds}-second backoff` });
  }
  if (answer.error?.name === "throttle_violation" || answer.error?.id === 502) {
    const seconds = /available in (\d{1,7}) seconds/i.exec(answer.error.message)?.[1];
    waits.push(seconds
      ? { until: new Date(now.getTime() + Number(seconds) * 1000), reason: "Stack Exchange is throttling this server (too many requests without a key)" }
      : { until: nextUtcDay(now), reason: "Stack Exchange is throttling this server (too many requests without a key)" });
  }
  if (answer.quotaRemaining === 0) {
    waits.push({ until: nextUtcDay(now), reason: "Stack Exchange's keyless allowance for this server is used up for today (UTC)" });
  }
  const refusal = waitFromRefusal({ status: status === 429 || status === 503 ? status : null }, now, "Stack Exchange");
  if (refusal) waits.push(refusal);
  return waits.sort((a, b) => b.until.getTime() - a.until.getTime())[0] ?? null;
}

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "an unknown date");

/** The question as a page for read_webpage. */
export function stackExchangePage(q: StackExchangeQuestion): ResearchPage {
  const facts = [
    `Stack Exchange question on ${q.site}, asked by ${q.asker ?? "an unknown user"} (a pseudonymous display name) on ${day(q.createdAt)}`,
    q.tags.length ? `tags: ${q.tags.join(", ")}` : null,
    q.score !== null ? `score ${q.score}` : null,
    q.answerCount !== null ? `${q.answerCount} answer${q.answerCount === 1 ? "" : "s"}${q.isAnswered ? " (answered)" : ""}` : null,
    q.closedReason ? `closed as ${q.closedReason}` : null,
  ].filter(Boolean).join("; ");
  return {
    url: q.link,
    title: q.title,
    body: [`${facts}.`, `Title: ${q.title}`, q.body ? clip(q.body, 5_000) : "(No body text.)"].join("\n\n"),
    links: publicLinks(q.html, q.link, 40),
    via: "the Stack Exchange API",
    evidence: [{ source: "Stack Exchange", url: q.link, author: q.asker, postedAt: q.createdAt, shows: "a stated problem" }],
  };
}

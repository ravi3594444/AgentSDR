import { describe, expect, test } from "bun:test";
import { commentIdsToRead, hackerNewsItemId, hackerNewsPage, parseHackerNewsItem, type HackerNewsItem } from "./hackerNews";
import { isRedditHost, redditClientHint, redditRefusal } from "./reddit";
import { discussionNote, researchSourceOf } from "./sources";
import { parseStackExchangeAnswer, stackExchangePage, stackExchangeQuestion, stackExchangeWait } from "./stackExchange";
import { decodeEntities, htmlToText } from "./text";

describe("Hacker News addresses", () => {
  test("an item address gives its id, with or without a scheme", () => {
    expect(hackerNewsItemId("https://news.ycombinator.com/item?id=41234567")).toBe(41234567);
    expect(hackerNewsItemId("news.ycombinator.com/item?id=8863&p=2")).toBe(8863);
    expect(hackerNewsItemId("http://NEWS.ycombinator.com./item?id=1")).toBe(1);
  });

  test("anything else is not an item", () => {
    for (const url of [
      "https://news.ycombinator.com/user?id=pg",
      "https://news.ycombinator.com/item?id=abc",
      "https://news.ycombinator.com/item?id=0",
      "https://news.ycombinator.com/item",
      "https://news.ycombinator.com/news",
      "https://ycombinator.com/item?id=1",
      "https://news.ycombinator.com.evil.example/item?id=1",
      "ftp://news.ycombinator.com/item?id=1",
      "not a url at all",
    ]) expect(hackerNewsItemId(url)).toBeNull();
  });
});

describe("Stack Exchange addresses", () => {
  test("question addresses give the site and id", () => {
    expect(stackExchangeQuestion("https://stackoverflow.com/questions/11227809/why-is-processing-faster")).toEqual({ site: "stackoverflow.com", id: 11227809 });
    expect(stackExchangeQuestion("https://www.stackoverflow.com/questions/5")).toEqual({ site: "stackoverflow.com", id: 5 });
    expect(stackExchangeQuestion("unix.stackexchange.com/questions/42/x")).toEqual({ site: "unix.stackexchange.com", id: 42 });
    expect(stackExchangeQuestion("https://superuser.com/q/9")).toEqual({ site: "superuser.com", id: 9 });
    expect(stackExchangeQuestion("https://serverfault.com/questions/7/slug/8#8")).toEqual({ site: "serverfault.com", id: 7 });
    expect(stackExchangeQuestion("https://askubuntu.com/questions/3")).toEqual({ site: "askubuntu.com", id: 3 });
    expect(stackExchangeQuestion("https://ru.stackoverflow.com/questions/2")).toEqual({ site: "ru.stackoverflow.com", id: 2 });
    expect(stackExchangeQuestion("https://math.meta.stackexchange.com/questions/4")).toEqual({ site: "math.meta.stackexchange.com", id: 4 });
  });

  test("other pages and look-alike hosts are not questions", () => {
    for (const url of [
      "https://stackoverflow.com/users/1/jeff",
      "https://stackoverflow.com/questions/tagged/postgres",
      "https://stackoverflow.com/questions",
      "https://api.stackexchange.com/questions/1",
      "https://chat.stackexchange.com/questions/1",
      "https://stackexchange.com/questions/1",
      "https://evil-stackoverflow.com/questions/1",
      "https://stackoverflow.com.evil.example/questions/1",
      "https://superuser.com/a/9",
    ]) expect(stackExchangeQuestion(url)).toBeNull();
  });
});

describe("Reddit", () => {
  test("every Reddit host is recognised, including redd.it", () => {
    for (const host of ["reddit.com", "www.reddit.com", "old.reddit.com", "new.reddit.com", "np.reddit.com", "redd.it", "i.redd.it", "REDDIT.COM", "reddit.com."]) {
      expect(isRedditHost(host)).toBe(true);
    }
    for (const host of ["notreddit.com", "reddit.co", "reddit.com.evil.example", "redditmedia.example", "credd.it"]) expect(isRedditHost(host)).toBe(false);
  });

  test("the refusal says nothing was read, and approval does not enable reading", () => {
    expect(redditRefusal(false)).toBe("Reddit is unavailable to research: its API needs Reddit's approval for this use, and that approval is not recorded (Settings → Lead research → Research sources). Nothing was read from Reddit.");
    expect(redditRefusal(true)).toContain("approval recorded; a Reddit reader is not built yet");
    expect(redditRefusal(true)).toContain("Nothing was read from Reddit.");
  });

  test("only a client id's last four characters are kept", () => {
    expect(redditClientHint("  abcDEF123xyz ")).toBe("…3xyz");
    expect(redditClientHint("")).toBeNull();
  });
});

test("researchSourceOf picks the reader, and nothing for other sites", () => {
  expect(researchSourceOf("https://news.ycombinator.com/item?id=7")).toEqual({ kind: "hackernews", id: 7 });
  expect(researchSourceOf("https://unix.stackexchange.com/questions/8")).toEqual({ kind: "stackexchange", site: "unix.stackexchange.com", id: 8 });
  expect(researchSourceOf("https://www.reddit.com/r/sales/comments/abc")).toBeNull();
  expect(researchSourceOf("https://example.com/questions/1")).toBeNull();
});

test("a discussion page carries the evidence rule; other pages none", () => {
  expect(discussionNote("news.ycombinator.com")).toMatch(/not buying intent.*pseudonymous.*not leads/);
  expect(discussionNote("serverfault.com")).toMatch(/stated problem.*pseudonymous serverfault\.com users/);
  expect(discussionNote("example.com")).toBeNull();
});

describe("HTML to text", () => {
  test("a Hacker News comment keeps paragraphs and decodes entities", () => {
    const html = "It&#x27;s <i>fine</i>.<p>Second &quot;para&quot; <a href=\"https:&#x2F;&#x2F;example.com&#x2F;x\" rel=\"nofollow\">https:&#x2F;&#x2F;example.com&#x2F;x</a>";
    expect(htmlToText(html)).toBe("It's fine.\n\nSecond \"para\" https://example.com/x");
  });

  test("lists, code and text that looks like a tag", () => {
    expect(htmlToText("<ul><li>one</li><li>two &amp; three</li></ul><pre><code>a  &lt;b&gt;</code></pre>")).toBe("- one\n- two & three\n\na <b>");
    expect(htmlToText("1 < 2 and <> stays")).toBe("1 < 2 and <> stays");
    expect(htmlToText("unclosed <b tag")).toBe("unclosed <b tag");
  });

  test("entities decode once, and invalid ones stay", () => {
    expect(decodeEntities("&amp;lt; &#128512; &#xD800; &bogus; &#0;")).toBe("&lt; 😀 &#xD800; &bogus; &#0;");
  });

  test("long text is cut", () => {
    expect(htmlToText("x".repeat(50), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("Hacker News answers", () => {
  const story = {
    by: "throwaway42", descendants: 12, id: 100, kids: [101, 102, "x", 103], score: 87, time: 1_700_000_000,
    title: "Ask HN: How do you <handle> invoicing for 20 clients?", type: "story", url: "https://blog.example/post",
    text: "We spend hours on it.<p>Any tools? <a href=\"https://tool.example/\">tool</a>",
  };

  test("a story is parsed with its comments' ids", () => {
    const item = parseHackerNewsItem(story)!;
    expect(item).toMatchObject({ id: 100, type: "story", by: "throwaway42", time: "2023-11-14T22:13:20.000Z", score: 87, descendants: 12, kids: [101, 102, 103], deleted: false, dead: false });
    expect(item.title).toBe("Ask HN: How do you <handle> invoicing for 20 clients?");
    expect(item.text).toBe("We spend hours on it.\n\nAny tools? tool");
  });

  test("missing fields are null, and no such item is null", () => {
    expect(parseHackerNewsItem(null)).toBeNull();
    expect(parseHackerNewsItem({ type: "story" })).toBeNull();
    expect(parseHackerNewsItem({ id: 5, deleted: true, type: "comment" })).toMatchObject({ id: 5, by: null, time: null, title: null, url: null, text: "", kids: [], deleted: true });
    expect(parseHackerNewsItem({ id: 6, url: "javascript:alert(1)" })!.url).toBeNull();
  });

  test("at most 15 top-level comments are read", () => {
    const item = parseHackerNewsItem({ id: 1, kids: Array.from({ length: 40 }, (_, i) => i + 2) })!;
    expect(commentIdsToRead(item)).toHaveLength(15);
  });

  test("the page names pseudonymous authors with their item links as evidence", () => {
    const item = parseHackerNewsItem(story)!;
    const comment = (id: number, by: string, text: string, extra: Partial<HackerNewsItem> = {}) => ({ ...parseHackerNewsItem({ id, by, text, time: 1_700_000_100, type: "comment" })!, ...extra });
    const page = hackerNewsPage({ item, comments: [comment(101, "pg_fan", "We use <a href=\"https://acct.example/\">acct</a>"), comment(102, "gone", "x", { deleted: true })], commentsSkipped: null });
    expect(page.url).toBe("https://news.ycombinator.com/item?id=100");
    expect(page.via).toBe("the Hacker News API");
    expect(page.body).toContain("Hacker News story by throwaway42 (a pseudonymous username), posted 2023-11-14; 87 points; 12 comments in all.");
    expect(page.body).toContain("[1] pg_fan, 2023-11-14 — https://news.ycombinator.com/item?id=101");
    expect(page.body).not.toContain("gone");
    expect(page.links).toEqual(["https://blog.example/post", "https://tool.example/", "https://acct.example/"]);
    expect(page.evidence.map((entry) => [entry.url, entry.author, entry.shows])).toEqual([
      ["https://news.ycombinator.com/item?id=100", "throwaway42", "a stated need or opinion"],
      ["https://news.ycombinator.com/item?id=101", "pg_fan", "a stated need or opinion"],
    ]);
  });

  test("comments skipped for the throttle are said to be skipped", () => {
    const page = hackerNewsPage({ item: parseHackerNewsItem(story)!, comments: [], commentsSkipped: "Hacker News API: the limit is used" });
    expect(page.body).toContain("Comments not read: Hacker News API: the limit is used.");
  });
});

describe("Stack Exchange answers", () => {
  const body = {
    items: [{
      tags: ["postgresql", "backup"], owner: { display_name: "J&#246;rg &quot;db&quot; M", user_type: "registered" }, is_answered: false, answer_count: 0, score: 3,
      creation_date: 1_700_000_000, question_id: 77, link: "https://dba.stackexchange.com/questions/77/how-to-back-up", title: "How to back up 2TB &amp; keep &#39;uptime&#39;?",
      body: "<p>Our nightly <code>pg_dump</code> takes 9 hours.</p>\n<p>See <a href=\"https://docs.example/backup\">docs</a>.</p>",
    }],
    has_more: false, quota_max: 300, quota_remaining: 287,
  };

  test("a question is parsed: decoded title and asker, tags, date, body text", () => {
    const answer = parseStackExchangeAnswer(body, "dba.stackexchange.com");
    expect(answer.quotaRemaining).toBe(287);
    expect(answer.backoffSeconds).toBeNull();
    expect(answer.error).toBeNull();
    expect(answer.questions[0]).toMatchObject({
      id: 77, site: "dba.stackexchange.com", title: "How to back up 2TB & keep 'uptime'?", asker: "Jörg \"db\" M", tags: ["postgresql", "backup"],
      createdAt: "2023-11-14T22:13:20.000Z", answerCount: 0, isAnswered: false, body: "Our nightly pg_dump takes 9 hours.\n\nSee docs.",
    });
  });

  test("missing fields fall back, and an empty answer has no question", () => {
    const answer = parseStackExchangeAnswer({ items: [{ question_id: 5 }] }, "superuser.com");
    expect(answer.questions[0]).toMatchObject({ id: 5, title: "Question 5", asker: null, createdAt: null, link: "https://superuser.com/questions/5", tags: [], body: "" });
    expect(parseStackExchangeAnswer({ items: [], quota_remaining: 10 }, "superuser.com").questions).toEqual([]);
    expect(parseStackExchangeAnswer("<html>", "superuser.com")).toMatchObject({ questions: [], quotaRemaining: null, error: null });
  });

  test("the page is evidence of a stated problem from a pseudonymous asker", () => {
    const page = stackExchangePage(parseStackExchangeAnswer(body, "dba.stackexchange.com").questions[0]!);
    expect(page.via).toBe("the Stack Exchange API");
    expect(page.body).toContain("asked by Jörg \"db\" M (a pseudonymous display name) on 2023-11-14; tags: postgresql, backup; score 3; 0 answers");
    expect(page.links).toEqual(["https://docs.example/backup"]);
    expect(page.evidence).toEqual([{ source: "Stack Exchange", url: "https://dba.stackexchange.com/questions/77/how-to-back-up", author: "Jörg \"db\" M", postedAt: "2023-11-14T22:13:20.000Z", shows: "a stated problem" }]);
  });
});

describe("Stack Exchange waits", () => {
  const now = new Date("2026-10-18T10:00:00.000Z");
  const tomorrow = new Date("2026-10-19T00:00:00.000Z").getTime();
  const answer = (extra: Record<string, unknown>) => parseStackExchangeAnswer({ items: [], quota_remaining: 100, ...extra }, "stackoverflow.com");

  test("no backoff, no wait", () => {
    expect(stackExchangeWait(200, answer({}), now)).toBeNull();
  });

  test("a backoff waits that many seconds", () => {
    const wait = stackExchangeWait(200, answer({ backoff: 10 }), now)!;
    expect(wait.until.getTime()).toBe(now.getTime() + 10_000);
    expect(wait.reason).toContain("10-second backoff");
  });

  test("a throttle violation waits the seconds it names, or until the UTC day ends", () => {
    const named = stackExchangeWait(400, answer({ error_id: 502, error_name: "throttle_violation", error_message: "too many requests from this IP, more requests available in 3600 seconds" }), now)!;
    expect(named.until.getTime()).toBe(now.getTime() + 3_600_000);
    const unnamed = stackExchangeWait(400, answer({ error_id: 502, error_name: "throttle_violation", error_message: "slow down" }), now)!;
    expect(unnamed.until.getTime()).toBe(tomorrow);
  });

  test("a used-up quota waits until the UTC day ends; 429 waits too; the longest wins", () => {
    expect(stackExchangeWait(200, answer({ quota_remaining: 0 }), now)!.until.getTime()).toBe(tomorrow);
    expect(stackExchangeWait(429, answer({}), now)!.until.getTime()).toBeGreaterThan(now.getTime());
    expect(stackExchangeWait(200, answer({ quota_remaining: 0, backoff: 30 }), now)!.until.getTime()).toBe(tomorrow);
  });
});

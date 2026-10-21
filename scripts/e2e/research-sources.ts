/**
 * Research sources end to end against the local database and stand-ins of
 * the Hacker News and Stack Exchange APIs (fetch intercepted; nothing leaves
 * the machine): read_webpage reads an HN thread and an SE question through
 * their APIs with evidence and no contacts, the throttles refuse past their
 * limits without calling, an SE backoff and a throttle violation become
 * waits that fall back to TinyFish (a stand-in) and say so, identical SE
 * requests are answered from memory, Reddit is refused with nothing
 * fetched, a public link that redirects to Reddit or a login wall is
 * refused with nothing of the page used (through TinyFish and read
 * directly), recording Reddit's approval does not enable reading, and a
 * second organization sees none of the first's settings or use.
 *
 *   bun run --conditions=react-server scripts/e2e/research-sources.ts
 *
 * Creates its own organizations ("Research check …") and leaves them
 * behind; resets the shared hackernews/stackexchange quota rows it uses.
 * Refuses a non-local DATABASE_URL.
 */
import { and, eq } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}

const stamp = Date.now();
const KEY = `sk-tinyfish-research-${stamp}`;
type Call = { host: string; path: string };
const calls: Call[] = [];
const hostCalls = (host: string) => calls.filter((call) => call.host === host).length;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

// The Hacker News stand-in: one story, three top-level comments (one deleted).
const t = Math.floor(Date.now() / 1000) - 3_600;
const HN_ITEMS: Record<number, unknown> = {
  9001: { id: 9001, type: "story", by: "ops_person", time: t, score: 120, descendants: 4, kids: [9002, 9003, 9004], title: "Ask HN: How do small agencies handle client invoicing?", text: "We lose a day a month to it.<p>What do you use?" },
  9002: { id: 9002, type: "comment", by: "pg_fan", time: t + 60, parent: 9001, text: "Spreadsheets, sadly. Reach me at founder@acme-agency.example if you build something." },
  9003: { id: 9003, type: "comment", by: "quiet_dev", time: t + 120, parent: 9001, text: "We switched to <a href=\"https://invoicer.example/\">invoicer</a>." },
  9004: { id: 9004, type: "comment", deleted: true, time: t + 180, parent: 9001 },
};
// The Stack Exchange stand-in: each question id answers as the test needs.
let seAnswer: (id: number) => Response = (id) => json(200, {
  items: [{ question_id: id, title: `How do I automate &quot;invoice&quot; reminders? (${id})`, body: "<p>We send 200 invoices a month by hand.</p>", tags: ["automation", "email"], owner: { display_name: "Dana K" }, creation_date: t, link: `https://stackoverflow.com/questions/${id}/how-do-i-automate`, score: 4, answer_count: 1, is_answered: false }],
  has_more: false, quota_max: 300, quota_remaining: 250,
});
// Public links that redirect elsewhere (a shortener or an /out?url= link), followed by TinyFish and by the direct reader alike.
const redirects = new Map<string, string>();
// The TinyFish stand-in reads any page.
const tinyfishFetch = (urls: string[]) => json(200, { results: urls.map((url) => ({ url, final_url: redirects.get(url) ?? url, title: "Read by TinyFish", text: "Thread text as TinyFish saw it. Mail ops@acme-agency.example", links: [] })), errors: [] });

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  calls.push({ host: url.hostname, path: `${url.pathname}${url.search}` });
  if (url.hostname === "hacker-news.firebaseio.com") {
    const id = Number(/\/v0\/item\/(\d+)\.json$/.exec(url.pathname)?.[1]);
    return json(200, HN_ITEMS[id] ?? null);
  }
  if (url.hostname === "api.stackexchange.com") return seAnswer(Number(/\/questions\/(\d+)$/.exec(url.pathname)?.[1]));
  if (url.hostname === "search.tf.test") return json(200, { query: "q", results: [], total_results: 0, page: 0 });
  if (url.hostname === "fetch.tf.test") return tinyfishFetch((JSON.parse(String(init?.body)) as { urls: string[] }).urls);
  // The direct reader (no TinyFish): the redirect, then the page it leads to.
  const redirect = redirects.get(url.toString());
  if (redirect) return new Response(null, { status: 301, headers: { location: redirect } });
  if ([...redirects.values()].includes(url.toString())) return new Response(`<html><title>Elsewhere</title><body>Thread text as read directly. Mail ops@acme-agency.example</body></html>`, { status: 200, headers: { "content-type": "text/html" } });
  // Anything else (Reddit included) must never be asked for.
  return json(599, { error: `unexpected request to ${url.hostname}` });
}) as typeof fetch;

const { db } = await import("@/lib/db");
const { organizations, users, members } = await import("@/lib/auth/schema");
const { runInOrganization } = await import("@/lib/tenancy/scope");
const { providerQuotaState, providerUsage } = await import("@/lib/quota/schema");
const { windowStarts } = await import("@/lib/quota/quota");
const { researchSettings } = await import("@/lib/research/sourcesSchema");
const { inOrg } = await import("@/lib/tenancy/scope");
const { setTinyfishApiBase } = await import("@/services/tinyfish");
const { saveTinyfishSettings } = await import("@/lib/tinyfish/tinyfish.server");
const { runTool } = await import("@/lib/assistant/tools.server");
const { createThread } = await import("@/lib/assistant/threads.server");
const { readHackerNewsThread } = await import("@/lib/research/sources/hackerNews.server");
const { readStackExchangeQuestion } = await import("@/lib/research/sources/stackExchange.server");
const { ResearchSourceWaitError } = await import("@/lib/research/sources/errors");
const settings = await import("@/lib/research/sources/settings.server");
setTinyfishApiBase({ search: "https://search.tf.test", fetch: "https://fetch.tf.test", browser: "https://browser.tf.test" });

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

const SCOPES = [["hackernews:server", "hackernews:api"], ["stackexchange:server", "stackexchange:api"]] as const;
const quotaRow = (index: 0 | 1) => and(eq(providerQuotaState.scopeKey, SCOPES[index][0]), eq(providerQuotaState.product, SCOPES[index][1]));
const state = async (index: 0 | 1) => (await db.select().from(providerQuotaState).where(quotaRow(index)))[0];
const setState = (index: 0 | 1, values: Partial<typeof providerQuotaState.$inferInsert>) => db.update(providerQuotaState).set(values).where(quotaRow(index));
// The rows are this server's, shared by every organization: start from zero.
const resetQuotas = async () => {
  for (const index of [0, 1] as const) await setState(index, { minuteUsed: 0, hourUsed: 0, dayUsed: 0, blockedUntil: null, blockedReason: null });
};
await resetQuotas();

async function organization(label: string) {
  const [org] = await db.insert(organizations).values({ name: `Research check ${label} ${stamp}`, slug: `research-check-${label}-${stamp}` }).returning();
  const [owner] = await db.insert(users).values({ name: `Owner ${label}`, email: `owner-${label}-${stamp}@research-check.test`, emailVerified: true }).returning();
  await db.insert(members).values({ organizationId: org!.id, userId: owner!.id, role: "owner" });
  return { org: org!, owner: owner! };
}
const a = await organization("a");
const b = await organization("b");

await runInOrganization(a.org.id, async () => {
  await saveTinyfishSettings({ key: KEY }, a.owner.id);
  const thread = await createThread(a.owner.id);
  const context = { threadId: thread.id, userId: a.owner.id, ownerText: "find agencies struggling with invoicing" };

  // ------------------------------------------------------------ Hacker News
  const before = calls.length;
  const hn = await runTool("read_webpage", { url: "https://news.ycombinator.com/item?id=9001" }, context);
  const hnCalls = calls.slice(before);
  check("an HN item is read through the API, not the page", hn.ok && /via the Hacker News API/.test(hn.summary) && hnCalls.every((call) => call.host === "hacker-news.firebaseio.com"), hn.summary.slice(0, 160));
  check("the item and its top-level comments are one request each", hnCalls.length === 4 && hnCalls[0]!.path === "/v0/item/9001.json", hnCalls.map((call) => call.path).join(" "));
  check("authors, times and each comment's own link are given", /ops_person \(a pseudonymous username\)/.test(hn.summary) && /\[1\] pg_fan, \d{4}-\d{2}-\d{2} — https:\/\/news\.ycombinator\.com\/item\?id=9002/.test(hn.summary) && !/9004/.test(hn.summary.split("Text:")[1] ?? ""));
  check("it is evidence of a stated need, and its authors are not leads", /not buying intent/.test(hn.summary) && /not leads to contact/.test(hn.summary));
  check("no contacts are offered from a discussion, even an email in a comment", /Contacts on the page: none\./.test(hn.summary) && (hn.data?.contacts as unknown[]).length === 0);
  const evidence = hn.data?.evidence as { url: string; author: string | null; shows: string }[] | undefined;
  check("the evidence lists the item and readable comments by URL", evidence?.length === 3 && evidence[0]!.url === "https://news.ycombinator.com/item?id=9001" && evidence.every((entry) => entry.shows === "a stated need or opinion"), JSON.stringify(evidence?.map((entry) => entry.url)));
  check("links in comments may be followed", hn.summary.includes("https://invoicer.example/"));
  const hnUsage = await db.select().from(providerUsage).where(and(eq(providerUsage.organizationId, a.org.id), eq(providerUsage.provider, "hackernews")));
  check("the requests are in the organization's ledger, settled", hnUsage.length === 2 && hnUsage.every((row) => row.status === "settled") && hnUsage.reduce((sum, row) => sum + (row.usedUnits ?? 0), 0) === 4, `${hnUsage.length} rows`);
  const missing = await runTool("read_webpage", { url: "https://news.ycombinator.com/item?id=424242" }, context);
  check("an item HN does not have is reported, not read another way", !missing.ok && /Hacker News has no item 424242/.test(missing.summary) && hostCalls("fetch.tf.test") === 0);

  // The throttle: 60 a minute for this server.
  await setState(0, { minuteStart: windowStarts(new Date()).minute, minuteUsed: 60 });
  const beforeLimit = hostCalls("hacker-news.firebaseio.com");
  const limited = await caught(readHackerNewsThread(9001));
  check("the HN throttle refuses past 60 a minute without calling", limited instanceof ResearchSourceWaitError && hostCalls("hacker-news.firebaseio.com") === beforeLimit, limited instanceof Error ? limited.message : "");
  const fallback = await runTool("read_webpage", { url: "https://news.ycombinator.com/item?id=9001" }, context);
  check("read_webpage then reads the page through TinyFish and says why", fallback.ok && /via TinyFish \(the Hacker News API is waiting until .* UTC: .*read through TinyFish instead\)/.test(fallback.summary) && hostCalls("hacker-news.firebaseio.com") === beforeLimit, fallback.summary.slice(0, 220));
  check("the TinyFish-read discussion still offers no contacts", /Contacts on the page: none\./.test(fallback.summary) && /pseudonymous/.test(fallback.summary));
  await setState(0, { minuteUsed: 0 });

  // ------------------------------------------------------------ Stack Exchange
  const seBefore = hostCalls("api.stackexchange.com");
  const se = await runTool("read_webpage", { url: "https://stackoverflow.com/questions/5001/how-do-i-automate" }, context);
  check("an SE question is read through the API", se.ok && /via the Stack Exchange API/.test(se.summary) && hostCalls("api.stackexchange.com") === seBefore + 1, se.summary.slice(0, 160));
  const sePath = calls.filter((call) => call.host === "api.stackexchange.com").at(-1)!.path;
  check("it asks for the question with its body on the right site, with no key", sePath === "/2.3/questions/5001?site=stackoverflow.com&filter=withbody", sePath);
  check("title, asker, tags and the stated-problem rule are given", /How do I automate "invoice" reminders\?/.test(se.summary) && /Dana K \(a pseudonymous display name\)/.test(se.summary) && /tags: automation, email/.test(se.summary) && /stated problem, not buying intent/.test(se.summary));
  const seEvidence = se.data?.evidence as { url: string; shows: string }[] | undefined;
  check("the question is the evidence", seEvidence?.length === 1 && seEvidence[0]!.url === "https://stackoverflow.com/questions/5001/how-do-i-automate" && seEvidence[0]!.shows === "a stated problem");
  const again = await runTool("read_webpage", { url: "https://stackoverflow.com/q/5001" }, context);
  check("the same request within a minute is answered from memory", again.ok && hostCalls("api.stackexchange.com") === seBefore + 1);
  const seRows = await db.select().from(providerUsage).where(and(eq(providerUsage.organizationId, a.org.id), eq(providerUsage.provider, "stackexchange")));
  check("one ledger row for one real request, with the quota Stack Exchange reported", seRows.length === 1 && seRows[0]!.status === "settled" && (seRows[0]!.detail as { quotaRemaining?: number }).quotaRemaining === 250);

  // 300 a day for this server.
  await setState(1, { dayStart: windowStarts(new Date()).day, dayUsed: 300 });
  const beforeDay = hostCalls("api.stackexchange.com");
  const daily = await caught(readStackExchangeQuestion({ site: "superuser.com", id: 6001 }));
  check("the SE throttle refuses past 300 a day without calling", daily instanceof ResearchSourceWaitError && /300 a day/.test(daily.message) && hostCalls("api.stackexchange.com") === beforeDay, daily instanceof Error ? daily.message : "");
  await setState(1, { dayUsed: 1 });

  // A backoff: this answer is used, the next request waits.
  seAnswer = (id) => json(200, { items: [{ question_id: id, title: "Backoff question", body: "<p>x</p>", owner: { display_name: "Lee" }, creation_date: t, link: `https://unix.stackexchange.com/questions/${id}` }], quota_remaining: 240, backoff: 30 });
  const withBackoff = await runTool("read_webpage", { url: "https://unix.stackexchange.com/questions/5002/x" }, context);
  const blocked = await state(1);
  check("an answer carrying a backoff is still read", withBackoff.ok && /Backoff question/.test(withBackoff.summary));
  check("the backoff becomes a wait for the whole server", Boolean(blocked?.blockedUntil) && Math.abs(blocked!.blockedUntil!.getTime() - (Date.now() + 30_000)) < 5_000 && /30-second backoff/.test(blocked!.blockedReason ?? ""), `${blocked?.blockedUntil?.toISOString()} ${blocked?.blockedReason}`);
  const beforeWait = hostCalls("api.stackexchange.com");
  const waited = await runTool("read_webpage", { url: "https://askubuntu.com/questions/5003" }, context);
  check("during the backoff SE is not called; the page is read through TinyFish, saying why", waited.ok && hostCalls("api.stackexchange.com") === beforeWait && /via TinyFish \(the Stack Exchange API is waiting until .*30-second backoff; read through TinyFish instead\)/.test(waited.summary), waited.summary.slice(0, 220));
  await setState(1, { blockedUntil: null, blockedReason: null });

  // A throttle violation (HTTP 400, error 502) waits the time it names.
  seAnswer = () => json(400, { error_id: 502, error_name: "throttle_violation", error_message: "too many requests from this IP, more requests available in 7200 seconds" });
  const violation = await caught(readStackExchangeQuestion({ site: "serverfault.com", id: 5004 }));
  const throttled = await state(1);
  check("a throttle violation becomes a wait of the seconds it names", violation instanceof ResearchSourceWaitError && Math.abs(throttled!.blockedUntil!.getTime() - (Date.now() + 7_200_000)) < 5_000);
  const violationRow = (await db.select().from(providerUsage).where(and(eq(providerUsage.organizationId, a.org.id), eq(providerUsage.provider, "stackexchange")))).find((row) => (row.detail as { question?: number }).question === 5004);
  check("the refused request is in the ledger as failed", violationRow?.status === "failed" && /throttle_violation/.test(violationRow.error ?? ""));
  await setState(1, { blockedUntil: null, blockedReason: null });

  // ------------------------------------------------------------ Reddit
  const beforeReddit = calls.length;
  const reddits = await Promise.all(["https://www.reddit.com/r/smallbusiness/comments/abc/invoicing/", "old.reddit.com/r/sales", "https://redd.it/abc123", "https://reddit.com/user/someone"].map((url) => runTool("read_webpage", { url }, context)));
  check("Reddit addresses are refused, with the approval not recorded", reddits.every((result) => !result.ok && result.summary === "Reddit is unavailable to research: its API needs Reddit's approval for this use, and that approval is not recorded (Settings → Lead research → Research sources). Nothing was read from Reddit."), reddits[0]!.summary);
  check("nothing was fetched for Reddit, TinyFish included", calls.length === beforeReddit);

  const view = await settings.saveResearchSources({ redditApproved: true, redditApprovalNote: "Approved by Reddit's data team, ticket 123", redditClientId: "abcDEF123wxyz" }, a.owner.id);
  check("approval is recorded with a note and only the client id's hint", Boolean(view.reddit.approvalRecordedAt) && view.reddit.clientHint === "…wxyz" && view.reddit.approvalNote === "Approved by Reddit's data team, ticket 123" && view.reddit.readerBuilt === false);
  const [stored] = await db.select().from(researchSettings).where(eq(researchSettings.organizationId, a.org.id));
  check("the full client id is never stored", !JSON.stringify(stored).includes("abcDEF123wxyz"));
  const afterApproval = await runTool("read_webpage", { url: "https://www.reddit.com/r/smallbusiness/" }, context);
  check("recording approval does not enable reading Reddit", !afterApproval.ok && afterApproval.summary === "Reddit is unavailable to research: approval recorded; a Reddit reader is not built yet. Nothing was read from Reddit." && calls.length === beforeReddit, afterApproval.summary);
  const tooLong = await caught(settings.saveResearchSources({ redditApprovalNote: "x".repeat(501) }, a.owner.id));
  check("a note over 500 characters is refused", tooLong instanceof settings.ResearchSourcesSettingsError);
  const kept = await settings.saveResearchSources({ redditApprovalNote: "still approved" }, a.owner.id);
  check("saving the note alone keeps the original approval time", kept.reddit.approvalRecordedAt === view.reddit.approvalRecordedAt);

  // A public link that redirects to Reddit or a login wall is refused like a link to one: nothing of the page is returned.
  redirects.set("https://example.com/go/thread", "https://www.reddit.com/r/smallbusiness/comments/abc/invoicing/");
  redirects.set("https://example.com/go/profile", "https://www.linkedin.com/in/someone");
  const redirectRefused = (result: { ok: boolean; summary: string }, host: RegExp, reason: RegExp) => !result.ok && host.test(result.summary) && reason.test(result.summary) && !/Thread text|ops@acme-agency/.test(result.summary);
  const tfReddit = await runTool("read_webpage", { url: "https://example.com/go/thread" }, context);
  const tfWalled = await runTool("read_webpage", { url: "https://example.com/go/profile" }, context);
  check("a link TinyFish followed to Reddit is refused, its page unused", redirectRefused(tfReddit, /www\.reddit\.com/, /Nothing was read from Reddit/), tfReddit.summary.slice(0, 200));
  check("a link TinyFish followed to a login wall is refused, its page unused", redirectRefused(tfWalled, /www\.linkedin\.com/, /needs a login/), tfWalled.summary.slice(0, 200));
  const aView = await settings.researchSourcesView();
  check("A's view shows its own use today", aView.hackerNews.usedToday === 5 && aView.stackExchange.usedToday === 3 && aView.hackerNews.perMinute === 60 && aView.stackExchange.perDay === 300, `${aView.hackerNews.usedToday} ${aView.stackExchange.usedToday}`);
});

// ------------------------------------------------------------ the second organization
await runInOrganization(b.org.id, async () => {
  const view = await settings.researchSourcesView();
  check("B sees none of A's Reddit record", view.reddit.approvalRecordedAt === null && view.reddit.approvalNote === null && view.reddit.clientHint === null && view.reddit.updatedAt === null);
  check("B's own use is zero", view.hackerNews.usedToday === 0 && view.stackExchange.usedToday === 0);
  const rows = await db.select().from(researchSettings).where(inOrg(researchSettings));
  check("B's scoped query finds no settings row", rows.length === 0);
  const thread = await createThread(b.owner.id);
  const before = calls.length;
  const refused = await runTool("read_webpage", { url: "https://www.reddit.com/r/sales/" }, { threadId: thread.id, userId: b.owner.id, ownerText: "x" });
  check("for B, Reddit's approval is not recorded", !refused.ok && /that approval is not recorded/.test(refused.summary) && calls.length === before);

  // B has no TinyFish, so read_webpage reads directly and follows the redirect itself. The direct
  // reader fetches through fetch (intercepted here) when a proxy is configured; make sure it is.
  const proxy = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = proxy || "http://proxy.invalid:1";
  try {
    const directReddit = await runTool("read_webpage", { url: "https://example.com/go/thread" }, { threadId: thread.id, userId: b.owner.id, ownerText: "x" });
    const directWalled = await runTool("read_webpage", { url: "https://example.com/go/profile" }, { threadId: thread.id, userId: b.owner.id, ownerText: "x" });
    const followed = calls.slice(before).some((call) => call.host === "example.com");
    const contacted = calls.slice(before).filter((call) => call.host === "www.reddit.com" || call.host === "www.linkedin.com").map((call) => call.host);
    check("the direct reader stops at a redirect to Reddit or a login wall: neither host is asked for anything", followed && contacted.length === 0, contacted.join(", "));
    check("a link read directly that redirects to Reddit is refused, its page unused", followed && !directReddit.ok && /www\.reddit\.com/.test(directReddit.summary) && /that approval is not recorded/.test(directReddit.summary) && !/Thread text|ops@acme-agency/.test(directReddit.summary), directReddit.summary.slice(0, 200));
    check("a link read directly that redirects to a login wall is refused, its page unused", !directWalled.ok && /www\.linkedin\.com needs a login|leads to www\.linkedin\.com/.test(directWalled.summary) && !/Thread text|ops@acme-agency/.test(directWalled.summary), directWalled.summary.slice(0, 200));
  } finally {
    if (proxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = proxy;
  }
});

await runInOrganization(a.org.id, async () => {
  const withdrawn = await settings.saveResearchSources({ redditApproved: false }, a.owner.id);
  check("withdrawing approval clears its time", withdrawn.reddit.approvalRecordedAt === null);
});

await resetQuotas();
setTinyfishApiBase(null);
globalThis.fetch = realFetch;
console.log(failures ? `\n${failures} check(s) failed` : "\nAll research source checks passed");
process.exit(failures ? 1 : 0);

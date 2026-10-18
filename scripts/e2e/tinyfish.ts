/**
 * TinyFish connection and provider quotas end to end against the local
 * database and a stand-in of TinyFish's three hosts (fetch intercepted for
 * *.tf.test; nothing leaves the machine): the key checked with one search
 * before it is saved and stored encrypted, two organizations saving the same
 * key sharing one quota, the free daily and hourly limits refusing before
 * any call, a 429 and a 402 recorded as waits every sharer honours, fetched
 * pages settling the URLs actually read, a lost answer kept as uncertain,
 * and each organization's ledger seeing only its own calls.
 *
 *   bun run --conditions=react-server scripts/e2e/tinyfish.ts
 *
 * Creates its own organizations ("TinyFish check …") and leaves them behind.
 * Refuses a non-local DATABASE_URL.
 */
import { and, desc, eq } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}

const stamp = Date.now();
const KEY = `sk-tinyfish-check-${stamp}`;
const BAD_KEY = `sk-tinyfish-wrong-${stamp}`;
type Call = { host: string; key: string | null; body: unknown };
const calls: Call[] = [];
let nextSearch: () => Response = () => json(200, { query: "q", results: [{ position: 1, site_name: "acme.example", title: "Acme", snippet: "s", url: "https://acme.example/" }], total_results: 1, page: 0 });
let nextFetch: (urls: string[]) => Response = (urls) => json(200, {
  results: urls.slice(0, -1).map((url) => ({ url, final_url: url, title: "T", text: "body", links: [] })),
  errors: urls.slice(-1).map((url) => ({ url, error: "page_not_found", status: 404 })),
});

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (!url.hostname.endsWith(".tf.test")) return realFetch(input, init);
  const key = new Headers(init?.headers).get("x-api-key");
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  calls.push({ host: url.hostname, key, body });
  if (key === BAD_KEY) return json(401, { error: { code: "INVALID_API_KEY" } });
  if (url.hostname === "search.tf.test") return nextSearch();
  if (url.hostname === "fetch.tf.test") return nextFetch((body as { urls: string[] }).urls);
  return json(404, {});
}) as typeof fetch;

const { db } = await import("@/lib/db");
const { organizations, users, members } = await import("@/lib/auth/schema");
const { runInOrganization } = await import("@/lib/tenancy/scope");
const { tinyfishSettings } = await import("@/lib/tinyfish/schema");
const { providerQuotaState, providerUsage } = await import("@/lib/quota/schema");
const { windowStarts } = await import("@/lib/quota/quota");
const { usedToday } = await import("@/lib/quota/quota.server");
const { setTinyfishApiBase } = await import("@/services/tinyfish");
const tf = await import("@/lib/tinyfish/tinyfish.server");
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

async function organization(label: string) {
  const [org] = await db.insert(organizations).values({ name: `TinyFish check ${label} ${stamp}`, slug: `tinyfish-check-${label}-${stamp}` }).returning();
  const [owner] = await db.insert(users).values({ name: `Owner ${label}`, email: `owner-${label}-${stamp}@tinyfish-check.test`, emailVerified: true }).returning();
  await db.insert(members).values({ organizationId: org!.id, userId: owner!.id, role: "owner" });
  return { org: org!, owner: owner! };
}
const a = await organization("a");
const b = await organization("b");
const scope = tf.keyScopeOf(KEY);
const state = async (product: string) => (await db.select().from(providerQuotaState).where(and(eq(providerQuotaState.scopeKey, scope), eq(providerQuotaState.product, `tinyfish:${product}`))))[0];
const setState = (product: string, values: Partial<typeof providerQuotaState.$inferInsert>) =>
  db.update(providerQuotaState).set(values).where(and(eq(providerQuotaState.scopeKey, scope), eq(providerQuotaState.product, `tinyfish:${product}`)));

// ---------------------------------------------------------------- the key
await runInOrganization(a.org.id, async () => {
  const before = calls.length;
  const refused = await caught(tf.saveTinyfishSettings({ key: BAD_KEY }, a.owner.id));
  check("a key TinyFish rejects is not saved", refused instanceof tf.TinyfishSettingsError && /rejected/.test(refused.message) && !(await tf.tinyfishConnection()));
  const view = await tf.saveTinyfishSettings({ key: KEY, browserMinutesPerDay: 0 }, a.owner.id);
  check("a good key is checked with exactly one search before saving", calls.length - before === 2 && calls.at(-1)!.host === "search.tf.test" && calls.at(-1)!.key === KEY);
  const [row] = await db.select().from(tinyfishSettings).where(eq(tinyfishSettings.organizationId, a.org.id));
  check("the key is stored encrypted, with a hint and its quota scope", Boolean(row?.encryptedKey) && !row!.encryptedKey!.includes(KEY) && row!.keyHint === `…${KEY.slice(-4)}` && row!.keyScope === scope);
  check("the view never carries the key", !JSON.stringify(view).includes(KEY) && view.connected && view.useForWebSearch && view.browserMinutesPerDay === 0);
  const tooMany = await caught(tf.saveTinyfishSettings({ browserMinutesPerDay: 999 }, a.owner.id));
  check("browser minutes outside 0–240 are refused", tooMany instanceof tf.TinyfishSettingsError);
});
await runInOrganization(b.org.id, async () => {
  await tf.saveTinyfishSettings({ key: KEY }, b.owner.id);
  check("a second organization saving the same key gets the same quota scope", (await tf.tinyfishConnection())?.scopeKey === scope);
});

// ---------------------------------------------------------------- search and its limits
await runInOrganization(a.org.id, async () => {
  const hits = await tf.searchWithTinyfish({ query: "dentists in Pune" }, { threadId: null });
  check("a search returns parsed hits", hits.length === 1 && hits[0]!.url === "https://acme.example/");
  const usage = await db.select().from(providerUsage).where(and(eq(providerUsage.organizationId, a.org.id), eq(providerUsage.product, "search"), eq(providerUsage.scopeKey, scope)));
  check("each search is a settled ledger row of one request", usage.length === 2 && usage.every((u) => u.status === "settled" && u.usedUnits === 1), `${usage.length} rows`);

  const hour = windowStarts(new Date()).hour;
  await setState("search", { hourStart: hour, hourUsed: 500 });
  const before = calls.length;
  const wait = await caught(tf.searchWithTinyfish({ query: "more" }));
  check("the free hourly limit refuses before calling TinyFish", wait instanceof tf.TinyfishWaitError && calls.length === before && wait.until.getTime() === hour.getTime() + 3_600_000, wait instanceof Error ? wait.message : "");
  await setState("search", { hourUsed: 0 });
});
await runInOrganization(b.org.id, async () => {
  const s = await state("search");
  check("both organizations' searches counted against the one shared key", (s?.dayUsed ?? 0) >= 3, `day_used ${s?.dayUsed}`);

  nextSearch = () => json(429, { error: { code: "RATE_LIMIT_EXCEEDED" } }, { "retry-after": "40" });
  const limited = await caught(tf.searchWithTinyfish({ query: "x" }));
  const blocked = await state("search");
  check("a 429 becomes a recorded wait of Retry-After", limited instanceof tf.TinyfishWaitError && Math.abs(blocked!.blockedUntil!.getTime() - (Date.now() + 40_000)) < 5_000);
});
await runInOrganization(a.org.id, async () => {
  nextSearch = () => json(200, { results: [] });
  const before = calls.length;
  const waited = await caught(tf.searchWithTinyfish({ query: "x" }));
  check("the other organization sharing the key waits too, without a call", waited instanceof tf.TinyfishWaitError && calls.length === before);
  await setState("search", { blockedUntil: null, blockedReason: null });
});

// ---------------------------------------------------------------- fetch
await runInOrganization(a.org.id, async () => {
  const day0 = (await state("fetch"))?.dayUsed ?? 0;
  const { pages, failures: failed } = await tf.fetchWithTinyfish(["https://a.example/1", "https://a.example/2", "https://a.example/3"]);
  const day1 = (await state("fetch"))!.dayUsed;
  check("fetch returns pages and per-URL failures", pages.length === 2 && failed.length === 1 && failed[0]!.code === "page_not_found");
  check("only the URLs actually read stay counted", day1 - day0 === 2, `${day0} → ${day1}`);

  await setState("fetch", { dayStart: windowStarts(new Date()).day, dayUsed: 999 });
  const before = calls.length;
  const over = await caught(tf.fetchWithTinyfish(["https://a.example/4", "https://a.example/5"]));
  check("the free 1,000 URLs a day refuse a batch that would cross it", over instanceof tf.TinyfishWaitError && calls.length === before && /1000 a day/.test((over as Error).message));
  await setState("fetch", { dayUsed: day1 });

  nextFetch = () => json(402, { error: { code: "FREE_ALLOWANCE_EXHAUSTED" } });
  const exhausted = await caught(tf.fetchWithTinyfish(["https://a.example/6"]));
  const tomorrow = windowStarts(new Date()).day.getTime() + 86_400_000;
  check("a 402 waits until 00:00 UTC", exhausted instanceof tf.TinyfishWaitError && (await state("fetch"))!.blockedUntil!.getTime() === tomorrow);
  await setState("fetch", { blockedUntil: null, blockedReason: null });

  nextFetch = () => {
    throw new TypeError("connection reset");
  };
  const lost = await caught(tf.fetchWithTinyfish(["https://a.example/7", "https://a.example/8"]));
  const [last] = await db.select().from(providerUsage).where(and(eq(providerUsage.organizationId, a.org.id), eq(providerUsage.product, "fetch"))).orderBy(desc(providerUsage.createdAt)).limit(1);
  check("a lost answer is kept as uncertain with its units counted", lost !== null && last?.status === "uncertain" && last.usedUnits === 2, `${last?.status} ${last?.usedUnits}`);
});

// ---------------------------------------------------------------- isolation
await runInOrganization(b.org.id, async () => {
  const fetched = await usedToday("tinyfish", "fetch");
  const rows = await db.select().from(providerUsage).where(eq(providerUsage.organizationId, b.org.id));
  check("B's ledger holds only B's calls", fetched === 0 && rows.every((row) => row.product === "search"), `fetch ${fetched}, rows ${rows.length}`);
  const view = await tf.tinyfishSettingsView();
  check("B's view shows the shared key's use today", view.connected && view.today.fetchedUrls > 0 && view.today.browserMinutes === 0);
});

setTinyfishApiBase(null);
globalThis.fetch = realFetch;
console.log(failures ? `\n${failures} check(s) failed` : "\nAll TinyFish checks passed");
process.exit(failures ? 1 : 0);

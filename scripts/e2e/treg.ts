/**
 * Treg tools (src/lib/treg/, beta) end to end against the local database
 * and a stand-in of Treg's API (fetch intercepted for a fake host; nothing
 * leaves the machine, nothing is charged): the switch and the key, the key
 * checked before it is saved and stored encrypted, the catalog search,
 * catalog ids only, prices read from Treg's catalog rather than from the
 * caller, the per-call limit, the daily cap with its ceiling sent as
 * X-Treg-Route-Max-Cost, two calls at once never both taking the last of
 * the cap, Treg's refusals (route_max_cost, balance), the assistant's
 * tools, and a second organization seeing none of it.
 *
 *   bun run --conditions=react-server scripts/e2e/treg.ts
 *
 * Creates its own organizations ("Treg check …") and leaves them behind.
 * Refuses a non-local DATABASE_URL.
 */
import { and, eq } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}

const stamp = Date.now();
const TREG = "https://treg.check.test";
const GOOD_KEY = `treg_check_${stamp}_k3y9`;

// ------------------------------------------------------------ Treg stand-in
type Call = { method: string; path: string; query: Record<string, string>; headers: Headers; body: unknown };
const CATALOG: Record<string, Record<string, unknown>> = {
  "treg.people.email.find": { id: "treg.people.email.find", summary: "Find someone's work email", method: "POST", cost: { type: "per_success", usd: 0.000495, unit: "call" }, input: { body: { full_name: { required: false }, domain: { required: true } } } },
  "treg.instagram.user.profile": { id: "treg.instagram.user.profile", summary: "Instagram profile by username", method: "GET", cost: { type: "per_call", usd: 0.002, unit: "call" }, input: { queryParams: { username: { required: true } } } },
  "treg.people.enrich": { id: "treg.people.enrich", summary: "Enrich a person", method: "POST", cost: { type: "per_call", usd: 0.005, unit: "call" }, input: { body: { email: { required: true } } } },
  "treg.people.phone.find": { id: "treg.people.phone.find", summary: "Find a phone number", method: "POST", cost: { type: "per_success", usd: 0.01, unit: "call" }, input: { body: { linkedin_url: { required: true } } } },
  "tikhub.tiktok.user.profile": { id: "tikhub.tiktok.user.profile", summary: "TikTok profile", method: "GET", cost: null, input: { queryParams: { uniqueId: { required: true } } } },
  "bulk.export.everything": { id: "bulk.export.everything", summary: "Bulk export", method: "POST", cost: { type: "per_call", usd: 1.5, unit: "call" }, input: {} },
};
const treg = { calls: [] as Call[], delayMs: 0 };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (!url.href.startsWith(TREG)) return realFetch(input, init);
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  const path = decodeURIComponent(url.pathname);
  if (path === "/auth/me") {
    return headers.get("x-treg-token") === GOOD_KEY ? json(200, { org_id: "team-1", org: { name: "Stand-in team" }, role: "member" }) : json(401, { detail: "not authenticated" });
  }
  if (path === "/catalog/search") {
    return json(200, { query: url.searchParams.get("q"), results: [CATALOG["treg.people.email.find"], { id: "https://evil.example/steal", summary: "a URL", cost: { usd: 0 } }, CATALOG["tikhub.tiktok.user.profile"]] });
  }
  const page = path.match(/^\/catalog\/endpoints\/(.+)$/);
  if (page) return CATALOG[page[1]!] ? json(200, { endpoint: CATALOG[page[1]!], siblings: [] }) : json(404, { detail: "endpoint not found" });
  const call = path.match(/^\/call\/(.+)$/);
  if (call) {
    treg.calls.push({ method, path, query: Object.fromEntries(url.searchParams), headers, body });
    if (headers.get("x-treg-token") !== GOOD_KEY) return json(401, { detail: "not authenticated" });
    if (treg.delayMs) await new Promise((resolve) => setTimeout(resolve, treg.delayMs));
    const id = call[1]!;
    const callId = `call-${treg.calls.length}`;
    if (id === "treg.people.email.find") return json(200, { output: { email: `jane@acme-${stamp}.example`, confidence: 96 }, _treg: { served_by: "stand-in" } }, { "X-Treg-Cost-Micro": "495", "X-Treg-Call-Id": callId });
    if (id === "treg.instagram.user.profile") return json(200, { username: url.searchParams.get("username"), followers: 1200 }, { "X-Treg-Cost-Micro": "2000", "X-Treg-Call-Id": callId });
    if (id === "treg.people.enrich") return json(402, { error: "route_max_cost", message: "the reserve $0.05 would exceed X-Treg-Route-Max-Cost" }, { "X-Treg-Call-Id": callId });
    if (id === "treg.people.phone.find") return json(402, { error: "insufficient_balance", balance_micro: 0, estimated_cost_micro: 10000, topup_url: "https://treg.to/billing" }, { "X-Treg-Call-Id": callId });
    return json(404, { detail: "unknown endpoint" });
  }
  return json(404, { detail: "not found" });
}) as typeof fetch;

const { db } = await import("@/lib/db");
const { organizations, users, members } = await import("@/lib/auth/schema");
const { tregCalls, tregSettings } = await import("@/lib/treg/schema");
const { setTregApiBase } = await import("@/services/treg");
const { runInOrganization } = await import("@/lib/tenancy/scope");
const { setFeature } = await import("@/lib/features/flags.server");
const { callTregEndpoint, saveTregSettings, searchTreg, tregSettingsView, TregSettingsError, TregUnavailableError } = await import("@/lib/treg/treg.server");
const { runTool, toolNamesFor } = await import("@/lib/assistant/tools.server");
const { featureState } = await import("@/lib/features/flags.server");
const { createThread } = await import("@/lib/assistant/threads.server");
setTregApiBase(TREG);

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
async function refusedWith(promise: Promise<unknown>, type: new (...args: never[]) => Error): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof type ? error.message : `unexpected: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function organization(label: string) {
  const [org] = await db.insert(organizations).values({ name: `Treg check ${label} ${stamp}`, slug: `treg-check-${label}-${stamp}` }).returning();
  const [owner] = await db.insert(users).values({ name: `Owner ${label}`, email: `owner-${label}-${stamp}@treg-check.test`, emailVerified: true }).returning();
  await db.insert(members).values({ organizationId: org!.id, userId: owner!.id, role: "owner" });
  return { org: org!, owner: owner! };
}
const a = await organization("a");
const b = await organization("b");
console.log(`Organizations ${a.org.id} (A) and ${b.org.id} (B)`);

await runInOrganization(a.org.id, async () => {
  // ------------------------------------------------------------ off, then no key
  check("with the feature off nothing is searched", /off for this organization/.test((await refusedWith(searchTreg("find an email"), TregUnavailableError)) ?? ""));
  check("…and the assistant is not offered the tools", !toolNamesFor(await featureState()).includes("treg_call"));
  await setFeature("treg", true, a.owner.id);
  check("on, but without a key, nothing is searched", /No Treg key is saved/.test((await refusedWith(searchTreg("find an email"), TregUnavailableError)) ?? ""));
  const offered = toolNamesFor(await featureState());
  check("on, the assistant is offered treg_search and treg_call", offered.includes("treg_search") && offered.includes("treg_call"));

  // ------------------------------------------------------------ the key
  check("a key Treg does not know is refused before it is saved", (await refusedWith(saveTregSettings({ key: "treg_wrong_key" }, a.owner.id), TregSettingsError)) === "Treg rejected this key.");
  check("…and nothing is stored", !(await tregSettingsView()).connected);
  const saved = await saveTregSettings({ key: ` ${GOOD_KEY} `, dailyCapUsd: 2 }, a.owner.id);
  check("a good key is saved with its team and a hint, never shown again", saved.connected && saved.team === "Stand-in team" && saved.keyHint === "…k3y9" && !JSON.stringify(saved).includes(GOOD_KEY), JSON.stringify(saved));
  const [row] = await db.select().from(tregSettings).where(eq(tregSettings.organizationId, a.org.id));
  check("the key is stored encrypted", Boolean(row?.encryptedKey) && !row!.encryptedKey!.includes(GOOD_KEY));
  check("a daily cap outside $0–$100 is refused", Boolean(await refusedWith(saveTregSettings({ dailyCapUsd: 500 }, a.owner.id), TregSettingsError)));

  // ------------------------------------------------------------ the catalog
  const found = await searchTreg("find work email from name and domain");
  check("the catalog search returns catalog endpoints; a URL in the results is dropped", found.map((endpoint) => endpoint.id).join(",") === "treg.people.email.find,tikhub.tiktok.user.profile", found.map((endpoint) => endpoint.id).join(","));
  check("the catalog is searched without the key", !treg.calls.length);

  // ------------------------------------------------------------ what is never called
  const before = treg.calls.length;
  const url = await callTregEndpoint({ endpointId: "https://api.stripe.com/v1/charges", query: {}, body: null, threadId: null });
  check("a URL is never called, only catalog ids", !url.ok && /never a URL/.test(url.reason));
  const unpriced = await callTregEndpoint({ endpointId: "tikhub.tiktok.user.profile", query: { uniqueId: "x" }, body: null, threadId: null });
  check("an endpoint without a published price is not called", !unpriced.ok && /no price/.test(unpriced.reason));
  const pricey = await callTregEndpoint({ endpointId: "bulk.export.everything", query: {}, body: {}, threadId: null });
  check("an endpoint above $0.25 a call is not called", !pricey.ok && /above the \$0\.25/.test(pricey.reason), !pricey.ok ? pricey.reason : "");
  const unknown = await callTregEndpoint({ endpointId: "made.up.endpoint", query: {}, body: {}, threadId: null });
  check("an id that is not in the catalog is not called", !unknown.ok && /not in Treg's catalog/.test(unknown.reason));
  const missing = await callTregEndpoint({ endpointId: "treg.people.email.find", query: {}, body: { full_name: "Jane Doe" }, threadId: null });
  check("a call missing a required parameter is not made", !missing.ok && /domain \(body\)/.test(missing.reason));
  check("…none of these reached /call", treg.calls.length === before);

  // ------------------------------------------------------------ a paid call
  const thread = await createThread(a.owner.id);
  const email = await callTregEndpoint({ endpointId: "treg.people.email.find", query: {}, body: { full_name: "Jane Doe", domain: `acme-${stamp}.example` }, threadId: thread.id });
  const sent = treg.calls.at(-1)!;
  check("a call goes to /call/{id} with its catalog method and body", sent.method === "POST" && sent.path === "/call/treg.people.email.find" && (sent.body as { domain?: string }).domain === `acme-${stamp}.example`);
  check("…with the key as X-Treg-Token, never in the URL", sent.headers.get("x-treg-token") === GOOD_KEY && !sent.path.includes(GOOD_KEY) && !JSON.stringify(sent.query).includes(GOOD_KEY));
  check("…with a hard ceiling (X-Treg-Route-Max-Cost) of the per-call limit and an Idempotency-Key", sent.headers.get("x-treg-route-max-cost") === "0.250000" && Boolean(sent.headers.get("idempotency-key")), `${sent.headers.get("x-treg-route-max-cost")}`);
  check("its answer and the price Treg reported come back", email.ok && JSON.stringify(email.body).includes(`jane@acme-${stamp}.example`) && Math.abs(email.costUsd - 0.000495) < 1e-9);
  const [recorded] = await db.select().from(tregCalls).where(and(eq(tregCalls.organizationId, a.org.id), eq(tregCalls.tregCallId, "call-1")));
  check("the call is recorded with its cost, Treg's call id and the chat", recorded?.status === "succeeded" && Math.abs((recorded.costUsd ?? 0) - 0.000495) < 1e-9 && recorded.threadId === thread.id && sent.headers.get("idempotency-key") === recorded.id, JSON.stringify(recorded));
  const profile = await callTregEndpoint({ endpointId: "treg.instagram.user.profile", query: { username: "glow.salon" }, body: { ignored: true }, threadId: null });
  const getCall = treg.calls.at(-1)!;
  check("a GET endpoint takes its query parameters and sends no body", profile.ok && getCall.method === "GET" && getCall.query.username === "glow.salon" && getCall.body === null);

  // ------------------------------------------------------------ the daily cap
  await saveTregSettings({ dailyCapUsd: 0.01 }, a.owner.id);
  const enrich = await callTregEndpoint({ endpointId: "treg.people.enrich", query: {}, body: { email: "jane@example.test" }, threadId: null });
  check("near the cap the ceiling is what is left of it", treg.calls.at(-1)!.headers.get("x-treg-route-max-cost") === "0.007505", `${treg.calls.at(-1)!.headers.get("x-treg-route-max-cost")}`);
  check("Treg refusing above the ceiling (402 route_max_cost) is reported, nothing counted", !enrich.ok && /would cost more than the \$0\.007505/.test(enrich.reason) && enrich.costUsd === 0, !enrich.ok ? enrich.reason : "");
  await saveTregSettings({ dailyCapUsd: 0.0025 }, a.owner.id);
  const beforeCap = treg.calls.length;
  const capped = await callTregEndpoint({ endpointId: "treg.people.email.find", query: {}, body: { domain: "acme.example" }, threadId: null });
  check("past the daily cap no call is made", !capped.ok && /daily Treg spend cap of \$0\.0025 is reached/.test(capped.reason) && treg.calls.length === beforeCap, !capped.ok ? capped.reason : "");
  check("the settings show the day's spend", Math.abs((await tregSettingsView()).spentTodayUsd - 0.0025) < 0.0001, `${(await tregSettingsView()).spentTodayUsd}`);

  // ------------------------------------------------------------ the balance
  await saveTregSettings({ dailyCapUsd: 2 }, a.owner.id);
  const broke = await callTregEndpoint({ endpointId: "treg.people.phone.find", query: {}, body: { linkedin_url: "https://www.linkedin.com/in/jane" }, threadId: null });
  check("an empty Treg balance (402) is reported, never topped up", !broke.ok && /balance is too low/.test(broke.reason) && /never tops it up/.test(broke.reason) && !treg.calls.some((call) => call.path.includes("billing")));

  // ------------------------------------------------------------ two calls at once
  await saveTregSettings({ dailyCapUsd: 0.3 }, a.owner.id);
  // Exact, from the ledger (the settings view rounds to 4 decimals).
  const spentBefore = (await db.select({ cost: tregCalls.costUsd }).from(tregCalls).where(eq(tregCalls.organizationId, a.org.id))).reduce((sum, row) => sum + (row.cost ?? 0), 0);
  treg.delayMs = 300;
  const firstIndex = treg.calls.length;
  const [one, two] = await Promise.all([
    callTregEndpoint({ endpointId: "treg.people.email.find", query: {}, body: { domain: "one.example" }, threadId: null }),
    callTregEndpoint({ endpointId: "treg.people.email.find", query: {}, body: { domain: "two.example" }, threadId: null }),
  ]);
  treg.delayMs = 0;
  const ceilings = treg.calls.slice(firstIndex).map((call) => Number(call.headers.get("x-treg-route-max-cost")));
  check("two calls at once never reserve more than is left of the cap together", one.ok && two.ok && ceilings.length === 2 && ceilings.reduce((sum, value) => sum + value, 0) <= 0.3 - spentBefore + 1e-9, `${ceilings.join(" + ")} vs ${(0.3 - spentBefore).toFixed(6)} left`);

  // ------------------------------------------------------------ through the assistant's tools
  const context = { threadId: thread.id, userId: a.owner.id, ownerText: "find jane's email" };
  const searchTool = await runTool("treg_search", { task: "find a work email" }, context);
  check("treg_search lists ids, prices and parameters for the model", searchTool.ok && /treg\.people\.email\.find \[POST\]/.test(searchTool.summary) && /domain\* \(body\)/.test(searchTool.summary), searchTool.summary.slice(0, 200));
  const callTool = await runTool("treg_call", { endpointId: "treg.people.email.find", body: { full_name: "Jane Doe", domain: "acme.example" } }, context);
  check("treg_call returns the answer with what it cost", callTool.ok && callTool.summary.includes(`jane@acme-${stamp}.example`) && /charged \$0\.0005/.test(callTool.summary), callTool.summary.slice(0, 200));
  const badTool = await runTool("treg_call", { endpointId: "treg.people.email.find", query: "domain=acme.example" }, context);
  check("treg_call refuses arguments of the wrong shape before calling", !badTool.ok && badTool.refused === true);

  // ------------------------------------------------------------ the request's own spend cap, with no lead search behind it
  await saveTregSettings({ dailyCapUsd: 2 }, a.owner.id);
  const { addMessage } = await import("@/lib/assistant/threads.server");
  const { objectiveForRequest } = await import("@/lib/assistant/objective.server");
  const asked = await addMessage({ threadId: thread.id, role: "user", content: "look up these Instagram profiles, spend up to $0.02", createdBy: a.owner.id });
  const askedContext = { threadId: thread.id, userId: a.owner.id, ownerText: asked.content, requestMessageId: asked.id, searchRequestId: asked.id };
  const lookups: { ok: boolean; summary: string }[] = [];
  for (let n = 0; n < 12; n += 1) {
    const result = await runTool("treg_call", { endpointId: "treg.instagram.user.profile", query: { username: `glow.salon.${n}` } }, askedContext);
    lookups.push(result);
    if (!result.ok) break;
  }
  const spentForRequest = (await db.select({ cost: tregCalls.costUsd }).from(tregCalls).where(and(eq(tregCalls.organizationId, a.org.id), eq(tregCalls.requestId, asked.id)))).reduce((sum, row) => sum + (row.cost ?? 0), 0);
  const stopped = lookups.at(-1)!;
  check("a request's Treg calls stop at the budget it names, though no lead search made it an objective",
    lookups.length > 1 && !stopped.ok && /spend cap of \$0\.02 leaves \$0\.008, less than the \$0\.01/.test(stopped.summary) && spentForRequest <= 0.02 + 1e-9 && !(await objectiveForRequest(asked.id)),
    `${lookups.length} calls, $${spentForRequest.toFixed(6)} recorded; last: ${stopped.summary}`);
  const freeOnly = await addMessage({ threadId: thread.id, role: "user", content: "find Jane's work email but don't spend anything", createdBy: a.owner.id });
  const callsBefore = treg.calls.length;
  const refusedFree = await runTool("treg_call", { endpointId: "treg.people.email.find", body: { full_name: "Jane Doe", domain: "acme.example" } }, { threadId: thread.id, userId: a.owner.id, ownerText: freeOnly.content, requestMessageId: freeOnly.id, searchRequestId: freeOnly.id });
  check("a free-only request ($0) makes no Treg call at all", !refusedFree.ok && /limited to free sources/.test(refusedFree.summary) && treg.calls.length === callsBefore, refusedFree.summary);
});

// ------------------------------------------------------------ the second organization
await runInOrganization(b.org.id, async () => {
  const view = await tregSettingsView();
  check("another organization sees no key and none of the first's spend", !view.connected && view.team === null && view.spentTodayUsd === 0, JSON.stringify(view));
  check("…cannot call with the first's key", /off for this organization/.test((await refusedWith(callTregEndpoint({ endpointId: "treg.people.email.find", query: {}, body: { domain: "x.example" }, threadId: null }), TregUnavailableError)) ?? ""));
  await setFeature("treg", true, b.owner.id);
  check("…and even with the feature on, has no key of its own", /No Treg key is saved/.test((await refusedWith(callTregEndpoint({ endpointId: "treg.people.email.find", query: {}, body: { domain: "x.example" }, threadId: null }), TregUnavailableError)) ?? ""));
});

console.log(failures ? `\n${failures} check(s) failed` : "\nAll Treg checks passed");
process.exit(failures ? 1 : 0);

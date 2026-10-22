/**
 * Included services end to end against the local database, with every
 * provider a stand-in (fetch intercepted for *.managed.test and
 * api.anthropic.com; nothing leaves the machine):
 *
 * - a new workspace with no keys of its own runs on the platform's
 *   credentials (TinyFish, Tavily, AI on the Anthropic engine);
 * - a workspace with its own saved keys keeps them, and one whose keys
 *   predate the migration is moved to "My own provider" by it;
 * - a failing own key is that key's error: the platform's key is never
 *   called for it and nothing is counted as Included;
 * - an own-provider workspace cannot reach the Included AI engine by naming
 *   its connection id;
 * - every call is attributed (credential_source) on its ledger row;
 * - truly parallel reservations cannot pass the workspace allowance or the
 *   platform budget;
 * - the views a customer reads never carry the platform's key or model.
 *
 *   bun run --conditions=react-server scripts/e2e/managed-saas.ts
 *
 * Needs the managed-saas migration (bun scripts/add-managed-saas.ts). Creates
 * its own organizations ("Managed check …"), removes the platform
 * credentials it stored when it ends, and refuses a non-local DATABASE_URL.
 */
import { and, eq } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}

const stamp = Date.now();
const PLATFORM = { tinyfish: `tf-platform-${stamp}`, tavily: `tvly-platform-${stamp}`, anthropic: `sk-ant-platform-${stamp}` };
const OWN = { tinyfish: `tf-own-${stamp}`, tavily: `tvly-own-${stamp}`, badTinyfish: `tf-own-bad-${stamp}` };

type Call = { host: string; key: string | null; path: string };
const calls: Call[] = [];
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const anthropicReply: () => Response = () => json(200, {
  id: `msg_${stamp}`, type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: "tool_use", stop_sequence: null,
  content: [{ type: "tool_use", id: "toolu_1", name: "classify", input: { label: "interested" } }],
  usage: { input_tokens: 1200, output_tokens: 300 },
});

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = input instanceof Request ? input : null;
  const url = new URL(request ? request.url : String(input));
  const headers = new Headers(init?.headers ?? request?.headers);
  if (url.hostname === "api.anthropic.com") {
    calls.push({ host: url.hostname, key: headers.get("x-api-key"), path: url.pathname });
    if (url.pathname.startsWith("/v1/models")) return json(200, { data: [], has_more: false, first_id: null, last_id: null });
    return anthropicReply();
  }
  if (!url.hostname.endsWith(".managed.test")) return realFetch(input, init);
  const key = headers.get("x-api-key") ?? headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  calls.push({ host: url.hostname, key, path: url.pathname });
  if (key === OWN.badTinyfish) return json(401, { error: { code: "INVALID_API_KEY" } });
  if (url.hostname === "search.managed.test") {
    return json(200, { query: "q", results: [{ position: 1, site_name: "acme.example", title: "Acme", snippet: "s", url: "https://acme.example/" }], total_results: 1, page: 0 });
  }
  if (url.hostname === "tavily.managed.test") return json(200, { results: [{ url: "https://acme.example/", title: "Acme", content: "Acme dental" }] });
  return json(404, {});
}) as typeof fetch;

const { db } = await import("@/lib/db");
const { organizations, users, members } = await import("@/lib/auth/schema");
const { runInOrganization } = await import("@/lib/tenancy/scope");
const { tinyfishSettings } = await import("@/lib/tinyfish/schema");
const { providerUsage } = await import("@/lib/quota/schema");
const { providerCredentialModes } = await import("@/lib/managed/schema");
const { setTinyfishApiBase } = await import("@/services/tinyfish");
const { setTavilyApiBase } = await import("@/services/tavily");
const { encryptIntegrationCredential } = await import("@/lib/integrations/credentials");
const tf = await import("@/lib/tinyfish/tinyfish.server");
const tavily = await import("@/lib/tavily/tavily.server");
const { generalWebSearch } = await import("@/lib/discovery/webSearch.server");
const store = await import("@/lib/managed/store.server");
const modes = await import("@/lib/managed/modes.server");
const { setAllowanceOverridesForTests, workspaceAllowances } = await import("@/lib/managed/usage.server");
const { completeStructured } = await import("@/lib/ai/server/structuredCompletion");
const { getAiConnection, getAiCredentials } = await import("@/lib/ai/connections");
const { saveByokSettings, getByokSettings, getOwnByokSettings } = await import("@/lib/ai/byok");
setTinyfishApiBase({ search: "https://search.managed.test", fetch: "https://fetch.managed.test", browser: "https://browser.managed.test" });
setTavilyApiBase("https://tavily.managed.test");

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
  const [org] = await db.insert(organizations).values({ name: `Managed check ${label} ${stamp}`, slug: `managed-check-${label}-${stamp}` }).returning();
  const [owner] = await db.insert(users).values({ name: `Owner ${label}`, email: `owner-${label}-${stamp}@managed-check.test`, emailVerified: true }).returning();
  await db.insert(members).values({ organizationId: org!.id, userId: owner!.id, role: "owner" });
  return { org: org!, owner: owner! };
}
const passThrough = async () => undefined;
const sourcesOf = async (organizationId: string, provider: string) =>
  (await db.select({ source: providerUsage.credentialSource, status: providerUsage.status }).from(providerUsage)
    .where(and(eq(providerUsage.organizationId, organizationId), eq(providerUsage.provider, provider))));

const included = await organization("included");
const own = await organization("own");
const upgraded = await organization("upgraded");
const second = await organization("second");

try {
  // ------------------------------------------------------------ the platform's keys (an operator stored them)
  for (const [key, apiKey] of Object.entries(PLATFORM) as [keyof typeof PLATFORM, string][]) {
    await store.storePlatformCredential(key, { apiKey }, { userId: null, verify: passThrough });
  }
  await store.saveManagedAiSettings({ engine: "anthropic", defaultModel: { provider: "anthropic", modelId: "claude-sonnet-5-5" } }, null);
  const statuses = await store.listPlatformCredentialStatus();
  check("stored platform credentials are listed with a masked hint only", statuses.filter((s) => s.stored).length === 3 && !JSON.stringify(statuses).includes(PLATFORM.tinyfish) && statuses.find((s) => s.key === "tavily")!.hints.apiKey === `…${PLATFORM.tavily.slice(-4)}`);

  // ------------------------------------------------------------ an own key saved in settings, and one from before the migration
  await runInOrganization(own.org.id, async () => {
    await tf.saveTinyfishSettings({ key: OWN.tinyfish }, own.owner.id);
    await tavily.saveTavilySettings({ key: OWN.tavily }, own.owner.id);
  });
  await db.insert(tinyfishSettings).values({ organizationId: upgraded.org.id, encryptedKey: encryptIntegrationCredential(OWN.badTinyfish), keyHint: "…bad", keyScope: tf.keyScopeOf(OWN.badTinyfish) });
  const migrate = Bun.spawnSync(["bun", "scripts/add-managed-saas.ts"], { env: process.env, stdout: "pipe", stderr: "pipe" });
  check("the migration runs again without error", migrate.exitCode === 0, migrate.stderr.toString().slice(0, 200));
  const [upgradedMode] = await db.select().from(providerCredentialModes).where(and(eq(providerCredentialModes.organizationId, upgraded.org.id), eq(providerCredentialModes.service, "tinyfish")));
  check("an organization whose key predates the migration is put on My own provider by it", upgradedMode?.mode === "own" && /before Included/.test(upgradedMode.reason ?? ""));
  const [ownMode] = await db.select().from(providerCredentialModes).where(and(eq(providerCredentialModes.organizationId, own.org.id), eq(providerCredentialModes.service, "tinyfish")));
  check("saving a key of its own records My own provider", ownMode?.mode === "own");
  check("the migration leaves workspaces without keys on no explicit choice", (await db.select().from(providerCredentialModes).where(eq(providerCredentialModes.organizationId, included.org.id))).length === 0);

  // ------------------------------------------------------------ resolution
  await runInOrganization(included.org.id, async () => {
    const connection = await tf.tinyfishConnection();
    check("a new workspace with no keys gets the platform's TinyFish key", connection?.source === "managed" && connection.key === PLATFORM.tinyfish && connection.browserMinutesPerDay === 0);
    check("…and the platform's Tavily key", (await tavily.tavilyConnection())?.source === "managed");
    const view = await tf.tinyfishSettingsView();
    const tavilyView = await tavily.tavilySettingsView();
    check("the workspace's settings show Included, never the platform's key or hint", view.included === true && view.keyHint === null && tavilyView.included === true && tavilyView.keyHint === null && !JSON.stringify([view, tavilyView]).includes(PLATFORM.tinyfish.slice(-4)));
  });
  await runInOrganization(own.org.id, async () => {
    const connection = await tf.tinyfishConnection();
    check("a workspace with its own key keeps its own", connection?.source === "own" && connection.key === OWN.tinyfish);
    check("…for Tavily too", (await tavily.tavilyConnection())?.key === OWN.tavily);
  });

  // ------------------------------------------------------------ attribution
  await runInOrganization(included.org.id, () => tf.searchWithTinyfish({ query: "dentists in Pune" }));
  await runInOrganization(own.org.id, () => tf.searchWithTinyfish({ query: "dentists in Pune" }));
  check("an Included search is recorded as managed", (await sourcesOf(included.org.id, "tinyfish")).every((row) => row.source === "managed"));
  check("an own-key search is recorded as own", (await sourcesOf(own.org.id, "tinyfish")).every((row) => row.source === "own"));
  check("each search went out with its own workspace's key", calls.filter((c) => c.host === "search.managed.test").slice(-2).map((c) => c.key).join(",") === `${PLATFORM.tinyfish},${OWN.tinyfish}`);

  // ------------------------------------------------------------ a failing own key never falls back
  const before = calls.length;
  const refused = await runInOrganization(upgraded.org.id, () => caught(tf.searchWithTinyfish({ query: "plumbers" })));
  const sent = calls.slice(before);
  check("a failing own key is that key's error", refused instanceof Error && /401|INVALID|rejected/i.test((refused as Error).message), refused instanceof Error ? refused.message : "no error");
  check("…the platform's key is not tried for it", sent.length === 1 && sent[0]!.key === OWN.badTinyfish);
  check("…and nothing is counted as Included for it", (await sourcesOf(upgraded.org.id, "tinyfish")).every((row) => row.source === "own"));

  // ------------------------------------------------------------ AI on the Included Anthropic engine
  const schema = { type: "object", properties: { label: { type: "string" } }, required: ["label"], additionalProperties: false };
  const ask = () => completeStructured({ timeoutMs: 10_000, systemPrompt: "Sort the reply.", userPrompt: "Yes please, send details.", maxOutputTokens: 500, jsonSchema: schema, schemaName: "classify" });
  const answer = await runInOrganization(included.org.id, ask);
  const anthropicCalls = calls.filter((c) => c.host === "api.anthropic.com" && c.path.startsWith("/v1/messages"));
  check("an Included workspace's AI runs on the platform's Anthropic key", JSON.parse(answer.text).label === "interested" && anthropicCalls.length === 1 && anthropicCalls[0]!.key === PLATFORM.anthropic);
  const [aiRow] = await db.select().from(providerUsage).where(and(eq(providerUsage.organizationId, included.org.id), eq(providerUsage.provider, "ai")));
  check("the AI call is one managed ledger row with an estimated cost", aiRow?.credentialSource === "managed" && aiRow.status === "settled" && Number(aiRow.costUsd) > 0 && aiRow.detail?.costEstimated === true, `${aiRow?.costUsd} ${JSON.stringify(aiRow?.detail)}`);
  // The own workspace chooses My own provider for AI too, and has no AI connection yet.
  await runInOrganization(own.org.id, () => modes.setServiceMode("ai", "own", own.owner.id));
  const ownAi = await runInOrganization(own.org.id, () => caught(ask()));
  check("an own-provider workspace without an AI connection is not served by the platform's engine", ownAi instanceof Error && /Connect an AI provider/.test(ownAi.message) && calls.filter((c) => c.host === "api.anthropic.com" && c.path.startsWith("/v1/messages")).length === 1);
  await runInOrganization(own.org.id, async () => {
    const forged = await caught(saveByokSettings({ ...(await getOwnByokSettings()), connectionId: "included-ai" }));
    check("an own-provider workspace cannot select the Included engine by its id", forged instanceof Error && !(await getAiConnection("included-ai")) && !(await getAiCredentials("included-ai")));
  });
  await runInOrganization(included.org.id, async () => {
    const own = await getOwnByokSettings();
    check("an Included workspace's own settings, the ones the browser reads, carry no engine or model", own.connectionId === null && own.defaultModel === null && (await getByokSettings()).defaultModel?.modelId === "claude-sonnet-5-5");
  });

  // ------------------------------------------------------------ allowances under truly parallel work
  await db.delete(providerUsage).where(eq(providerUsage.provider, "tinyfish"));
  setAllowanceOverridesForTests({ tinyfish_search: { workspace: 3, platform: 5 }, tavily_search: { workspace: 2, platform: 100 } });
  await runInOrganization(second.org.id, async () => check("a second new workspace is Included too", (await tf.tinyfishConnection())?.source === "managed"));
  const burst = (orgId: string) => Promise.all(Array.from({ length: 8 }, (_, i) => runInOrganization(orgId, () => caught(tf.searchWithTinyfish({ query: `burst ${i}` })))));
  const first = await burst(included.org.id);
  check("8 parallel searches in one workspace: exactly its allowance of 3 go through", first.filter((e) => e === null).length === 3, `${first.filter((e) => e === null).length} succeeded`);
  check("…the rest are refused with the workspace's allowance, before any call", first.filter((e) => e instanceof tf.TinyfishWaitError && /allowance|used up/.test((e as Error).message)).length === 5);
  const both = await Promise.all([burst(included.org.id), burst(second.org.id)]);
  const secondOk = both[1].filter((e) => e === null).length;
  check("parallel bursts in two workspaces stop at the platform budget of 5", both[0].every((e) => e !== null) && secondOk === 2, `${secondOk} succeeded in the second`);
  const managedRows = (await db.select().from(providerUsage).where(and(eq(providerUsage.provider, "tinyfish"), eq(providerUsage.credentialSource, "managed"))));
  check("the ledger holds exactly the 5 reserved searches", managedRows.length === 5 && managedRows.every((row) => row.status === "settled"));
  const tavilyBurst = await Promise.all(Array.from({ length: 6 }, (_, i) => runInOrganization(included.org.id, () => caught(generalWebSearch({ query: `tavily ${i}` }, {})))));
  // TinyFish is on for web search, so the assistant's search uses TinyFish; its allowance is used up.
  check("the assistant's searches respect the used-up allowance too", tavilyBurst.every((e) => e instanceof Error));
  const views = await runInOrganization(included.org.id, () => workspaceAllowances(["tinyfish_search", "ai_usd"]));
  check("the workspace sees what is left and when it resets, never the platform's figures", views[0]!.remaining === 0 && views[0]!.limit === 3 && Boolean(views[0]!.resetsAt) && views[1]!.used > 0 && !JSON.stringify(views).includes("platform"));
} finally {
  setAllowanceOverridesForTests({});
  for (const key of ["tinyfish", "tavily", "anthropic"] as const) await store.removePlatformCredential(key);
  await store.saveManagedAiSettings({ engine: null }, null);
  modes.clearServiceModeCache();
}

console.log(failures ? `\n✗ ${failures} failure(s)` : "\n✓ all managed SaaS checks pass");
process.exit(failures ? 1 : 0);

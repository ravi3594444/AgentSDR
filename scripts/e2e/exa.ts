/** Exa HTTP stand-in + real app tools/database + both harnesses. No outside providers or messages. */
import { mock } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (!/^postgres(?:ql)?:\/\/[^/]+@(localhost|127\.0\.0\.1):\d+\/agentsdr_native$/.test(process.env.DATABASE_URL ?? "")) throw new Error("Requires disposable local agentsdr_native database");
process.env.GEOCODER_URL = "off";
const root = resolve(import.meta.dir, "../..");
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("External network refused in the Exa check");
  return realFetch(input, init);
}) as typeof fetch;
// Keep the real public-address guard, with deterministic DNS; never contact this website.
const pages = await import("@/lib/discovery/websiteContacts.server");
const assertPublicPage = pages.assertPublicPageUrl;
mock.module(join(root, "src/lib/discovery/websiteContacts.server.ts"), () => ({ ...pages,
  assertPublicPageUrl: (url: string) => assertPublicPage(url, { resolve: async () => [{ address: "93.184.216.34", family: 4 }] }),
}));
let apiCalls = 0;
const steps = [
  { tool: "exa_search", arguments: JSON.stringify({ query: "Independent manufacturing business owners with public contact details" }) },
  { tool: "exa_read", arguments: JSON.stringify({ urls: ["https://exa-prospect.example/about"] }) },
  { tool: "add_contacts", arguments: JSON.stringify({ contacts: [{ name: "Priya", email: "priya@exa-prospect.example" }], listName: "Exa research" }) },
];
mock.module(join(root, "src/lib/ai/server/structuredCompletion.ts"), () => ({ completeStructured: async (input: { schemaName: string; accept: (text: string) => void }) => {
  if (input.schemaName !== "assistant_reply") throw new Error(`Unexpected AI stage ${input.schemaName}`);
  console.log(`Exa scripted API step ${apiCalls + 1}`);
  const action = steps[apiCalls++];
  const text = JSON.stringify({ message: action ? "" : "Saved the researched lead list. Nobody contacted.", actions: action ? [action] : [], suggestions: [] });
  input.accept(text);
  return { text, model: "fake-api", response: {}, usage: {} };
} }));

const { and, eq, sql } = await import("drizzle-orm");
const { db } = await import("@/lib/db");
const { organizations, members, users } = await import("@/lib/auth/schema");
const { people } = await import("@/lib/leads/schema");
const { platformCredentials } = await import("@/lib/managed/schema");
const { storePlatformCredential, removePlatformCredential } = await import("@/lib/managed/store.server");
const { verifyPlatformCredential } = await import("@/lib/managed/verify.server");
const { platformUsageReport } = await import("@/lib/managed/report.server");
const { providerQuotaState, providerUsage } = await import("@/lib/quota/schema");
const { runInOrganization, inOrg } = await import("@/lib/tenancy/scope");
const { createThread, addMessage, listMessages } = await import("@/lib/assistant/threads.server");
const { runAgentTurn } = await import("@/lib/assistant/agent.server");
const { ensureObjective, objectiveSpend, setObjectiveState } = await import("@/lib/assistant/objective.server");
const { searchWithExa } = await import("@/lib/exa/exa.server");
const { runTool, toolDescriptionsFor } = await import("@/lib/assistant/tools.server");
const { featureState } = await import("@/lib/features/flags.server");
const { setExaApiBaseForTests } = await import("@/services/exa");
const cli = await import("@/lib/ai/claudeCode/cli.server");
const engine = await import("@/lib/ai/claudeCode/engine.server");
const { resetRunnerForTests } = await import("@/lib/ai/claudeCode/runner.server");
const stamp = randomUUID();
const fixture = async (label: string) => {
  const [org] = await db.insert(organizations).values({ name: `Exa ${label}`, slug: `exa-${label}-${stamp}` }).returning();
  const [user] = await db.insert(users).values({ name: `Exa ${label}`, email: `${label}-${stamp}@exa.test`, emailVerified: true }).returning();
  await db.insert(members).values({ organizationId: org!.id, userId: user!.id, role: "owner" });
  return { org: org!, user: user! };
};
const a = await fixture("a"); const b = await fixture("b");
let mode: "ok" | "rate" | "lost" | "unauthorized" = "ok";
let httpCalls = 0;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  httpCalls++;
  if (request.headers.get("x-api-key") !== "exa-fixture-private-key-20261027") throw new Error("Wrong key");
  const body = await request.json() as { urls?: string[] };
  if (mode === "rate") return Response.json({ error: "rate limited" }, { status: 429, headers: { "Retry-After": "60" } });
  if (mode === "unauthorized") return Response.json({ error: "provider detail must not escape" }, { status: 401 });
  if (mode === "lost") return new Response("not-json");
  return Response.json({ requestId: `exa-${httpCalls}`, costDollars: { total: body.urls ? 0.001 : 0.007 }, results: [{ url: "https://exa-prospect.example/about", title: "Independent manufacturer", highlights: ["Priya owns this manufacturer. Email priya@exa-prospect.example"], ...(body.urls ? { text: "Priya owns this independent manufacturer. Contact priya@exa-prospect.example" } : {}) }] });
} });
setExaApiBaseForTests(server.url.origin);
const data = mkdtempSync(join(tmpdir(), "agentsdr-exa-db-"));
cli.setClaudeDataDirForTests(data);
cli.setClaudeCliForTests({ command: process.execPath, args: [join(root, "src/lib/ai/claudeCode/testing/fake-claude.ts")] });
engine.setOperatorOrganizationForTests(a.org.id);
let checks = 0;
function check(label: string, value: unknown) { if (!value) throw new Error(`FAIL ${label}`); checks++; console.log(`PASS ${label}`); }
try {
  const ddl = readFileSync(join(root, "db/migrations/20261027-exa.sql"), "utf8");
  const beforeConstraint = await db.execute(sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'platform_credentials_provider_chk'`);
  await db.transaction(async (tx) => { await tx.execute(sql.raw(ddl)); });
  await db.transaction(async (tx) => { await tx.execute(sql.raw(ddl)); });
  const afterConstraint = await db.execute(sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'platform_credentials_provider_chk'`);
  check("Exa migration is re-runnable and matches a fresh install", JSON.stringify(beforeConstraint) === JSON.stringify(afterConstraint));
  await storePlatformCredential("exa", { apiKey: "exa-fixture-private-key-20261027" }, { userId: a.user.id, verify: verifyPlatformCredential });
  const [stored] = await db.select().from(platformCredentials).where(eq(platformCredentials.provider, "exa"));
  check("operator key is encrypted, not copied into public config", stored && !JSON.stringify(stored).includes("exa-fixture-private-key-20261027"));
  check("saving a key really checks the provider", httpCalls === 1);
  let aThread = "";
  await runInOrganization(a.org.id, async () => {
    const tools = toolDescriptionsFor(await featureState());
    check("both harnesses' shared tool catalog includes search and reading", tools.some((tool) => tool.name === "exa_search") && tools.some((tool) => tool.name === "exa_read"));
    const thread = await createThread(a.user.id); aThread = thread.id;
    check("API harness completes real Exa app tools and saves a lead", await runAgentTurn({ threadId: thread.id, userId: a.user.id, text: "Research only. Find independent manufacturers and save their published contact details. Do not contact anyone." }) === "done");
    const messages = await listMessages(thread.id);
    check("API harness records Exa search and page provenance", messages.some((row) => row.tool === "exa_search" && row.status === "ok") && messages.some((row) => row.tool === "exa_read" && row.status === "ok"));
    check("API engine still uses its existing completion loop", apiCalls === 4);
    check("published contact reaches the existing importer", (await db.select().from(people).where(and(inOrg(people), eq(people.email, "priya@exa-prospect.example")))).length === 1);
    const usage = await db.select().from(providerUsage).where(and(inOrg(providerUsage), eq(providerUsage.provider, "exa")));
    check("search and contents are attributed only to this workspace", usage.length === 2 && usage.every((row) => row.credentialSource === "managed" && row.status === "settled"));
    check("provider estimates, not zero, are recorded", usage.reduce((sum, row) => sum + Number(row.costUsd), 0) === 0.008);
    const before = httpCalls;
    for (const url of ["http://127.0.0.1/admin", "https://www.instagram.com/example/", "https://www.reddit.com/r/test/"]) {
      const result = await runTool("exa_read", { urls: [url] }, { threadId: thread.id, userId: a.user.id, ownerText: "read pages" });
      check(`unsupported destination refused: ${new URL(url).hostname}`, !result.ok);
    }
    check("private/social refusals send no Exa request", httpCalls === before);
    const contextFor = async (content: string) => {
      const thread = await createThread(a.user.id);
      const message = await addMessage({ threadId: thread.id, role: "user", content });
      const created = await ensureObjective({ requestMessageId: message.id, threadId: thread.id, userId: a.user.id });
      if (!created) throw new Error("No objective");
      return { threadId: thread.id, requestId: message.id, objective: created.objective };
    };
    const free = await contextFor("Find independent businesses, research only. Free sources only, $0 source budget.");
    await searchWithExa({ query: "independent businesses" }, free).then(() => check("explicit free-only refused", false), () => check("explicit free-only refused", httpCalls === before));
    const budget = await contextFor("Find independent businesses, research only. Spend up to $0.02.");
    await searchWithExa({ query: "independent businesses" }, budget);
    await searchWithExa({ query: "independent manufacturers" }, budget);
    const atCap = httpCalls;
    await searchWithExa({ query: "independent owners" }, budget).then(() => check("explicit dollar cap enforced", false), () => check("explicit dollar cap enforced", httpCalls === atCap));
    check("request spend includes both Exa calls", (await objectiveSpend({ requestMessageId: budget.requestId })).totalUsd === 0.014);
    const paused = await contextFor("Research independent businesses");
    check("no default request spending cap is introduced", paused.objective.spendCapUsd === null);
    await setObjectiveState(paused.objective.id, "pause", { name: "Owner" });
    await searchWithExa({ query: "independent businesses" }, paused).then(() => check("paused request refused", false), () => check("paused request refused", httpCalls === atCap));
    await setObjectiveState(paused.objective.id, "cancel", { name: "Owner" });
    await searchWithExa({ query: "independent businesses" }, paused).then(() => check("cancelled request refused", false), () => check("cancelled request refused", httpCalls === atCap));
    mode = "rate";
    await searchWithExa({ query: "owners" }, { threadId: thread.id, requestId: null }).catch(() => {});
    const rateCalls = httpCalls;
    await searchWithExa({ query: "owners" }, { threadId: thread.id, requestId: null }).catch(() => {});
    check("Retry-After prevents another transport call", httpCalls === rateCalls);
    const rateRows = await db.select().from(providerUsage).where(and(inOrg(providerUsage), eq(providerUsage.provider, "exa"), eq(providerUsage.status, "failed")));
    check("rate-limited trigger releases the held cost", rateRows.some((row) => Number(row.costUsd) === 0 && row.usedUnits === 0));
    await db.delete(providerQuotaState).where(eq(providerQuotaState.product, "exa:search"));
    mode = "lost";
    const callsBeforeLost = httpCalls;
    await searchWithExa({ query: "owners" }, { threadId: thread.id, requestId: null }).catch(() => {});
    const uncertain = await db.select().from(providerUsage).where(and(inOrg(providerUsage), eq(providerUsage.provider, "exa"), eq(providerUsage.status, "uncertain")));
    check("lost answer is never automatically retried and stays counted", httpCalls === callsBeforeLost + 1 && uncertain.length === 1 && Number(uncertain[0]?.costUsd) === 0.007);
    mode = "unauthorized";
    const denied = await runTool("exa_search", { query: "owners" }, { threadId: thread.id, userId: a.user.id, ownerText: "find owners" });
    check("bad credentials return a useful safe error", !denied.ok && denied.summary.includes("operator") && !denied.summary.includes("provider detail"));
    mode = "ok";
    const account = { organizationId: a.org.id, userId: a.user.id };
    const paths = cli.accountPaths(account);
    writeFileSync(join(paths.config, ".credentials.json"), "fake", { mode: 0o600 });
    writeFileSync(join(paths.config, "fake-scenario.json"), JSON.stringify({ nativeSteps: steps.map((step) => ({ name: step.tool, args: JSON.parse(step.arguments) })), answer: { message: "Saved the researched lead list. Nobody contacted.", suggestions: [] } }));
    await engine.saveClaudeEngine({ selected: true, ownerUserId: a.user.id, model: "sonnet", checks: {} });
    const native = await createThread(a.user.id);
    const beforeApi = apiCalls;
    check("native Claude completes Exa search/read/import through actual MCP", await runAgentTurn({ threadId: native.id, userId: a.user.id, text: "Research only. Find independent manufacturers and save their contacts. Do not contact anyone." }) === "done");
    const nativeMessages = await listMessages(native.id);
    check("Claude's Exa calls are visible as the same app tool cards", nativeMessages.some((row) => row.tool === "exa_search" && row.status === "ok") && nativeMessages.some((row) => row.tool === "exa_read" && row.status === "ok"));
    check("native turn uses one CLI loop and no API assistant generation", apiCalls === beforeApi && readFileSync(join(paths.config, "fake-calls.jsonl"), "utf8").trim().split("\n").length === 1);
  });
  await runInOrganization(b.org.id, async () => {
    check("another workspace sees no Exa usage or saved contacts", (await db.select().from(providerUsage).where(inOrg(providerUsage))).length === 0 && (await db.select().from(people).where(inOrg(people))).length === 0 && (await listMessages(aThread)).length === 0);
  });
  const report = await platformUsageReport();
  check("operator usage report includes attributed Exa estimates", report.rows.some((row) => row.provider === "exa" && row.organizationId === a.org.id && row.costUsd > 0 && row.estimated));
  await removePlatformCredential("exa");
  await runInOrganization(a.org.id, async () => {
    const before = httpCalls;
    const result = await runTool("exa_search", { query: "owners" }, { threadId: aThread, userId: a.user.id, ownerText: "find owners" });
    check("removed key disables Exa without affecting other sources", !result.ok && result.summary.includes("not connected") && httpCalls === before);
  });
  console.log(`Exa checks: ${checks} passed. Providers/models are stand-ins; nothing sent.`);
} finally {
  setExaApiBaseForTests(null); server.stop(true); globalThis.fetch = realFetch;
  cli.setClaudeCliForTests(null); cli.setClaudeDataDirForTests(null); resetRunnerForTests(); engine.setOperatorOrganizationForTests(null);
  rmSync(data, { recursive: true, force: true });
}

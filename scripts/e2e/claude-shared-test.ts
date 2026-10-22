/** Private test sharing: real settings, ownership and usage queries; fake CLI, no provider calls.
 * Only run on an empty local disposable database; this suite changes the global AI default.
 * bun --conditions=react-server scripts/e2e/claude-shared-test.ts
 */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq, inArray } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) throw new Error("A local disposable DATABASE_URL is required");
const { db } = await import("@/lib/db");
const { organizations, users, members } = await import("@/lib/auth/schema");
const { platformOperators, platformSettings, providerCredentialModes } = await import("@/lib/managed/schema");
const { gridProviders } = await import("@/lib/grid/schema");
const { assistantUsage } = await import("@/lib/assistant/schema");
const { providerUsage } = await import("@/lib/quota/schema");
const { runInOrganization, currentOrganizationId } = await import("@/lib/tenancy/scope");
const { getManagedAiSettings, saveManagedAiSettings, clearPlatformCredentialCache } = await import("@/lib/managed/store.server");
const { setServiceMode } = await import("@/lib/managed/modes.server");
const { claudeCodeBinding, saveClaudeEngine, checkClaudeModel, resetClaudeEngineCachesForTests, claudeCodeBlocked } = await import("@/lib/ai/claudeCode/engine.server");
const { sharedClaudeBinding, privateClaudeStatus } = await import("@/lib/ai/claudeCode/shared.server");
const { completeStructured } = await import("@/lib/ai/server/structuredCompletion");
const { accountPaths, setClaudeCliForTests, setClaudeDataDirForTests } = await import("@/lib/ai/claudeCode/cli.server");
const { ClaudeLoginController } = await import("@/lib/ai/claudeCode/login.server");
const { resetRunnerForTests, runningOn } = await import("@/lib/ai/claudeCode/runner.server");
const previousAi = await getManagedAiSettings();
assert.equal(previousAi.engine, null, "Use an empty disposable database, not one with an AI default");
const stamp = randomUUID();
const orgs = [randomUUID(), randomUUID(), randomUUID()];
const owner = randomUUID();
const friend = randomUUID();
const source = { organizationId: orgs[0], userId: owner };
const dataDir = mkdtempSync(join(tmpdir(), "agentsdr-shared-test-"));
setClaudeDataDirForTests(dataDir);
setClaudeCliForTests({ command: process.execPath, args: [resolve("src/lib/ai/claudeCode/testing/fake-claude.ts")] });
let apiCalls = 0;
let checks = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => { apiCalls += 1; throw new Error("Unexpected provider request"); }) as unknown as typeof fetch;
const check = (name: string, value: unknown) => { assert.ok(value, name); checks += 1; console.log(`ok ${checks}: ${name}`); };
const scenario = (value: Record<string, unknown>) => writeFileSync(join(accountPaths(source).config, "fake-scenario.json"), JSON.stringify(value));
const calls = () => {
  const path = join(accountPaths(source).config, "fake-calls.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((line) => line.includes('"-p"')).length : 0;
};
const ask = (org: string, prompt = "Separate workspace task") => runInOrganization(org, () => completeStructured({ schemaName: "private_test", systemPrompt: `Workspace ${org}`, userPrompt: prompt, maxOutputTokens: 100, timeoutMs: 15_000, jsonSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } }));
const settings = { engine: "claude-code", defaultModel: { provider: "claude-code", modelId: "sonnet" }, sharedClaude: { ...source, approvedOrganizationIds: [orgs[0], orgs[1]] } };
try {
  await db.insert(users).values([{ id: owner, name: "Pilot owner", email: `owner-${stamp}@example.test`, emailVerified: true }, { id: friend, name: "Friend", email: `friend-${stamp}@example.test`, emailVerified: true }]);
  await db.insert(organizations).values(orgs.map((id, index) => ({ id, name: `Private test ${index}`, slug: `private-${index}-${stamp}`, ...(index === 0 ? { metadata: '{"initial":true}', createdAt: new Date(0) } : {}) })));
  await db.insert(members).values([{ organizationId: orgs[0], userId: owner, role: "owner" }, { organizationId: orgs[0], userId: friend, role: "member" }, { organizationId: orgs[1], userId: friend, role: "owner" }]);
  await db.insert(platformOperators).values({ userId: owner, grantedBy: "disposable-check" });
  await assert.rejects(() => saveManagedAiSettings(settings, owner), /Check this model/);
  check("an unchecked login cannot become the default", true);
  const login = new ClaudeLoginController(source, { startupMs: 10_000, lifetimeMs: 60_000, completeMs: 15_000 }, () => runningOn(source));
  const flow = await login.start("claudeai");
  await login.complete(flow.flowId, "GOOD-CODE-1234#state");
  const checked = await runInOrganization(orgs[0], () => checkClaudeModel(source, "sonnet"));
  check("the official-CLI stand-in signs in and checks its real model id", checked.ok);
  await runInOrganization(orgs[0], () => saveClaudeEngine({ selected: false, ownerUserId: owner, model: "sonnet", checks: { [owner]: { sonnet: checked } } }));
  await assert.rejects(() => saveManagedAiSettings(settings, friend), /own Claude Code/);
  check("a different caller cannot publish the owner's login", true);
  await saveManagedAiSettings(settings, owner);
  const status = await privateClaudeStatus(owner);
  check("the operator sees checks and selectable workspaces without credentials", status.source?.userId === owner && status.checks.sonnet?.ok && !JSON.stringify(status).includes("credentials.json"));
  check("approved source workspace may include a friend", await runInOrganization(orgs[0], () => claudeCodeBlocked(orgs[0], owner)) === null);
  check("borrowing keeps its own organization scope", await runInOrganization(orgs[1], async () => { const binding = await claudeCodeBinding(); return binding?.account.organizationId === orgs[0] && currentOrganizationId() === orgs[1]; }));
  await ask(orgs[1], "Friend request only");
  await ask(orgs[0], "Owner request only");
  const usage = await db.select().from(providerUsage).where(inArray(providerUsage.organizationId, orgs));
  check("each task is metered to its requesting workspace", usage.length === 2 && orgs.slice(0, 2).every((org) => usage.some((row) => row.organizationId === org && row.status === "settled" && row.product === "claude-code")));
  check("account usage has tokens and no invented API dollar charge", usage.every((row) => row.costUsd === null && row.detail?.billing === "claude_account" && Boolean(row.detail?.tokens)));
  const { sortLeads } = await import("@/lib/assistant/writer.server");
  scenario({ answer: { leads: [{ index: 0, group: "Dental clinics", approach: "standard", reason: "A dental clinic in Miami.", requestFit: "fits", noWebsiteRequired: false }] } });
  const sorted = await runInOrganization(orgs[1], () => sortLeads({ context: "AI front desks for dental clinics", request: "Dental clinics in Miami", leads: [{ index: 0, facts: { name: "Acme Dental", city: "Miami" } }], knownGroups: [], cost: { calls: 0, usd: null } }));
  check("the friend's real lead judge uses the shared runtime", sorted.get(0)?.requestFit === "fits");
  const { classifyCrmReply } = await import("@/lib/crm/ai/classify");
  scenario({ answer: { categoryKey: "interested", subcategoryKey: "demo_requested", confidence: 0.94, reasoning: "The person asked for a demo.", suggestedNextActionAt: null } });
  const classified = await runInOrganization(orgs[1], () => classifyCrmReply({
    categories: [{ key: "customer", label: "Customer" }, { key: "interested", label: "Interested" }, { key: "not_interested", label: "Not Interested" }, { key: "other", label: "Other" }],
    subcategories: [{ id: "demo", categoryKey: "interested", key: "demo_requested", name: "Demo requested", reviewRequired: false }],
    person: { id: "person", fullName: "Priya Rao", email: "priya@example.test" }, company: { name: "Acme", domain: "acme.example" },
    currentClassification: { categoryKey: null, subcategoryKey: null, categorySource: null, categoryLocked: false },
    latestInboundMessage: { id: "message", channel: "email", direction: "inbound", sentAt: "2026-10-22T12:00:00Z", bodyText: "Can you show me a demo?" },
    recentConversation: [], policy: { autoApplyConfidence: 0.85, reviewOther: true, customerRequiresReview: true },
  }));
  check("the friend's real reply classifier uses the shared runtime", JSON.stringify(classified).includes("demo_requested"));
  scenario({});
  const before = calls();
  await assert.rejects(() => ask(orgs[2]), /unavailable for this workspace/);
  check("unapproved workspace starts no CLI", calls() === before);
  await runInOrganization(orgs[1], () => setServiceMode("ai", "own", friend));
  check("My own provider does not borrow the login", await runInOrganization(orgs[1], () => sharedClaudeBinding()) === null);
  await runInOrganization(orgs[1], () => setServiceMode("ai", "managed", friend));
  await db.delete(platformOperators).where(eq(platformOperators.userId, owner));
  await assert.rejects(() => ask(orgs[1]), /unavailable for this workspace/);
  check("removing the operator grant prevents new work", calls() === before);
  await db.insert(platformOperators).values({ userId: owner, grantedBy: "disposable-check" });
  await db.update(members).set({ role: "member" }).where(eq(members.userId, owner));
  await assert.rejects(() => ask(orgs[1]), /unavailable for this workspace/);
  check("removing source ownership prevents new work", calls() === before);
  await db.update(members).set({ role: "owner" }).where(eq(members.userId, owner));
  scenario({ generation: "limit" });
  await assert.rejects(() => ask(orgs[1]), /limit/);
  const afterLimit = calls();
  await assert.rejects(() => ask(orgs[0]), /limit/);
  check("one workspace's account limit holds the other without a new generation", afterLimit === before + 1 && calls() === afterLimit);
  resetRunnerForTests();
  scenario({});
  await saveManagedAiSettings({ ...settings, sharedClaude: { ...source, approvedOrganizationIds: [orgs[0]] } }, owner);
  await assert.rejects(() => ask(orgs[1]), /unavailable for this workspace/);
  check("removing a workspace's approval prevents its next call", calls() === afterLimit);
  await saveManagedAiSettings(settings, owner);
  await login.signOut();
  await assert.rejects(() => ask(orgs[1]), /unavailable for this workspace/);
  check("signing out holds the service without an API fallback", calls() === afterLimit && apiCalls === 0);
  check("friend has no copied login directory", !existsSync(join(dataDir, "accounts", orgs[1])));
  console.log(`${checks} private Claude checks passed; no live provider called`);
} finally {
  globalThis.fetch = realFetch;
  await db.delete(providerUsage).where(inArray(providerUsage.organizationId, orgs));
  await db.delete(assistantUsage).where(inArray(assistantUsage.organizationId, orgs));
  await db.delete(providerCredentialModes).where(inArray(providerCredentialModes.organizationId, orgs));
  await db.delete(gridProviders).where(inArray(gridProviders.organizationId, orgs));
  await db.delete(platformSettings).where(eq(platformSettings.key, "ai"));
  clearPlatformCredentialCache();
  await db.delete(platformOperators).where(eq(platformOperators.userId, owner));
  await db.delete(members).where(inArray(members.organizationId, orgs));
  await db.delete(organizations).where(inArray(organizations.id, orgs));
  await db.delete(users).where(inArray(users.id, [owner, friend]));
  resetClaudeEngineCachesForTests();
  resetRunnerForTests();
  setClaudeCliForTests(null);
  setClaudeDataDirForTests(null);
  rmSync(dataDir, { recursive: true, force: true });
}

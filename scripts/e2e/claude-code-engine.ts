/**
 * The Claude Code engine (src/lib/ai/claudeCode/), end to end against the
 * local database, with a fake `claude` CLI (src/lib/ai/claudeCode/testing/
 * fake-claude.ts) and every API provider call intercepted (global fetch
 * throws and is counted; nothing leaves the machine):
 *
 *   bun run --conditions=react-server scripts/e2e/claude-code-engine.ts
 *
 * What it proves: until an owner selects Claude Code nothing changes (the
 * API path answers and the CLI is never started); once the operator
 * organization's owner signs in, checks a model and selects it, the app's
 * real AI functions — lead judging (sortLeads) and the CRM classifier
 * (classifyCrmReply) — run on that owner's login through completeStructured
 * with their own schemas and validation, record usage with no invented
 * cost, and never touch the API; a call that names an API model keeps the
 * API path; a web-search call is refused; a usage limit stops the call and
 * holds the next one without starting the CLI or any API; a demoted owner,
 * another organization's selection, and a member are refused; stopping
 * returns the work to the API path; account B's work never runs on A's
 * login.
 *
 * Creates its own people and a second organization ("Claude Code check …")
 * and removes them, its engine rows and its usage rows at the end. Refuses a
 * non-local DATABASE_URL.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { and, eq, gte, inArray } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}

const stamp = Date.now();
const startedAt = new Date(stamp);
const FAKE = resolve(import.meta.dir, "../../src/lib/ai/claudeCode/testing/fake-claude.ts");
const VALID_CODE = "GOOD-CODE-1234#state";
const dataDir = mkdtempSync(join(tmpdir(), "agentsdr-claude-e2e-"));

// Every API provider request is refused and counted: none may happen on the Claude Code path.
const apiCalls: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  apiCalls.push(url);
  throw new Error(`API provider called: ${url}`);
}) as unknown as typeof fetch;

const { db } = await import("@/lib/db");
const { organizations, users, members } = await import("@/lib/auth/schema");
const { gridProviders } = await import("@/lib/grid/schema");
const { assistantUsage } = await import("@/lib/assistant/schema");
const { runInOrganization } = await import("@/lib/tenancy/scope");
const { operatorOrganizationId } = await import("@/lib/auth/operator.server");
const cli = await import("@/lib/ai/claudeCode/cli.server");
const { ClaudeLoginController } = await import("@/lib/ai/claudeCode/login.server");
const engineModule = await import("@/lib/ai/claudeCode/engine.server");
const { ClaudeCodeError, runningOn } = await import("@/lib/ai/claudeCode/runner.server");
const { completeStructured } = await import("@/lib/ai/server/structuredCompletion");
const { sortLeads } = await import("@/lib/assistant/writer.server");
const { classifyCrmReply } = await import("@/lib/crm/ai/classify");

cli.setClaudeCliForTests({ command: process.execPath, args: [FAKE] });
cli.setClaudeDataDirForTests(dataDir);

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok  ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  }
}
async function failsWith(run: () => Promise<unknown>): Promise<Error | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}
function scenario(account: { organizationId: string; userId: string }, value: Record<string, unknown>) {
  writeFileSync(join(cli.accountPaths(account).config, "fake-scenario.json"), JSON.stringify(value));
}
function generations(account: { organizationId: string; userId: string }): number {
  const file = join(cli.accountPaths(account, false).config, "fake-calls.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((line) => line.includes("\"-p\"")).length : 0;
}
async function signIn(account: { organizationId: string; userId: string }) {
  const login = new ClaudeLoginController(account, { startupMs: 10_000, lifetimeMs: 60_000, completeMs: 15_000 }, () => runningOn(account));
  const started = await login.start("claudeai");
  return login.complete(started.flowId, VALID_CODE);
}

// ------------------------------------------------------------------ fixtures
// A disposable database already has its operator organization; this check acts as one of its own.
const [orgA] = await db.insert(organizations).values({ name: `Claude Code check A ${stamp}`, slug: `claude-code-a-${stamp}` }).returning();
const operatorId = orgA!.id;
engineModule.setOperatorOrganizationForTests(operatorId);
check("the database still has its own operator organization", (await operatorOrganizationId()) !== null);
const [orgB] = await db.insert(organizations).values({ name: `Claude Code check B ${stamp}`, slug: `claude-code-b-${stamp}` }).returning();
const person = async (label: string) => (await db.insert(users).values({ name: `Claude check ${label}`, email: `claude-${label}-${stamp}@claude-code-check.test`, emailVerified: true }).returning())[0]!;
const ownerA = await person("owner-a");
const memberM = await person("member-m");
const ownerB = await person("owner-b");
await db.insert(members).values([
  { organizationId: operatorId, userId: ownerA.id, role: "owner" },
  { organizationId: orgB!.id, userId: ownerB.id, role: "owner" },
]);
const accountA = { organizationId: operatorId, userId: ownerA.id };
const accountB = { organizationId: orgB!.id, userId: ownerB.id };

const LEAD_ANSWER = { leads: [{ index: 0, group: "Dental clinics", approach: "standard", reason: "A dental clinic in Miami.", requestFit: "fits", noWebsiteRequired: false }] };
const CLASSIFY_ANSWER = { categoryKey: "interested", subcategoryKey: "demo_requested", confidence: 0.94, reasoning: "The person asked for a demo.", suggestedNextActionAt: null };
const classifyInput = {
  categories: [{ key: "customer", label: "Customer" }, { key: "interested", label: "Interested" }, { key: "not_interested", label: "Not Interested" }, { key: "other", label: "Other" }],
  subcategories: [{ id: "subcategory-demo", categoryKey: "interested", key: "demo_requested", name: "Demo requested", reviewRequired: false }],
  person: { id: "person-1", fullName: "Priya Rao", email: "priya@example.com" },
  company: { name: "Example", domain: "example.com" },
  currentClassification: { categoryKey: null, subcategoryKey: null, categorySource: null, categoryLocked: false },
  latestInboundMessage: { id: "message-1", channel: "email", direction: "inbound", sentAt: "2026-08-31T12:00:00.000Z", bodyText: "Can you show me a demo?" },
  recentConversation: [],
  policy: { autoApplyConfidence: 0.85, reviewOther: true, customerRequiresReview: true },
} as Parameters<typeof classifyCrmReply>[0];
const judge = () => sortLeads({ context: "We sell AI front desks to dental clinics.", request: "Dental clinics in Miami", leads: [{ index: 0, facts: { name: "Acme Dental", city: "Miami" } }], knownGroups: [], cost: { calls: 0, usd: null } });
const plainCall = (extra: Record<string, unknown> = {}) => completeStructured({ timeoutMs: 20_000, systemPrompt: "S", userPrompt: "U", maxOutputTokens: 200, jsonSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false }, schemaName: "check", ...extra });

try {
  console.log("Claude Code engine e2e");

  // 1. Nothing selected: the API path answers; the CLI is never started.
  await runInOrganization(operatorId, () => engineModule.saveClaudeEngine({ selected: false, ownerUserId: null, model: "default", checks: {} }));
  await runInOrganization(operatorId, () => failsWith(judge));
  check("before selection the CLI is not started", generations(accountA) === 0);

  // 2. Access: owner of the operator organization only.
  check("the operator organization's owner may use it", (await engineModule.claudeCodeAccess({ organizationId: operatorId, roles: ["owner"] })).allowed);
  check("a member may not", !(await engineModule.claudeCodeAccess({ organizationId: operatorId, roles: ["member"] })).allowed);
  check("an admin may not", !(await engineModule.claudeCodeAccess({ organizationId: operatorId, roles: ["admin"] })).allowed);
  check("another organization's owner may not", !(await engineModule.claudeCodeAccess({ organizationId: orgB!.id, roles: ["owner"] })).allowed);

  // 3. Owner A signs in, checks a model, selects it.
  const signedIn = await signIn(accountA);
  check("owner A signs in through the CLI", signedIn.phase === "succeeded", signedIn);
  scenario(accountA, {});
  const modelCheck = await runInOrganization(operatorId, () => engineModule.checkClaudeModel(accountA, "sonnet"));
  check("the model check reports the model the CLI ran", modelCheck.ok && modelCheck.modelId === "claude-sonnet-5-5", modelCheck);
  await runInOrganization(operatorId, () => engineModule.saveClaudeEngine({ selected: true, ownerUserId: ownerA.id, model: "sonnet", checks: { [ownerA.id]: { sonnet: modelCheck } } }));
  const usageBefore = await db.select({ id: assistantUsage.id }).from(assistantUsage).where(eq(assistantUsage.organizationId, operatorId));

  // 4. Lead judging and the CRM classifier run on A's login with their own validation.
  scenario(accountA, { answer: LEAD_ANSWER });
  const callsBefore = generations(accountA);
  const sorted = await runInOrganization(operatorId, judge);
  check("lead judging (sortLeads) answers through Claude Code", sorted.get(0)?.group === "Dental clinics" && sorted.get(0)?.requestFit === "fits", [...sorted.entries()]);
  check("…one CLI generation on owner A's login", generations(accountA) === callsBefore + 1);
  scenario(accountA, { answer: CLASSIFY_ANSWER });
  const classified = await runInOrganization(operatorId, () => classifyCrmReply(classifyInput));
  check("the CRM classifier answers through Claude Code", JSON.stringify(classified).includes("demo_requested"), classified);
  check("no API provider was called", apiCalls.length === 0, apiCalls);
  const usageAfter = await db.select().from(assistantUsage).where(eq(assistantUsage.organizationId, operatorId));
  const newUsage = usageAfter.filter((row) => !usageBefore.some((old) => old.id === row.id));
  check("usage is recorded with the model the CLI ran and no invented cost", newUsage.length >= 1 && newUsage.every((row) => row.costUsd === null && row.model === "claude-sonnet-5-5"), newUsage.map((row) => ({ kind: row.kind, model: row.model, cost: row.costUsd })));

  // 5. A validator's rejection is fed back and retried on the same login.
  scenario(accountA, { answer: { leads: [] } });
  const beforeRetry = generations(accountA);
  const missing = await runInOrganization(operatorId, () => failsWith(judge));
  check("an answer the caller rejects is retried and then fails", missing?.message.includes("missing: 0") === true && generations(accountA) === beforeRetry + 3, missing?.message);

  // 6. A call naming an API model keeps the API path; web search is refused.
  const beforeApi = generations(accountA);
  await runInOrganization(operatorId, () => failsWith(() => plainCall({ requestedModel: { provider: "openrouter", modelId: "openai/gpt-5.2" } })));
  check("a call that names an API model does not run on Claude Code", generations(accountA) === beforeApi);
  const plugin = await runInOrganization(operatorId, () => failsWith(() => plainCall({ plugins: [{ id: "web" }] })));
  check("a web-search call is refused, not answered from memory", plugin?.message.includes("does not offer") === true && generations(accountA) === beforeApi, plugin?.message);

  // 7. A usage limit stops at once and holds the next call without the CLI or an API.
  scenario(accountA, { generation: "limit" });
  const beforeLimit = generations(accountA);
  const apiBeforeLimit = apiCalls.length;
  const limited = await runInOrganization(operatorId, () => failsWith(judge));
  check("a usage limit fails the call with the reset", limited instanceof ClaudeCodeError && limited.kind === "limit" && limited.message.includes("resets"), limited?.message);
  const held = await runInOrganization(operatorId, () => failsWith(judge));
  check("…and holds the next call without starting the CLI", held instanceof ClaudeCodeError && held.kind === "limit" && generations(accountA) === beforeLimit + 1);
  check("…and no API provider is called", apiCalls.length === apiBeforeLimit, apiCalls.slice(apiBeforeLimit));
  const status = await runInOrganization(operatorId, () => engineModule.claudeCodeStatus({ organizationId: operatorId, userId: ownerA.id, roles: ["owner"] }));
  check("the settings status shows the limit and the reported windows", status.limits.length > 0 && status.windows.some((window) => window.window === "five_hour") && status.account.signedIn === true && status.engine.selected, { limits: status.limits, windows: status.windows });

  // 7b. Another member in the organization: their work would run on A's account, so nothing runs.
  scenario(accountA, {});
  const { resetRunnerForTests } = await import("@/lib/ai/claudeCode/runner.server");
  resetRunnerForTests();
  await db.insert(members).values({ organizationId: operatorId, userId: memberM.id, role: "member" });
  engineModule.resetClaudeEngineCachesForTests();
  const beforeMember = generations(accountA);
  const withMember = await runInOrganization(operatorId, () => failsWith(() => plainCall()));
  check("with another member in the organization, nothing runs on the owner's login", withMember instanceof ClaudeCodeError && withMember.message.includes("other member") && generations(accountA) === beforeMember, withMember?.message);
  check("…and the settings say why", (await runInOrganization(operatorId, () => engineModule.claudeCodeStatus({ organizationId: operatorId, userId: ownerA.id, roles: ["owner"] }))).engine.blocked?.includes("1 other member") === true);
  await db.delete(members).where(and(eq(members.organizationId, operatorId), eq(members.userId, memberM.id)));
  engineModule.resetClaudeEngineCachesForTests();
  const alone = await runInOrganization(operatorId, () => plainCall().then(() => null, (error: unknown) => error));
  check("once the owner is the only member again, it runs", alone === null && generations(accountA) === beforeMember + 1, alone instanceof Error ? alone.message : alone);

  // 8. A demoted owner's login stops answering; no fallback.
  await db.update(members).set({ role: "admin" }).where(and(eq(members.organizationId, operatorId), eq(members.userId, ownerA.id)));
  const demoted = await runInOrganization(operatorId, () => failsWith(() => plainCall()));
  check("a demoted owner's login no longer answers", demoted instanceof ClaudeCodeError && demoted.message.includes("no longer an owner"), demoted?.message);
  await db.update(members).set({ role: "owner" }).where(and(eq(members.organizationId, operatorId), eq(members.userId, ownerA.id)));

  // 9. Another organization: its own selection is refused, and A's login never answers for it.
  await signIn(accountB);
  await runInOrganization(orgB!.id, () => engineModule.saveClaudeEngine({ selected: true, ownerUserId: ownerB.id, model: "sonnet", checks: {} }));
  const beforeB = generations(accountA);
  const refusedB = await runInOrganization(orgB!.id, () => failsWith(() => plainCall()));
  check("another organization's selection is refused (owner-only pilot)", refusedB instanceof ClaudeCodeError && refusedB.message.includes("pilot"), refusedB?.message);
  check("…its work runs on no login, and not on A's", generations(accountB) === 0 && generations(accountA) === beforeB);
  await runInOrganization(orgB!.id, () => engineModule.saveClaudeEngine({ selected: true, ownerUserId: ownerA.id, model: "sonnet", checks: {} }));
  const borrowed = await runInOrganization(orgB!.id, () => failsWith(() => plainCall()));
  check("pointing another organization at A's login is refused", borrowed instanceof ClaudeCodeError && generations(accountA) === beforeB, borrowed?.message);

  // 10. Stop using: the work returns to the API path.
  await runInOrganization(operatorId, () => engineModule.saveClaudeEngine({ selected: false, ownerUserId: ownerA.id, model: "sonnet", checks: {} }));
  const beforeStop = generations(accountA);
  await runInOrganization(operatorId, () => failsWith(() => plainCall()));
  check("after Stop using, the CLI is not started", generations(accountA) === beforeStop);
} finally {
  globalThis.fetch = realFetch;
  engineModule.setOperatorOrganizationForTests(null);
  await db.delete(gridProviders).where(and(inArray(gridProviders.organizationId, [operatorId, orgB!.id]), eq(gridProviders.key, "claude-code-engine")));
  await db.delete(assistantUsage).where(and(inArray(assistantUsage.organizationId, [operatorId, orgB!.id]), gte(assistantUsage.createdAt, startedAt)));
  await db.delete(members).where(inArray(members.userId, [ownerA.id, memberM.id, ownerB.id]));
  await db.delete(users).where(inArray(users.id, [ownerA.id, memberM.id, ownerB.id]));
  await db.delete(organizations).where(inArray(organizations.id, [operatorId, orgB!.id]));
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll Claude Code engine checks passed");
process.exit(failures ? 1 : 0);

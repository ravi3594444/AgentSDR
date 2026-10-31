/**
 * Real chat, MCP HTTP, guards and database, with a scripted CLI and web
 * provider. No real model/provider is called and no message is sent.
 * DATABASE_URL must name a disposable local agentsdr_native database.
 */
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
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("External network refused in the native harness check");
  return realFetch(input, init);
}) as typeof fetch;

const web = await import("@/lib/discovery/webSearch.server");
mock.module(join(root, "src/lib/discovery/webSearch.server.ts"), () => ({ ...web, generalWebSearch: async () => ({
  provider: "tinyfish", hits: [{ title: "Independent business owner", url: "https://native-prospect.example/about", snippet: "Owner: Priya. Contact priya@native-prospect.example" }],
}) }));
let apiAssistantCalls = 0;
mock.module(join(root, "src/lib/ai/server/structuredCompletion.ts"), () => ({ completeStructured: async (input: { schemaName: string; accept: (text: string) => void }) => {
  if (input.schemaName !== "assistant_reply") throw new Error(`Unexpected AI stage ${input.schemaName}`);
  apiAssistantCalls++;
  const text = JSON.stringify({ message: "The standard API engine answered.", actions: [], suggestions: [] });
  input.accept(text);
  return { text, model: "fake-api", response: {}, usage: {} };
} }));

const { and, eq } = await import("drizzle-orm");
const { db } = await import("@/lib/db");
const { organizations, members, users } = await import("@/lib/auth/schema");
const { people } = await import("@/lib/leads/schema");
const { brightdataSettings } = await import("@/lib/brightdata/schema");
const { platformSettings } = await import("@/lib/managed/schema");
const { CLAUDE_PRIVATE_PILOTS } = await import("@/lib/ai/claudeCode/pilotAccess.server");
const { encryptIntegrationCredential } = await import("@/lib/integrations/credentials");
const { assistantMessages, outreachRuns } = await import("@/lib/assistant/schema");
const { runInOrganization } = await import("@/lib/tenancy/scope");
const { createThread, getThread, listMessages } = await import("@/lib/assistant/threads.server");
const { setThreadAutonomous } = await import("@/lib/assistant/autonomy.server");
const { updateBusinessProfile } = await import("@/lib/assistant/profile.server");
const { getObjective, objectiveForRequest } = await import("@/lib/assistant/objective.server");
const { runAgentTurn } = await import("@/lib/assistant/agent.server");
const { setFeature } = await import("@/lib/features/flags.server");
const cli = await import("@/lib/ai/claudeCode/cli.server");
const engine = await import("@/lib/ai/claudeCode/engine.server");
const { resetRunnerForTests } = await import("@/lib/ai/claudeCode/runner.server");

const data = mkdtempSync(join(tmpdir(), "agentsdr-native-db-"));
cli.setClaudeDataDirForTests(data);
cli.setClaudeCliForTests({ command: process.execPath, args: [join(root, "src/lib/ai/claudeCode/testing/fake-claude.ts")] });
const stamp = randomUUID();
const fixture = async (label: string) => {
  const [org] = await db.insert(organizations).values({ name: `Native ${label}`, slug: `native-${label}-${stamp}` }).returning();
  const [user] = await db.insert(users).values({ name: `Native ${label}`, email: `${label}-${stamp}@native.test`, emailVerified: true }).returning();
  await db.insert(members).values({ organizationId: org!.id, userId: user!.id, role: "owner" });
  return { org: org!, user: user! };
};
const a = await fixture("a"); const b = await fixture("b");
engine.setOperatorOrganizationForTests(a.org.id);
const account = { organizationId: a.org.id, userId: a.user.id };
const paths = cli.accountPaths(account);
writeFileSync(join(paths.config, ".credentials.json"), "fake", { mode: 0o600 });
const scenario = (steps: unknown[], message: string) => writeFileSync(join(paths.config, "fake-scenario.json"), JSON.stringify({ nativeSteps: steps, answer: { message, suggestions: [] } }));
const calls = () => readFileSync(join(paths.config, "fake-calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { args: string[] });
let checks = 0;
let nativeThreadId = "";
function check(label: string, value: unknown) { if (!value) throw new Error(`FAIL ${label}`); checks++; console.log(`PASS ${label}`); }

try {
  await runInOrganization(a.org.id, async () => {
    await engine.saveClaudeEngine({ selected: true, ownerUserId: a.user.id, model: "sonnet", checks: {} });
    await updateBusinessProfile({ businessName: "22nd x ai", targetCustomers: "real estate agencies in Mumbai", offer: "AI automation", senderName: "Ravi" }, a.user.id);
    await setFeature("brightdata", true, a.user.id);
    await db.insert(brightdataSettings).values({ organizationId: a.org.id, encryptedKey: encryptIntegrationCredential("fake-native-brightdata-key"), maxRecordsPerSearch: 5 });
    const thread = await createThread(a.user.id);
    const prompt = "Research only. Find successful business owners anywhere. Save a lead list. Use free sources only. Do not contact anyone.";
    scenario([
      { name: "set_brief", args: { goal: "Find successful business owners anywhere, research only", contact: false, channels: null, leadTarget: null, spendCapUsd: 0, timeLimitMinutes: null, done: "Save a researched lead list" } },
      { name: "add_contacts", args: { contacts: [{ name: "Made up", email: "invented@not-published.example" }] } },
      { name: "web_search", args: { query: "successful independent business owners contact" } },
      { name: "add_contacts", args: { contacts: [{ name: "Priya", email: "priya@native-prospect.example" }], listName: "Native research check" } },
      { name: "prepare_outreach", args: { leads: "all" } },
      { name: "research_social_sources", args: { customers: "business owners", platforms: ["instagram"], maxResults: 5 } },
      { name: "finish_request", args: { summary: "Saved the researched lead list; nobody contacted" } },
    ], "Saved the lead list. Nobody was contacted.");
    check("native chat finishes", await runAgentTurn({ threadId: thread.id, userId: a.user.id, text: prompt }) === "done");
    check("one CLI process performs several app tool calls", calls().length === 1);
    check("native chat bypasses the JSON action-loop completion call", apiAssistantCalls === 0);
    const messages = await listMessages(thread.id);
    const owner = messages.find((message) => message.role === "user")!;
    const objective = await objectiveForRequest(owner.id);
    check("brief becomes the real persisted request", objective && (await getObjective(objective.id))?.requestMessageId === owner.id);
    check("explicit free-only cap survives native dispatch", objective?.spendCapUsd === 0);
    check("saved profile does not become an audience requirement", objective && !JSON.stringify(objective.controls.brief).includes("Mumbai"));
    const saved = await db.select().from(people).where(eq(people.organizationId, a.org.id));
    check("the published contact is saved through the existing importer", saved.some((person) => person.email === "priya@native-prospect.example"));
    check("invented contact is refused before an importer effect", !saved.some((person) => person.email === "invented@not-published.example"));
    check("all executed tools are recorded in the chat", messages.some((message) => message.tool === "web_search" && message.status === "ok") && messages.some((message) => message.tool === "add_contacts" && message.status === "ok"));
    check("research-only request cannot create outreach", (await db.select().from(outreachRuns).where(eq(outreachRuns.organizationId, a.org.id))).length === 0);
    check("paid research remains refused on the free-only request", messages.some((message) => message.tool === "research_social_sources" && message.status === "error" && message.content.includes("free sources")));
    check("research-only plan refusal is visible to Claude", messages.some((message) => message.tool === "prepare_outreach" && message.status === "error"));
    check("native answer retains the engine provenance", messages.some((message) => message.role === "assistant" && message.toolResult?.engine === "claude-native"));
    check("thread claim is released after the native process", (await getThread(thread.id))?.busySince === null);
    scenario([{ name: "list_audiences" }], "The saved list is available.");
    check("background continuation can use the owner's request session", await runAgentTurn({ threadId: thread.id, userId: null, text: null, eventRequestId: owner.id }) === "done");
    check("continuation explicitly resumes, not the machine's most recent session", calls()[1].args.includes("--resume") && !calls()[1].args.includes("--continue"));
    nativeThreadId = thread.id;
    // Autonomous mode gives the turn more steps than one CLI run takes: the run still starts, checkpointing within the CLI's own bound.
    const autonomousThread = await createThread(a.user.id);
    check("Autonomous mode can be turned on by the owner", await setThreadAutonomous(autonomousThread.id, true, a.user.id));
    scenario([{ name: "check_setup" }], "Setup checked.");
    check("an Autonomous native turn finishes", await runAgentTurn({ threadId: autonomousThread.id, userId: a.user.id, text: "Find leads for our AI automation work" }) === "done");
    const autonomousRun = calls().at(-1)!.args;
    const turnsPerRun = Number(autonomousRun[autonomousRun.indexOf("--max-turns") + 1]);
    check("its CLI run takes at most 40 model turns before a checkpoint", turnsPerRun >= 1 && turnsPerRun <= 40);
  });
  const threadId = nativeThreadId;
  await runInOrganization(b.org.id, async () => {
    check("another workspace cannot read the native chat", await getThread(threadId) === null);
    check("another workspace cannot see its tool results", (await db.select().from(assistantMessages).where(and(eq(assistantMessages.organizationId, b.org.id), eq(assistantMessages.threadId, threadId)))).length === 0);
    const thread = await createThread(b.user.id);
    check("a standard API workspace still completes through the existing harness", await runAgentTurn({ threadId: thread.id, userId: b.user.id, text: "hello" }) === "done");
    check("API default calls the existing completion path", apiAssistantCalls === 1);
    check("API workspace starts no Claude process", calls().length === 3);
  });
  await runInOrganization(a.org.id, async () => {
    await engine.saveClaudeEngine({ selected: false, ownerUserId: null, model: "sonnet", checks: {} });
    const thread = await createThread(a.user.id);
    check("explicitly switching back to API keeps the old engine", await runAgentTurn({ threadId: thread.id, userId: a.user.id, text: "hello" }) === "done" && apiAssistantCalls === 2 && calls().length === 3);
  });
  await db.insert(platformSettings).values({ key: CLAUDE_PRIVATE_PILOTS, value: { grants: [{ organizationId: b.org.id, userId: b.user.id }] } });
  await runInOrganization(b.org.id, async () => {
    check("a private grant enables only the named workspace owner", (await engine.claudeCodeAccess({ organizationId: b.org.id, userId: b.user.id, roles: ["owner"] })).allowed);
    check("another user cannot borrow that private grant", !(await engine.claudeCodeAccess({ organizationId: b.org.id, userId: a.user.id, roles: ["owner"] })).allowed);
    const ownAccount = { organizationId: b.org.id, userId: b.user.id };
    const ownPaths = cli.accountPaths(ownAccount);
    writeFileSync(join(ownPaths.config, ".credentials.json"), "fake", { mode: 0o600 });
    writeFileSync(join(ownPaths.config, "fake-scenario.json"), JSON.stringify({ nativeSteps: [{ name: "check_setup" }], answer: { message: "Ready.", suggestions: [] } }));
    await engine.saveClaudeEngine({ selected: true, ownerUserId: b.user.id, model: "sonnet", checks: {} });
    const thread = await createThread(b.user.id);
    check("the approved private workspace runs native Claude on its own login", await runAgentTurn({ threadId: thread.id, userId: b.user.id, text: "Show setup" }) === "done" && (await listMessages(thread.id)).some((row) => row.toolResult?.engine === "claude-native"));
    check("the private workspace does not start a process on the original owner's login", calls().length === 3);
    await db.delete(platformSettings).where(eq(platformSettings.key, CLAUDE_PRIVATE_PILOTS));
    check("revoking a private grant makes the binding fail closed", await engine.claudeCodeBinding().then(() => false, () => true));
  });
  console.log(`Native Claude database checks: ${checks} passed. Fake CLI and web results; nothing sent.`);
} finally {
  cli.setClaudeCliForTests(null); cli.setClaudeDataDirForTests(null); resetRunnerForTests(); engine.setOperatorOrganizationForTests(null);
  globalThis.fetch = realFetch;
  rmSync(data, { recursive: true, force: true });
}

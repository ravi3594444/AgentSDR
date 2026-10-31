import { afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { accountPaths, setClaudeCliForTests, setClaudeDataDirForTests, type ClaudeAccount } from "./cli.server";
import { NATIVE_MAX_TURNS_PER_RUN, nativeFlags, nativeInitProblem, parseNativeAnswer } from "./nativeProtocol";
import { nativeSession } from "./nativeSession.server";
import { runNativeAssistant } from "./nativeAssistant.server";
import { accountUsage, resetRunnerForTests, runGeneration, runningOn } from "./runner.server";
import { startToolBridge, type NativeTool } from "./toolBridge.server";
import { nativeToolSignal } from "./nativeToolScope.server";
import { coerceToolArguments, TOOL_SCHEMAS } from "@/lib/assistant/toolSchemas";

setDefaultTimeout(20_000);
let directory = "";
const FAKE = join(import.meta.dir, "testing/fake-claude.ts");
const tools: NativeTool[] = ["set_brief", "web_search", "report"].map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {}, additionalProperties: true } }));
const account = (): ClaudeAccount => ({ organizationId: randomUUID(), userId: randomUUID() });
const answer = { message: "The results are saved.", suggestions: [] };
function scenario(owner: ClaudeAccount, value: Record<string, unknown>) {
  const paths = accountPaths(owner);
  writeFileSync(join(paths.config, ".credentials.json"), "fake", { mode: 0o600 });
  writeFileSync(join(paths.config, "fake-scenario.json"), JSON.stringify({ answer, ...value }));
}
function calls(owner: ClaudeAccount): Array<{ args: string[]; envKeys: string[]; cwd: string }> {
  return readFileSync(join(accountPaths(owner).config, "fake-calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
}
const turn = (owner: ClaudeAccount, extra: Partial<Parameters<typeof runNativeAssistant>[0]> = {}) => runNativeAssistant({
  binding: { account: owner, model: "sonnet" }, threadId: randomUUID(), requestId: randomUUID(),
  systemPrompt: "Use tools.", userPrompt: "Find clinics.", tools, maxTurns: 24, maxCalls: 288, timeoutMs: 10_000,
  authorize: async () => {}, execute: async () => ({ content: [{ type: "text", text: "ok" }] }), ...extra,
});
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "agentsdr-native-test-"));
  setClaudeDataDirForTests(directory);
  setClaudeCliForTests({ command: process.execPath, args: [FAKE] });
});
beforeEach(() => resetRunnerForTests());
afterAll(() => { setClaudeDataDirForTests(null); setClaudeCliForTests(null); rmSync(directory, { recursive: true, force: true }); });

test("native flags allow only app MCP, use explicit session IDs and no permission bypass", () => {
  const args = nativeFlags({ sessionId: randomUUID(), resume: false, maxTurns: 24, mcpConfigFile: "/private/mcp.json" });
  expect(args).toContain("mcp__agentsdr__*");
  expect(args).toContain("--session-id");
  expect(args).not.toContain("--dangerously-skip-permissions");
  expect(args).not.toContain("--continue");
  expect(() => nativeFlags({ sessionId: "../other", resume: false, maxTurns: 24, mcpConfigFile: "x" })).toThrow();
  // One run's bound: a longer turn checkpoints and resumes, so callers pass at most this (agent.server.ts clamps its step budget to it).
  expect(nativeFlags({ sessionId: randomUUID(), resume: false, maxTurns: NATIVE_MAX_TURNS_PER_RUN, mcpConfigFile: "x" })).toContain(String(NATIVE_MAX_TURNS_PER_RUN));
  expect(() => nativeFlags({ sessionId: randomUUID(), resume: false, maxTurns: NATIVE_MAX_TURNS_PER_RUN + 1, mcpConfigFile: "x" })).toThrow();
});

test("native final answers cannot smuggle action batches or invalid suggestions", () => {
  expect(parseNativeAnswer(JSON.stringify(answer))).toEqual(answer);
  expect(() => parseNativeAnswer(JSON.stringify({ ...answer, actions: [{ tool: "send" }] }))).toThrow();
  expect(() => parseNativeAnswer('{"message":"hi","suggestions":[1]}')).toThrow();
});

test("init must confirm the own login, app tools and no built-in or foreign tools", () => {
  const init = { type: "system", subtype: "init", apiKeySource: "none", tools: ["StructuredOutput", "mcp__agentsdr__set_brief"] };
  expect(nativeInitProblem(init)).toBeNull();
  expect(nativeInitProblem({ ...init, apiKeySource: "ANTHROPIC_API_KEY" })).not.toBeNull();
  expect(nativeInitProblem({ ...init, tools: [...init.tools, "Bash"] })).not.toBeNull();
  expect(nativeInitProblem({ ...init, tools: [...init.tools, "mcp__other__send"] })).not.toBeNull();
});

test("a tool call read before the CLI's init frame waits for it, and runs only after it", async () => {
  const owner = account();
  scenario(owner, { nativeCallBeforeInit: true, nativeSteps: [{ name: "set_brief", args: { goal: "clinics" } }] });
  const seen: string[] = [];
  const result = await turn(owner, { execute: async (name) => { seen.push(name); return { content: [{ type: "text", text: "ok" }] }; } });
  expect(result.answer).toEqual(answer);
  expect(seen).toEqual(["set_brief"]);
});

test("a call whose init frame never verifies is refused, not run", async () => {
  const owner = account();
  scenario(owner, { nativeCallBeforeInit: true, nativeInitTools: ["StructuredOutput", "mcp__agentsdr__set_brief", "Bash"], nativeSteps: [{ name: "set_brief", args: { goal: "clinics" } }] });
  const seen: string[] = [];
  await expect(turn(owner, { execute: async (name) => { seen.push(name); return { content: [{ type: "text", text: "ok" }] }; } })).rejects.toThrow();
  expect(seen).toEqual([]);
});

test("one native process receives a tool result and uses it in its next call", async () => {
  const owner = account();
  scenario(owner, { nativeSteps: [{ name: "set_brief", args: { goal: "clinics" } }, { name: "web_search", copyPrevious: true }] });
  const seen: unknown[] = [];
  let authorizations = 0;
  const result = await turn(owner, { authorize: async () => { authorizations++; }, execute: async (name, args) => {
    seen.push({ name, args });
    return { content: [{ type: "text", text: "Search clinics in Pune" }], structuredContent: { data: { query: "clinics Pune" } } };
  } });
  expect(result.answer).toEqual(answer);
  expect(seen).toEqual([{ name: "set_brief", args: { goal: "clinics" } }, { name: "web_search", args: { query: "clinics Pune" } }]);
  expect(authorizations).toBeGreaterThanOrEqual(5);
  const started = calls(owner);
  expect(started).toHaveLength(1);
  expect(started[0].args).not.toContain("--no-session-persistence");
  expect(started[0].args[started[0].args.indexOf("--tools") + 1]).toBe("");
  expect(JSON.parse(started[0].args[started[0].args.indexOf("--settings") + 1]).permissions.deny).toContain("Read");
  for (const key of ["DATABASE_URL", "INTEGRATION_CREDENTIALS_KEY", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) expect(started[0].envKeys).not.toContain(key);
  expect(runningOn(owner)).toBe(0);
});

test("request sessions resume explicitly and stay separate across accounts, requests and models", async () => {
  const owner = account(); const other = account();
  scenario(owner, {}); scenario(other, {});
  const ids = { threadId: randomUUID(), requestId: randomUUID() };
  const first = await turn(owner, ids);
  const second = await turn(owner, ids);
  expect(second.sessionId).toBe(first.sessionId);
  expect(second.resumed).toBe(true);
  expect(calls(owner)[1].args).toContain("--resume");
  expect((await turn(other, ids)).sessionId).not.toBe(first.sessionId);
  expect((await turn(owner, { ...ids, requestId: randomUUID() })).sessionId).not.toBe(first.sessionId);
  expect((await turn(owner, { ...ids, binding: { account: owner, model: "haiku" } })).sessionId).not.toBe(first.sessionId);
  const session = nativeSession(owner, { ...ids, model: "haiku" });
  expect(statSync(session.cwd).mode & 0o777).toBe(0o700);
  expect(statSync(join(session.cwd, "session.json")).mode & 0o777).toBe(0o600);
  expect(() => nativeSession(owner, { ...ids, threadId: "../../other", model: "haiku" })).toThrow();
});

test("an app tool's structured writer can run while its native parent waits, within the process cap", async () => {
  const owner = account(); scenario(owner, { nativeSteps: [{ name: "set_brief" }] });
  let childAnswer = "";
  await turn(owner, { execute: async () => {
    const child = await runGeneration({ account: owner, model: "sonnet", systemPrompt: "Write.", userPrompt: "Draft.", jsonSchema: {}, timeoutMs: 1_000 });
    childAnswer = child.text;
    return { content: [{ type: "text", text: "Writer finished" }] };
  } });
  expect(JSON.parse(childAnswer)).toEqual(answer);
  expect(calls(owner)).toHaveLength(2);
  expect(runningOn(owner)).toBe(0);
});

test("an uncertain app effect stops the native loop rather than repeating or advancing it", async () => {
  const owner = account(); scenario(owner, { nativeSteps: [{ name: "set_brief" }, { name: "web_search" }] });
  let effects = 0;
  await expect(turn(owner, { execute: async () => { effects++; throw new Error("Recording failed after commit"); } })).rejects.toThrow("Recording failed");
  expect(effects).toBe(1);
});

test("two native accounts leave a writer slot and do not deadlock each other", async () => {
  const owners = [account(), account()];
  owners.forEach((owner) => scenario(owner, { nativeSteps: [{ name: "set_brief" }] }));
  const results = await Promise.all(owners.map((owner) => turn(owner, { execute: async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    await runGeneration({ account: owner, model: "sonnet", systemPrompt: "Write.", userPrompt: "Draft.", jsonSchema: {}, timeoutMs: 1_000 });
    return { content: [] };
  } })));
  expect(results).toHaveLength(2);
  owners.forEach((owner) => expect(calls(owner)).toHaveLength(2));
});

test("native extra usage is held immediately before any following app effect", async () => {
  const owner = account(); scenario(owner, { generation: "overage", nativeSteps: [{ name: "set_brief" }] });
  let effects = 0;
  await expect(turn(owner, { execute: async () => { effects++; return { content: [] }; } })).rejects.toThrow("extra usage");
  expect(effects).toBe(0);
  expect(accountUsage(owner).limits[0]?.window).toBe("overage");
});

test("a revoked binding fences the next tool and cancels the native process", async () => {
  const owner = account();
  scenario(owner, { nativeSteps: [{ name: "set_brief" }, { name: "web_search" }] });
  let revoked = false; let effects = 0;
  await expect(turn(owner, { authorize: async () => { if (revoked) throw new Error("Access revoked"); }, execute: async () => {
    effects++; revoked = true; return { content: [{ type: "text", text: "done" }] };
  } })).rejects.toThrow("Access revoked");
  expect(effects).toBe(1);
  expect(runningOn(owner)).toBe(0);
});

test("foreign tools and inherited API credentials authorize zero effects", async () => {
  for (const value of [{ generation: "env_key" }, { nativeInitTools: ["StructuredOutput", "mcp__agentsdr__set_brief", "Bash"] }]) {
    const owner = account(); scenario(owner, { ...value, nativeSteps: [{ name: "set_brief" }] });
    let effects = 0;
    await expect(turn(owner, { execute: async () => { effects++; return { content: [] }; } })).rejects.toThrow();
    expect(effects).toBe(0);
    expect(runningOn(owner)).toBe(0);
  }
});

test("a subscription limit holds the next turn without an API fallback or another process", async () => {
  const owner = account(); scenario(owner, { generation: "limit" });
  await expect(turn(owner)).rejects.toThrow();
  expect(accountUsage(owner).limits).toHaveLength(1);
  await expect(turn(owner)).rejects.toThrow();
  expect(calls(owner)).toHaveLength(1);
});

test("a cancelled native invocation releases its slot and never falls back", async () => {
  const owner = account(); scenario(owner, { generation: "slow", slowMs: 10_000 });
  const controller = new AbortController();
  const pending = turn(owner, { signal: controller.signal });
  setTimeout(() => controller.abort(new Error("Owner cancelled")), 100);
  await expect(pending).rejects.toThrow("Owner cancelled");
  expect(runningOn(owner)).toBe(0);
});

// ── Typed contracts, checkpoints and continuation ───────────────────────────

const typedTools: NativeTool[] = ["set_brief", "web_search", "report"].map((name) => ({ name, description: name, inputSchema: TOOL_SCHEMAS[name]! }));
function runs(owner: ClaudeAccount): Array<{ args: string[]; promptHead?: string; toolResults?: string[]; held?: boolean }> {
  return calls(owner).filter((call) => call.args.includes("--mcp-config")) as never;
}
const sessionArg = (args: string[]) => args[args.indexOf(args.includes("--resume") ? "--resume" : "--session-id") + 1];

test("each tool's typed input schema reaches the CLI's MCP list, and arguments sent as text arrive typed", async () => {
  const owner = account();
  scenario(owner, { nativeSteps: [{ name: "set_brief", args: { goal: "clinics", newRequest: "true", leadTarget: "25", channels: "[\"email\"]" } }] });
  const seen: unknown[] = [];
  await turn(owner, { tools: typedTools, execute: async (name, args) => {
    // As runAgentTurn's execute does before its checks (and runTool again before the tool).
    seen.push(coerceToolArguments(TOOL_SCHEMAS[name], args));
    return { content: [{ type: "text", text: "ok" }] };
  } });
  const listed = JSON.parse(readFileSync(join(accountPaths(owner).config, "fake-tools.json"), "utf8")) as NativeTool[];
  const brief = listed.find((tool) => tool.name === "set_brief")!.inputSchema as unknown as { properties: Record<string, { type: unknown }>; required: string[] };
  expect(brief.properties.newRequest!.type).toBe("boolean");
  expect(brief.properties.leadTarget!.type).toEqual(["integer", "null"]);
  expect(brief.required).toEqual(["goal"]);
  expect(listed.find((tool) => tool.name === "web_search")!.inputSchema.required).toEqual(["query"]);
  expect(seen).toEqual([{ args: { goal: "clinics", newRequest: true, leadTarget: 25, channels: ["email"] }, problems: [] }]);
});

test("a run that reaches its --max-turns continues in the same session, from a resume message, and the turn finishes", async () => {
  const owner = account();
  scenario(owner, { nativeRuns: [{ steps: [{ name: "set_brief" }], maxTurns: true }, { steps: [{ name: "web_search" }] }] });
  const seen: string[] = [];
  const checkpoints: unknown[] = [];
  const result = await turn(owner, {
    execute: async (name) => { seen.push(name); return { content: [{ type: "text", text: "ok" }] }; },
    resumePrompt: async (checkpoint) => { checkpoints.push(checkpoint); return "CONTINUE from the record."; },
  });
  expect(result.answer).toEqual(answer);
  expect(result.paused).toBeNull();
  expect(result.runs).toBe(2);
  expect(seen).toEqual(["set_brief", "web_search"]);
  expect(checkpoints).toEqual([{ reason: "turns", forced: false, run: 1 }]);
  const [first, second] = runs(owner);
  expect(first!.args).toContain("--session-id");
  expect(second!.args).toContain("--resume");
  expect(sessionArg(second!.args)).toBe(sessionArg(first!.args));
  expect(second!.promptHead).toStartWith("CONTINUE from the record.");
  // Both runs' usage is counted.
  expect(result.usage).toEqual({ inputTokens: 220, outputTokens: 50 });
  expect(runningOn(owner)).toBe(0);
});

test("a run past its time checkpoints between calls: the call in flight finishes, the next is not run, and nothing runs twice on resume", async () => {
  const owner = account();
  scenario(owner, { nativeRuns: [
    { steps: [{ name: "set_brief", args: { goal: "clinics" } }, { name: "web_search", args: { query: "clinics" } }], holdMs: 8_000 },
    { steps: [{ name: "set_brief", args: { goal: "clinics" } }, { name: "web_search", args: { query: "clinics" } }] },
  ] });
  const seen: string[] = [];
  const result = await turn(owner, {
    timeoutMs: 1_500,
    turnTimeoutMs: 15_000,
    drainGraceMs: 200,
    execute: async (name) => {
      seen.push(name);
      // The first effect is still running when the run's time is up.
      if (seen.length === 1) await new Promise((resolve) => setTimeout(resolve, 2_500));
      return { content: [{ type: "text", text: `${name} done` }] };
    },
  });
  expect(result.answer).toEqual(answer);
  expect(result.runs).toBe(2);
  // set_brief ran once (in the first run); web_search, refused there as "not run", ran once in the resumed run.
  expect(seen).toEqual(["set_brief", "web_search"]);
  // The first run was stopped between calls (before it could record); the resumed one saw the record.
  const resumed = runs(owner).find((run) => (run as { nativeRun?: number }).nativeRun === 1)!;
  expect(resumed.args).toContain("--resume");
  expect(resumed.toolResults![0]).toContain("already ran just before the pause; it was not run again");
  expect(resumed.toolResults![1]).toBe("web_search done");
  expect(runningOn(owner)).toBe(0);
});

test("past the whole turn's bound the turn pauses, saved, and the next turn resumes its session", async () => {
  const owner = account();
  scenario(owner, { nativeRuns: [{ steps: [{ name: "set_brief" }], holdMs: 5_000 }] });
  const ids = { threadId: randomUUID(), requestId: randomUUID() };
  const result = await turn(owner, { ...ids, timeoutMs: 10_000, turnTimeoutMs: 1_500, drainGraceMs: 200 });
  expect(result.answer).toBeNull();
  expect(result.paused).toEqual({ reason: "time", forced: true, run: 1 });
  const session = nativeSession(owner, { ...ids, model: "sonnet" });
  expect(session.resume).toBe(true);
  expect(session.sessionId).toBe(result.sessionId);
  expect(session.savedAt).toBeInstanceOf(Date);
  expect(runningOn(owner)).toBe(0);
});

test("cancelling during a resumed run stops its tool at once and never falls back", async () => {
  const owner = account();
  scenario(owner, { nativeRuns: [{ steps: [{ name: "set_brief" }], maxTurns: true }, { steps: [{ name: "web_search" }] }] });
  const controller = new AbortController();
  let toolSawCancel = false;
  await expect(turn(owner, { signal: controller.signal, execute: async (name) => {
    if (name !== "web_search") return { content: [] };
    const signal = nativeToolSignal()!;
    controller.abort(new Error("Owner cancelled"));
    toolSawCancel = signal.aborted;
    return { content: [] };
  } })).rejects.toThrow("Owner cancelled");
  expect(toolSawCancel).toBe(true);
  expect(runningOn(owner)).toBe(0);
});

test("a final answer the record does not back goes back to Claude in the same session, and only a backed one is returned", async () => {
  const owner = account();
  const claimed = { message: "I found 20 salons.", suggestions: [] };
  scenario(owner, { nativeRuns: [{ answer: claimed }, { answer }] });
  const result = await turn(owner, { checkAnswer: async (given) => (given.message === claimed.message ? "These searches only start now." : null) });
  expect(result.answer).toEqual(answer);
  const [, second] = runs(owner);
  expect(second!.args).toContain("--resume");
  expect(second!.promptHead).toContain("was not shown to the owner: These searches only start now.");
});

test("the bridge's allowance and drain answer \"not run\" and never execute", async () => {
  const controller = new AbortController(); let effects = 0; const checkpoints: string[] = [];
  const bridge = await startToolBridge({ tools, signal: controller.signal, maxCalls: 1, onCheckpoint: (why) => checkpoints.push(why), execute: async () => { effects++; return { content: [{ type: "text", text: "ok" }] }; } });
  const connection = bridge.config.mcpServers.agentsdr;
  const client = new Client({ name: "drain", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: connection.headers } }));
    await client.callTool({ name: "set_brief", arguments: {} });
    const over = await client.callTool({ name: "web_search", arguments: {} });
    const drained = await client.callTool({ name: "report", arguments: {} });
    expect(effects).toBe(1);
    expect(over.isError && JSON.stringify(over.content)).toContain("Not run: this run used its tool-call allowance");
    expect(drained.isError).toBe(true);
    expect(checkpoints).toEqual(["allowance", "drained"]);
    await bridge.idle();
  } finally { await client.close(); await bridge.close(); }
});

test("the real MCP client can discover and call only this bridge's tools", async () => {
  const controller = new AbortController(); let effects = 0;
  const bridge = await startToolBridge({ tools, signal: controller.signal, maxCalls: 2, execute: async () => { effects++; return { content: [{ type: "text", text: "ok" }] }; } });
  const connection = bridge.config.mcpServers.agentsdr;
  const client = new Client({ name: "native-probe", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: connection.headers } }));
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(tools.map((tool) => tool.name));
    await client.callTool({ name: "set_brief", arguments: {} });
    const invalid = await client.callTool({ name: "Bash", arguments: { command: "cat secret" } });
    expect(invalid.isError).toBe(true);
    expect(effects).toBe(1);
  } finally { await client.close(); await bridge.close(); }
});

test("bridge tokens, Origin and Host checks prevent cross-turn and browser calls", async () => {
  const controller = new AbortController(); let effects = 0;
  const create = () => startToolBridge({ tools, signal: controller.signal, maxCalls: 10, execute: async () => { effects++; return { content: [] }; } });
  const a = await create(); const b = await create();
  const connection = a.config.mcpServers.agentsdr;
  try {
    for (const headers of [{}, b.config.mcpServers.agentsdr.headers, { ...connection.headers, Origin: "https://evil.test" }, { ...connection.headers, Host: "evil.test" }]) {
      const response = await fetch(connection.url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "set_brief", arguments: {} } }) });
      expect(response.status).toBe(403);
    }
    expect(effects).toBe(0);
  } finally { await a.close(); await b.close(); }
});

test("parallel tool effects are serialized and abort prevents queued effects", async () => {
  const controller = new AbortController(); const order: string[] = [];
  const bridge = await startToolBridge({ tools, signal: controller.signal, maxCalls: 2, execute: async (name) => {
    order.push(name); await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort(new Error("Stopped")); return { content: [] };
  } });
  const connection = bridge.config.mcpServers.agentsdr;
  const client = new Client({ name: "parallel", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: connection.headers } }));
    await Promise.allSettled([client.callTool({ name: "set_brief", arguments: {} }), client.callTool({ name: "web_search", arguments: {} })]);
    expect(order).toEqual(["set_brief"]);
  } finally { await client.close(); await bridge.close(); }
});

test("replayed MCP request IDs share one result and cannot authorize a second effect", async () => {
  const controller = new AbortController(); let effects = 0;
  const bridge = await startToolBridge({ tools, signal: controller.signal, maxCalls: 2, execute: async () => { effects++; return { content: [{ type: "text", text: "done" }] }; } });
  const connection = bridge.config.mcpServers.agentsdr;
  const send = (name: string) => fetch(connection.url, { method: "POST", headers: { ...connection.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" }, body: JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tools/call", params: { name, arguments: {} } }) }).then((response) => response.json()) as Promise<{ result: { isError?: boolean } }>;
  try {
    await Promise.all([send("set_brief"), send("set_brief")]);
    expect(effects).toBe(1);
    expect((await send("web_search")).result.isError).toBe(true);
    expect(effects).toBe(1);
  } finally { await bridge.close(); }
});

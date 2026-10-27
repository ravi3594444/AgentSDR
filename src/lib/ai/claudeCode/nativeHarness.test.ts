import { afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { accountPaths, setClaudeCliForTests, setClaudeDataDirForTests, type ClaudeAccount } from "./cli.server";
import { nativeFlags, nativeInitProblem, parseNativeAnswer } from "./nativeProtocol";
import { nativeSession } from "./nativeSession.server";
import { runNativeAssistant } from "./nativeAssistant.server";
import { accountUsage, resetRunnerForTests, runGeneration, runningOn } from "./runner.server";
import { startToolBridge, type NativeTool } from "./toolBridge.server";

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

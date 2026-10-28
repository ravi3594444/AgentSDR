#!/usr/bin/env bun
/**
 * A stand-in for the `claude` CLI, for the Claude Code engine's tests
 * (claudeCode.test.ts, scripts/e2e/claude-code-engine.ts). Run as
 * `bun fake-claude.ts <args>`; it imports nothing from the app.
 *
 * It answers what AgentSDR runs, in the shapes Claude Code 2.1.306 printed on
 * 21 Oct 2026: `--version`, `auth status --json`, `auth login --<method>`
 * (prints Anthropic's link, waits for the pasted code on stdin), `auth
 * logout`, and `-p --output-format stream-json` (init, rate_limit_event,
 * result with structured_output).
 *
 * The test sets the scenario in `<CLAUDE_CONFIG_DIR>/fake-scenario.json`,
 * because the engine hands the CLI an allowlisted environment and nothing
 * else. Every call is appended to `<CLAUDE_CONFIG_DIR>/fake-calls.jsonl`
 * (arguments without the prompt texts, environment keys, working directory,
 * start and end times) so a test can check what reached it.
 */
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const VALID_CODE = "GOOD-CODE-1234#state";

type Scenario = {
  /** Generation outcome. */
  generation?: "valid" | "prose" | "limit" | "past_limit" | "bad_flag" | "opus_limit" | "overage" | "env_key" | "signed_out" | "crash" | "crash_once" | "slow" | "model_unavailable" | "overloaded";
  /** The structured answer to return; generated from the schema when absent. */
  answer?: Record<string, unknown>;
  /** auth status says logged in without a credential in this directory (an inherited login). */
  foreignLogin?: boolean;
  /** auth login never prints its link. */
  noLink?: boolean;
  slowMs?: number;
  nativeSteps?: Array<{ name: string; args?: Record<string, unknown>; copyPrevious?: boolean }>;
  nativeInitTools?: string[];
  /** Sends the first native tool call before printing init, as a host under load may read them in that order. */
  nativeCallBeforeInit?: boolean;
};

const config = process.env.CLAUDE_CONFIG_DIR ?? "";
const args = process.argv.slice(2);
const startedAt = Date.now();

function scenario(): Scenario {
  try {
    return JSON.parse(readFileSync(join(config, "fake-scenario.json"), "utf8")) as Scenario;
  } catch {
    return {};
  }
}

function record(extra: Record<string, unknown> = {}) {
  if (!config) return;
  const shown = args.map((arg, index) => (args[index - 1] === "--system-prompt" ? `<system prompt ${arg.length} chars>` : arg));
  const fileArg = args.indexOf("--system-prompt-file");
  const systemPrompt = fileArg >= 0 ? (() => { try { return readFileSync(args[fileArg + 1], "utf8"); } catch { return null; } })() : null;
  extra = { systemPromptFromFile: systemPrompt === null ? null : systemPrompt.length, ...extra };
  appendFileSync(join(config, "fake-calls.jsonl"), `${JSON.stringify({ args: shown, envKeys: Object.keys(process.env).sort(), home: process.env.HOME, cwd: process.cwd(), startedAt, endedAt: Date.now(), ...extra })}\n`);
}

const credentials = () => join(config, ".credentials.json");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function example(schema: unknown): unknown {
  const node = schema && typeof schema === "object" ? schema as Record<string, unknown> : {};
  if (Array.isArray(node.enum)) return node.enum[0];
  const type = Array.isArray(node.type) ? node.type.find((entry) => entry !== "null") : node.type;
  if (type === "object" || node.properties) {
    const properties = (node.properties ?? {}) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, example(value)]));
  }
  if (type === "array") return [];
  if (type === "boolean") return true;
  if (type === "number" || type === "integer") return 1;
  return "ok";
}

const emit = (frame: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(frame)}\n`);

async function generate() {
  const current = scenario();
  if (current.generation === "bad_flag") {
    // An older CLI refusing a flag: it exits before reading the prompt on stdin.
    record({ badFlag: true });
    process.stderr.write("error: unknown option '--json-schema'\n");
    process.exit(1);
  }
  const prompt = await readStdin();
  const modelArg = args.indexOf("--model");
  const alias = modelArg >= 0 ? args[modelArg + 1] : "default";
  const model = alias === "default" ? "claude-sonnet-5-5" : `claude-${alias}-5-5`;
  const schemaArg = args.indexOf("--json-schema");
  const schema: unknown = schemaArg >= 0 ? JSON.parse(args[schemaArg + 1]) : null;
  const callsSoFar = existsSync(join(config, "fake-calls.jsonl")) ? readFileSync(join(config, "fake-calls.jsonl"), "utf8").split("\n").filter((line) => line.includes("\"-p\"")).length : 0;
  const outcome = current.generation ?? "valid";
  const done = (extra: Record<string, unknown> = {}) => record({ promptChars: prompt.length, rejectedFeedback: prompt.includes("Your previous answer was rejected"), ...extra });
  const keySource = outcome === "env_key" ? "ANTHROPIC_API_KEY" : "none";

  if (!existsSync(credentials()) && !current.foreignLogin) {
    emit({ type: "system", subtype: "init", model, apiKeySource: keySource, tools: ["StructuredOutput"] });
    emit({ type: "assistant", error: "authentication_failed", is_api_error_message: true, message: { model: "<synthetic>", content: [{ type: "text", text: "Not logged in · Please run /login" }] } });
    emit({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" });
    done();
    return;
  }
  if (outcome === "crash" || (outcome === "crash_once" && callsSoFar === 0)) {
    emit({ type: "system", subtype: "init", model, apiKeySource: keySource, tools: ["StructuredOutput"] });
    done({ crashed: true });
    process.exit(1);
  }
  if (outcome === "slow") await sleep(current.slowMs ?? 10_000);
  const mcpIndex = args.indexOf("--mcp-config");
  let nativeRpc: ((method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>) | null = null;
  let nativeTools: string[] = [];
  if (mcpIndex >= 0) {
    const mcp = JSON.parse(readFileSync(args[mcpIndex + 1], "utf8")).mcpServers.agentsdr;
    let id = 0;
    nativeRpc = async (method, params = {}) => {
      const response = await fetch(mcp.url, { method: "POST", headers: { ...mcp.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
      if (!response.ok) throw new Error(`Fake native MCP refused (${response.status})`);
      const body = await response.json() as { result?: Record<string, unknown>; error?: unknown };
      if (body.error) throw new Error("Fake native MCP error");
      return body.result ?? {};
    };
    await nativeRpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fake-claude", version: "1.0.0" } });
    const list = await nativeRpc("tools/list");
    nativeTools = (list.tools as Array<{ name: string }>).map((tool) => `mcp__agentsdr__${tool.name}`);
  }
  const first = current.nativeSteps?.[0];
  const early = current.nativeCallBeforeInit && nativeRpc && first ? nativeRpc("tools/call", { name: first.name, arguments: first.args ?? {} }) : null;
  emit({ type: "system", subtype: "init", model, apiKeySource: keySource, tools: current.nativeInitTools ?? ["StructuredOutput", ...nativeTools] });
  const resetsAt = Math.floor(Date.now() / 1000) + 3_600;
  if (outcome === "opus_limit") {
    emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: resetsAt + 86_400, rateLimitType: "seven_day_opus", isUsingOverage: false } });
    emit({ type: "assistant", error: "rate_limit", is_api_error_message: true, message: { model: "<synthetic>", content: [{ type: "text", text: "You've hit your weekly Opus limit" }] } });
    emit({ type: "result", subtype: "success", is_error: true, api_error: "usage_limit_reached", result: "You've hit your weekly Opus limit" });
    done();
    return;
  }
  if (outcome === "overage") {
    emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt, rateLimitType: "five_hour", isUsingOverage: true, overageStatus: "allowed", unifiedWindows: { five_hour: { utilization: 1, resetsAt } } } });
    const answer = current.answer ?? example(schema);
    emit({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(answer), structured_output: answer, usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 20, output_tokens: 30 } });
    done();
    return;
  }
  if (outcome === "limit" || outcome === "past_limit") {
    const reset = outcome === "past_limit" ? resetsAt - 4 * 3_600 : resetsAt;
    emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: reset, rateLimitType: "five_hour", isUsingOverage: false, unifiedWindows: { five_hour: { utilization: 1, resetsAt }, seven_day: { utilization: 0.4, resetsAt: resetsAt + 86_400 } } } });
    emit({ type: "assistant", error: "rate_limit", is_api_error_message: true, message: { model: "<synthetic>", content: [{ type: "text", text: "You've hit your 5-hour limit · resets 6pm" }] } });
    emit({ type: "result", subtype: "success", is_error: true, api_error: "usage_limit_reached", result: "You've hit your 5-hour limit · resets 6pm" });
    done();
    return;
  }
  emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt, rateLimitType: "five_hour", isUsingOverage: false, unifiedWindows: { five_hour: { utilization: 0.3, resetsAt }, seven_day: { utilization: 0.37, resetsAt: resetsAt + 86_400 } } } });
  if (outcome === "signed_out") {
    emit({ type: "assistant", error: "authentication_failed", is_api_error_message: true, message: { model: "<synthetic>", content: [{ type: "text", text: "Login expired · Please run /login" }] } });
    emit({ type: "result", subtype: "success", is_error: true, result: "Login expired · Please run /login" });
  } else if (outcome === "model_unavailable") {
    emit({ type: "assistant", error: "model_not_found", is_api_error_message: true, message: { model: "<synthetic>", content: [{ type: "text", text: `There's an issue with the selected model (${model}). It may not exist or you may not have access to it.` }] } });
    emit({ type: "result", subtype: "success", is_error: true, api_error_status: 404, result: "model not found" });
  } else if (outcome === "overloaded") {
    emit({ type: "assistant", error: "overloaded", is_api_error_message: true, message: { model: "<synthetic>", content: [{ type: "text", text: "API Error: 529 Overloaded" }] } });
    emit({ type: "result", subtype: "success", is_error: true, api_error_status: 529, result: "API Error: 529 Overloaded" });
  } else if (outcome === "prose") {
    emit({ type: "result", subtype: "success", is_error: false, result: "I think the answer is fine.", usage: { input_tokens: 40, output_tokens: 8 } });
  } else {
    let previous: Record<string, unknown> = {};
    for (const [index, step] of (nativeRpc ? current.nativeSteps ?? [] : []).entries()) {
      if (!nativeRpc) throw new Error("Native tools were requested without an MCP connection");
      const result = index === 0 && early ? await early : await nativeRpc("tools/call", { name: step.name, arguments: { ...(step.copyPrevious ? previous : {}), ...step.args } });
      previous = ((result.structuredContent as { data?: Record<string, unknown> } | undefined)?.data) ?? {};
    }
    const answer = current.answer ?? example(schema);
    emit({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(answer), structured_output: answer, usage: { input_tokens: 120, output_tokens: 30 }, total_cost_usd: 0.0004 });
  }
  done();
}

async function login() {
  const current = scenario();
  if (current.noLink) {
    await sleep(60_000);
    return;
  }
  process.stdout.write("Opening browser to sign in…\n");
  process.stdout.write("https://claude.com/cai/oauth/authorize?code=true&client_id=fake&response_type=code&state=fake-state\n");
  process.stdout.write("Paste code here if prompted > ");
  const line = await new Promise<string>((resolve) => {
    let buffered = "";
    process.stdin.on("data", (chunk) => {
      buffered += chunk.toString();
      if (buffered.includes("\n")) resolve(buffered.split("\n")[0]);
    });
    process.stdin.on("end", () => resolve(buffered));
  });
  // Only whether it matched is recorded; the code itself is not written anywhere.
  record({ codeAccepted: line.trim() === VALID_CODE });
  if (line.trim() !== VALID_CODE) {
    process.stdout.write("\nOAuth error: Invalid code\n");
    process.exit(1);
  }
  const method = args.find((arg) => ["--claudeai", "--console", "--sso"].includes(arg))?.slice(2) ?? "claudeai";
  writeFileSync(credentials(), JSON.stringify({ fake: true, method }), { mode: 0o600 });
  process.stdout.write("\nLogin successful.\n");
  process.exit(0);
}

async function main() {
  if (args[0] === "--version") {
    process.stdout.write("2.1.306 (Claude Code)\n");
    return;
  }
  if (args[0] === "auth" && args[1] === "status") {
    const signedIn = existsSync(credentials());
    const foreign = !signedIn && scenario().foreignLogin === true;
    record();
    process.stdout.write(`${JSON.stringify({ loggedIn: signedIn || foreign, authMethod: signedIn ? "claude.ai" : foreign ? "oauth_token" : "none", apiProvider: "firstParty", configDirectory: config })}\n`);
    process.exit(signedIn || foreign ? 0 : 1);
  }
  if (args[0] === "auth" && args[1] === "login") return login();
  if (args[0] === "auth" && args[1] === "logout") {
    rmSync(credentials(), { force: true });
    record();
    process.stdout.write("Successfully logged out from your Anthropic account.\n");
    return;
  }
  if (args.includes("-p")) return generate();
  process.stderr.write(`fake claude: unsupported arguments ${args.join(" ")}\n`);
  process.exit(2);
}

await main();

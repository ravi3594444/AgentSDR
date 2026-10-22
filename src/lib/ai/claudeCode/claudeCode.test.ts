import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeStructured } from "@/lib/ai/server/structuredCompletion";
import { accountAuthStatus, accountPaths, setClaudeCliForTests, setClaudeDataDirForTests, type ClaudeAccount } from "./cli.server";
import { claudeLoginCode, claudeLoginPrompt, claudeSignInLink, GENERATION_SETTINGS, generationArgs, limitRefusal, parseAuthStatus, readGeneration } from "./cliOutput";
import { normalizeClaudeEngine } from "./engine.server";
import { ClaudeLoginController } from "./login.server";
import { accountUsage, claudeHoldUntil, ClaudeCodeError, resetRunnerForTests, runGeneration, runningOn } from "./runner.server";
import { claudeCodeRuntime } from "./runtime.server";

// Every case starts several CLI processes.
setDefaultTimeout(30_000);

const FAKE = join(import.meta.dir, "testing", "fake-claude.ts");
const VALID_CODE = "GOOD-CODE-1234#state";
const TIMINGS = { startupMs: 8_000, lifetimeMs: 60_000, completeMs: 15_000 };

// Real frames from Claude Code 2.1.306, 21 Oct 2026 (ids and timings trimmed).
const REAL_LOGIN_OUTPUT = "Opening browser to sign in…\nhttps://claude.com/cai/oauth/authorize?code=true&client_id=x&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=c&code_challenge_method=S256&state=s\nPaste code here if prompted > ";
const REAL_GENERATION = [
  JSON.stringify({ type: "system", subtype: "init", model: "claude-haiku-5-5", apiKeySource: "none", tools: ["StructuredOutput"] }),
  JSON.stringify({ type: "assistant", message: { model: "claude-haiku-5-5", content: [{ type: "tool_use", name: "StructuredOutput", input: { kind: "fruit", reason: "An apple is a fruit." } }] } }),
  JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1792613400, rateLimitType: "five_hour", overageStatus: "rejected", isUsingOverage: false, unifiedWindows: { five_hour: { utilization: 0.3, resetsAt: 1792613400 }, seven_day: { utilization: 0.37, resetsAt: 1793000000 } } } }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "{\"kind\":\"fruit\",\"reason\":\"An apple is a fruit.\"}", structured_output: { kind: "fruit", reason: "An apple is a fruit." }, usage: { input_tokens: 5, output_tokens: 40 }, stop_reason: "tool_use" }),
];

let dataDir = "";
const SCHEMA = { type: "object", properties: { verdict: { type: "string", enum: ["match", "no_match"] }, reason: { type: "string" } }, required: ["verdict", "reason"], additionalProperties: false };

function account(organizationId = randomUUID()): ClaudeAccount {
  return { organizationId, userId: randomUUID() };
}
function setScenario(target: ClaudeAccount, scenario: Record<string, unknown>) {
  writeFileSync(join(accountPaths(target).config, "fake-scenario.json"), JSON.stringify(scenario));
}
function calls(target: ClaudeAccount): Array<Record<string, unknown>> {
  const file = join(accountPaths(target, false).config, "fake-calls.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) : [];
}
const generations = (target: ClaudeAccount) => calls(target).filter((call) => (call.args as string[]).includes("-p"));
function controller(target: ClaudeAccount) {
  return new ClaudeLoginController(target, TIMINGS, () => runningOn(target));
}
async function signIn(target: ClaudeAccount) {
  const login = controller(target);
  const started = await login.start("claudeai");
  expect(started.phase).toBe("waiting");
  const done = await login.complete(started.flowId, VALID_CODE);
  expect(done.phase).toBe("succeeded");
  return login;
}
/** Files under `dir`, leaving out Bun's own cache (the fake CLI runs on Bun, and the cache holds its source). */
function allFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name !== ".cache" && name !== ".bun").flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? allFiles(path) : [path];
  });
}
const generation = (target: ClaudeAccount, timeoutMs = 20_000) => runGeneration({ account: target, model: "sonnet", systemPrompt: "Judge the lead.", userPrompt: "Lead: Acme Dental, Miami.", jsonSchema: SCHEMA, timeoutMs });

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), "agentsdr-claude-code-"));
  setClaudeDataDirForTests(dataDir);
  setClaudeCliForTests({ command: process.execPath, args: [FAKE] });
});
afterAll(() => {
  setClaudeCliForTests(null);
  setClaudeDataDirForTests(null);
  rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => resetRunnerForTests());

describe("reading the CLI", () => {
  test("shows only Anthropic's own https sign-in links", () => {
    expect(claudeLoginPrompt(REAL_LOGIN_OUTPUT)?.authorizationUrl.startsWith("https://claude.com/cai/oauth/authorize?")).toBe(true);
    expect(claudeSignInLink("https://evil.example/claude.com")).toBeNull();
    expect(claudeSignInLink("http://claude.com/x")).toBeNull();
    expect(claudeSignInLink("https://user:pw@claude.ai/x")).toBeNull();
    expect(claudeSignInLink("https://claude.com.evil.example/x")).toBeNull();
    // A link on an unfinished line is not read yet.
    expect(claudeLoginPrompt("https://claude.com/cai/oauth/authorize?code=true")).toBeNull();
  });

  test("accepts a pasted code only in the shape Anthropic shows", () => {
    expect(claudeLoginCode(`  ${VALID_CODE}\n`)).toBe(VALID_CODE);
    expect(claudeLoginCode("short")).toBeNull();
    expect(claudeLoginCode("has spaces in it")).toBeNull();
    expect(claudeLoginCode("abc;rm -rf /")).toBeNull();
  });

  test("auth status: in, out or unknown", () => {
    expect(parseAuthStatus("{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"configDirectory\":\"/x\"}", 0)).toEqual({ state: "in", method: "claude.ai", configDirectory: "/x" });
    expect(parseAuthStatus("{\"loggedIn\":false}", 1).state).toBe("out");
    expect(parseAuthStatus("{\"loggedIn\":true}", 1).state).toBe("unknown");
    expect(parseAuthStatus("not json", 0).state).toBe("unknown");
  });

  test("a generation runs with no tools, no file reads, no settings, no MCP and nothing kept", () => {
    const args = generationArgs({ model: "default", systemPromptFile: "/w/system-prompt.txt", jsonSchema: SCHEMA });
    // The CLI reads `@path` mentions in a prompt even with no tools; only a Read deny stops it (probed on 2.1.306).
    expect(JSON.parse(args[args.indexOf("--settings") + 1]).permissions.deny).toContain("Read");
    expect(args[args.indexOf("--settings") + 1]).toBe(GENERATION_SETTINGS);
    // The system prompt goes in a file, not on the command line.
    expect(args).not.toContain("--system-prompt");
    expect(args[args.indexOf("--system-prompt-file") + 1]).toBe("/w/system-prompt.txt");
    expect(args).toContain("-p");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    for (const flag of ["--no-session-persistence", "--strict-mcp-config", "--disable-slash-commands", "--json-schema"]) expect(args).toContain(flag);
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--bare");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(generationArgs({ model: "opus", systemPromptFile: "/w/s", jsonSchema: SCHEMA })).toContain("opus");
  });

  test("real 2.1.306 frames: the structured answer, the model, usage and the reported windows", () => {
    const outcome = readGeneration(REAL_GENERATION);
    expect(outcome.failure).toBeNull();
    expect(JSON.parse(outcome.text!)).toEqual({ kind: "fruit", reason: "An apple is a fruit." });
    expect(outcome.modelId).toBe("claude-haiku-5-5");
    expect(outcome.usage).toEqual({ inputTokens: 5, outputTokens: 40 });
    expect(outcome.windows.map((window) => window.window)).toEqual(["five_hour", "seven_day"]);
    expect(outcome.windows[0].utilization).toBe(0.3);
  });

  test("failures: sign-out, usage limit with its reset, model, transient, unfinished", () => {
    const signedOut = readGeneration([
      JSON.stringify({ type: "assistant", error: "authentication_failed", is_api_error_message: true, message: { content: [{ type: "text", text: "Not logged in · Please run /login" }] } }),
      JSON.stringify({ type: "result", is_error: true }),
    ]);
    expect(signedOut.failure?.kind).toBe("signed_out");
    const limited = readGeneration([
      JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1792613400, rateLimitType: "seven_day", isUsingOverage: false } }),
      JSON.stringify({ type: "result", is_error: true, api_error: "usage_limit_reached", result: "You've hit your weekly limit" }),
    ]);
    expect(limited.failure?.kind).toBe("limit");
    expect(limited.failure?.kind === "limit" && limited.failure.limit.resetsAt).toBe(new Date(1792613400 * 1000).toISOString());
    expect(limited.failure?.kind === "limit" && limited.failure.limit.message).toContain("weekly limit");
    // Extra usage paying for the call is not a refusal.
    expect(limitRefusal({ status: "rejected", isUsingOverage: true })).toBeNull();
    expect(readGeneration([JSON.stringify({ type: "result", is_error: true, api_error_status: 404, result: "model not found" })]).failure?.kind).toBe("model_unavailable");
    expect(readGeneration([JSON.stringify({ type: "result", is_error: true, api_error_status: 529, result: "API Error: 529 Overloaded" })]).failure?.kind).toBe("transient");
    expect(readGeneration([JSON.stringify({ type: "system", subtype: "init", model: "m" })]).finished).toBe(false);
  });

  test("engine settings: selection needs an owner; checks are kept per person", () => {
    expect(normalizeClaudeEngine({ selected: true }).selected).toBe(false);
    const engine = normalizeClaudeEngine({ selected: true, ownerUserId: "u1", model: "opus", checks: { u1: { opus: { ok: true, modelId: "claude-opus-5-5", checkedAt: "t" }, bogus: { ok: true } }, u2: "x" } });
    expect(engine).toEqual({ selected: true, ownerUserId: "u1", model: "opus", checks: { u1: { opus: { ok: true, modelId: "claude-opus-5-5", checkedAt: "t" } } } });
    expect(normalizeClaudeEngine({ model: "gpt-5" }).model).toBe("default");
  });
});

describe("signing in through the CLI (fake CLI)", () => {
  test("success: the official link, the code once to the same process, confirmed by auth status", async () => {
    const target = account();
    const login = controller(target);
    const started = await login.start("claudeai");
    expect(started.authorizationUrl?.startsWith("https://claude.com/")).toBe(true);
    const done = await login.complete(started.flowId, VALID_CODE);
    expect(done.phase).toBe("succeeded");
    expect((await accountAuthStatus(target)).state).toBe("in");
    await expect(login.complete(started.flowId, VALID_CODE)).rejects.toThrow("no longer available");
    // The code reached the CLI once and is in no file this app wrote.
    expect(calls(target).filter((call) => "codeAccepted" in call)).toHaveLength(1);
    for (const file of allFiles(accountPaths(target).root)) expect(readFileSync(file, "utf8")).not.toContain(VALID_CODE);
  });

  test("the CLI's other sign-in choices are passed through", async () => {
    const target = account();
    const login = controller(target);
    const started = await login.start("console");
    await login.complete(started.flowId, VALID_CODE);
    const loginCall = calls(target).find((call) => (call.args as string[])[1] === "login");
    expect(loginCall?.args).toEqual(["auth", "login", "--console"]);
  });

  test("cancel stops the CLI; a wrong code fails with Anthropic's refusal; no link in time fails", async () => {
    const cancelled = account();
    const login = controller(cancelled);
    await login.start("claudeai");
    await login.cancel();
    expect(login.current()?.phase).toBe("cancelled");
    expect((await accountAuthStatus(cancelled)).state).toBe("out");

    const wrong = account();
    const second = controller(wrong);
    const started = await second.start("claudeai");
    const failed = await second.complete(started.flowId, "WRONG-CODE-999");
    expect(failed.phase).toBe("failed");
    expect(failed.message).toContain("did not accept");

    const silent = account();
    setScenario(silent, { noLink: true });
    const third = new ClaudeLoginController(silent, { ...TIMINGS, startupMs: 1_500 });
    await expect(third.start("claudeai")).rejects.toThrow("did not show a sign-in link");
  });

  test("sign out, then reconnect; sign-out waits while a generation runs", async () => {
    const target = account();
    const login = await signIn(target);
    setScenario(target, { generation: "slow", slowMs: 2_500 });
    const running = generation(target);
    await Bun.sleep(400);
    await expect(login.signOut()).rejects.toThrow("running on this Claude login");
    // A second Sign in while one is being set up is refused, not a second CLI login.
    const racing = account();
    const raceLogin = controller(racing);
    const [first, second] = await Promise.allSettled([raceLogin.start("claudeai"), raceLogin.start("claudeai")]);
    expect([first.status, second.status].sort()).toEqual(["fulfilled", "rejected"]);
    await raceLogin.cancel();
    await running;
    await login.signOut();
    expect((await accountAuthStatus(target)).state).toBe("out");
    await expect(generation(target)).rejects.toMatchObject({ kind: "not_signed_in", status: 401 });
    await signIn(target);
    setScenario(target, {});
    expect(JSON.parse((await generation(target)).text).verdict).toBe("match");
  });

  test("a restart ends a sign-in in progress but keeps the CLI's login on disk", async () => {
    const pending = account();
    const before = controller(pending);
    const started = await before.start("claudeai");
    const after = controller(pending); // a new process has new controllers
    await expect(after.complete(started.flowId, VALID_CODE)).rejects.toThrow("no longer available");
    await before.cancel();

    const signedIn = account();
    await signIn(signedIn);
    resetRunnerForTests();
    expect((await accountAuthStatus(signedIn)).state).toBe("in");
    expect(JSON.parse((await generation(signedIn)).text).verdict).toBe("match");
  });
});

describe("accounts stay apart (fake CLI)", () => {
  test("each account has its own directories; B never runs on A's login", async () => {
    const organizationId = randomUUID();
    const a = account(organizationId);
    const b = account(organizationId);
    const other = account();
    await signIn(a);
    expect((await accountAuthStatus(b)).state).toBe("out");
    expect((await accountAuthStatus(other)).state).toBe("out");
    await expect(generation(b)).rejects.toMatchObject({ kind: "not_signed_in" });
    await expect(generation(other)).rejects.toMatchObject({ kind: "not_signed_in" });
    expect(generations(b)).toHaveLength(0);
    await generation(a);
    const [call] = generations(a);
    expect(call.home).toBe(accountPaths(a).home);
    expect(String(call.cwd).startsWith(accountPaths(a).work)).toBe(true);
    expect(readdirSync(accountPaths(a).work)).toHaveLength(0);
  });

  test("a login the CLI reports from elsewhere on the machine is not this account's", async () => {
    const target = account();
    setScenario(target, { foreignLogin: true });
    const auth = await accountAuthStatus(target);
    expect(auth.state).toBe("out");
    expect(auth.own).toBe(false);
    await expect(generation(target)).rejects.toMatchObject({ kind: "not_signed_in" });
    expect(generations(target)).toHaveLength(0);
  });

  test("the CLI gets an allowlisted environment: no server secrets, no inherited Anthropic credentials", async () => {
    const saved = { DATABASE_URL: process.env.DATABASE_URL, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN, INTEGRATION_CREDENTIALS_KEY: process.env.INTEGRATION_CREDENTIALS_KEY };
    process.env.DATABASE_URL = "postgres://secret@db/agentsdr";
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-reach";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "someone-elses-login";
    process.env.INTEGRATION_CREDENTIALS_KEY = "k";
    try {
      const target = account();
      await signIn(target);
      await generation(target);
      const keys = generations(target)[0].envKeys as string[];
      for (const key of ["DATABASE_URL", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "INTEGRATION_CREDENTIALS_KEY", "BETTER_AUTH_SECRET"]) expect(keys).not.toContain(key);
      for (const key of ["HOME", "CLAUDE_CONFIG_DIR", "DISABLE_AUTOUPDATER"]) expect(keys).toContain(key);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("structured answers through completeStructured (fake CLI)", () => {
  test("one shared account serializes independent tasks and uses fresh working directories", async () => {
    const target = account();
    await signIn(target);
    setScenario(target, { generation: "slow", slowMs: 150 });
    const first = generation(target);
    const second = generation(target);
    await Promise.all([first, second]);
    const records = generations(target);
    expect(records).toHaveLength(2);
    expect(Number(records[1].startedAt)).toBeGreaterThanOrEqual(Number(records[0].endedAt));
    expect(records[0].cwd).not.toBe(records[1].cwd);
    for (const record of records) {
      expect(record.args).toContain("--no-session-persistence");
      expect(record.args).not.toContain("--resume");
      expect(record.args).not.toContain("--continue");
    }
    expect(readdirSync(accountPaths(target).work)).toHaveLength(0);
  });

  test("a queued task rechecks an account-wide hold before starting", async () => {
    const target = account();
    await signIn(target);
    setScenario(target, { generation: "limit" });
    const tasks = await Promise.allSettled([generation(target), generation(target)]);
    expect(tasks.every((task) => task.status === "rejected" && task.reason instanceof ClaudeCodeError && task.reason.kind === "limit")).toBe(true);
    expect(generations(target)).toHaveLength(1);
  });

  test("approval revoked while a task waits prevents its generation", async () => {
    const target = account();
    await signIn(target);
    setScenario(target, { generation: "slow", slowMs: 150 });
    const first = generation(target);
    let rechecked = false;
    const second = runGeneration({ account: target, model: "sonnet", systemPrompt: "Second workspace", userPrompt: "Separate task", jsonSchema: SCHEMA, timeoutMs: 10_000, authorize: async () => { rechecked = true; throw new ClaudeCodeError("error", "Workspace approval revoked"); } });
    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes[0].status).toBe("fulfilled");
    expect(outcomes[1].status).toBe("rejected");
    expect(rechecked).toBe(true);
    expect(generations(target)).toHaveLength(1);
    expect(runningOn(target)).toBe(0);
  });

  async function bound(scenario: Record<string, unknown> = {}) {
    const target = account();
    await signIn(target);
    setScenario(target, scenario);
    return { target, runtime: async () => claudeCodeRuntime({ account: target, model: "sonnet" }, 20_000) };
  }
  const ask = (runtime: () => Promise<ReturnType<typeof claudeCodeRuntime>>, accept?: (text: string) => void) => completeStructured({
    timeoutMs: 20_000,
    systemPrompt: "Judge the lead.",
    userPrompt: "Lead: Acme Dental, Miami.",
    maxOutputTokens: 400,
    jsonSchema: SCHEMA,
    schemaName: "judge_lead",
    accept,
  }, { runtime, sleep: async () => {} });

  test("a valid answer passes the caller's schema validation unchanged", async () => {
    const { runtime } = await bound({ answer: { verdict: "no_match", reason: "Not in Miami." } });
    const result = await ask(runtime, (text) => { if (!["match", "no_match"].includes(JSON.parse(text).verdict)) throw new Error("bad verdict"); });
    expect(JSON.parse(result.text)).toEqual({ verdict: "no_match", reason: "Not in Miami." });
    expect(result.provider).toBe("claude-code");
    expect(result.attempts).toBe(1);
  });

  test("an answer that is not JSON, or that the caller rejects, is retried with the reason and then fails", async () => {
    const prose = await bound({ generation: "prose" });
    await expect(ask(prose.runtime)).rejects.toThrow("not a JSON object");
    expect(generations(prose.target)).toHaveLength(3);

    const rejected = await bound({ answer: { verdict: "match", reason: "" } });
    await expect(ask(rejected.runtime, (text) => { if (!JSON.parse(text).reason) throw new Error("reason is empty"); })).rejects.toThrow("reason is empty");
    const attempts = generations(rejected.target);
    expect(attempts).toHaveLength(3);
    expect(attempts[1].rejectedFeedback).toBe(true);
  });

  test("a usage limit stops at once, is not retried, and holds later calls without starting the CLI", async () => {
    const { target, runtime } = await bound({ generation: "limit" });
    const failure = await ask(runtime).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ClaudeCodeError);
    expect(failure).toMatchObject({ kind: "limit", status: 402 });
    expect((failure as Error).message).toContain("5-hour limit");
    expect((failure as Error).message).toContain("nothing is sent to another provider");
    expect(generations(target)).toHaveLength(1);
    await expect(ask(runtime)).rejects.toMatchObject({ kind: "limit" });
    expect(generations(target)).toHaveLength(1);
    const usage = accountUsage(target);
    expect(usage.limits[0]?.resetsAt).not.toBeNull();
    expect((failure as ClaudeCodeError).retryAt?.toISOString()).toBe(usage.limits[0]?.resetsAt ?? "");
    expect(claudeHoldUntil(failure)?.toISOString()).toBe(usage.limits[0]?.resetsAt ?? "");
    expect(claudeHoldUntil(new ClaudeCodeError("signed_out", "x"))).toBeNull();
    expect(usage.windows.find((window) => window.window === "five_hour")?.utilization).toBe(1);
    // Once the reported reset has passed, calls run again.
    expect(accountUsage(target, Date.now() + 2 * 3_600_000).limits).toHaveLength(0);
  });

  test("one model's weekly limit holds only that model; a model check still runs while held", async () => {
    const { target } = await bound({ generation: "opus_limit" });
    const opus = { account: target, model: "opus" as const, systemPrompt: "S", userPrompt: "U", jsonSchema: SCHEMA, timeoutMs: 20_000 };
    await expect(runGeneration(opus)).rejects.toMatchObject({ kind: "limit" });
    expect(accountUsage(target).limits).toMatchObject([{ window: "seven_day_opus", model: "opus", modelSpecific: true }]);
    setScenario(target, {});
    const callsBefore = generations(target).length;
    await expect(runGeneration(opus)).rejects.toMatchObject({ kind: "limit" });
    expect(generations(target)).toHaveLength(callsBefore);
    expect(JSON.parse((await generation(target)).text).verdict).toBe("match");
    expect(JSON.parse((await runGeneration({ ...opus, ignoreHolds: true })).text).verdict).toBe("match");
  });

  test("extra usage: the answer already billed is kept, then the account is held and nothing more runs", async () => {
    const { target, runtime } = await bound({ generation: "overage" });
    const first = await ask(runtime);
    expect(JSON.parse(first.text).verdict).toBe("match");
    // Cached prompt tokens count as input (10 + 90 + 20).
    expect(first.usage.inputTokens).toBe(120);
    const held = await ask(runtime).catch((error: unknown) => error);
    expect(held).toMatchObject({ kind: "overage", status: 402 });
    expect((held as Error).message).toContain("extra usage");
    expect(generations(target)).toHaveLength(1);
  });

  test("a credential from the server's own settings is refused, its answer not used, and later calls held", async () => {
    const { target, runtime } = await bound({ generation: "env_key" });
    await expect(ask(runtime)).rejects.toThrow("not this account's own login");
    setScenario(target, {});
    await expect(generation(target)).rejects.toThrow("not this account's own login");
    expect(generations(target)).toHaveLength(1);
  });

  test("an account-wide limit holds model checks too", async () => {
    const { target } = await bound({ generation: "limit" });
    await expect(generation(target)).rejects.toMatchObject({ kind: "limit" });
    setScenario(target, {});
    await expect(runGeneration({ account: target, model: "opus", systemPrompt: "S", userPrompt: "U", jsonSchema: SCHEMA, timeoutMs: 20_000, ignoreHolds: true })).rejects.toMatchObject({ kind: "limit" });
    expect(generations(target)).toHaveLength(1);
  });

  test("a reported reset already past still holds for a few minutes, so a clock ahead cannot spin", async () => {
    const { target } = await bound({ generation: "past_limit" });
    const failure = await generation(target).catch((error: unknown) => error);
    expect(failure).toMatchObject({ kind: "limit" });
    expect((failure as ClaudeCodeError).retryAt!.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
    await expect(generation(target)).rejects.toMatchObject({ kind: "limit" });
    expect(generations(target)).toHaveLength(1);
  });

  test("a CLI that exits before reading its prompt fails the call, not the server, and is not retried", async () => {
    const { target, runtime } = await bound({ generation: "bad_flag" });
    const big = "Lead notes. ".repeat(200_000);
    await expect(runGeneration({ account: target, model: "sonnet", systemPrompt: "S", userPrompt: big, jsonSchema: SCHEMA, timeoutMs: 20_000 })).rejects.toMatchObject({ kind: "error", retryable: false });
    await expect(ask(runtime)).rejects.toThrow("before answering");
    expect(generations(target)).toHaveLength(2);
    expect(runningOn(target)).toBe(0);
  });

  test("a call aborted while it waits for a slot never starts the CLI", async () => {
    const saved = process.env.AGENTSDR_CLAUDE_CODE_MAX_PROCESSES;
    process.env.AGENTSDR_CLAUDE_CODE_MAX_PROCESSES = "1";
    try {
      const { target } = await bound({ generation: "slow", slowMs: 1_500 });
      const holder = generation(target);
      await Bun.sleep(300);
      const aborted = new AbortController();
      const waiting = runGeneration({ account: target, model: "sonnet", systemPrompt: "S", userPrompt: "U", jsonSchema: SCHEMA, timeoutMs: 20_000, signal: aborted.signal });
      aborted.abort(new Error("cancelled"));
      await expect(waiting).rejects.toThrow("cancelled");
      await holder;
      expect(generations(target)).toHaveLength(1);
      expect(runningOn(target)).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.AGENTSDR_CLAUDE_CODE_MAX_PROCESSES;
      else process.env.AGENTSDR_CLAUDE_CODE_MAX_PROCESSES = saved;
    }
  });

  test("a login the CLI refused as signed out shows as expired, and Sign in runs the CLI login again", async () => {
    const target = account();
    await signIn(target);
    setScenario(target, { generation: "signed_out" });
    await expect(generation(target)).rejects.toMatchObject({ kind: "signed_out" });
    expect(accountUsage(target).signedOutAt).not.toBeNull();
    // The stored file still says signed in; signing in again must still run the CLI's login.
    const login = controller(target);
    const started = await login.start("claudeai", true);
    expect(started.phase).toBe("waiting");
    expect((await login.complete(started.flowId, VALID_CODE)).phase).toBe("succeeded");
    expect(accountUsage(target).signedOutAt).toBeNull();
  });

  test("signing in again with a wrong code fails, though the old login file is still there", async () => {
    const target = account();
    await signIn(target);
    setScenario(target, { generation: "signed_out" });
    await expect(generation(target)).rejects.toMatchObject({ kind: "signed_out" });
    const login = controller(target);
    const started = await login.start("claudeai", true);
    const failed = await login.complete(started.flowId, "WRONG-CODE-999");
    expect(failed.phase).toBe("failed");
    expect(accountUsage(target).signedOutAt).not.toBeNull();
  });

  test("the model id the CLI ran is what the result records; the system prompt reached the CLI from its file", async () => {
    const { target, runtime } = await bound({});
    const result = await ask(runtime);
    expect(result.model).toBe("claude-sonnet-5-5");
    expect(generations(target)[0].systemPromptFromFile).toBeGreaterThan(0);
  });

  test("a call aborted before it starts never runs; a scratch directory that cannot be made leaks no slot", async () => {
    const { target } = await bound({});
    const aborted = new AbortController();
    aborted.abort(new Error("cancelled"));
    await expect(runGeneration({ account: target, model: "sonnet", systemPrompt: "S", userPrompt: "U", jsonSchema: SCHEMA, timeoutMs: 5_000, signal: aborted.signal })).rejects.toThrow("cancelled");
    expect(generations(target)).toHaveLength(0);
    const work = accountPaths(target).work;
    rmSync(work, { recursive: true, force: true });
    writeFileSync(work, "not a directory");
    try {
      await expect(generation(target)).rejects.toThrow();
      expect(runningOn(target)).toBe(0);
    } finally {
      rmSync(work, { force: true });
      accountPaths(target);
    }
    expect(JSON.parse((await generation(target)).text).verdict).toBe("match");
  });

  test("an expired login and an unavailable model are not retried", async () => {
    const expired = await bound({ generation: "signed_out" });
    await expect(ask(expired.runtime)).rejects.toMatchObject({ kind: "signed_out", status: 401 });
    expect(generations(expired.target)).toHaveLength(1);
    const model = await bound({ generation: "model_unavailable" });
    await expect(ask(model.runtime)).rejects.toMatchObject({ kind: "model_unavailable", status: 404 });
    expect(generations(model.target)).toHaveLength(1);
  });

  test("a CLI that dies mid-answer is retried; a hung one is stopped at the timeout", async () => {
    const crash = await bound({ generation: "crash_once" });
    const result = await ask(crash.runtime);
    expect(result.attempts).toBe(2);

    const hung = await bound({ generation: "slow", slowMs: 30_000 });
    const began = Date.now();
    await expect(runGeneration({ account: hung.target, model: "sonnet", systemPrompt: "S", userPrompt: "U", jsonSchema: SCHEMA, timeoutMs: 1_500 })).rejects.toMatchObject({ kind: "timeout", status: 504, retryable: false });
    expect(Date.now() - began).toBeLessThan(8_000);
    expect(runningOn(hung.target)).toBe(0);
  });

  test("a timeout or a busy server is not retried by completeStructured", async () => {
    const saved = process.env.AGENTSDR_CLAUDE_CODE_MAX_PROCESSES;
    process.env.AGENTSDR_CLAUDE_CODE_MAX_PROCESSES = "1";
    try {
      const hung = await bound({ generation: "slow", slowMs: 30_000 });
      const short = async () => claudeCodeRuntime({ account: hung.target, model: "sonnet" }, -18_500);
      const holder = ask(short).catch((error: unknown) => error);
      await Bun.sleep(300);
      // The one slot is taken: this call waits until its own 1 s deadline, then fails busy, once (three tries would take 3 s).
      const waitStarted = Date.now();
      const waiting = await completeStructured({ timeoutMs: -19_000, systemPrompt: "S", userPrompt: "U", maxOutputTokens: 100, jsonSchema: SCHEMA, schemaName: "judge_lead" }, { runtime: async () => claudeCodeRuntime({ account: hung.target, model: "sonnet" }, -19_000), sleep: async () => {} }).catch((error: unknown) => error);
      expect(waiting).toMatchObject({ kind: "busy", retryable: false });
      expect(Date.now() - waitStarted).toBeLessThan(2_500);
      // The holder timed out once: a retry would have outlived the 30 s hung CLI's first kill and started a second process.
      expect(await holder).toMatchObject({ kind: "timeout" });
      expect(runningOn(hung.target)).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.AGENTSDR_CLAUDE_CODE_MAX_PROCESSES;
      else process.env.AGENTSDR_CLAUDE_CODE_MAX_PROCESSES = saved;
    }
  });

  test("at most AGENTSDR_CLAUDE_CODE_MAX_PROCESSES generations run at once", async () => {
    const saved = process.env.AGENTSDR_CLAUDE_CODE_MAX_PROCESSES;
    process.env.AGENTSDR_CLAUDE_CODE_MAX_PROCESSES = "1";
    try {
      const { target } = await bound({ generation: "slow", slowMs: 800 });
      await Promise.all([generation(target), generation(target), generation(target)]);
      const spans = generations(target).map((call) => [Number(call.startedAt), Number(call.endedAt)] as const).sort((x, y) => x[0] - y[0]);
      expect(spans).toHaveLength(3);
      for (let index = 1; index < spans.length; index += 1) expect(spans[index][0]).toBeGreaterThanOrEqual(spans[index - 1][1] - 50);
    } finally {
      if (saved === undefined) delete process.env.AGENTSDR_CLAUDE_CODE_MAX_PROCESSES;
      else process.env.AGENTSDR_CLAUDE_CODE_MAX_PROCESSES = saved;
    }
  });
});

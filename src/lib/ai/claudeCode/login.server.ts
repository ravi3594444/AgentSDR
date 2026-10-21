import "server-only";

import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { accountAuthStatus, accountEnvironment, accountKey, accountPaths, runCliCommand, spawnCli, stopCli, type ClaudeAccount } from "./cli.server";
import { claudeLoginCode, claudeLoginPrompt, loginArgs } from "./cliOutput";
import type { ClaudeCodeLoginMethod, ClaudeCodeSignIn } from "./contract";

/**
 * Signs one account's CLI in from Settings: the unmodified `claude auth
 * login` runs with pipes, only its Anthropic sign-in link is shown, the code
 * Anthropic's page shows is written once to that same process's stdin, and
 * `claude auth status --json` confirms. The code is never stored or logged;
 * no OAuth client, cookie or password handling exists in this app (Anthropic
 * permits an end user signing in to the unmodified binary with their own
 * account and forbids intermediating claude.ai credentials).
 *
 * Adapted from OpenMausBot server/drivers/claude-login-auth.ts at commit
 * bdcfc44044bc1f59fb49b0315aae85fb3c502e93, Copyright 2026 Milind Soni and
 * OpenMausBot contributors, Apache License 2.0
 * (docs/third-party/openmausbot/LICENSE). Changes: one controller per
 * AgentSDR account (organization and person) with its own directories, the
 * CLI's login method passed through, sign-out refused while this account's
 * generations run, AgentSDR wording.
 *
 * Flows live in memory: a restart ends one in progress (the page then says
 * to start again); the CLI's own login on disk is what survives.
 */

const MAX_OUTPUT = 32_768;
const NOT_AVAILABLE = "This sign-in is no longer available. Start sign-in again.";
const UNREADABLE = "Claude Code's sign-in state could not be read on this server (its data directory may not be writable). Check the server, then start sign-in again.";

type Flow = {
  status: ClaudeCodeSignIn;
  child: ChildProcess | null;
  ready: boolean;
  codeSent: boolean;
  output: string;
  resolve: (value: ClaudeCodeSignIn) => void;
  reject: (error: Error) => void;
  startupTimer: NodeJS.Timeout;
  expiryTimer: NodeJS.Timeout;
  completion?: { resolve: () => void; reject: (error: Error) => void };
  stopping?: Promise<void>;
};

export type LoginTimings = { startupMs: number; lifetimeMs: number; completeMs: number };
const DEFAULT_TIMINGS: LoginTimings = { startupMs: 30_000, lifetimeMs: 15 * 60_000, completeMs: 60_000 };

export class ClaudeLoginController {
  private flow: Flow | null = null;
  private busy: Promise<unknown> | null = null;

  constructor(
    private readonly account: ClaudeAccount,
    private readonly timings: LoginTimings = DEFAULT_TIMINGS,
    /** Generations running on this account now; sign-out waits for none. */
    private readonly running: () => number = () => 0,
  ) {}

  current(): ClaudeCodeSignIn | null {
    return this.flow ? { ...this.flow.status } : null;
  }

  async start(method: ClaudeCodeLoginMethod): Promise<ClaudeCodeSignIn> {
    if (this.flow?.status.phase === "waiting") {
      if (this.flow.ready) return { ...this.flow.status };
      throw new Error("A Claude sign-in is already starting. Wait for its link.");
    }
    if (this.busy) throw new Error("Claude Code is still signing out. Try again in a moment.");
    await this.flow?.stopping;
    return new Promise<ClaudeCodeSignIn>((resolveStart, reject) => {
      const flow: Flow = {
        status: { phase: "waiting", flowId: randomUUID(), authorizationUrl: null, expiresAt: new Date(Date.now() + this.timings.lifetimeMs).toISOString() },
        child: null,
        ready: false,
        codeSent: false,
        output: "",
        resolve: resolveStart,
        reject,
        startupTimer: setTimeout(() => this.finish(flow, "failed", "Claude Code did not show a sign-in link in time. Check that it is installed and up to date on this server, then try again."), this.timings.startupMs),
        expiryTimer: setTimeout(() => this.finish(flow, "expired", "The Claude sign-in link expired. Start sign-in again."), this.timings.lifetimeMs),
      };
      flow.startupTimer.unref();
      flow.expiryTimer.unref();
      this.flow = flow;
      // Never replace a working login because Sign in was clicked twice.
      void accountAuthStatus(this.account).then((auth) => {
        if (flow.status.phase !== "waiting") return;
        if (auth.state === "in") this.finish(flow, "succeeded");
        else this.login(flow, method);
      }, () => this.finish(flow, "failed", UNREADABLE));
    });
  }

  async complete(flowId: string, pasted: string): Promise<ClaudeCodeSignIn> {
    const flow = this.flow;
    if (!flowId || flow?.status.flowId !== flowId || flow.status.phase !== "waiting" || !flow.ready) throw new Error(NOT_AVAILABLE);
    if (flow.codeSent) throw new Error("A code was already sent for this sign-in. Wait for the result, or cancel and start again.");
    const code = claudeLoginCode(pasted);
    if (!code) throw new Error("Paste the whole code Anthropic's page shows after you sign in.");
    const stdin = flow.child?.stdin;
    if (!flow.child || !stdin || flow.child.exitCode !== null || flow.child.signalCode !== null) throw new Error(NOT_AVAILABLE);
    flow.codeSent = true;
    await new Promise<void>((resolveDone, rejectDone) => {
      flow.completion = { resolve: resolveDone, reject: rejectDone };
      const timer = setTimeout(() => this.finish(flow, "failed", "Claude Code did not finish the sign-in after the code was entered. Start sign-in again."), this.timings.completeMs);
      timer.unref();
      // Written once, to the process that asked for it; it is not kept anywhere.
      stdin.write(`${code}\n`, (error) => {
        if (error) this.finish(flow, "failed", "The code could not be handed to Claude Code on this server. Start sign-in again.");
      });
    }).catch(() => undefined);
    return { ...flow.status };
  }

  async cancel(): Promise<void> {
    if (this.flow?.status.phase === "waiting") this.finish(this.flow, "cancelled", "Claude sign-in cancelled.");
    await this.flow?.stopping;
  }

  /** Signs this account's CLI out (`claude auth logout`) and confirms it. Refused while a sign-in or a generation runs. */
  async signOut(): Promise<void> {
    if (this.flow?.status.phase === "waiting") throw new Error("Finish or cancel the Claude sign-in in progress before signing out.");
    if (this.running() > 0) throw new Error(`${this.running()} AI ${this.running() === 1 ? "step is" : "steps are"} running on this Claude login. Sign out when ${this.running() === 1 ? "it finishes" : "they finish"}.`);
    if (this.busy) throw new Error("Claude Code is already signing out.");
    const run = (async () => {
      const paths = accountPaths(this.account);
      const result = await runCliCommand(["auth", "logout"], { env: accountEnvironment(paths), cwd: paths.home, timeoutMs: 30_000 });
      if (!result) throw new Error("Claude Code could not start on this server. Check that it is installed, then try again.");
      const auth = await accountAuthStatus(this.account);
      if (auth.own) throw new Error("Claude Code still reports a sign-in for this account. Try again, or update Claude Code on the server.");
      if (auth.state === "unknown") throw new Error("Claude Code could not confirm the sign-out. Try again, or update Claude Code on the server.");
    })();
    this.busy = run;
    try {
      await run;
      this.flow = null;
    } finally {
      this.busy = null;
    }
  }

  private login(flow: Flow, method: ClaudeCodeLoginMethod): void {
    if (flow.status.phase !== "waiting") return;
    const paths = accountPaths(this.account);
    let child: ChildProcess;
    try {
      // No browser on a server: `true` "opens" nothing and the CLI prints its link.
      child = spawnCli(loginArgs(method), { env: accountEnvironment(paths, { BROWSER: "true" }), cwd: paths.home });
    } catch {
      this.finish(flow, "failed", "Claude Code could not start on this server. Check that it is installed, then try again.");
      return;
    }
    flow.child = child;
    const receive = (chunk: Buffer) => {
      if (flow.status.phase !== "waiting") return;
      if (flow.output.length + chunk.length > MAX_OUTPUT) {
        this.finish(flow, "failed", "Claude Code returned an unexpected sign-in response. Update Claude Code on the server and try again.");
        return;
      }
      flow.output += chunk.toString("utf8");
      if (flow.ready) return;
      const prompt = claudeLoginPrompt(flow.output);
      if (!prompt) return;
      flow.status = { ...flow.status, authorizationUrl: prompt.authorizationUrl };
      flow.ready = true;
      clearTimeout(flow.startupTimer);
      flow.resolve({ ...flow.status });
    };
    child.stdout?.on("data", receive);
    child.stderr?.on("data", receive);
    child.once("error", (error: NodeJS.ErrnoException) => {
      this.finish(flow, "failed", error.code === "ENOENT"
        ? "Claude Code is not installed on this server. Install it (docs/plans/CLAUDE_CODE_LOGIN.md), then try again."
        : "Claude Code could not start on this server. Check the configured CLI path and its permissions.");
    });
    child.once("close", (code) => {
      if (flow.child === child) flow.child = null;
      if (flow.status.phase !== "waiting") return;
      const output = stripVTControlCharacters(flow.output);
      flow.output = "";
      void accountAuthStatus(this.account).then((auth) => {
        if (flow.status.phase !== "waiting") return;
        if (auth.state === "in") {
          this.finish(flow, "succeeded");
          return;
        }
        this.finish(flow, "failed", flow.codeSent
          ? /invalid|expired|denied|rejected/i.test(output)
            ? "Anthropic did not accept that code. Start sign-in again and paste the whole code it shows."
            : "Claude Code finished but this account is not signed in. Start sign-in again."
          : code === 0
            ? "Claude Code finished but this account is not signed in. Start sign-in again."
            : "Claude Code stopped before the sign-in finished. Check this server's connection and try again.");
      }, () => this.finish(flow, "failed", UNREADABLE));
    });
  }

  private finish(flow: Flow, phase: Exclude<ClaudeCodeSignIn["phase"], "waiting">, message?: string): void {
    if (flow.status.phase !== "waiting") return;
    clearTimeout(flow.startupTimer);
    clearTimeout(flow.expiryTimer);
    flow.status = { phase, flowId: flow.status.flowId, authorizationUrl: null, expiresAt: null, ...(phase !== "succeeded" && message ? { message } : {}) };
    flow.output = "";
    if (!flow.ready) {
      if (phase === "succeeded") flow.resolve({ ...flow.status });
      else flow.reject(new Error(message ?? "Claude sign-in did not finish."));
    }
    if (flow.completion) {
      if (phase === "succeeded") flow.completion.resolve();
      else flow.completion.reject(new Error(message ?? "Claude sign-in did not finish."));
      flow.completion = undefined;
    }
    flow.stopping = stopCli(flow.child).then(() => undefined, () => undefined);
  }
}

type Registry = Map<string, ClaudeLoginController>;
const globalRegistry = globalThis as typeof globalThis & { __agentsdrClaudeLogins?: Registry };

/** The one controller for this account in this process (one sign-in per account at a time). */
export function loginController(account: ClaudeAccount, running: () => number): ClaudeLoginController {
  const registry = (globalRegistry.__agentsdrClaudeLogins ??= new Map());
  const key = accountKey(account);
  let controller = registry.get(key);
  if (!controller) {
    controller = new ClaudeLoginController(account, DEFAULT_TIMINGS, running);
    registry.set(key, controller);
  }
  return controller;
}

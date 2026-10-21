import "server-only";

import type { ChildProcess } from "node:child_process";
import { accountEnvironment, accountKey, accountPaths, hasOwnLogin, scratchDirectory, spawnCli, stopCli, type ClaudeAccount } from "./cli.server";
import { generationArgs, readGeneration, type ClaudeFailure } from "./cliOutput";
import type { ClaudeCodeLimit, ClaudeCodeModel, ClaudeCodeWindow } from "./contract";

/**
 * One structured generation on an account's own Claude login: the CLI runs
 * `-p` in an empty directory with no tools, the prompt on stdin, and exits.
 * Nothing is resumed or kept between calls, so no conversation can carry
 * from one organization, person or task to another.
 *
 * Bounded: at most AGENTSDR_CLAUDE_CODE_MAX_PROCESSES CLI processes run at once on
 * this server (default 2; each is a few hundred MB), and a call that cannot
 * get a slot within its timeout fails as busy. A call past its timeout, or
 * whose caller aborts, has its process group stopped.
 *
 * What the CLI reports about usage is kept per account in memory: the last
 * windows it reported, and a usage limit until its reset, during which calls
 * are refused without starting the CLI. Nothing is estimated, and a refusal
 * never moves the work to another provider.
 */

export class ClaudeCodeError extends Error {
  /** HTTP-like, so the app's existing retry rules read it: 503 is retried, 4xx is not. */
  readonly status: number;
  readonly kind: ClaudeFailure["kind"] | "busy" | "not_signed_in";
  constructor(kind: ClaudeCodeError["kind"], message: string) {
    super(message);
    this.name = "ClaudeCodeError";
    this.kind = kind;
    this.status = kind === "signed_out" || kind === "not_signed_in" ? 401
      : kind === "limit" ? 402
      : kind === "model_unavailable" ? 404
      : kind === "transient" || kind === "busy" ? 503
      : 400;
  }
}

/** `limitUntil`: the reported reset, or 15 minutes when the CLI gave none (the refusal is then tried again, not assumed over). */
type AccountState = { running: number; limit: ClaudeCodeLimit | null; limitUntil: number; windows: ClaudeCodeWindow[]; windowsAt: string | null };
const UNKNOWN_RESET_HOLD_MS = 15 * 60_000;
type RunnerState = { active: number; waiting: Array<() => void>; accounts: Map<string, AccountState>; children: Set<ChildProcess> };
const globalRunner = globalThis as typeof globalThis & { __agentsdrClaudeRunner?: RunnerState };
function runner(): RunnerState {
  return (globalRunner.__agentsdrClaudeRunner ??= { active: 0, waiting: [], accounts: new Map(), children: new Set() });
}

function accountState(account: ClaudeAccount): AccountState {
  const key = accountKey(account);
  const accounts = runner().accounts;
  let state = accounts.get(key);
  if (!state) {
    state = { running: 0, limit: null, limitUntil: 0, windows: [], windowsAt: null };
    accounts.set(key, state);
  }
  return state;
}

/** What the page shows about this account's usage: generations running now, an unexpired limit, the last reported windows. */
export function accountUsage(account: ClaudeAccount, now = Date.now()): { running: number; limit: ClaudeCodeLimit | null; windows: ClaudeCodeWindow[]; windowsAt: string | null } {
  const state = accountState(account);
  if (state.limit && state.limitUntil <= now) state.limit = null;
  return { running: state.running, limit: state.limit, windows: state.windows, windowsAt: state.windowsAt };
}

export function runningOn(account: ClaudeAccount): number {
  return accountState(account).running;
}

export function maxProcesses(): number {
  const configured = Number.parseInt(process.env.AGENTSDR_CLAUDE_CODE_MAX_PROCESSES ?? "", 10);
  return Number.isFinite(configured) ? Math.min(8, Math.max(1, configured)) : 2;
}

async function acquireSlot(deadline: number, signal?: AbortSignal): Promise<() => void> {
  const state = runner();
  const release = () => {
    state.active -= 1;
    state.waiting.shift()?.();
  };
  if (state.active < maxProcesses()) {
    state.active += 1;
    return release;
  }
  await new Promise<void>((resolveSlot, rejectSlot) => {
    const wake = () => {
      clearTimeout(timer);
      state.active += 1;
      resolveSlot();
    };
    const timer = setTimeout(() => {
      state.waiting = state.waiting.filter((entry) => entry !== wake);
      rejectSlot(new ClaudeCodeError("busy", `Claude Code is busy on this server (${maxProcesses()} AI ${maxProcesses() === 1 ? "step" : "steps"} at a time); this one waited too long and will be tried again.`));
    }, Math.max(0, deadline - Date.now()));
    timer.unref();
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      state.waiting = state.waiting.filter((entry) => entry !== wake);
      rejectSlot(signal.reason);
    }, { once: true });
    state.waiting.push(wake);
  });
  return release;
}

export type GenerationInput = {
  account: ClaudeAccount;
  model: ClaudeCodeModel;
  systemPrompt: string;
  userPrompt: string;
  jsonSchema: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
  timeZone?: string;
};

export type GenerationResult = { text: string; modelId: string | null; usage: { inputTokens?: number; outputTokens?: number } };

const MAX_STDOUT = 4 * 1024 * 1024;

/** Runs one generation; throws ClaudeCodeError for every way it can fail. */
export async function runGeneration(input: GenerationInput): Promise<GenerationResult> {
  const paths = accountPaths(input.account);
  if (!hasOwnLogin(paths)) throw new ClaudeCodeError("not_signed_in", "Claude Code is not signed in for this account. Sign in again in Settings → AI provider.");
  const state = accountState(input.account);
  const usage = accountUsage(input.account);
  if (usage.limit) throw new ClaudeCodeError("limit", usage.limit.message);

  const deadline = Date.now() + input.timeoutMs;
  const release = await acquireSlot(deadline, input.signal);
  state.running += 1;
  const scratch = scratchDirectory(paths);
  const proc: { child: ChildProcess | null } = { child: null };
  try {
    const lines = await new Promise<string[]>((resolveRun, rejectRun) => {
      try {
        proc.child = spawnCli(generationArgs(input), { env: accountEnvironment(paths), cwd: scratch.cwd });
      } catch {
        rejectRun(new ClaudeCodeError("error", "Claude Code could not start on this server. Check that it is installed."));
        return;
      }
      const running = proc.child;
      runner().children.add(running);
      let stdout = "";
      let overflow = false;
      let timedOut = false;
      running.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length + chunk.length > MAX_STDOUT) { overflow = true; return; }
        stdout += chunk.toString("utf8");
      });
      // Not logged: it can echo the prompt.
      running.stderr?.on("data", () => {});
      const timer = setTimeout(() => { timedOut = true; void stopCli(running); }, Math.max(1_000, deadline - Date.now()));
      timer.unref();
      const abort = () => { void stopCli(running); };
      input.signal?.addEventListener("abort", abort, { once: true });
      running.once("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        rejectRun(new ClaudeCodeError("error", error.code === "ENOENT" ? "Claude Code is not installed on this server." : "Claude Code could not start on this server."));
      });
      running.once("close", () => {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", abort);
        runner().children.delete(running);
        if (input.signal?.aborted) return rejectRun(input.signal.reason);
        if (timedOut) return rejectRun(new ClaudeCodeError("transient", `Claude Code did not answer within ${Math.round(input.timeoutMs / 1000)} s.`));
        if (overflow) return rejectRun(new ClaudeCodeError("error", "Claude Code returned more output than an answer can be."));
        resolveRun(stdout.split("\n"));
      });
      running.stdin?.end(input.userPrompt);
    });
    const outcome = readGeneration(lines, input.timeZone);
    if (outcome.windows.length) {
      state.windows = outcome.windows;
      state.windowsAt = new Date().toISOString();
    }
    if (outcome.failure) {
      if (outcome.failure.kind === "limit") {
        state.limit = outcome.failure.limit;
        state.limitUntil = outcome.failure.limit.resetsAt ? Date.parse(outcome.failure.limit.resetsAt) : Date.now() + UNKNOWN_RESET_HOLD_MS;
        throw new ClaudeCodeError("limit", outcome.failure.limit.message);
      }
      throw new ClaudeCodeError(outcome.failure.kind, outcome.failure.message);
    }
    if (!outcome.finished) throw new ClaudeCodeError("transient", "Claude Code stopped before it finished answering.");
    return { text: outcome.text ?? "", modelId: outcome.modelId, usage: outcome.usage };
  } finally {
    state.running -= 1;
    release();
    scratch.remove();
    if (proc.child) await stopCli(proc.child, 500);
  }
}

/** Stops every CLI generation this process started (shutdown). */
export async function stopAllGenerations(): Promise<void> {
  await Promise.all([...runner().children].map((child) => stopCli(child, 500)));
}

/** Tests: forget per-account state between cases. */
export function resetRunnerForTests(): void {
  globalRunner.__agentsdrClaudeRunner = { active: 0, waiting: [], accounts: new Map(), children: new Set() };
}

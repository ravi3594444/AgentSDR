import "server-only";

import type { ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountEnvironment, accountKey, accountPaths, hasOwnLogin, scratchDirectory, spawnCli, stopCli, type ClaudeAccount } from "./cli.server";
import { foreignKeySource, generationArgs, readGeneration, windowName, type ClaudeFailure } from "./cliOutput";
import type { ClaudeCodeLimit, ClaudeCodeModel, ClaudeCodeWindow } from "./contract";

/**
 * One structured generation on an account's own Claude login: the CLI runs
 * `-p` in an empty directory with no tools and no file access, the system
 * prompt in a file there, the user prompt on stdin, and exits. Nothing is
 * resumed or kept between calls, so no conversation can carry from one
 * organization, person or task to another.
 *
 * Bounded: at most AGENTSDR_CLAUDE_CODE_MAX_PROCESSES generations run at once
 * on this server (default 2; each CLI is a few hundred MB). A call waits at
 * most 30 s (and never past its own timeout) for a slot, else fails as busy.
 * A call past its timeout, or whose caller aborts, has its process group
 * stopped. Busy and timed-out calls are not retried by completeStructured
 * (`retryable`), so a slow CLI cannot multiply a job's run time.
 *
 * What the CLI reports about usage is kept per account in memory: the last
 * windows it reported; a usage limit until its reset (only that model when
 * the window is one model's weekly limit), during which calls are refused
 * without starting the CLI; extra usage (billed beyond the plan), which holds
 * the account until the window resets so nothing more is billed that way; and
 * a sign-out the CLI reported, until the account signs in again. Nothing is
 * estimated, and a refusal never moves the work to another provider.
 */

export type ClaudeCodeErrorKind = ClaudeFailure["kind"] | "busy" | "timeout" | "not_signed_in" | "overage";

export class ClaudeCodeError extends Error {
  /** HTTP-like, for the app's existing rules (the reply agent stops on a 4xx). */
  readonly status: number;
  readonly kind: ClaudeCodeErrorKind;
  /** Whether completeStructured may try again; set for every kind. */
  readonly retryable: boolean;
  /** When a held account may answer again (a limit's reset). */
  readonly retryAt: Date | null;
  constructor(kind: ClaudeCodeErrorKind, message: string, retryAt: Date | null = null) {
    super(message);
    this.name = "ClaudeCodeError";
    this.kind = kind;
    this.retryAt = retryAt;
    this.retryable = kind === "transient";
    this.status = kind === "signed_out" || kind === "not_signed_in" ? 401
      : kind === "limit" || kind === "overage" ? 402
      : kind === "model_unavailable" ? 404
      : kind === "timeout" ? 504
      : kind === "transient" || kind === "busy" ? 503
      : 400;
  }
}

/** Whether an error is a Claude Code usage hold, and when it lifts; null otherwise. */
export function claudeHoldUntil(error: unknown): Date | null {
  return error instanceof ClaudeCodeError && (error.kind === "limit" || error.kind === "overage") ? error.retryAt : null;
}

type Hold = { limit: ClaudeCodeLimit; until: number };
type AccountState = {
  /** Generations running or waiting for a slot on this login. */
  running: number;
  /** Holds by model alias; "*" holds every model. */
  holds: Map<string, Hold>;
  windows: ClaudeCodeWindow[];
  windowsAt: string | null;
  /** When the CLI last answered that this login is signed out or expired. */
  signedOutAt: string | null;
};
/** Held this long when the CLI named no reset: the refusal is then tried again, not assumed over. */
const UNKNOWN_RESET_HOLD_MS = 15 * 60_000;
const SLOT_WAIT_MS = 30_000;
const ALL = "*";

type RunnerState = { active: number; waiting: Array<() => void>; accounts: Map<string, AccountState> };
const globalRunner = globalThis as typeof globalThis & { __agentsdrClaudeRunner?: RunnerState };
function runner(): RunnerState {
  return (globalRunner.__agentsdrClaudeRunner ??= { active: 0, waiting: [], accounts: new Map() });
}

function accountState(account: ClaudeAccount): AccountState {
  const key = accountKey(account);
  const accounts = runner().accounts;
  let state = accounts.get(key);
  if (!state) {
    state = { running: 0, holds: new Map(), windows: [], windowsAt: null, signedOutAt: null };
    accounts.set(key, state);
  }
  return state;
}

function liveHolds(state: AccountState, now: number): Map<string, Hold> {
  for (const [key, hold] of state.holds) if (hold.until <= now) state.holds.delete(key);
  return state.holds;
}

function holdFor(state: AccountState, model: ClaudeCodeModel, now = Date.now()): Hold | null {
  const holds = liveHolds(state, now);
  return holds.get(ALL) ?? holds.get(model) ?? null;
}

/** What the page shows about this login: generations running or waiting, unexpired holds, the last reported windows, a reported sign-out. */
export function accountUsage(account: ClaudeAccount, now = Date.now()) {
  const state = accountState(account);
  const limits = [...liveHolds(state, now).values()].map((hold) => hold.limit);
  return { running: state.running, limits, windows: state.windows, windowsAt: state.windowsAt, signedOutAt: state.signedOutAt };
}

export function runningOn(account: ClaudeAccount): number {
  return accountState(account).running;
}

/** A successful sign-in clears the CLI's earlier "signed out" answer. */
export function clearSignedOut(account: ClaudeAccount): void {
  accountState(account).signedOutAt = null;
}

export function maxProcesses(): number {
  const configured = Number.parseInt(process.env.AGENTSDR_CLAUDE_CODE_MAX_PROCESSES ?? "", 10);
  return Number.isFinite(configured) ? Math.min(8, Math.max(1, configured)) : 2;
}

function busy(): ClaudeCodeError {
  const max = maxProcesses();
  return new ClaudeCodeError("busy", `Claude Code is busy on this server (${max} AI ${max === 1 ? "step" : "steps"} at a time) and this one could not start in time.`);
}

async function acquireSlot(deadline: number, signal?: AbortSignal): Promise<() => void> {
  const state = runner();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    state.active -= 1;
    state.waiting.shift()?.();
  };
  if (state.active < maxProcesses()) {
    state.active += 1;
    return release;
  }
  await new Promise<void>((resolveSlot, rejectSlot) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      state.waiting = state.waiting.filter((entry) => entry !== wake);
    };
    const wake = () => {
      cleanup();
      state.active += 1;
      resolveSlot();
    };
    const onAbort = () => {
      cleanup();
      rejectSlot(signal!.reason);
    };
    const timer = setTimeout(() => { cleanup(); rejectSlot(busy()); }, Math.max(0, Math.min(deadline, Date.now() + SLOT_WAIT_MS) - Date.now()));
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
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
  /** A model check runs even while a hold stands, so the owner can find a model that still answers. */
  ignoreHolds?: boolean;
};

export type GenerationResult = { text: string; modelId: string | null; usage: { inputTokens?: number; outputTokens?: number } };

const MAX_STDOUT = 4 * 1024 * 1024;

function hold(state: AccountState, limit: ClaudeCodeLimit, model: ClaudeCodeModel): ClaudeCodeError {
  const until = limit.resetsAt ? Date.parse(limit.resetsAt) : Date.now() + UNKNOWN_RESET_HOLD_MS;
  const scoped = limit.modelSpecific ? { ...limit, model } : limit;
  state.holds.set(limit.modelSpecific ? model : ALL, { limit: scoped, until });
  return new ClaudeCodeError("limit", scoped.message, new Date(until));
}

/** Runs one generation; throws ClaudeCodeError for every way it can fail. */
export async function runGeneration(input: GenerationInput): Promise<GenerationResult> {
  if (input.signal?.aborted) throw input.signal.reason;
  const paths = accountPaths(input.account);
  if (!hasOwnLogin(paths)) throw new ClaudeCodeError("not_signed_in", "Claude Code is not signed in for this account. Sign in again in Settings → AI provider.");
  const state = accountState(input.account);
  const held = input.ignoreHolds ? null : holdFor(state, input.model);
  if (held) throw new ClaudeCodeError(held.limit.window === "overage" ? "overage" : "limit", held.limit.message, new Date(held.until));

  const deadline = Date.now() + input.timeoutMs;
  // Counted while waiting too, so sign-out and switching see work that is about to start.
  state.running += 1;
  let release: (() => void) | null = null;
  let scratch: { cwd: string; remove: () => void } | null = null;
  const proc: { child: ChildProcess | null } = { child: null };
  try {
    release = await acquireSlot(deadline, input.signal);
    scratch = scratchDirectory(paths);
    const systemPromptFile = join(scratch.cwd, "system-prompt.txt");
    writeFileSync(systemPromptFile, input.systemPrompt, { mode: 0o600 });
    const cwd = scratch.cwd;
    const lines = await new Promise<string[]>((resolveRun, rejectRun) => {
      try {
        proc.child = spawnCli(generationArgs({ model: input.model, systemPromptFile, jsonSchema: input.jsonSchema }), { env: accountEnvironment(paths), cwd });
      } catch {
        rejectRun(new ClaudeCodeError("error", "Claude Code could not start on this server. Check that it is installed."));
        return;
      }
      const running = proc.child;
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
        if (input.signal?.aborted) return rejectRun(input.signal.reason);
        if (timedOut) return rejectRun(new ClaudeCodeError("timeout", `Claude Code did not answer within ${Math.round(input.timeoutMs / 1000)} s.`));
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
    if (foreignKeySource(outcome.apiKeySource)) {
      throw new ClaudeCodeError("error", `Claude Code answered with a credential from this server's settings (${outcome.apiKeySource}), not this account's own login. Remove it from the server; the answer was not used.`);
    }
    if (outcome.overage) {
      // This call already ran on extra usage; hold the account so nothing more is billed that way.
      const until = outcome.overage.resetsAt ?? new Date(Date.now() + UNKNOWN_RESET_HOLD_MS).toISOString();
      state.holds.set(ALL, {
        limit: {
          window: "overage",
          resetsAt: outcome.overage.resetsAt,
          modelSpecific: false,
          message: `Your Claude plan's ${windowName(outcome.overage.window)} is used up, and Anthropic billed the last AI step as extra usage. AI steps on Claude Code stay held until it resets so nothing more is billed that way; nothing moves to another provider.`,
        },
        until: Date.parse(until),
      });
    }
    if (outcome.failure) {
      if (outcome.failure.kind === "limit") throw hold(state, outcome.failure.limit, input.model);
      if (outcome.failure.kind === "signed_out") state.signedOutAt = new Date().toISOString();
      throw new ClaudeCodeError(outcome.failure.kind, outcome.failure.message);
    }
    if (!outcome.finished) throw new ClaudeCodeError("transient", "Claude Code stopped before it finished answering.");
    state.signedOutAt = null;
    return { text: outcome.text ?? "", modelId: outcome.modelId, usage: outcome.usage };
  } finally {
    state.running -= 1;
    release?.();
    if (proc.child) await stopCli(proc.child, 500);
    scratch?.remove();
  }
}

/** Tests: forget per-account state between cases. */
export function resetRunnerForTests(): void {
  globalRunner.__agentsdrClaudeRunner = { active: 0, waiting: [], accounts: new Map() };
}

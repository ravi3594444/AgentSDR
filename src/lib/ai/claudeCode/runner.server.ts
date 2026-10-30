import "server-only";

import type { ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { accountEnvironment, accountKey, accountPaths, hasOwnLogin, scratchDirectory, spawnCli, stopCli, type ClaudeAccount } from "./cli.server";
import { foreignKeySource, generationArgs, limitRefusal, readGeneration, windowName, type ClaudeFailure } from "./cliOutput";
import type { ClaudeCodeEffort, ClaudeCodeLimit, ClaudeCodeModel, ClaudeCodeWindow } from "./contract";
import { nativeFlags } from "./nativeProtocol";
import { nativeToolParent } from "./nativeToolScope.server";

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
/** A reported reset is never taken as sooner than this, so a reset already past (a clock ahead) cannot spin. */
const MIN_HOLD_MS = 5 * 60_000;
/** A credential from the server's settings answered: refuse further calls this long, until the server is fixed. */
const FOREIGN_KEY_HOLD_MS = 15 * 60_000;
const SLOT_WAIT_MS = 30_000;
const ALL = "*";

type SlotWaiter = { key: string; reentrant: boolean; native: boolean; wake: () => void };
type RunnerState = { active: number; activeAccounts: Set<string>; waiting: SlotWaiter[]; accounts: Map<string, AccountState> };
const globalRunner = globalThis as typeof globalThis & { __agentsdrClaudeRunner?: RunnerState };
function runner(): RunnerState {
  return (globalRunner.__agentsdrClaudeRunner ??= { active: 0, activeAccounts: new Set(), waiting: [], accounts: new Map() });
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

/** The hold this call meets. A model check passes one model's weekly hold (to find a model that answers), never an account-wide one. */
function holdFor(state: AccountState, model: ClaudeCodeModel, checking: boolean, now = Date.now()): Hold | null {
  const holds = liveHolds(state, now);
  return holds.get(ALL) ?? (checking ? null : holds.get(model) ?? null);
}

/** Sets a hold; a hold already standing for longer is kept. */
function setHold(state: AccountState, key: string, limit: ClaudeCodeLimit, until: number): number {
  const at = Math.max(until, Date.now() + MIN_HOLD_MS);
  const standing = state.holds.get(key);
  if (standing && standing.until >= at) return standing.until;
  state.holds.set(key, { limit, until: at });
  return at;
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

async function acquireSlot(account: ClaudeAccount, deadline: number, signal?: AbortSignal, native = false): Promise<() => void> {
  const state = runner();
  const key = accountKey(account);
  const reentrant = Boolean(nativeToolParent(account));
  // A native parent waits while an app tool's structured writer runs.
  // Leave one physical slot available so two parents cannot occupy every slot.
  const canAdmit = (entry: { key: string; reentrant: boolean; native: boolean }) => state.active < maxProcesses()
    && (!entry.native || state.active < Math.max(1, maxProcesses() - 1))
    && (entry.reentrant || !state.activeAccounts.has(entry.key));
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    state.active -= 1;
    if (!reentrant) state.activeAccounts.delete(key);
    while (state.active < maxProcesses()) {
      const index = state.waiting.findIndex(canAdmit);
      if (index < 0) break;
      state.waiting[index].wake();
    }
  };
  if (canAdmit({ key, reentrant, native })) {
    state.active += 1;
    if (!reentrant) state.activeAccounts.add(key);
    return release;
  }
  await new Promise<void>((resolveSlot, rejectSlot) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      state.waiting = state.waiting.filter((entry) => entry.wake !== wake);
    };
    const wake = () => {
      cleanup();
      state.active += 1;
      if (!reentrant) state.activeAccounts.add(key);
      resolveSlot();
    };
    const onAbort = () => {
      cleanup();
      rejectSlot(signal!.reason);
    };
    const timer = setTimeout(() => { cleanup(); rejectSlot(busy()); }, Math.max(0, Math.min(deadline, Date.now() + SLOT_WAIT_MS) - Date.now()));
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    state.waiting.push({ key, reentrant, native, wake });
    if (signal?.aborted) onAbort();
  });
  return release;
}

export type GenerationInput = {
  account: ClaudeAccount;
  model: ClaudeCodeModel;
  /** The login's chosen effort (`--effort`); absent or "default": none passed. */
  effort?: ClaudeCodeEffort;
  systemPrompt: string;
  userPrompt: string;
  jsonSchema: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
  timeZone?: string;
  /** A model check runs past one model's weekly hold, so the owner can find a model that still answers; never past an account-wide hold. */
  ignoreHolds?: boolean;
  /** Recheck a shared workspace's approval after waiting and before starting the CLI. */
  authorize?: () => Promise<void>;
  /** Internal native assistant path only. Ordinary structured calls keep their no-tools contract. */
  native?: {
    session: { cwd: string; sessionId: string; resume: boolean };
    mcpConfig: Record<string, unknown>;
    maxTurns: number;
    onFrame: (frame: Record<string, unknown>) => void;
    onFailure: (error: Error) => void;
  };
};

export type GenerationResult = {
  text: string;
  modelId: string | null;
  usage: { inputTokens?: number; outputTokens?: number };
  /** Native only: the CLI stopped itself at --max-turns, between turns; its session resumes where it stopped. */
  stopped?: "max_turns";
};

const MAX_STDOUT = 4 * 1024 * 1024;
/**
 * A native turn's stream echoes every tool result (page text, screenshots),
 * so its size grows with the work done: only the frames readGeneration reads
 * are kept, and the bound is on one frame, not on the whole turn.
 */
const MAX_NATIVE_FRAME = 32 * 1024 * 1024;

/** The frames readGeneration reads; a native turn keeps only these. */
function outcomeFrame(frame: Record<string, unknown>): boolean {
  return (frame.type === "system" && frame.subtype === "init") || frame.type === "rate_limit_event" || frame.type === "result"
    || (frame.type === "assistant" && (frame.is_api_error_message === true || typeof frame.error === "string"));
}

function hold(state: AccountState, limit: ClaudeCodeLimit, model: ClaudeCodeModel): ClaudeCodeError {
  const reported = limit.resetsAt ? Date.parse(limit.resetsAt) : Date.now() + UNKNOWN_RESET_HOLD_MS;
  const scoped = limit.modelSpecific ? { ...limit, model } : limit;
  const until = setHold(state, limit.modelSpecific ? model : ALL, scoped, reported);
  return new ClaudeCodeError("limit", scoped.message, new Date(until));
}

/** Runs one generation; throws ClaudeCodeError for every way it can fail. */
export async function runGeneration(input: GenerationInput): Promise<GenerationResult> {
  const parent = nativeToolParent(input.account);
  if (parent) {
    if (maxProcesses() < 2) throw new ClaudeCodeError("busy", "Native Claude plan writing needs two CLI slots (the waiting agent and its writer). Increase AGENTSDR_CLAUDE_CODE_MAX_PROCESSES to at least 2, or select the API engine.");
    input = { ...input, signal: input.signal ? AbortSignal.any([input.signal, parent.signal]) : parent.signal };
  }
  if (input.signal?.aborted) throw input.signal.reason;
  const paths = accountPaths(input.account);
  if (!hasOwnLogin(paths)) throw new ClaudeCodeError("not_signed_in", "Claude Code is not signed in for this account. Sign in again in Settings → AI provider.");
  const state = accountState(input.account);
  const held = holdFor(state, input.model, input.ignoreHolds === true);
  if (held) throw new ClaudeCodeError(held.limit.window === "overage" ? "overage" : "limit", held.limit.message, new Date(held.until));

  const deadline = Date.now() + input.timeoutMs;
  // Counted while waiting too, so sign-out and switching see work that is about to start.
  state.running += 1;
  let release: (() => void) | null = null;
  let scratch: { cwd: string; remove: () => void } | null = null;
  const proc: { child: ChildProcess | null } = { child: null };
  try {
    release = await acquireSlot(input.account, deadline, input.signal, Boolean(input.native));
    if (input.signal?.aborted) throw input.signal.reason;
    if (Date.now() >= deadline) throw new ClaudeCodeError("timeout", "Claude Code could not start before this AI step timed out.");
    // A preceding workspace may have hit a limit or signed out while this
    // request waited. A queued request must not start past that hold.
    const queuedHold = holdFor(state, input.model, input.ignoreHolds === true);
    if (queuedHold) throw new ClaudeCodeError(queuedHold.limit.window === "overage" ? "overage" : "limit", queuedHold.limit.message, new Date(queuedHold.until));
    if (state.signedOutAt || !hasOwnLogin(paths)) throw new ClaudeCodeError("not_signed_in", "Claude Code is signed out. The platform operator must sign in again.");
    await input.authorize?.();
    scratch = scratchDirectory(paths);
    const systemPromptFile = join(scratch.cwd, "system-prompt.txt");
    writeFileSync(systemPromptFile, input.systemPrompt, { mode: 0o600 });
    const cwd = input.native?.session.cwd ?? scratch.cwd;
    let args = generationArgs({ model: input.model, effort: input.effort, systemPromptFile, jsonSchema: input.jsonSchema });
    if (input.native) {
      const mcpConfigFile = join(scratch.cwd, "mcp.json");
      writeFileSync(mcpConfigFile, JSON.stringify(input.native.mcpConfig), { mode: 0o600 });
      args = args.filter((arg) => arg !== "--no-session-persistence");
      args.push(...nativeFlags({ ...input.native.session, maxTurns: input.native.maxTurns, mcpConfigFile }));
    }
    const lines = await new Promise<string[]>((resolveRun, rejectRun) => {
      try {
        proc.child = spawnCli(args, { env: accountEnvironment(paths, input.native ? { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1", ENABLE_TOOL_SEARCH: "false" } : {}), cwd });
      } catch {
        rejectRun(new ClaudeCodeError("error", "Claude Code could not start on this server. Check that it is installed."));
        return;
      }
      const running = proc.child;
      // A CLI that exits before reading its prompt (an unknown flag, a crash) must fail this call, not the server.
      running.stdin?.on("error", () => {});
      let sawInit = false;
      let stdout = "";
      const kept: string[] = [];
      let overflow = false;
      let timedOut = false;
      let frameError: Error | null = null;
      const decoder = new StringDecoder("utf8");
      let pending = "";
      running.stdout?.on("data", (chunk: Buffer) => {
        if (overflow) return;
        if (!input.native) {
          if (stdout.length + chunk.length > MAX_STDOUT) { overflow = true; return; }
          stdout += decoder.write(chunk);
          sawInit ||= stdout.includes('"subtype":"init"');
          return;
        }
        if (frameError) return;
        pending += decoder.write(chunk);
        if (pending.length > MAX_NATIVE_FRAME) {
          overflow = true;
          input.native.onFailure(new Error("Claude returned a single answer too large to read; saved work is kept."));
          void stopCli(running);
          return;
        }
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const frame = JSON.parse(line) as Record<string, unknown>;
            if (outcomeFrame(frame)) kept.push(line);
            if (frame.type === "system" && frame.subtype === "init") sawInit = true;
            if (frame.type === "rate_limit_event") {
              const update = readGeneration([line], input.timeZone);
              if (update.windows.length) { state.windows = update.windows; state.windowsAt = new Date().toISOString(); }
              const limited = limitRefusal(frame.rate_limit_info, input.timeZone);
              if (limited) throw hold(state, limited, input.model);
              if (update.overage) {
                const message = "Claude reported extra usage. This native turn stopped immediately; the account stays held until the reported window resets.";
                const until = setHold(state, ALL, { window: "overage", resetsAt: update.overage.resetsAt, modelSpecific: false, message }, update.overage.resetsAt ? Date.parse(update.overage.resetsAt) : Date.now() + UNKNOWN_RESET_HOLD_MS);
                throw new ClaudeCodeError("overage", message, new Date(until));
              }
            }
            input.native.onFrame(frame);
          }
          catch (error) {
            frameError = error instanceof SyntaxError ? new Error("Claude returned an invalid stream frame.") : error instanceof Error ? error : new Error("Claude returned an invalid frame.");
            input.native.onFailure(frameError);
            void stopCli(running);
            break;
          }
        }
      });
      // Not logged: it can echo the prompt.
      running.stderr?.on("data", () => {});
      const timer = setTimeout(() => {
        timedOut = true;
        input.native?.onFailure(new ClaudeCodeError("timeout", "This Claude turn reached its time limit. Saved work is kept."));
        void stopCli(running);
      }, Math.max(1_000, deadline - Date.now()));
      timer.unref();
      const abort = () => { void stopCli(running); };
      input.signal?.addEventListener("abort", abort, { once: true });
      if (input.signal?.aborted) abort();
      running.once("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", abort);
        rejectRun(new ClaudeCodeError("error", error.code === "ENOENT" ? "Claude Code is not installed on this server." : "Claude Code could not start on this server."));
      });
      running.once("close", (code) => {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", abort);
        if (frameError) return rejectRun(frameError);
        if (input.signal?.aborted) return rejectRun(input.signal.reason);
        if (timedOut) return rejectRun(new ClaudeCodeError("timeout", `Claude Code did not answer within ${Math.round(input.timeoutMs / 1000)} s.`));
        if (overflow) return rejectRun(new ClaudeCodeError("error", "Claude Code returned more output than an answer can be."));
        if (input.native) {
          // A last frame without its newline (the result, usually) is read like the others.
          const last = (pending + decoder.end()).trim();
          if (last) {
            try { if (outcomeFrame(JSON.parse(last) as Record<string, unknown>)) kept.push(last); } catch { /* not a frame */ }
          }
          sawInit ||= kept.some((line) => line.includes('"subtype":"init"'));
        }
        // Exited before it even started a session: the installed CLI refused how it was run; another attempt fails the same way.
        if (!sawInit && code !== 0) return rejectRun(new ClaudeCodeError("error", `Claude Code on this server exited (code ${code ?? "unknown"}) before answering. Check that the installed version supports the flags this app uses (docs/plans/CLAUDE_CODE_LOGIN.md).`));
        resolveRun(input.native ? kept : stdout.split("\n"));
      });
      running.stdin?.end(input.userPrompt);
    });
    const outcome = readGeneration(lines, input.timeZone);
    if (outcome.windows.length) {
      state.windows = outcome.windows;
      state.windowsAt = new Date().toISOString();
    }
    if (foreignKeySource(outcome.apiKeySource)) {
      const message = `Claude Code answered with a credential from this server's settings (${outcome.apiKeySource}), not this account's own login. Remove it from the server; the answer was not used.`;
      setHold(state, ALL, { window: null, resetsAt: null, modelSpecific: false, message }, Date.now() + FOREIGN_KEY_HOLD_MS);
      throw new ClaudeCodeError("error", message);
    }
    if (outcome.overage) {
      // This call already ran on extra usage; hold the account so nothing more is billed that way.
      const until = outcome.overage.resetsAt ? Date.parse(outcome.overage.resetsAt) : Date.now() + UNKNOWN_RESET_HOLD_MS;
      setHold(state, ALL, {
        window: "overage",
        resetsAt: outcome.overage.resetsAt,
        modelSpecific: false,
        message: `Your Claude plan's ${windowName(outcome.overage.window)} is used up, and Anthropic billed the last AI step as extra usage. AI steps on Claude Code stay held until it resets so nothing more is billed that way; nothing moves to another provider.`,
      }, until);
    }
    if (outcome.failure?.kind === "max_turns" && input.native) {
      state.signedOutAt = null;
      return { text: "", modelId: outcome.modelId, usage: outcome.usage, stopped: "max_turns" };
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
  globalRunner.__agentsdrClaudeRunner = { active: 0, activeAccounts: new Set(), waiting: [], accounts: new Map() };
}

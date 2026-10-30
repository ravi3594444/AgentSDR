import "server-only";
import { accountKey, type ClaudeAccount } from "./cli.server";
import type { ClaudeCodeEffort, ClaudeCodeModel } from "./contract";
import { nativeInitProblem, NATIVE_ANSWER_SCHEMA, parseNativeAnswer } from "./nativeProtocol";
import { nativeSession } from "./nativeSession.server";
import { accountUsage, ClaudeCodeError, runGeneration, type GenerationResult } from "./runner.server";
import { inNativeTool } from "./nativeToolScope.server";
import { startToolBridge, type NativeTool } from "./toolBridge.server";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** How long a tool call read before the CLI's init frame waits for it. Nothing runs until the login and tools are verified, so waiting costs nothing. */
const INIT_WAIT_MS = 30_000;
/** Once a checkpoint is due and no call is running, how long the model may finish its step (a final answer ends the run anyway) before its process is stopped. */
const DRAIN_GRACE_MS = 60_000;
/** A process still running past the turn's bound (an effect finishing, then the drain) is stopped this much later at the latest. */
const HARD_STOP_MS = 10 * 60_000;
/** A final answer the record does not back is handed back this many times before the turn fails. */
const MAX_ANSWER_CORRECTIONS = 2;
/** Without a whole-turn bound of its own, a turn may take this many runs' time. */
const DEFAULT_RUNS_PER_TURN = 4;

const CHECKPOINT = Symbol("native checkpoint");

/** Why one CLI run of a turn ended before the model's final answer. */
export type NativeCheckpoint = {
  /** Its --max-turns (the CLI stopped itself), its time, or its tool-call allowance. */
  reason: "turns" | "time" | "calls";
  /** Stopped by the host between calls (time, calls) rather than by the CLI itself. */
  forced: boolean;
  /** The run that ended, from 1. */
  run: number;
};

type Answer = { message: string; suggestions: string[] };

/**
 * The CLI drives the tool loop itself; all effects go back through the
 * host's existing handlers and nothing is retried here. A turn is one or
 * more CLI runs on the same session: a run that reaches its --max-turns, its
 * time or its call allowance is a checkpoint (stopped between calls, never
 * during one), and the turn continues in a resumed run from the record. Only
 * the whole turn's bound pauses it, saved and resumable by the next turn.
 * Cancellation, revoked access, sign-out and the account's usage limits stop
 * it at once; nothing ever moves to an API provider. The ordinary
 * completeStructured runtime is not changed.
 */
export async function runNativeAssistant(input: {
  binding: { account: ClaudeAccount; model: ClaudeCodeModel; effort?: ClaudeCodeEffort };
  threadId: string;
  requestId: string;
  systemPrompt: string;
  /** The turn's first message, given the session it goes to (resumed or new, and when it was last saved). */
  userPrompt: string | ((session: { resume: boolean; savedAt: Date | null }) => Promise<string>);
  tools: NativeTool[];
  /** Model turns per CLI run (its --max-turns). */
  maxTurns: number;
  /** Tool calls per CLI run. */
  maxCalls: number;
  /** One CLI run's time before it checkpoints. */
  timeoutMs: number;
  /** The whole turn's time; past it the turn pauses, saved, instead of starting another run. */
  turnTimeoutMs?: number;
  /** Tests: how long a due checkpoint lets the model finish its step (default DRAIN_GRACE_MS). */
  drainGraceMs?: number;
  signal?: AbortSignal;
  /** Re-resolve the current binding; called before each run and each tool, including after queue waits. */
  authorize: () => Promise<void>;
  execute: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
  /** The message that continues the turn after a checkpoint (the record of what ran is the host's). */
  resumePrompt?: (checkpoint: NativeCheckpoint) => Promise<string>;
  /** Why a final answer cannot be shown (a claim the record does not back), or null: handed back to the model to correct. */
  checkAnswer?: (answer: Answer) => Promise<string | null>;
}) {
  const session = nativeSession(input.binding.account, { threadId: input.threadId, requestId: input.requestId, model: input.binding.model });
  const controller = new AbortController();
  const abort = () => controller.abort(input.signal?.reason ?? new Error("This Claude turn was cancelled."));
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) abort();
  const turnDeadline = Date.now() + (input.turnTimeoutMs ?? input.timeoutMs * DEFAULT_RUNS_PER_TURN);
  let checking = false;
  const check = async () => {
    if (controller.signal.aborted) throw controller.signal.reason;
    await input.authorize();
    const usage = accountUsage(input.binding.account);
    const held = usage.limits.find((limit) => !limit.modelSpecific || limit.model === input.binding.model);
    if (held) throw new ClaudeCodeError(held.window === "overage" ? "overage" : "limit", held.message, held.resetsAt ? new Date(held.resetsAt) : null);
    if (usage.signedOutAt) throw new ClaudeCodeError("signed_out", "The connected Claude account signed out. Sign in again; no API fallback was used.");
    if (controller.signal.aborted) throw controller.signal.reason;
  };
  // Revoked access interrupts an in-flight model call, even when it makes no tools.
  const timer = setInterval(() => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    void check().catch((error: unknown) => controller.abort(error)).finally(() => { checking = false; });
  }, 10_000);
  timer.unref();

  const usage: GenerationResult["usage"] = {};
  const count = (more: GenerationResult["usage"]) => {
    if (more.inputTokens !== undefined) usage.inputTokens = (usage.inputTokens ?? 0) + more.inputTokens;
    if (more.outputTokens !== undefined) usage.outputTokens = (usage.outputTokens ?? 0) + more.outputTokens;
  };
  let modelId: string | null = null;
  let resume = session.resume;
  // A run the host stopped delivered its last call's result just before; the resumed session may lack it, so that exact call is answered from the record, not run again.
  let atRisk: { fingerprint: string; result: CallToolResult } | null = null;

  /** One CLI run: its final text, or the checkpoint it stopped at. */
  const runOnce = async (run: number, userPrompt: string): Promise<{ result: GenerationResult; checkpoint: null } | { result: GenerationResult | null; checkpoint: NativeCheckpoint; lastEffect: { fingerprint: string; result: CallToolResult } | null }> => {
    let initialized = false;
    let verified: () => void = () => {};
    // The CLI prints init before its first call, but this process can read that call first (two pipes, no order between them).
    const initFrame = new Promise<void>((resolve) => { verified = resolve; });
    const stop = new AbortController();
    let due: NativeCheckpoint["reason"] | null = null;
    let ended = false;
    let lastEffect: { fingerprint: string; result: CallToolResult } | null = null;
    let calledWhileDraining: () => void = () => {};
    const drained = new Promise<void>((resolve) => { calledWhileDraining = resolve; });
    const bridge = await startToolBridge({
      tools: input.tools,
      signal: controller.signal,
      maxCalls: input.maxCalls,
      onCheckpoint: (why) => {
        if (why === "allowance") checkpoint("calls");
        calledWhileDraining();
      },
      execute: async (name, args) => {
        // A call read before the init frame waits for it; nothing runs until the login and tools are verified.
        if (!initialized) await Promise.race([initFrame, new Promise((resolve) => { setTimeout(resolve, INIT_WAIT_MS).unref(); controller.signal.addEventListener("abort", resolve, { once: true }); })]);
        if (!initialized) throw new Error("Claude's login and tool configuration have not been verified.");
        try { await check(); }
        catch (error) { controller.abort(error); throw error; }
        const fingerprint = JSON.stringify([name, args]);
        if (atRisk?.fingerprint === fingerprint) {
          const earlier = atRisk.result;
          atRisk = null;
          return { ...earlier, content: [{ type: "text", text: "This exact call already ran just before the pause; it was not run again. Its result:" }, ...earlier.content] };
        }
        try {
          const result = await inNativeTool(input.binding.account, controller.signal, () => input.execute(name, args));
          lastEffect = { fingerprint, result };
          return result;
        } catch (error) {
          // An effect may have committed before its recording failed. Stop the
          // model rather than letting it blindly repeat the uncertain call.
          controller.abort(error);
          throw error;
        }
      },
    });
    // At a checkpoint nothing new runs; the process stops between calls: once one is refused, or the model has had a moment to answer.
    function checkpoint(reason: NativeCheckpoint["reason"]) {
      if (due || ended) return;
      due = reason;
      bridge.drain(reason === "time" ? "this run reached its time and pauses at a checkpoint" : "this run used its tool-call allowance and pauses at a checkpoint");
      void (async () => {
        await bridge.idle();
        await Promise.race([drained, new Promise((resolve) => { setTimeout(resolve, input.drainGraceMs ?? DRAIN_GRACE_MS).unref(); })]);
        await bridge.idle();
        if (!ended) stop.abort(CHECKPOINT);
      })();
    }
    const clock = setTimeout(() => checkpoint("time"), Math.max(0, Math.min(Date.now() + input.timeoutMs, turnDeadline) - Date.now()));
    clock.unref();
    try {
      const result = await runGeneration({
        ...input.binding,
        systemPrompt: input.systemPrompt,
        userPrompt,
        jsonSchema: NATIVE_ANSWER_SCHEMA,
        // The checkpoints stop a run between calls; this only stops a process that outlives the whole turn.
        timeoutMs: Math.max(60_000, turnDeadline + HARD_STOP_MS - Date.now()),
        signal: AbortSignal.any([controller.signal, stop.signal]),
        authorize: check,
        native: {
          session: { cwd: session.cwd, sessionId: session.sessionId, resume },
          mcpConfig: bridge.config,
          maxTurns: input.maxTurns,
          onFailure: (error) => controller.abort(error),
          onFrame: (frame) => {
            if (frame.type === "system" && frame.subtype === "init") {
              const problem = nativeInitProblem(frame);
              if (problem) throw new Error(problem);
              initialized = true;
              verified();
            }
          },
        },
      });
      ended = true;
      if (result.modelId) modelId = result.modelId;
      count(result.usage);
      if (result.stopped === "max_turns") return { result, checkpoint: { reason: "turns", forced: false, run }, lastEffect: null };
      return { result, checkpoint: null };
    } catch (error) {
      ended = true;
      if (stop.signal.aborted && !controller.signal.aborted && due) return { result: null, checkpoint: { reason: due, forced: true, run }, lastEffect };
      throw error;
    } finally {
      clearTimeout(clock);
      await bridge.close();
    }
  };

  try {
    let prompt: string | null = null;
    let corrections = 0;
    for (let run = 1; ; run += 1) {
      await check();
      const userPrompt: string = prompt ?? (typeof input.userPrompt === "string" ? input.userPrompt : await input.userPrompt({ resume: session.resume, savedAt: session.savedAt }));
      const outcome = await runOnce(run, userPrompt);
      // Each run is a finished invocation of this session: the next one, or the next turn, resumes it.
      if (outcome.checkpoint || outcome.result) session.save();
      resume = true;
      if (outcome.checkpoint) {
        atRisk = outcome.checkpoint.forced ? outcome.lastEffect : null;
        if (Date.now() >= turnDeadline) {
          await check();
          return { text: "", modelId, usage, answer: null, paused: outcome.checkpoint, runs: run, accountKey: accountKey(input.binding.account), sessionId: session.sessionId, resumed: session.resume };
        }
        prompt = input.resumePrompt ? await input.resumePrompt(outcome.checkpoint)
          : "Continue this turn from where you stopped: it paused at a checkpoint. A call answered \"Not run\" did not run. Finish the work, then give your final answer.";
        continue;
      }
      atRisk = null;
      await check();
      // Corrupt or failed responses never authorize fallback.
      const answer = parseNativeAnswer(outcome.result.text);
      const problem = input.checkAnswer ? await input.checkAnswer(answer) : null;
      if (problem) {
        if (corrections >= MAX_ANSWER_CORRECTIONS) throw new Error(problem);
        corrections += 1;
        prompt = `Your final answer was not shown to the owner: ${problem} Answer again, saying only what the tool results show; tools are still available if something is missing.`;
        continue;
      }
      return { text: outcome.result.text, modelId, usage, answer, paused: null, runs: run, accountKey: accountKey(input.binding.account), sessionId: session.sessionId, resumed: session.resume };
    }
  } finally {
    clearInterval(timer);
    input.signal?.removeEventListener("abort", abort);
    controller.abort(new Error("This Claude turn has ended."));
  }
}

import "server-only";
import { accountKey, type ClaudeAccount } from "./cli.server";
import type { ClaudeCodeModel } from "./contract";
import { nativeInitProblem, NATIVE_ANSWER_SCHEMA, parseNativeAnswer } from "./nativeProtocol";
import { nativeSession } from "./nativeSession.server";
import { accountUsage, ClaudeCodeError, runGeneration } from "./runner.server";
import { inNativeTool } from "./nativeToolScope.server";
import { startToolBridge, type NativeTool } from "./toolBridge.server";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** How long a tool call read before the CLI's init frame waits for it. */
const INIT_WAIT_MS = 5_000;

/**
 * The CLI drives the complete tool loop in one process. All effects go back
 * through the host's existing handlers; there is no transport retry here.
 * A partial turn stays in the app transcript and retries use its recorded
 * effects. The ordinary completeStructured runtime is not changed.
 */
export async function runNativeAssistant(input: {
  binding: { account: ClaudeAccount; model: ClaudeCodeModel };
  threadId: string;
  requestId: string;
  systemPrompt: string;
  userPrompt: string;
  tools: NativeTool[];
  maxTurns: number;
  maxCalls: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Re-resolve the current binding; called before startup and each tool, including after queue waits. */
  authorize: () => Promise<void>;
  execute: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
}) {
  const session = nativeSession(input.binding.account, { threadId: input.threadId, requestId: input.requestId, model: input.binding.model });
  const controller = new AbortController();
  const abort = () => controller.abort(input.signal?.reason ?? new Error("This Claude turn was cancelled."));
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) abort();
  let initialized = false;
  // The CLI prints init before its first call, but this process can read that call first (two pipes, no order between them).
  let verified: () => void = () => {};
  const initFrame = new Promise<void>((resolve) => { verified = resolve; });
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
  const bridge = await startToolBridge({
    tools: input.tools,
    signal: controller.signal,
    maxCalls: input.maxCalls,
    execute: async (name, args) => {
      // A call read before the init frame waits for it (briefly); nothing runs until the login and tools are verified.
      if (!initialized) await Promise.race([initFrame, new Promise((resolve) => { setTimeout(resolve, INIT_WAIT_MS).unref(); controller.signal.addEventListener("abort", resolve, { once: true }); })]);
      if (!initialized) throw new Error("Claude's login and tool configuration have not been verified.");
      try { await check(); }
      catch (error) { controller.abort(error); throw error; }
      try { return await inNativeTool(input.binding.account, controller.signal, () => input.execute(name, args)); }
      catch (error) {
        // An effect may have committed before its recording failed. Stop the
        // model rather than letting it blindly repeat the uncertain call.
        controller.abort(error);
        throw error;
      }
    },
  }).catch((error: unknown) => {
    input.signal?.removeEventListener("abort", abort);
    throw error;
  });
  // Revoked access interrupts an in-flight model call, even when it makes no tools.
  const timer = setInterval(() => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    void check().catch((error: unknown) => controller.abort(error)).finally(() => { checking = false; });
  }, 10_000);
  timer.unref();
  try {
    await check();
    const result = await runGeneration({
      ...input.binding,
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      jsonSchema: NATIVE_ANSWER_SCHEMA,
      timeoutMs: input.timeoutMs,
      signal: controller.signal,
      authorize: check,
      native: {
        session,
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
    await check();
    const answer = parseNativeAnswer(result.text);
    // Persist only an identified, finished invocation. Corrupt or failed responses never authorize fallback.
    session.save();
    return { ...result, answer, accountKey: accountKey(input.binding.account), sessionId: session.sessionId, resumed: session.resume };
  } finally {
    clearInterval(timer);
    input.signal?.removeEventListener("abort", abort);
    controller.abort(new Error("This Claude turn has ended."));
    await bridge.close();
  }
}

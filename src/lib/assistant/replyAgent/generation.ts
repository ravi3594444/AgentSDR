/** The worker's model/check/retry loop, independent of storage and sending. */
import type { ReplyAgentTurn } from "../schema";
import { agentUserPrompt, MAX_TURNS, parseAgentDecision, replyProblems, speculativeQuestionNote, type AgentDecision } from "./agent";
import { closingAcknowledgement } from "@/lib/crm/wrongNumber";

export type AgentModelResult = { text: string; provider?: string; model?: string; request?: unknown; response?: unknown; usage?: { inputTokens?: number; outputTokens?: number } };
export type AgentModel = (input: { systemPrompt: string; userPrompt: string }) => Promise<AgentModelResult>;

function httpStatus(error: unknown): number | null {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const value = current as { status?: unknown; cause?: unknown };
    if (typeof value.status === "number") return value.status;
    current = value.cause;
  }
  return null;
}

export function generationFailureReason(turns: ReplyAgentTurn[]): string {
  const last = turns.at(-1);
  const reason = last?.error ?? last?.problems.join("; ") ?? "no usable answer";
  return `AI reply generation failed after ${turns.length} ${turns.length === 1 ? "attempt" : "attempts"}: ${reason || "no usable answer"}`;
}

/** Claim errors that end the loop by throwing: a displaced execution must not run the failure path's effects either. */
const CLAIM_GENERATION_ERRORS = new Set([
  "CrmJobClaimLostError",
  "ReplyAgentClaimLostError",
]);

/** Budget errors that end the loop with no decision: the caller's failure path leaves the visible owner state. */
const BUDGET_GENERATION_ERRORS = new Set([
  "StructuredBudgetExhaustedError",
  "ReplyBudgetPersistenceError",
]);

export async function runReplyGeneration(input: {
  systemPrompt: string;
  context: Omit<Parameters<typeof agentUserPrompt>[0], "problems" | "previousReply" | "turn">;
  model: AgentModel;
  /** Captures the requested model even when the provider rejects the call. */
  requestedModel?: () => string | null;
  /** Aborted when this execution loses its claim: the loop stops instead of drafting or sending. */
  signal?: AbortSignal;
}) {
  const turns: ReplyAgentTurn[] = [];
  let decision: AgentDecision | null = null;
  let lastResult: AgentModelResult | null = null;
  let problems: string[] = [];
  let previousReply: string | null = null;
  for (let turn = 1; turn <= MAX_TURNS && !decision; turn++) {
    if (input.signal?.aborted) {
      throw input.signal.reason instanceof Error
        ? input.signal.reason
        : new Error("Reply generation was cancelled: this execution lost its claim");
    }
    const began = Date.now();
    try {
      const result = await input.model({
        systemPrompt: input.systemPrompt,
        userPrompt: agentUserPrompt({ ...input.context, problems, previousReply, turn }),
      });
      // The takeover landed while the model worked (a stand-in model may
      // not honour the signal): its answer belongs to the replacement.
      if (input.signal?.aborted) {
        throw input.signal.reason instanceof Error
          ? input.signal.reason
          : new Error("Reply generation was cancelled: this execution lost its claim");
      }
      lastResult = result;
      const parsed = parseAgentDecision(result.text);
      const found = parsed.action === "reply" ? replyProblems(parsed.reply, input.context.channel, input.context.knowledge) : [];
      // Repair the note rather than deleting it: the same note could contain
      // a real unanswered question alongside its speculative prediction.
      if (speculativeQuestionNote(parsed.ownerNote)) found.push("The owner note predicts a possible future question. Remove that prediction. Keep a note only for an actual unanswered question the lead already asked or another real owner action; retain any genuine handoff. If the latest question is answered from the business information, ownerNote must be null.");
      const replaced = parsed.action === "wrong_number" ? closingAcknowledgement(parsed.reply, input.context.leadMessage, input.context.channel).problems : [];
      turns.push({ turn, ms: Date.now() - began, action: parsed.action, reply: parsed.reply || null, problems: [...found, ...replaced], error: null });
      if (found.length) {
        problems = found;
        previousReply = parsed.reply;
      } else {
        decision = parsed;
      }
    } catch (error) {
      if (input.signal?.aborted) throw error;
      const status = httpStatus(error);
      turns.push({ turn, ms: Date.now() - began, action: null, reply: null, problems: [], error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000), ...(status === null ? {} : { httpStatus: status }) });
      if (error instanceof Error && CLAIM_GENERATION_ERRORS.has(error.name)) throw error;
      if (error instanceof Error && BUDGET_GENERATION_ERRORS.has(error.name)) break;
      // The transport already handles transient errors. An unchanged request
      // cannot repair an invalid schema, missing model, or rejected credentials.
      if (status !== null && status >= 400 && status < 500 && ![408, 409, 429].includes(status)) break;
    }
  }
  const model = lastResult?.model ?? input.requestedModel?.() ?? null;
  return { decision, turns, lastResult, model, failureReason: decision ? null : generationFailureReason(turns) };
}

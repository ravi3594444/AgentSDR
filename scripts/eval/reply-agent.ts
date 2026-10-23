/** Send-free, database-free real-model evaluation of the production prospect reply harness. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { agentSystemPrompt, parseAgentDecision, DECISION_SCHEMA, type AgentDecision, type AgentPromptInput } from "@/lib/assistant/replyAgent/agent";
import { runReplyGeneration } from "@/lib/assistant/replyAgent/generation";
import { selectableAimlModels } from "@/lib/ai/aimlapi-types";
import { runtimeFor } from "@/lib/ai/server/runtime";
import { completeStructured } from "@/lib/ai/server/structuredCompletion";

type Message = AgentPromptInput["conversation"][number];
type Scenario = { id: string; history: Message[]; message: string; businessKnown?: boolean; category?: AgentDecision["category"]; expect?: "price" | "stop" | "followup" };
const outbound = (bodyText: string): Message => ({ direction: "outbound", bodyText });
const inbound = (bodyText: string): Message => ({ direction: "inbound", bodyText });
const opening = outbound("Hi, Ravi here from 22nd X AI. We build AI calling agents, lead qualification and CRM automation. When a new inquiry comes in, who handles the first reply?");
const question = outbound("Hey, thanks for replying! Quick one: what kind of business do you run, and is it mostly inbound leads or outbound calls?");

export const SCENARIOS: Scenario[] = [
  { id: "owners-outbound-typo", history: [opening, inbound("Hey"), question], message: "Yeah outbound calla", category: "other" },
  { id: "known-business-and-process", history: [opening, inbound("I run a dental clinic. My receptionist calls new enquiries and writes notes manually."), outbound("Which part is causing the most work?")], message: "following up on the people who dont answer", businessKnown: true, category: "other", expect: "followup" },
  { id: "repeated-greeting", history: [opening, inbound("Hey"), question], message: "Hi", category: "other" },
  { id: "clear-need-no-new-crm", history: [opening, inbound("We already have a CRM and three people doing outbound calls."), outbound("Where do things get stuck?")], message: "we forget followups, dont need a new crm", category: "other", expect: "followup" },
  { id: "unknown-price", history: [opening, inbound("We need help automating outbound followups."), outbound("We can automate follow-ups and update your existing CRM.")], message: "how much does it cost?", expect: "price" },
  { id: "stop-contact", history: [opening], message: "not interested, stop messaging me", expect: "stop" },
  { id: "continue-generated-reply", history: [opening, inbound("Hey"), question, inbound("Yeah outbound calla"), outbound("Got it, outbound calling. Our AI calling agents can handle first-touch calls and qualify leads, then push the results into your CRM. Are you using a CRM right now, or are the calls tracked another way?")], message: "we track calls in a spreadsheet and miss followups", category: "other", expect: "followup" },
];

/** Evaluation observations only: these phrase checks never gate or rewrite a customer's reply. */
export function observations(decision: AgentDecision | null, scenario: Scenario): string[] {
  if (!decision) return ["no usable decision"];
  const problems: string[] = [];
  const text = decision.reply;
  const previous = [...scenario.history].reverse().find(message => message.direction === "outbound")?.bodyText ?? "";
  const acknowledgement = /^(?:hey[,! ]+|hi[,! ]+)?(thanks?|got it|understood|okay|good question)\b/i;
  const before = acknowledgement.exec(previous)?.[1]?.toLowerCase();
  const after = acknowledgement.exec(text)?.[1]?.toLowerCase();
  if (before && before === after) problems.push("repeats the previous acknowledgement");
  if (/\b(?:when you say|do you mean|just to (?:make sure|confirm|clarify))\b.{0,110}\boutbound/i.test(text) && /outbound calla/i.test(scenario.message)) problems.push("asks to confirm an obvious typo");
  if (/what (?:kind|type|sort) of business|what (?:business|industry) (?:are you|do you)/i.test(text) && scenario.businessKnown) problems.push("asks for the business type already given");
  if (/\b(?:Ravi here|I['’]m Ravi|we['’]re an AI consulting agency)\b/i.test(text)) problems.push("repeats the introduction");
  if ((text.match(/\?/g) ?? []).length > 1) problems.push("asks multiple questions at once");
  if (scenario.expect === "price" && decision.ownerNote?.kind !== "question") problems.push("missing-price question was not handed to the owner");
  if (scenario.expect === "stop" && (decision.action !== "stop_contact" || text)) problems.push("opt-out did not stop silently");
  if (scenario.expect === "followup" && decision.action === "reply" && !/follow[ -]?up|retri|retry|call.*back|ring.*back/i.test(text)) problems.push("does not address the stated follow-up problem");
  if (scenario.category && decision.category !== scenario.category) problems.push(`ordinary chat was classified as ${decision.category}`);
  if (scenario.category === "other" && decision.ownerNote?.kind === "ready") problems.push("reports an unrequested next step to the owner");
  if (scenario.id === "repeated-greeting" && text.includes("?")) problems.push("adds another sales question after the previous question was ignored");
  return problems;
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name: string, fallback = "") => args.includes(name) ? args[args.indexOf(name) + 1] ?? fallback : fallback;
  const keyFile = option("--key-file");
  const key = (keyFile ? readFileSync(keyFile, "utf8") : process.env.AIML_API_KEY ?? "").trim();
  if (!key) throw new Error("Supply AIML_API_KEY or --key-file for this local test only");
  const modelId = option("--model", "deepseek/deepseek-chat");
  const phase = option("--phase", "check");
  const output = option("--output");
  if (!output) throw new Error("Supply --output outside the repository for the evaluation transcript");
  const budgetFile = option("--budget-file", "/tmp/agentsdr-reply-eval-budget.json");
  type Budget = { requests: number; answers: number; inputTokens: number; outputTokens: number };
  const budget: Budget = existsSync(budgetFile) ? JSON.parse(readFileSync(budgetFile, "utf8")) as Budget : { requests: 0, answers: 0, inputTokens: 0, outputTokens: 0 };
  if (![budget.requests, budget.answers, budget.inputTokens, budget.outputTokens].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error("Invalid evaluation budget; refusing to reset the cap");
  const saveBudget = () => writeFileSync(budgetFile, JSON.stringify(budget), { mode: 0o600 });
  const fetchNetwork = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== "https://api.aimlapi.com" || !url.pathname.startsWith("/v1/")) throw new Error("This test permits only AI/ML API requests");
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set("User-Agent", "AgentSDR-reply-eval/1.0");
    return fetchNetwork(input, { ...init, headers });
  }) as typeof fetch;
  const catalogFile = option("--catalog-file");
  const catalog = selectableAimlModels(catalogFile ? JSON.parse(readFileSync(catalogFile, "utf8")) : await fetch("https://api.aimlapi.com/v1/models?include=capabilities").then(response => response.json()));
  if (!catalog.some(model => model.id === modelId)) throw new Error("The selected model is absent from the live structured-output catalog");
  const runtime = await runtimeFor({ providerKey: "aimlapi", selection: { provider: "aimlapi", modelId }, routing: {}, structuredOutput: "json_schema", supportsPlugins: false },
    { id: "reply-eval", providerKey: "aimlapi", name: "Reply evaluation only", enabled: true, verified: true }, key, 25_000, { listModels: async () => catalog });
  const create = runtime.client.chat.completions.create.bind(runtime.client.chat.completions);
  runtime.client.chat.completions.create = (async (...parameters: Parameters<typeof create>) => {
    if (budget.requests >= 54 || budget.answers >= 30) throw Object.assign(new Error("Local evaluation call budget reached"), { status: 400 });
    budget.requests++; saveBudget();
    const response = await create(...parameters);
    if ("choices" in response) {
      budget.answers++;
      budget.inputTokens += response.usage?.prompt_tokens ?? 0;
      budget.outputTokens += response.usage?.completion_tokens ?? 0;
      saveBudget();
    }
    return response;
  }) as typeof runtime.client.chat.completions.create;
  const profile = { businessName: "22nd X AI", senderName: "Ravi", offer: "AI calling agents, lead qualification, CRM automation, websites and landing pages", problemsSolved: "Manual follow-up and CRM updates", nextStep: "A short discussion with Ravi about the workflow" };
  const knowledge = "Business: 22nd X AI. Sender: Ravi. Services: AI calling agents, lead qualification, CRM automation, websites and landing pages. We can automate follow-ups and update an existing CRM. Prices and appointment times are not saved. Next step: discuss the workflow with Ravi.";
  const systemPrompt = agentSystemPrompt({ channel: "whatsapp", profile });
  const results: Record<string, unknown>[] = [];
  const redact = (text: string) => text.split(key).join("[redacted]");
  async function evaluate(scenario: Scenario) {
    const started = Date.now();
    const result = await runReplyGeneration({ systemPrompt, context: { channel: "whatsapp", profile, knowledge, lead: {}, conversation: scenario.history, leadMessage: scenario.message },
      model: async input => completeStructured({ ...input, timeoutMs: 25_000, maxOutputTokens: 1_500, maxAttempts: 2, schemaName: "reply_decision", schemaDescription: "Your decision for the lead's latest message.", jsonSchema: DECISION_SCHEMA, accept: text => void parseAgentDecision(text) }, { runtime: async () => runtime }) });
    const checks = observations(result.decision, scenario);
    const row = { case: scenario.id, leadMessage: scenario.message, history: scenario.history, decision: result.decision, observations: checks, ms: Date.now() - started, turns: result.turns.length, failure: result.failureReason };
    results.push(row);
    writeFileSync(output, redact(JSON.stringify({ phase, model: modelId, promptHash: createHash("sha256").update(systemPrompt).digest("hex"), results, cumulativeBudget: budget }, null, 2)));
    console.log(redact(JSON.stringify({ case: scenario.id, reply: result.decision?.reply, action: result.decision?.action, category: result.decision?.category, observations: checks, ms: row.ms, failure: row.failure })));
    if (result.turns.some(turn => [401, 402, 403, 429].includes(turn.httpStatus ?? 0))) throw new Error("Stopped evaluation after a provider refusal");
    return result.decision;
  }
  const only = option("--only");
  for (const scenario of SCENARIOS.filter(scenario => !args.includes("--dialogue-only") && (!only || only.split(",").includes(scenario.id)))) await evaluate(scenario);
  if (!only && !args.includes("--no-dialogue")) {
    const history = [opening];
    for (const [index, message] of ["Hey", "Yeah outbound calla", "we do it ourselves and forget to follow up"].entries()) {
      const decision = await evaluate({ id: `dialogue-${index + 1}`, history: [...history], message });
      history.push(inbound(message));
      if (decision?.reply) history.push(outbound(decision.reply));
    }
  }
  console.log(JSON.stringify({ phase, scenarios: results.length, cumulativeBudget: budget }));
}

if (import.meta.main) main().then(() => process.exit(0)).catch(() => { console.error("Evaluation stopped. Check the saved transcript and call budget; credentials were not logged."); process.exit(1); });

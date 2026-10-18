/**
 * The assistant's real structured request, through the real harness
 * (completeStructured, accept = parseAgentReply), against AI/ML API: the
 * production system prompt and assistant_reply schema, a request like the
 * owner's of 18 October 2026, and the structured mode AI/ML's catalog gives
 * the model. Checks that a usable plan comes back and how many attempts it
 * took. Reads the key from AIML_API_KEY for this check only (the app reads
 * keys from the organization's AI Settings). A few cents per model.
 *
 *   AIML_API_KEY=… bun run --conditions=react-server scripts/e2e/aiml-live.ts [model …]
 *
 * Default model: anthropic/claude-haiku-5.5. On 18 Oct 2026 it stopped
 * mid-call (finish "length", arguments {} or message-only) on every
 * tool_choice "auto" request, and answered completely once the function was
 * named; the harness now names it for AI/ML API.
 */
import { agentReplySchema, parseAgentReply } from "@/lib/assistant/agent";
import { assistantSystemPrompt } from "@/lib/assistant/agent.server";
import { TOOL_NAMES } from "@/lib/assistant/tools.server";
import { aimlStructuredMode } from "@/lib/ai/aimlapi-types";
import { createAimlClient, listAimlModels } from "@/lib/ai/server/aimlapi";
import { completeStructured, type StructuredCompletionRuntime } from "@/lib/ai/server/structuredCompletion";

const key = process.env.AIML_API_KEY;
if (!key) {
  console.error("Set AIML_API_KEY for this check.");
  process.exit(2);
}
const models = process.argv.slice(2).length ? process.argv.slice(2) : ["anthropic/claude-haiku-5.5"];
const catalog = await listAimlModels();
const features = { instagram: true, web_discovery: true, inquiry_intake: false, apify_discovery: true, treg: false };
const systemPrompt = assistantSystemPrompt(features as never, { runsPerDay: 10, leadsPerDay: 300, searchesPerDay: 20 });
const userPrompt = [
  "TODAY: 2026-10-18",
  "BUSINESS PROFILE: business name 22nd X AI Studio; offer AI automations for small businesses; target customers real estate agents, salons; locations India",
  "SETUP: email connected; WhatsApp connected; LinkedIn connected; Instagram connected; Google Maps search available; Apify set up; web search TinyFish",
  "",
  "CONVERSATION (newest last):",
  "OWNER: hey find leads for our agency find and reach otu them in every ay possible insta email linked ai whastapp find leads to sell our ai aautomations any locatiosn i ned leads that si s liek active",
  "",
  "Your turn.",
].join("\n");

let failures = 0;
for (const modelId of models) {
  const entry = catalog.find((model) => model.id === modelId);
  const mode = entry ? aimlStructuredMode(entry.capabilities) : "json_schema";
  const runtime: StructuredCompletionRuntime = async () => ({
    providerKey: "aimlapi",
    selection: { provider: modelId.split("/")[0]!, modelId },
    routing: {},
    structuredOutput: mode,
    supportsPlugins: false,
    client: createAimlClient(key, 120_000) as never,
  });
  const started = performance.now();
  try {
    const result = await completeStructured({
      timeoutMs: 120_000,
      maxOutputTokens: 1_500,
      schemaName: "assistant_reply",
      schemaDescription: "Your message to the owner and the tools to run now.",
      jsonSchema: agentReplySchema(TOOL_NAMES),
      systemPrompt,
      userPrompt,
      accept: (text) => void parseAgentReply(text, TOOL_NAMES),
    }, { runtime });
    const reply = parseAgentReply(result.text, TOOL_NAMES);
    const ok = reply.actions.length > 0;
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${modelId} (${mode}): ${reply.actions.length} actions in ${result.attempts} attempt(s), ${Math.round(performance.now() - started)} ms — ${reply.actions.map((action) => action.tool).join(", ")}`);
  } catch (error) {
    failures++;
    console.log(`FAIL  ${modelId} (${mode}): ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
  }
}
process.exit(failures ? 1 : 0);

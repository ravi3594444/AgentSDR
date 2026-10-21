/**
 * Read the recorded reply failure. --probe asks the selected AI/ML model for
 * a decision on a synthetic greeting the way the worker does: json_schema
 * for a model tagged structured_output, and when that request is refused
 * with HTTP 400 and the model is tagged tools, the one function-call
 * fallback (structuredCompletion.ts). That is at most TWO AI requests. It
 * never sends a chat message or writes to the database. Keys stay inside
 * this process.
 *
 * bun scripts/diagnose-reply-agent.ts --record-id <CRM-record-UUID> [--probe]
 * Works in the production container with these four source files copied
 * to /tmp: this script, credential-crypto.ts, replyAgent/decisionSchema.ts,
 * and ai/aimlapi-types.ts.
 */
import { SQL } from "bun";
import { decryptCredentialText } from "../src/lib/integrations/credential-crypto";
import { DECISION_SCHEMA } from "../src/lib/assistant/replyAgent/decisionSchema";
import { aimlFunctionCallFallback, aimlStructuredMode } from "../src/lib/ai/aimlapi-types";

type Body = Record<string, unknown>;
const object = (value: unknown): Body | null => value && typeof value === "object" && !Array.isArray(value) ? value as Body : null;

export function redactReplyDiagnostic(value: unknown, secrets: (string | undefined)[]): string {
  let text = JSON.stringify(value, null, 2);
  for (const secret of secrets.filter((item): item is string => Boolean(item)).sort((a, b) => b.length - a.length)) {
    for (const encoded of [JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)]) {
      if (encoded) text = text.split(encoded).join("[REDACTED]");
    }
  }
  return text;
}

export function replyProbeRequest(model: string, mode: "json_schema" | "tool_call") {
  const base = {
    model,
    ...(model.startsWith("openai/") ? { max_completion_tokens: 1_500 } : { max_tokens: 1_500 }),
    messages: [
      { role: "system", content: "You are a business assistant. The lead only said Hello. Greet them back and ask one short question about their business needs. Make no promises. Submit one reply_decision result with category other, ownerNote null, and confidence 0.5." },
      { role: "user", content: "Hello" },
    ],
  };
  return mode === "json_schema" ? {
    ...base,
    response_format: { type: "json_schema", json_schema: { name: "reply_decision", strict: true, schema: DECISION_SCHEMA } },
  } : {
    ...base,
    tools: [{ type: "function", function: { name: "reply_decision", description: "Your decision for the lead's latest message.", parameters: DECISION_SCHEMA } }],
    tool_choice: { type: "function", function: { name: "reply_decision" } },
  };
}

async function probeOnce(model: string, apiKey: string, mode: "json_schema" | "tool_call", fetcher: typeof fetch) {
  const response = await fetcher("https://api.aimlapi.com/v1/chat/completions", {
    method: "POST", redirect: "error",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(replyProbeRequest(model, mode)), signal: AbortSignal.timeout(30_000),
  });
  const body: unknown = await response.json().catch(() => ({ message: "Non-JSON provider response" }));
  const json = object(body);
  return {
    mode, httpStatus: response.status,
    requestId: response.headers.get("x-request-id") ?? response.headers.get("request-id"),
    // This request contains no real lead data. Preserve the complete validation
    // response rather than losing field paths behind the SDK's .message.
    validation: response.ok ? null : body,
    answer: response.ok ? json?.choices ?? null : null,
    usage: response.ok ? json?.usage ?? null : null,
  };
}

export async function probeReplyProvider(model: string, apiKey: string, capabilities: string[], fetcher: typeof fetch = fetch) {
  const mode = aimlStructuredMode(capabilities);
  const functionCallFallback = aimlFunctionCallFallback(capabilities);
  const attempts = [await probeOnce(model, apiKey, mode, fetcher)];
  // Only a 400 on json_schema falls back, once; 401, 403, 404, 422, 429 and 5xx do not.
  if (mode === "json_schema" && functionCallFallback && attempts[0]!.httpStatus === 400) {
    attempts.push(await probeOnce(model, apiKey, "tool_call", fetcher));
  }
  const last = attempts.at(-1)!;
  return {
    currentModel: model, mode, functionCallFallback, capabilities,
    request: { model, schema: DECISION_SCHEMA, outputTokenLimit: 1_500 },
    // The last request's outcome: what the worker would go on with.
    answeredAs: last.mode, httpStatus: last.httpStatus, requestId: last.requestId,
    validation: last.validation, answer: last.answer, usage: last.usage,
    attempts,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] !== "--record-id" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args[1] ?? "") || args.length > 3 || (args[2] && args[2] !== "--probe")) {
    throw new Error("Usage: bun scripts/diagnose-reply-agent.ts --record-id <CRM-record-UUID> [--probe]");
  }
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const sql = new SQL(process.env.DATABASE_URL, { max: 1, tls: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false } });
  let apiKey = "";
  let model = "";
  let recorded: unknown;
  try {
    await sql.begin(async (tx) => {
      await tx`SET TRANSACTION READ ONLY`;
      const [record] = await tx<{ organization_id: string }[]>`select organization_id from crm_records where id=${args[1]!}`;
      if (!record) throw new Error("CRM record not found");
      recorded = await tx`
        select g.created_at, g.status, g.model, g.reason, g.turns
        from reply_agent_runs g join crm_conversations c
          on c.id=g.conversation_id and c.organization_id=g.organization_id
        where c.crm_record_id=${args[1]!} and g.organization_id=${record.organization_id}
        order by g.created_at desc limit 3`;
      if (args[2] !== "--probe") return;
      const [settings] = await tx<{ config: Body }[]>`
        select config from grid_providers
        where organization_id=${record.organization_id} and key='openrouter-byok-settings' limit 1`;
      const selected = object(settings?.config.defaultModel);
      const connectionId = settings?.config.connectionId;
      if (selected?.provider !== "aimlapi" || typeof selected.modelId !== "string" || typeof connectionId !== "string") {
        throw new Error("This probe requires the record's organization to have an AI/ML API default model");
      }
      const [connection] = await tx<{ encrypted_payload: string; config: Body }[]>`
        select c.encrypted_payload, p.config from grid_providers p
        join grid_provider_credentials c on c.provider_id=p.id
        where p.id::text=${connectionId} and p.organization_id=${record.organization_id} and p.enabled=true limit 1`;
      if (!connection || connection.config.aiProviderKey !== "aimlapi") throw new Error("No enabled AI/ML connection for this organization");
      const credentials = object(JSON.parse(decryptCredentialText(connection.encrypted_payload)));
      if (typeof credentials?.apiKey !== "string") throw new Error("AI key is not configured");
      apiKey = credentials.apiKey;
      model = selected.modelId;
    });
  } finally {
    await sql.close();
  }
  let probe: unknown = null;
  if (apiKey) {
    const catalog = await fetch("https://api.aimlapi.com/v1/models?include=capabilities", { signal: AbortSignal.timeout(15_000) });
    if (!catalog.ok) throw new Error("Could not read current model capabilities");
    const body = await catalog.json() as { data?: Array<{ id?: string; capabilities?: string[] }> };
    const entry = body.data?.find((item) => item.id === model && (item as { type?: string }).type === "openai/chat-completions");
    if (!entry || !Array.isArray(entry.capabilities)) throw new Error("The selected model is missing from the live catalog");
    probe = await probeReplyProvider(model, apiKey, entry.capabilities);
  }
  console.log(redactReplyDiagnostic({ recorded, probe, note: "No database changes or outreach sends. --probe makes at most two synthetic AI requests (json_schema, then the function-call fallback if that is refused with HTTP 400); AI token usage may be billed." }, [apiKey, process.env.DATABASE_URL, process.env.INTEGRATION_CREDENTIALS_KEY, process.env.POSTGRES_PASSWORD]));
}

if (import.meta.main) main().catch(() => {
  console.error("Diagnostic could not complete. Check the record ID, current AI connection and container environment. No outreach was sent.");
  process.exitCode = 1;
});

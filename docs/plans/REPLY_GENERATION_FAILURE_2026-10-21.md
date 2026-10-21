# Reply generation failure — 21 October 2026

## Observed failure

An automatic WhatsApp reply to `Hello` became the fixed sentence “Thanks! Let me check on that and get back to you shortly.” The VM's recorded `reply_agent_runs` row shows three HTTP 400 failures, no model decision, a null model, and a final `replied` status. Its reason says a holding line was sent after the model gave no answer. The owner subsequently answered from their phone; do not replay or resend this conversation.

The selected background model was AI/ML API's `deepseek/deepseek-chat` (DeepSeek Chat / V4.1 Flash). Background replies use the organization's default AI selection, which can differ from a chat's model selection.

## Cause

The adapter treated the catalog's `structured_output` tag as proof that strict `response_format: {type: "json_schema"}` was accepted. DeepSeek advertises both `structured_output` and `tools`, but its published model-specific input schema permits only `text` and `json_object` response formats. It supports function calling. The adapter therefore built a request this model refuses, and nothing let it try the function call it does support.

Primary provider endpoints checked on 21 October 2026:

- Catalog: https://api.aimlapi.com/v1/models?include=capabilities
- DeepSeek input schema: https://api.aimlapi.com/docs-json?model=deepseek%2Fdeepseek-chat&endpoint=openai%2Fchat-completions

The saved production error is generic `400 Validation failed`; it does not name the invalid field. The field mismatch is established from the adapter and the provider's published schema. A corrected authenticated request still needs the VM probe below.

The tag is not wrong for most models: json_schema was live-tested on 13 October 2026 (openai/gpt-4o-mini, google/gemini-3.5-flash-lite, anthropic/claude-haiku-latest) and is how roughly 300 AI/ML models tagged `structured_output` (Gemini, GPT-5.x, Qwen, Mistral and others) are asked today. The fix therefore keeps json_schema as the first request and only reacts to a model that actually refuses it.

Two harness behaviors hid this problem: the outer reply loop repeated the unchanged 400 request three times, then fabricated a customer-facing holding message and recorded the outcome as a successful reply.

## Changes

- `aimlStructuredMode` is unchanged from the base: `structured_output` means json_schema, otherwise a function call. Every model that accepts json_schema sends exactly the request it sent before.
- AI/ML API only: when a json_schema request is refused with HTTP 400 and the model's catalog tags include `tools` (`aimlFunctionCallFallback`, passed to `completeStructured` as the runtime's `functionCallFallback`), the same attempt is sent once more as a forced function call: same model, same system and user input, the same JSON schema as the function's parameters. The rest of that call stays a function call, with the usual answer checks (`accept`, rejected-answer feedback, the doubled budget after a `length` finish) and the usual attempt bound. The switch happens at most once per call and never back; the refused request is not counted as an attempt, so a call makes at most `maxAttempts` + 1 requests.
- No fallback for anything but a 400: 401, 403, 404, 408, 409, 422, 429, 5xx and timeouts behave exactly as before, and a model not tagged `tools` (or whose catalog entry could not be read) keeps its 400. OpenRouter is untouched. There is no model-ID special case and no provider or model switch.
- If the function-call retry fails as well, the error says the json_schema request was rejected and the function-call retry also failed, with both reasons, and keeps the HTTP status (on the error and its `cause`) so the reply loop still stops on a permanent 4xx.
- Stop the reply generation loop on permanent HTTP 4xx errors. Transient failures and rejected drafts retain bounded retries; rejected claims receive correction feedback.
- Retain the selected model and the HTTP status with failed attempts.
- If generation exhausts its attempts, send and draft nothing. Mark the record's workflow as Error, append a `reply.generation_failed` event, and open a Needs you decision with the reason. Recheck whether the owner answered or the conversation changed first.
- Preserve the existing wrong-number closing path and send protections.
- Remove the fabricated holding-line fallback. No schema migration is needed; HTTP status is an optional key in the existing JSON turn history.
- Add a diagnostic that reads recorded failures and can probe the provider the way the worker now asks: json_schema first, then the one function-call fallback if that request is refused with HTTP 400 and the model is tagged `tools`. At most two provider requests; it never sends an outreach message or updates the database.

## Validation

- Adapter tests cover: a json_schema model answering as before (one request, no tools); a 400 with `tools` tagged (exactly two requests, the second a forced function call with the same model, input and schema, its answer checked by `accept`); a 400 without `tools` (one request, status 400 kept); 401, 403, 404 and 422 (no fallback, one request); 429, 500 and 503 (the usual retries, all json_schema); a refused function-call retry (two requests, both reasons, status 400 kept); a rejected function-call answer (retried as a function call within the attempt bound, never json_schema again); OpenRouter's 400 (unchanged, `tool_choice` "auto"); and the DeepSeek reply decision end to end through `DECISION_SCHEMA` and `parseAgentDecision`.
- Focused adapter, runtime-plan, diagnostic and reply-agent tests: 65 pass, 0 fail.
- Full unit suite (`npm test`): 1,925 pass, 0 fail across 189 files. The four failures previously seen on base `373ac3c` (CSV date conversion, intake date parsing, two sender-status locale punctuation tests) did not reproduce in this run's environment; nothing here touches them.
- Typecheck (`npx tsc --noEmit`) and ESLint on the changed files pass.
- The database-backed reply-agent suite (`scripts/e2e/reply-agent.ts`) passed 108/108 against a disposable local PostgreSQL 16 database, including the greeting/HTTP-400 case.
- No production image, deployed worker, live customer send, or authenticated provider request was tested here.

## VM probe before deployment

This fetches the isolated fix branch without changing the checkout. The optional `--probe` asks the selected model the way the worker does, using saved credentials inside the container and only a synthetic greeting, never prospect data: one json_schema request, and only if that is refused with HTTP 400 and the model is tagged `tools`, one function-call request. At most two requests; it can incur a small AI charge. The displayed provider response is redacted against the configured credentials.

```bash
(
set -euo pipefail
cd ~/leads-x
git fetch origin codex/reply-generation-failure
git archive FETCH_HEAD \
  scripts/diagnose-reply-agent.ts \
  src/lib/integrations/credential-crypto.ts \
  src/lib/assistant/replyAgent/decisionSchema.ts \
  src/lib/ai/aimlapi-types.ts \
  | docker exec -i agentsdr-app-1 tar -xf - -C /tmp
docker exec agentsdr-app-1 agentsdr-entrypoint bun \
  /tmp/scripts/diagnose-reply-agent.ts \
  --record-id 2710301b-aff9-4164-9180-bc398306cffa --probe
)
```

For DeepSeek Chat, expect `mode: "json_schema"`, `functionCallFallback: true`, a first attempt answered with HTTP 400 (its full validation body is kept in `attempts[0].validation`), and a second attempt with `answeredAs: "tool_call"` and HTTP 200. An HTTP 200 alone does not establish a valid decision: inspect the returned `reply_decision` arguments too. If the json_schema request succeeds, the model needs no fallback and the first attempt is the answer. If the function call is refused as well, preserve the displayed full validation details rather than switching models and calling the root cause fixed.

Before merging, run `scripts/e2e/reply-agent.ts` against a disposable native PostgreSQL database. After deploying, test a new greeting on an owner-approved test conversation and confirm both a contextual reply and the recorded model. Do not resend to the prospect whose owner has already replied.

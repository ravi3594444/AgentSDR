# Reply generation failure — 21 October 2026

## Observed failure

An automatic WhatsApp reply to `Hello` became the fixed sentence “Thanks! Let me check on that and get back to you shortly.” The VM's recorded `reply_agent_runs` row shows three HTTP 400 failures, no model decision, a null model, and a final `replied` status. Its reason says a holding line was sent after the model gave no answer. The owner subsequently answered from their phone; do not replay or resend this conversation.

The selected background model was AI/ML API's `deepseek/deepseek-chat` (DeepSeek Chat / V4.1 Flash). Background replies use the organization's default AI selection, which can differ from a chat's model selection.

## Cause

The adapter treated the catalog's `structured_output` tag as proof that strict `response_format: {type: "json_schema"}` was accepted. DeepSeek advertises both `structured_output` and `tools`, but its published model-specific input schema permits only `text` and `json_object` response formats. It supports function calling. The old adapter therefore constructs an invalid request for this model.

Primary provider endpoints checked on 21 October 2026:

- Catalog: https://api.aimlapi.com/v1/models?include=capabilities
- DeepSeek input schema: https://api.aimlapi.com/docs-json?model=deepseek%2Fdeepseek-chat&endpoint=openai%2Fchat-completions

The saved production error is generic `400 Validation failed`; it does not name the invalid field. The field mismatch is established from the adapter and the provider's published schema. A corrected authenticated request still needs the VM probe below.

Two harness behaviors hid this problem: the outer reply loop repeated the unchanged 400 request three times, then fabricated a customer-facing holding message and recorded the outcome as a successful reply.

## Changes

- Prefer function calling when AI/ML advertises `tools`, including models also tagged `structured_output`. Preserve the existing schema-only and unknown-capability paths. There is no model-ID special case or automatic provider switch.
- Stop the reply generation loop on permanent HTTP 4xx errors. Transient failures and rejected drafts retain bounded retries; rejected claims receive correction feedback.
- Retain the selected model and the HTTP status with failed attempts.
- If generation exhausts its attempts, send and draft nothing. Mark the record's workflow as Error, append a `reply.generation_failed` event, and open a Needs you decision with the reason. Recheck whether the owner answered or the conversation changed first.
- Preserve the existing wrong-number closing path and send protections.
- Remove the fabricated holding-line fallback. No schema migration is needed; HTTP status is an optional key in the existing JSON turn history.
- Add a diagnostic that reads recorded failures and can make one synthetic provider call with the shared worker decision schema. It never sends an outreach message or updates the database.

## Validation

- The request-format regression failed with the old adapter and passes with the fix.
- Focused adapter, decision, retry, reply-state and diagnostic tests pass (56 checks).
- Full unit suite: 1,909 pass, four fail. All four failures reproduce on unchanged base commit `373ac3c` in the same environment: CSV date conversion, intake date parsing, and two locale punctuation expectations in sender status. They are outside this change.
- Typecheck and ESLint on changed code pass.
- The database-backed reply-agent suite is updated for the new failure behavior, including the greeting/HTTP-400 case. It has **not passed here**: there is no usable native PostgreSQL service in this environment, and the disposable PGlite socket substitute fails with a prepared-statement protocol mismatch. This is not evidence of a product failure or a passing worker integration test.
- No production image, deployed worker, live customer send, or corrected authenticated provider request was tested here.

## VM probe before deployment

This fetches the isolated fix branch without changing the checkout. The optional `--probe` performs one model request using saved credentials inside the container; it uses only a synthetic greeting, never prospect data. It can incur a small AI charge. The displayed provider response is redacted against the configured credentials.

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

Expect the selected model, `tool_call` mode and an HTTP 200 function-call response. An HTTP 200 alone does not establish a valid decision: inspect the returned `reply_decision` arguments too. If the provider rejects it, preserve the displayed full validation details rather than switching models and calling the root cause fixed.

Before merging, run `scripts/e2e/reply-agent.ts` against a disposable native PostgreSQL database. After deploying, test a new greeting on an owner-approved test conversation and confirm both a contextual reply and the recorded model. Do not resend to the prospect whose owner has already replied.

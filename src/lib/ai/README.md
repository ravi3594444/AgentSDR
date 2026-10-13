# Use AI

This subsystem is a sibling of `src/lib/integrations`. An integration action
has fixed inputs and outputs; an AI model accepts a free-text prompt and
returns the fields requested by the user.

Inference goes through one of two OpenAI-compatible providers, chosen per
organization in Settings → AI provider: **OpenRouter** or **AI/ML API**. Each
organization's connection is a `grid_providers` row with its secrets encrypted
in `grid_provider_credentials` (`connections.ts`), verified with one cheap call
before it is stored (`server/verify.ts`). The settings (selected connection,
enabled models, default model, transcription model, OpenRouter's routing
confirmation) live in the per-organization row keyed `openrouter-byok-settings`;
the key predates AI/ML API and is kept so existing installs need no migration.
The selected connection's provider decides which rules apply.

`runtimePlan.ts` is the gate every model call passes, as a pure function, and
`server/runtime.ts` (`getAiRuntime`) is the mandatory entry point that applies
it, decrypts the key and returns a client. `server/structuredCompletion.ts`
(`completeStructured`) is how every structured answer is requested.

## OpenRouter

The connection holds two secrets: an inference API key and a management key.
The management key reads `/api/v1/byok`; it cannot run completions.
Provider/model choices are discovered from the live BYOK account.

Text calls send `provider.only`, `provider.order`, `allow_fallbacks: false`,
and `require_parameters: true`. Image calls use the dedicated
`/api/v1/images` endpoint with the same one-provider pin and disabled
fallbacks; that endpoint does not support `require_parameters`. Structured
answers are requested as a function call (see the comment in
`structuredCompletion.ts` for why not `response_format`).

Fallback-section BYOK credentials are discovered for visibility but are not
selectable. A connection must contain at least one active prioritized BYOK
credential, and selected models are revalidated against the live catalog.

### BYOK-only requirement

OpenRouter does not expose its “Shared capacity fallback” switch through the
public management API. An operator must set **Never use shared capacity on this
provider** for every enabled provider in the OpenRouter BYOK dashboard, then
confirm that setting in the app. Runtime calls are blocked until confirmed.

## AI/ML API

One secret: the AI/ML API key (`aimlapi-types.ts`, `server/aimlapi.ts`). It is
verified with `GET /v1/key`, which costs nothing and answers 401 for a bad key
(the model list is public, so it cannot verify anything). There is no
management key, BYOK provider list or routing confirmation.

Selectable models are the chat-completion models in AI/ML's catalog
(`GET /v1/models?include=capabilities`) tagged `structured_output`; they are
revalidated against the live catalog on save. Structured answers use
`response_format: json_schema`, strict when the schema qualifies
(`isStrictJsonSchema`), and the answer is the message content.

Not available through AI/ML API, and refused with a message that says so:

- call transcription (audio input has only been checked through OpenRouter);
- OpenRouter's web plugin, so web-research AI columns and the qualification
  parent lookup;
- image AI columns.

## Columns

The column config (`AiConfig`) lives in `src/lib/grid/types.ts`. Live model
IDs are persisted directly in `AiConfig.modelKey`, together with the selected
upstream provider in `AiConfig.upstreamProvider` (`aimlapi` for AI/ML API). A
column runs on the connection AI Settings selects; a column saved for the
other provider is refused until it is re-saved.

After changing this subsystem, run `npx tsc --noEmit`, `bun run test` and a
production build. `scripts/e2e/ai-live-crm.ts` checks live classification and
drafting through whichever provider is configured.

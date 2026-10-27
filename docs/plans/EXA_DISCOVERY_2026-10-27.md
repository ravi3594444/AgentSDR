# Exa discovery — 22nd x ai

Separate branch: `codex/exa-discovery-20261027`, based on the native Claude prototype. Neither release nor main has been changed or deployed.

## Behavior

- The operator stores one Exa API key in `/platform` → Providers → Exa. The existing operator guard, encrypted platform credential store, masked hints, replacement and removal apply. Saving verifies with one small metered Search call; it is an operator action, not a workspace research request.
- `exa_search` runs Auto Search from a natural-language description. Optional result count (Exa's public 1–100 range), included/excluded domains. Returns source URLs, titles, dates, authors and highlights. No default city, niche or source priority.
- `exa_read` uses Contents for a batch of up to 10 public pages, with text bounded to the existing 12,000-character page snapshot. More pages can be read in later batches. It reports published contacts; login-walled social pages and Reddit's existing access rules are not bypassed.
- The tool catalog is shared by the API JSON harness and native Claude MCP. Both use the same app handlers, credential resolution, request controls, evidence grounding and import path. UI cards identify Exa.
- No additional Exa request budget, monthly allowance or free-only default is added. The owner can explicitly ask for a dollar cap or free-only research. Exa's promotional credits are not assumed to make every request free.
- Calls reserve estimated cost in `provider_usage` before transport, under the existing request-spend lock when a cap exists. The provider's `costDollars.total` settles the estimate; missing costs retain the conservative list-price estimate. The request and operator reports include these amounts. AI model tokens remain separate, as before.
- A 429 releases the held cost and records Retry-After. Unknown/server-failure outcomes remain counted conservatively. No automatic transport retry resends uncertain paid work. Native cancellation propagates to the Exa transport. This does not claim that Exa reports the remaining account balance or independently confirmed billing.
- Search grounding uses only returned results, not the model's query. Page grounding strips query-string contact echoes. Sources still do not establish buying interest, and page instructions never grant permission to send.

## Upgrade

One re-runnable migration, `add-exa` / `db/migrations/20261027-exa.sql`, adds `exa` to the platform-credential constraint. It is included in the default deploy sequence, Dockerfile and Docker build-context allowlist. Existing credentials and customer provider choices are unchanged. There is no customer Exa setup page or environment-key fallback.

## Verification

- Full unit suite: 2,323 passed, 0 failed; includes 9 new focused Exa tests.
- Disposable PGlite: Exa integration 30 checks, native Claude harness 27 checks, organization-scope check passed. Both harness tests run real app handlers and database writes; the model/CLI/provider responses are scripted stand-ins. Native tests use the actual MCP HTTP path.
- The Exa checks cover encrypted key verification, both harnesses, saved contact evidence, isolated usage and leads, request spend, no implicit cap, free-only, pause/cancel, unsafe URLs, rate limits, uncertain billing, safe credential failures, key removal and migration replay/fresh-schema equivalence.
- Typecheck and changed-file lint pass.
- Production webpack build passed when run alone, including the build TypeScript check and all 116 static pages. Google font responses used an offline fixture. An earlier build overlapped other memory-intensive checks and was killed; cgroup counters recorded one OOM kill. No application code was changed for the rerun.
- No real Exa key/call, signed-in Claude generation, real social session, Docker image build or VM deployment was performed.

The earlier native prototype's remaining live/concurrency/full-flow limitations still apply; adding Exa does not turn those into verified results. Derived Graphify output is regenerated locally; the large graph could not be included in the previous connector snapshot and must be rebuilt if the remote checkout needs it.

## Sources checked 27 October 2026

- https://exa.ai/docs/reference/search
- https://exa.ai/docs/reference/get-contents
- https://exa.ai/pricing/

Auto Search base price: $0.007 for up to 10 results, with list-price reservations for additional results/content; Contents: $0.001/page for one content type. All app figures are estimates, not an account balance or billing guarantee.

Browser integration is a separate handoff: `BROWSER_RESEARCH_AGENT_HANDOFF_2026-10-27.md`.

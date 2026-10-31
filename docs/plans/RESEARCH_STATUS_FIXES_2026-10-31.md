# Research counts, uncertain outcomes and evidence dates

Base: `codex/browser-integration-20261030` at `5b48f91`.

## Changes

Follow-up requests now use the full continued-request funnel for Found, Contactable and Matching. Their target still counts only newly found matches, so “find 10 more” does not immediately complete on inherited leads. The progress card labels that target as new contactable matches when earlier matches are included in the totals. Older responses without the new field retain their existing fallback.

The native loopback MCP server now supplies an explicit per-server timeout aligned with the host's remaining turn and finishing-effect allowance. Without a configured tool timeout, Claude Code's HTTP first-response timer can expire while a long app operation is still running. See [the official timeout reference](https://code.claude.com/docs/en/mcp#time-limits-on-mcp-tool-calls). Host cancellation, account authorization, serialization and duplicate protections continue to apply; the change does not retry effects.

Both assistant engines reconcile ambiguous or negative plan/send statements against the canonical scoped request summary before publishing the final answer. An existing plan or recorded contact evidence is handed back for correction. Ordinary answers add no summary query. If the read fails too, the outcome stays unconfirmed. Shared guidance directs status recovery to the existing plan rather than recreating it. Recorded contact is not proof of delivery, reading or a reply.

The research agent and lead judge now explicitly check each applicable owner criterion, preserve alternatives the owner allowed, and distinguish potential prospects from verified public buying requests. Qualification and review expose publication age computed from the stored post date. Reading a page today cannot make its old post recent; missing, invalid and future dates remain uncertain. The judge gets the business's current date and time zone for calendar-relative criteria. These evidence changes add no per-lead model call, industry rules, source preferences or blanket exclusions of unconfirmed prospects the owner expressly selected. A contradicted final status answer uses the engines' existing correction flow to ask for a corrected answer.

## Validation

- 59 relevant unit checks and 27 native harness checks passed in separate test processes (86 total). These include publication-age uncertainty, preserved prospecting behavior, inherited target labels and saved-status corrections.
- The native MCP fixture lost a response after the operation began, then recovered its committed status with one effect; replay, serialization, cancellation and authorization regressions also passed.
- 13 request/projection database checks and the existing request-workspace suite passed (61 PASS lines total), including organization isolation and the new follow-up and saved-status assertions. The workspace suite includes its 22 compact/full React rendering checks.
- All 12 research-progress render checks, changed-file ESLint, the production build and standalone TypeScript passed. The build retains the existing formula-sandbox dynamic-import warnings and local build-time auth configuration warnings; no production credentials were used.
- Graphify's incremental rebuild refreshed all 23 code files changed since `c0a9710`, then clustering completed without model calls. Queries find both new helpers. The 19.5 MB generated graph and its report remain local: they exceed the GitHub connector's request-size limit, and direct Git push has no authenticated credential in this workspace. The published commit contains the application, tests and this note.

The database fixtures use disposable PGlite (PostgreSQL in WebAssembly), not native PostgreSQL concurrency verification. The MCP regression uses a real local MCP client and a simulated lost response; it sends no outreach. Lead-fit decisions remain model judgments; no live-model quality result is claimed.

The public HTTP 502 is separate from the local MCP timeout. Its exact cause still requires the VM's app/proxy logs. No server deployment, production data change, live account acceptance or message send is included here. No migration or extension update is needed.

## Manual verification after deployment

1. Reopen a request with earlier matching leads and check its follow-up status. Found, Contactable and Matching should include the same inherited scope; the new-lead target should remain separate.
2. Read an existing outreach plan's status. Compare the assistant's answer with its saved card. A status failure should remain unconfirmed until refreshed and should not instruct the owner to create another copy.
3. Run a small research-only request for recent public buying requests. Inspect the source quote, publication date, computed age and why each lead fits. Compare with a broad prospecting request: do not require public buying intent when the owner did not ask for it.

# Browser efficiency and regression plan

Base: `codex/browser-integration-20261030` (`ebcfe6a9`). Work on an isolated branch; no deployment or messages to real recipients during implementation.

## Problem and scope

The owner's signed-in WhatsApp run made twelve model-facing calls: task authorization, two opens of the same tab, six reads, two screenshots and one visual click. The trace proves the sequence, not the duration of each component. The page loader waits for Chrome's document load and then sleeps 1.5 seconds; that does not establish application readiness. Opens and actions already return observations. Browser reads and writes are also all labelled as searches in the activity summary.

Implement improvements in the extension and shared browser tools, keeping the selected model's native harness in charge:

1. Bounded, read-only readiness waits inside a browser command. Allow a visible CSS target and/or page text as conditions, return the final observation and an explicit timeout state, and respect Stop/disconnect/command expiry. Provide useful readiness for the WhatsApp chat entry point without repeatedly asking the model to poll a loading page. No arbitrary JavaScript and no automatic Send.
2. Reuse the same request's exact already-open page where possible. Do not silently adopt unrelated owner tabs, overwrite drafts, select another signed-in account, or reuse an ambiguous recipient based only on the domain. Preserve explicit new-tab/navigation options.
3. Improve observations so usable fields and their controls survive the element limit and icon controls retain meaningful labels. This should make ordinary DOM interaction available before screenshots are necessary.
4. Record queue, browser execution/readiness and server round-trip durations in tool details. Measure the separate task-authorization call; do not add another agent loop or change the owner's model.
5. Separate browser activity from search counters and show a compact truthful summary. Keep detailed calls available.
6. Fix direct phone-recipient matching in the existing message checks, so a browser message addressed by phone is checked against the same saved person's Do Not Contact record. No unsolicited sends or changes to campaign authorization.

The final send remains an explicit existing action with the task grant and a returned observation. An uncertain outcome must be inspected before retrying. This avoids introducing a compound send operation before recipient/draft/acknowledgment handling is proven.

## Verification matrix

- Readiness: immediate/delayed content; delayed rich editor after document load; invalid selector; timeout; login/CAPTCHA; navigation while waiting; Stop/disconnect/expiry while waiting. Waiting never submits or sends.
- Reuse: exact URL in the same request; query-string differences; another request's tab; shared/adopted owner tabs; explicit new tab; an already-filled draft preserved.
- DOM observations: a composer below many navigation links; icon-only Send; sensitive values remain redacted; existing form/reset and research-only restrictions unchanged.
- Recipients: international phone normalization; explicit owner number; duplicate saved contacts; Do Not Contact and workspace isolation; malformed numbers do not become silently corrected destinations.
- Outcomes: existing lost-acknowledgment and duplicate-send behavior retained; no retry of uncertain writes; Stop prevents following actions.
- Compatibility: older extension keeps ordinary features; new wait options have a clear version requirement; schemas use typed inputs; packaged extension and app agree on the release.
- UI: browser-only tasks are not labelled searches; mixed research/browser requests retain true provider counts and details.
- Run relevant regression suites, typecheck, lint, extension packaging and production build. Use deterministic DOM/Chrome fixtures and disposable local data. Distinguish these from real WhatsApp and real desktop acceptance.

Target: remove model-facing loading polls and unnecessary observations. A warm chat should normally need task authorization, a useful open/read, fill, and Send with its returned verification. This is a tool-count target, not an unmeasured promise of wall-clock speed.

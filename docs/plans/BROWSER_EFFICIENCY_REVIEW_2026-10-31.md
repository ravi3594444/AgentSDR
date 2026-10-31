# Browser efficiency implementation review

Base: `codex/browser-integration-20261030` at `ebcfe6a9`. Review: PR #13.

The extension now handles loading waits locally and returns one useful final observation. The selected model still controls the task through the existing native harness. No account, sender, or model was changed during verification.

## Changes and related defects covered

| Problem | Result |
| --- | --- |
| Document load did not mean the application was usable | Bounded, read-only selector/text waits; WhatsApp chat entry waits for its composer; explicit timeout/cancellation outcomes |
| Reopening a page could repeat navigation | Exact same-request page reuse, with an explicit fresh-page option; no adoption of unrelated tabs or changes to drafts |
| Navigation links could consume the observation limit | Fields and nearby controls take priority; icon-only buttons receive meaningful labels |
| Browser work appeared as repeated searches | A browser activity summary; technical steps and overlapping timing phases remain in Details |
| A click could be described as a completed send | Click results require the outgoing state to be checked before claiming completion |
| Phone formatting and duplicate contacts could miss an opt-out | Canonical international phone matching, all matching saved contacts checked, organization isolation retained; malformed destinations are not silently corrected |
| Waiting could invalidate earlier screenshots or shared-tab behavior | Both sides invalidate old screenshots; toolbar-shared tabs retain their existing read-only access; other tabs remain inaccessible |

The extension is **0.19.0**. Its manifest changes only the version. New wait/reuse capabilities are version-gated; ordinary tools remain usable with 0.18.0.

## Verification

| Check | Result |
| --- | --- |
| Full unit suite, UTC | 2,436 passed across 231 files |
| Real Chromium readiness/observation fixtures | 16 passed |
| Existing real Chromium page-action rules | 77 passed |
| Actual extension controller with stand-in Chrome/DOM/bridge | 14 passed |
| Connection-replacement race and same-connection control | Both passed |
| React activity markup | 6 passed |
| Browser task database suite | 41 passed |
| Browser research database suite | 69 passed |
| Phone-recipient and bridge-contract database suite | 9 passed |
| TypeScript, scoped ESLint, patch whitespace | Passed |
| Extension package | 17 files; version 0.19.0; bundled controller matches the build |
| Final production build | Passed with Node/webpack, including its TypeScript and static-page steps; existing formula-sandbox import warnings remain |

Chromium was 153.0.8010.0, using fixture pages. Database checks used disposable PGlite with stand-in browser/model responses; they are not evidence of native PostgreSQL concurrency or live provider delivery. No real message was sent. React review found no added effects, network requests, or heavy client imports in the activity-panel changes.

The new CI browser job runs the DOM, existing action-rule, controller, race and activity-render checks. GitHub currently reports no workflow runs for this fork; no remote CI pass is claimed. The project graph was refreshed locally. Its generated JSON exceeds the connector's 16 MiB write limit, so the refreshed graph is not included in the remote patch.

## Controlled acceptance after deployment

1. Deploy the integration branch and install extension 0.19.0. Confirm the connection reports that extension version.
2. Use a confirmed test recipient. Ask for one short message and inspect the outgoing message before treating it as sent; uncertain writes must be inspected before retrying.
3. Check that loading is handled inside the open/read, the composer and Send control appear in the observation, and an existing draft is preserved unless explicitly changed.
4. Inspect Details for authorization, queue, browser/readiness and round-trip durations. These phases overlap and must not be added as a total. Browser calls should not appear as lead searches.

The intended warm-chat sequence is task authorization, useful open/read, fill, and Send with its returned verification. This is a tool-count target, not a measured live WhatsApp speed claim. Live account behavior, desktop UI acceptance, and end-to-end timing remain to be checked after deployment.

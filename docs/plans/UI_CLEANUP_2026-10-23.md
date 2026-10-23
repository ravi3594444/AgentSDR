# UI cleanup — 23 October 2026

Branch: `codex/ui-cleanup-20261023`, based on pilot commit `3fc03b4`. Backend work is separate; see `REPLY_RELIABILITY_HANDOFF_2026-10-23.md` on this branch.

## What changed

- Sidebar and command palette use the unified Inbox. The four channel-inbox links are behind the client-safe `channelInboxes` release flag, off by default. Existing routes, account connections and campaign tools remain available. Old inbox URLs highlight Inbox in navigation.
- The global decision queue is removed from the Outreach chat, which now links directly to Inbox. Contextual chat questions and plan controls remain in place.
- Inbox filters and summary statistics start collapsed on desktop as well as phones. Active filter counts remain visible; the same filters and actions are available when expanded. The summary explicitly says it covers all channels.
- Reply rows/cards show their saved processing state, last update and available failure reason under Details. This is saved state, not proof that a worker is alive. Actual per-call timings are not in the list response and are not fabricated here.
- Advanced settings start collapsed in the desktop rail, opening by default when first visiting an advanced section. Every setting and its storage remains in place; phones retain their grouped section picker. The existing daily lead limit remains the visible sending input.
- Getting started explains that only one sending account is required, links to the daily limit and Outreach, and moves supporting facts into Details. Sending/reply checks expand when they need attention. The badge reports connected channels, not a misleading all-optional-steps-complete target.

The existing record pop-up and full page already share `CrmRecordClient`; only its back-link presentation differs by variant. Their handlers are shared. No replacement conversation workspace was built.

## Verification

- `tsc --noEmit`: pass.
- ESLint on all seven changed code/test files: pass, no warnings.
- `TZ=UTC bun test --conditions=react-server`: 2,219 pass, zero failures, on the final code.
- Full PostCSS/Tailwind stylesheet compilation: pass.
- `git diff --check`: pass.
- Reviewed new disclosures for labels, keyboard access and separation from clickable row/preview controls. No additional polling or network request was added.
- Graphify rebuilt locally. Its approximately 18 MB JSON exceeds the GitHub connector's 16 MiB input limit; the regenerated graph pair remains local rather than publishing half of it.

The local environment's `TZ=Asia/Kolkata` also exposed two pre-existing date-parsing test failures: PHP form dates and spreadsheet ISO dates shift back a day. Both reproduce on unchanged `3fc03b4` in a disposable checkout with the same time zone. Their source was not changed. UTC is explicit in the passing unit command above; this does not establish those parsers work under every process time zone.

No production build, browser automation, screenshot, real provider call or send was performed for this UI patch. The combined backend/UI release still needs its build and controlled live checks.

## Quick manual check after a preview/deploy

1. Open Outreach: the global decision list is absent, Inbox is reachable, and chat/plan actions remain usable.
2. In Inbox, switch channels, expand Filters and summary, and open a processing/error row's Details without opening its editor accidentally.
3. Open a record from Inbox, then close it: its underlying list and filters should remain. Check edit, classify and reply-mode actions with test data.
4. Open Settings on desktop and phone; expand Advanced and follow a direct advanced-settings link.
5. Open Getting started with one connected account. Verify the connected-channel badge, per-plan reply-mode wording and expandable sending/reply checks.

## Release boundary

This patch changes presentation and a navigation release flag. It changes no database query, migration, AI prompt, provider setting, worker, budget, sending rule or permission check. It does not fix expiring claims, nested retries, unbounded history or the failed-draft edit transition. The agent's backend branch addresses those in separate tested commits, followed by a review before merge and regression checks on the combined result.

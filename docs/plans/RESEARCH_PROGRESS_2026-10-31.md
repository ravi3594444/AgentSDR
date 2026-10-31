# Visible research progress

Base: `codex/browser-integration-20261030` at `c0a9710`.

The chat now has one visible research card for the whole request, including browser searches that have no background provider job. It reads the saved brief, actual tool states, provider stages and the request's lead counts. It does not make model calls or control the agent's source choices.

The card shows Approach, Find, Check fit, Shortlist and Results, with the active action and subtle motion while recorded work is running. Stages can be revisited as research moves between discovery and checking. The saved approach is expandable. Technical tool history and the existing source rows remain available below.

Found, Contactable and Matching retain their request-wide meanings. Reviewed counts distinct saved people, using the same rule as the existing finish check. A judge's unconfirmed result is still unchecked until the assistant inspects it. Unconfirmed after review is shown separately from candidates still to check. Review progress is a measured fraction of saved candidates, not an estimate of all work remaining. A default lead target is labelled as a default; unknown counters remain unknown.

The request projection reuses the existing scoped funnel query for review counts. A null fit is counted as pending. No database migration, new permission or extension update is needed; extension 0.19.0 remains compatible.

Paused research, provider waits, failed sources and unavailable live status have separate presentations. A status failure keeps saved counts visible and stops stale activity animation in both the card and source rows. The generic Thinking indicator also stops when the latest update cannot be confirmed. This addresses the misleading client display around an HTTP 502; the cause of a server/proxy 502 still requires the VM logs.

## Validation

- 89 relevant unit tests passed, including phase changes, returning to discovery, default targets, duplicate stages, paused/stopped work, provider waits, uncertain fit, missing counters and non-research browser tasks.
- 11 new React render checks and the 6 existing browser-activity render checks passed. These cover measured fractions, collapsed Details, reduced-motion classes, stale status, provider rows and ordinary browser tasks.
- 9 new database checks passed on disposable PGlite: actual SQL against the existing checked-person rule, duplicate sources, verdict precedence, null fits, the request projection and organization isolation.
- The existing request-workspace suite passed, including its 22 compact/full React render checks and the new distinct-person review-count assertion.
- Changed-file ESLint and patch whitespace checks passed.
- Final Node/webpack production build and standalone TypeScript passed. The first concurrent build exceeded workspace memory; the final build ran with a 4096 MB heap and heavy checks separated. Existing formula-sandbox dynamic-import warnings remain.

Database checks use PostgreSQL in WebAssembly, not native PostgreSQL concurrency verification. CI now runs the new database fixture on PostgreSQL 16 and the new render fixture with the browser regressions. No remote CI pass, live account acceptance, message send or VM deployment is claimed.

## Manual verification after deployment

1. Start a lead search using the connected browser. Confirm the card appears after the brief, even before a provider job exists, and its counts update as candidates are saved and checked.
2. Inspect the current action, saved research approach and source details. Confirm a new search after checking returns to Find, and qualification activity switches to Check fit.
3. Check that reviewed progress counts a business once across lists, and that an unchecked unconfirmed candidate is not shown as reviewed. Default targets must not be described as a number the owner requested.
4. Pause/resume the request. During a failed status read, confirm that saved counts remain visible and stale Thinking/spinners stop; use Refresh status to recover.
5. Check a narrow mobile viewport, dark/light themes and the operating system's reduced-motion setting. Stage labels, counts and the recorded action must remain readable.
6. Run an ordinary browser task such as opening a page or sending a message to a named test contact. It should retain browser activity without acquiring a lead funnel.

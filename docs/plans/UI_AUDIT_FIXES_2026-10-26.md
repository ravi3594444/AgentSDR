# Sequential UI audit fixes

Scope chosen by the owner: fix audit items 1, 4, 5 and 6 in that order, verifying each end to end before changing the next. Items 2 (automatic greeting wording) and 3 (authentication email setup) are excluded.

## 1. Requests loading and recovery — verified

The Requests page had no route-specific loading/error fallback, no deadline for its client reads, and no protection against an older response overwriting a newer filter. Expanded details did not refresh for every kind of progress change.

The page now has loading and retry states. Saved-state reads time out after 20 seconds; this is a UI recovery deadline, not a research deadline. Retry reads saved work and never restarts a request or sends anything. The last loaded rows stay visible after a refresh failure; malformed JSON is an error rather than an empty list. A new filter cancels and invalidates the previous read. Expanded details refresh while visible.

Verification on the production build: 13 browser checks passed (real sign-in and workspace selection, real saved requests and details, detail refresh, injected HTTP 500 with preserved rows, retry to the real API, malformed success, stalled first read and retry, stale filter response, phone width and no runtime errors). The Requests database suite passed 38 checks, including cross-organization reads and no unintended writes. Type checking, changed-file lint and the production webpack build passed.

The database was a fresh PGlite instance with serialized protocol cycles for browser clients. These UI checks do not prove native PostgreSQL locking or provider delivery. No live provider was called and no outreach was sent. The exact cause of the original VM's blank page was not established; this change addresses the identified missing recovery paths.

## 4. Setup counts — verified

Getting started now counts connected senders separately from setup/reply warnings. For example, two connected mailboxes plus one failed mailbox still count as an email channel; one disconnected older WhatsApp or Instagram account does not erase the connected account. The warnings remain visible with a connected-account count. Included Unipile resolves through the same connection check the sender uses instead of requiring a workspace-owned credential row.

The chat badge shows connected channels, Set up AI, or Connect a sender. Optional channels and the built-in Maps scraper no longer add to a misleading “N to set up” total. The menu explains that one sending channel is enough.

Verification: all 38 onboarding unit checks pass, including three new cases for mixed account states, preserved reply-sync warnings and missing integrations/migrations. Browser checks passed against the production build for both own and Included credentials, on Bun 1.4.4, through real sign-in, saved account rows and the real settings/chat pages, at desktop and phone widths. Type checking, changed-file lint, the organization-scope contract and the production build pass. No provider calls or sends.

An older local Bun 1.3.14 standalone run produced hydration errors; the same build passed with Bun 1.4.4 (the VM runtime) and Node 24. No runtime or Docker change was made to hide that result.

## 5. Classification controls — verified

A held proposal now compares the two actual choices, including subcategory IDs. When Accept and Keep would send the same payload, the record and both Inbox layouts show one confirmation. A real category or subcategory change retains both explicit choices. An actual agreement is described neutrally; an absent proposed category is not described as AI agreement. The manual classification picker remains available.

No classification is silently applied. The existing guarded classification API, context/revision checks and downstream behavior are unchanged.

Verification: five choice tests pass; all 107 workspace reply/replay checks pass. Twelve browser checks pass on Bun 1.4.4: real Inbox data, the single confirmation, genuine changes retaining both controls, a real confirmation request persisted as accepted without changing Other, and desktop/phone layouts, with no browser errors. Type checking, changed-file lint and the production build pass. Fixtures and providers were disposable/fake; no real message was sent.

## 6. Chat and email clutter — verified

The brief has a short “Request saved” summary, with its full text under Details. Exact tool-result echoes are omitted from the visible chat even when routine steps separate them; whitespace is normalized, and a new user turn ends that comparison. Stored messages are unchanged. Questions, suggestions and assistant/tool errors remain outside the routine activity log, along with the final answer. Routine summaries are shortened while their full detail stays expandable.

Email previews in the unified Inbox use the same quoted-history splitter as the email thread. They show the latest written reply instead of repeating the older sales email below it. The shared helper is moved without changing its existing parsing rules; other channels and the stored message body are unchanged.

The 20 focused chat/email tests pass. Independent TypeScript checking, changed-file lint and the production webpack build pass. Thirteen checks pass through the real local production server on Bun 1.4.4: real authentication and workspace selection, the final answer/question/error staying visible, a compact brief with one expandable full copy, desktop and phone previews showing the new email text, the full email remaining in the record API, phone width and no browser runtime errors. The database and providers were disposable/fake. No live provider was called and nothing was sent.

## Final regression results (27 October)

The complete Bun 1.4.4 unit run is **2,291 pass / 6 fail** across 220 files. It is not an all-green suite. Two failures are the existing UTF-8 CSV and Elementor/PHP-style form cases; four are timing failures (the deploy mock's five-second timeout and three hostile-page parser benchmarks). None of the affected source or test files differs from release baseline `a8e3a61`. A clean worktree at that baseline, using the same dependencies/runtime, reproduces the CSV/form failures, the deploy timeout and one parser timing failure: 143 pass / 4 fail across the five affected suites. Timing failures vary with load. No assertions or deadlines were weakened, and no unrelated parser/import/deploy changes were added to this UI scope.

The older Bun 1.3.14 full run also had six failures; it is kept separate from the VM-runtime result. The earlier per-item browser/database results above remain the verification for items 1, 4 and 5. The organization-scope contract passes again on the combined tree. The complete production build and item 6 browser checks pass. The final HTTP tenant-isolation walk passes against the production build served by Bun 1.4.4: 132 reads, 20 writes and 66 pages, 46 fingerprints across 15 fixture tables, zero isolation failures. Two unchanged mailbox routes return 200 to the other organization without changing the row (signature PATCH and mailbox DELETE); these remain review notes, not data leaks.

An initial broad walk was stopped by automatic approval review because a provider-reaching endpoint could attempt an AI request. The final walk is explicitly offline: the isolation fixture selects no AI provider and stores no AI credentials, and `localOnlyNetwork.ts` is preloaded into the seed, app and probe processes. Its separate check proves external HTTP/HTTPS fetch, Node HTTP, sockets, WebSockets and redirects are refused while localhost HTTP works (seven checks). The broad walk refuses to start without this guard. This is not live-provider acceptance and does not prove native PostgreSQL concurrency. No outreach was sent.

The code graph was regenerated locally. Its generated JSON is about 18 MB and is not included in this connector checkpoint; it can be regenerated with `graphify update .`.

Deployment is pending. The live VM is not changed by these checks. No migrations are added by these UI fixes.

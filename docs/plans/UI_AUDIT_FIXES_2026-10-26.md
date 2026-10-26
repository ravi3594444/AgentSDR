# Sequential UI audit fixes

Scope chosen by the owner: fix audit items 1, 4, 5 and 6 in that order, verifying each end to end before changing the next. Items 2 (automatic greeting wording) and 3 (authentication email setup) are excluded.

## 1. Requests loading and recovery — verified

The Requests page had no route-specific loading/error fallback, no deadline for its client reads, and no protection against an older response overwriting a newer filter. Expanded details did not refresh for every kind of progress change.

The page now has loading and retry states. Saved-state reads time out after 20 seconds; this is a UI recovery deadline, not a research deadline. Retry reads saved work and never restarts a request or sends anything. The last loaded rows stay visible after a refresh failure; malformed JSON is an error rather than an empty list. A new filter cancels and invalidates the previous read. Expanded details refresh while visible.

Verification on the production build: 13 browser checks passed (real sign-in and workspace selection, real saved requests and details, detail refresh, injected HTTP 500 with preserved rows, retry to the real API, malformed success, stalled first read and retry, stale filter response, phone width and no runtime errors). The Requests database suite passed 38 checks, including cross-organization reads and no unintended writes. Type checking, changed-file lint and the production webpack build passed.

The database was a fresh PGlite instance with serialized protocol cycles for browser clients. These UI checks do not prove native PostgreSQL locking or provider delivery. No live provider was called and no outreach was sent. The exact cause of the original VM's blank page was not established; this change addresses the identified missing recovery paths.

## 4. Setup counts — next

## 5. Classification controls — pending

## 6. Chat and email clutter — pending

Deployment is pending. The live VM is not changed by these checks.

# Combined reply/UI release — 24 October 2026

Release branch: `codex/reply-release-20261023`.
Combines backend `48e53b9` and UI `4e8e69c`.

Additional fixes from re-review: ownership checks lock claim rows in their
write transaction; legacy draft and reply-check calls receive cancellation;
draft preparation and failure writes check ownership; a displaced classifier
cannot mark its replacement failed. Suppression reads reuse the current
transaction instead of requesting a second connection. A test-only nested
pool lookup was hoisted outside its transaction without changing assertions.

Verification on the combined code:
- Unit suite: 2,251 pass, zero failures (UTC).
- Typecheck and changed-file lint pass.
- Original review probe: 11/11, unchanged.
- Additional ownership/cancellation checks: 6/6 (all six failed before the fixes).
- Reply-agent suite: 110 checks pass.
- Reply delivery: 21 checks pass.
- Workspace replay: 107 checks pass.
- Organization-scope contract: pass.

All database checks used disposable PGlite, one connection, fake providers.
Real multi-connection PostgreSQL contention and live recipient replies remain
unverified. Nothing was sent and no running VM was changed.

The production compiler check uses Next's build-only Google Fonts fixtures:
this environment blocks fonts.gstatic.com. Those fixtures are outside the
repository and are not shipped. The VM deploy must still build with real fonts.
Compiler check status: pending.

No new migration. Deploy with the existing docker/deploy.sh workflow and its
default migrations. Check the running revision after deployment; then use a
recipient you control for one Automatic reply and one Review reply.

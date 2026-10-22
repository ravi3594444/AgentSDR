# Managed SaaS upgrade: missing Tavily table — 22 October 2026

## Observed on the VM

The Docker image for `9527b64` built successfully. Its last migration,
`add-managed-saas`, failed with PostgreSQL `42P01: relation tavily_settings
does not exist`. The deploy script did not switch the app, restored the
running image's tag, and restarted the Maps scraper.

The Tavily table was originally created by the optional
`add-instagram-intake-discovery.ts` script. That script is not in the current
default deployment sequence. The managed migration unconditionally selected
from Tavily to preserve existing credential choices, so older installations
without the table could not upgrade. A fresh schema already contains the
table, which is why applying the migrations twice to a fresh database did
not expose this gap.

## Fix

`db/migrations/20261022-managed-saas.sql` creates the complete Tavily settings
table, if missing, before the credential backfill. The columns, defaults,
primary key, organization foreign key and daily-limit constraint match the
existing fresh schema. Existing tables and rows are left intact. The fix
does not change the application bundle, default migration list, credentials
or sending behavior, and does not replay the broad older migration.

## Verification

- New local-database regression: `scripts/e2e/managed-saas-upgrade.ts`.
- Before the fix: **5 pass, 1 fail**, with the same missing-relation error.
- After the fix: **8 pass, 0 fail**. The missing-table case recreates the
  fresh columns and constraints; repeated runs leave the table empty. The
  existing-table case preserves encrypted keys, key hints, custom daily
  limits, timestamps, explicit Included choices and their reasons; an empty
  settings row does not force own-provider mode.
- All 12 default migration scripts applied twice successfully.
- These SQL checks ran on disposable PGlite through a single test connection,
  not native PostgreSQL. They exercise SQL upgrades, not concurrent-session
  locking. Both scenarios roll back their fixture and schema changes.
- Typecheck and focused lint pass. Deploy packaging/sequencing tests pass.
- No production image was rebuilt here: the only runtime change is SQL.
  The VM's already-built `9527b64` application remains usable after repairing
  the database. Live provider and native combined-suite acceptance remains
  pending as documented in the release report.

## Recovery using the already-built application

For a VM still checked out at `9527b64`, fetch the fix without pulling or
changing the working tree. Apply the corrected managed SQL from its verified
commit through `psql --single-transaction --set ON_ERROR_STOP=1`, with a
10-second lock timeout and 120-second statement timeout. The failed deploy
already made a database backup; retain it.

Then rerun the existing deploy script with `SKIP_GIT_UPDATE=1`, the same
compose overlays and 4096 MB build heap. This keeps the source inputs at
`9527b64`, allowing BuildKit to reuse the image layers that just built;
the script still performs its normal backup, migration, rollback and health
checks. Its original migration now succeeds because Tavily exists. The
expected running image revision remains `9527b64`.

This is a database repair plus a cached deployment, not a claim that the
new SQL is present inside the old image. The fix is committed on the deploy
branch for subsequent ordinary deployments. Pulling that fix before the
immediate retry changes the build context and may recompile the app.

After success, grant the first platform operator through
`agentsdr-entrypoint bun scripts/grant-platform-operator.ts`, then open
`/platform` and adopt/store the platform keys and select the Included AI
engine. Existing own-provider workspaces retain their choices.

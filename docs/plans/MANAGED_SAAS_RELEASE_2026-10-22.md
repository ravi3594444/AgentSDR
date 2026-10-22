# Managed SaaS and research harness release — 22 October 2026

Combined inputs:

- `codex/managed-saas-20261022` at `99a57c6aeae91a50da87fd86f38560e986764788`.
- `claude/research-v2-live-fixes` at `d1237978debbc1a96a7ce1bffe2d00ce8dd57f02`.
- Both retain the previous deploy head, `5c1d03fe21644d63cf3c990654234f62c3844806`.

Application files merged automatically. The two generated graph files were
resolved locally by rebuilding the graph from the combined tree. The GitHub
connector rejected the rebuilt 17 MB graph because its escaped request exceeds
the connector's 16 MiB limit. The published tree retains the managed branch's
graph files; the rebuilt graph remains in the local release checkout. Application
files and this verification report are published. This release does not include
the unfinished Claude model/effort handoff branch.

## Verification performed on the combined tree

- TypeScript check: pass, Node heap 6144 MB.
- ESLint: zero errors; six existing LinkedIn warnings. The changed assertion
  and operator-script files also pass their focused lint check.
- Unit tests: **2165 pass, zero fail**, `TZ=UTC bun test --conditions=react-server`.
  The first run had four environment-related failures. Two date parsing cases
  pass with the UTC test environment. Two display tests also failed on the
  previous deploy source because ICU inserts an optional comma after a weekday;
  their assertions now permit that punctuation while requiring the exact reset
  date, clock time and time zone. Product formatting was not changed.
- Recorder package: pass.
- Production Node/Webpack build with 4096 MB heap: pass. Existing sandbox
  dynamic-require warnings remain. No Docker daemon is available here, so this
  was the Dockerfile's application build command, not a Docker image build.
- The **12 default migrations run twice** on a disposable PGlite database: pass.
  PGlite is not native PostgreSQL and does not prove concurrent-session locking.
- Managed services, platform admin, Unipile ownership, research-v2 and full-flow
  database suites were attempted through PGlite's TCP multiplexer. They cannot
  complete reliably: interleaved connections produce PostgreSQL wire-protocol
  prepared-statement/bind errors. Those attempts are **not passing e2e gates**
  and are not evidence of native PostgreSQL product failures.

The originating branches' native PostgreSQL results are in their own reports.
The full native database suites have **not** been rerun against this combined
tree. Live provider calls, real account connections, delivery, and the VM image
remain unverified here. Deployment to the owner's testing VM is not acceptance
for onboarding paying customers.

## Scope and outstanding limitations

Read `MANAGED_SAAS_IMPLEMENTATION_2026-10-22.md` for the complete design and
limitations. In particular:

- Shared Unipile remains v1 with application ownership checks, not provider
  Scopes. The documented account-claim window is not resolved by this merge.
  Exploiting it requires a valid private callback token and another newly
  created, unowned account id. Neither is returned in customer connection
  responses. Do not describe this as provider-enforced isolation or a completed
  live isolation test.
- No per-customer plan editor, suspension controls or provider-health dashboard
  were implemented. Allowances are the default set in code.
- Existing workspaces retain their own providers and credentials. New Included
  workspaces need the operator to configure platform keys and an AI default.
- Claude Code subscription login remains an owner-only pilot.
- The research branch makes the newer harness built-in for all workspaces,
  including workspaces with an old saved off choice. There is no harness toggle.

## Deploy on the testing VM

Use the published release/deploy branch named in the handoff, inside the
existing tmux session. Keep the discovery and Claude Code compose overlays.
Do not override the migration list: the deploy script now includes
`add-managed-saas` after the previous eleven migrations.

The deploy script checks available memory plus swap, backs up the database,
keeps a rollback image, pauses the Maps scraper during the build, runs the
migrations before switching, and checks health, revision and worker startup.

After deployment, grant the signed-in account explicitly. Use the entrypoint
so bundled-database credentials and the public origin are populated:

```bash
read -r -p 'Your AgentSDR sign-in email: ' operator_email
docker compose exec -T app agentsdr-entrypoint bun \
  scripts/grant-platform-operator.ts --email "$operator_email"
```

Open `/platform`, adopt/store provider credentials, and choose an Included AI
engine and model. TinyFish key verification uses one search; adopting existing
configuration is an explicit operator action. Existing own-provider workspaces
keep their configuration.

## Remaining acceptance

Run the combined native PostgreSQL suites before customer rollout. On the
testing VM verify the running image revision, operator access, one research-only
request, and hosted-auth callbacks for each intended sending channel. Any test
send requires an approved recipient. No provider key, account connection or
outbound message was changed during this release preparation.

## Rollback

Use the exact rollback tag printed by `docker/deploy.sh` with the same compose
overlays. The additive migrations can remain. Existing own-provider workspaces
continue on the old image; Included services introduced by this release will
not be available on it. Preserve the new ownership tables.

# Pilot combined release: research preview and sender pacing

Combines `claude/research-v2-live-fixes` at `8801a2a` (all six new commits:
Bright Data source choice, owl research preview, tool loosening and graph rebuilds)
with the existing pilot branch at `013aad2` (managed SaaS and Claude private testing).

Email, WhatsApp and initial Instagram outreach now default to a minimum of
**30 seconds per sender**, for new and existing workspaces. Send workers check
every 10 seconds by default, so actual delivery may take longer. Daily limits,
Do Not Contact, provider restrictions, sender warm-up, approvals and planned
follow-up dates continue to apply. This does not change LinkedIn pacing.

`add-sender-pacing` runs after `add-managed-saas`. It removes existing pacing
overrides once, using a marker in `platform_settings`, and shortens old email
and Instagram pacing timers using their recorded last sends/attempts. It never
resets a usage counter or edits a recipient's follow-up date or send claim.
Ordinary reruns leave later explicit settings untouched. The explicit post-switch
`--refresh` catches a legacy timer the old app may write during migration.

Two integration conflicts were resolved:

- Apify readiness retains managed/own credential attribution and accepts an
  unavailable account-limits snapshot as the research change expects.
- TinyFish → Tavily fallback retains the Tavily credential source, so Included
  calls keep their allowance and billing attribution. Typecheck caught the
  missing property after the automatic merge.

## Verification

- Combined unit suite: 2,199 passed, no failures.
- Typecheck and focused ESLint pass after the integration fixes.
- Sender-pacing SQL regression: 14 checks passed on a local disposable PGlite
  database using one PostgreSQL connection. Includes two workspaces, preserved
  daily counts and limits, four-day follow-ups, untouched sent/uncertain claims,
  remaining 30-second waits, reruns and the explicit timer refresh.
- Deploy tests verify the new script is in the default order, Dockerfile and
  `.dockerignore` allowlist.
- The AST graph was rebuilt locally. Its JSON exceeds the GitHub connector's
  request limit; publication retains the research branch's existing graph blobs.
- Production build result is stated in the handoff. The first parallel attempt
  hit this container's 8 GB memory ceiling; the repeat runs alone.

No live provider calls, live sends or VM deployment are covered by these checks.
No native PostgreSQL concurrency claim is made from the single-connection check.

## VM deployment

```bash
(
set -euo pipefail
cd ~/leads-x
unset SKIP_GIT_UPDATE DEPLOY_REEXEC MIGRATIONS
export COMPOSE_FILE=docker-compose.yml:docker-compose.build.yml:docker-compose.discovery.yml:docker-compose.claude-code.yml
NEXT_BUILD_HEAP_MB=4096 bash docker/deploy.sh --branch codex/pilot-deploy-20261021
docker compose exec -T app agentsdr-entrypoint bun scripts/add-sender-pacing.ts --refresh
docker inspect agentsdr-app-1 --format 'Revision={{index .Config.Labels "org.opencontainers.image.revision"}} Started={{.State.StartedAt}}'
)
```

The deploy script backs up, builds, applies the existing migrations plus sender
pacing, switches the image, then checks it. A failure before switching keeps
the previous app. Existing VM edits are retained by the script's normal flow.

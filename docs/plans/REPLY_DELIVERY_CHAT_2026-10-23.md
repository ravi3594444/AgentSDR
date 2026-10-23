# Automatic replies and chat noise — 23 October 2026

## What was reproduced

A WhatsApp reply attempted during the local sender gap was rejected before
provider submission. The CRM treated that ordinary wait as a terminal send
failure. The reply agent then opened an owner decision instead of scheduling
the already-written answer. This is a confirmed code defect; it is not proof
that every missing reply in the VM transcript had this cause.

The assistant's delivery tool returned outbound queues and historical totals,
but no latest-message processing evidence. An empty campaign queue did not
establish whether an inbound reply had been answered. Older disconnected
accounts can also have the same displayed phone number as the current account.

## Changes

- Only the known, local `send_gap` refusal defers an automatic WhatsApp reply.
  The existing draft, revision and idempotency key are kept. A durable
  `auto_send` job waits until the recorded time; repeated gaps reschedule it.
- Sending rechecks the run, mode, newer messages, takeover, suppression,
  Do Not Contact and limits. Stop, Pause or a newer answer cannot revive a
  stale draft. Wrong-number acknowledgements keep their one-attempt rule.
  Unknown delivery outcomes are not automatically retried.
- A plan-scoped delivery check now includes recent incoming reply previews,
  their classification/send job outcomes and the exact conversation account.
  It distinguishes queued work, failure, manual review and an actual answer.
  All data access remains scoped to the organization.
- Both chat harnesses use those message-level facts for status questions,
  rather than asking the owner to repeat text that is already recorded.
- Earlier narration and routine steps fold into an expandable Activity log.
  Plans, errors, decisions, research cards and the last assistant answer stay
  visible. Reports show recorded figures first, with their complete text under
  Details. Delivery cards keep recent reply outcomes visible. Saved lead lists
  are expandable. Existing chat messages are not deleted.

No provider selection, Claude Code setting, sending interval or database
schema is changed. No new migration is needed.

## Verification

- TypeScript and lint, including the new files: pass.
- Unit tests: 2,212 pass, 0 fail, under `TZ=UTC` and `--conditions=react-server`.
  Two unchanged date-import tests fail under this machine's non-UTC default
  and pass with UTC; no date-import code was changed.
- `scripts/e2e/reply-delivery.ts`: 21 checks pass against disposable PGlite
  using the real CRM and reply-agent code with a fake model and send adapter.
  It covers waiting, one send, original text/idempotency, repeated waits,
  Pause/Stop/new-message/DNC guards, actual classification errors, exact-account
  status, uncertain delivery and organization isolation. It forbids external
  fetches. This is not a native Postgres concurrency or live provider test.
- The organization-scope database check passes on the disposable schema.
- Webpack production build with Node's 4 GB heap, as in the Dockerfile: pass.
  The standalone output runs under Bun and serves `/sign-in` with HTTP 200.
  No Docker daemon is available here, so the image itself was not built.
- HTTP tenancy walk on that build: 132 reads, 17 writes and 66 pages; no
  isolation failures. Two unrelated routes (`/api/nav/badges` and
  `/api/settings/providers`) returned 500 because PGlite's shared protocol
  session lost an unnamed prepared statement between connections. They need
  a native Postgres recheck; this is not a claim that every route passed.
- The code graph was rebuilt with `graphify update .` (14,016 nodes,
  47,326 edges). Its 17.9 MB JSON could not be uploaded: GitHub connector
  `create_blob` refused the escaped request for exceeding its 16 MiB body
  limit. The release retains the previous graph files; the rebuilt copies
  remain local. Regenerate with `graphify update .` before the next graph query.

## Deploy and one live check

```bash
(
set -euo pipefail
cd ~/leads-x
unset SKIP_GIT_UPDATE DEPLOY_REEXEC MIGRATIONS
export COMPOSE_FILE=docker-compose.yml:docker-compose.build.yml:docker-compose.discovery.yml:docker-compose.claude-code.yml
NEXT_BUILD_HEAP_MB=4096 bash docker/deploy.sh --branch codex/pilot-deploy-20261021
docker inspect agentsdr-app-1 --format 'Revision={{index .Config.Labels "org.opencontainers.image.revision"}} Started={{.State.StartedAt}}'
)
```

After deployment, send one fresh message from your controlled recipient to
the running Automatic plan. A reply held by the sender gap should show
“Answer written; waiting for the sender until …”, then “Answered”. Actual
sending also depends on worker availability and the other recorded gates.
Ask the assistant to check that specific plan once; its delivery card should
show the latest recorded message and outcome without a wall of diagnostics.
Expand Activity and Details to inspect the full history.

This deployment does not bulk-retry historical failed or uncertain sends.
No live provider call, customer message or VM deployment was performed here.

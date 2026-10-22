# Claude Code private test

The platform operator can now choose **Claude Code (private test)** as the
Included AI default and approve named workspaces. New users of those workspaces
need no Claude account or API key. This supersedes the app's original single-member
restriction for the explicitly approved test; the personal pilot remains available.

## Set up

1. In the server's original workspace, open Settings → AI provider → Claude Code.
   Sign in using the official CLI flow and check the model you want to use.
2. Open `/platform`, choose **Claude Code (private test)**, choose a checked
   model, select the test workspaces (including your own if wanted), and save.
3. New workspaces use Included AI by default. A workspace that already chose
   **My own provider** keeps that choice; its owner can select Included AI in
   Advanced → Use your own providers.

Only an explicitly granted platform operator who also owns the source workspace
can publish their own login. Another operator cannot select that person's login.
Unknown workspaces are refused. The ordinary account connection controls stay
owner-only; friends never receive credentials or control the operator's login.

No migration is added: the approved workspace ids and source account identity are
non-secret keys in the existing global `platform_settings` AI row.

## Runtime and isolation

- Each task retains its requesting workspace's immutable organization scope.
  Only the credential binding's model-check metadata is read from the explicitly
  approved source workspace, using its organization id in the query.
- Every generation has an empty working directory, no tools, no file reads,
  no MCP configuration, no resumed conversation and no session persistence.
  The CLI still manages its own login. No tokens are read or copied by AgentSDR.
- The current single app process runs one generation at a time per Claude
  account. The existing server-wide process cap also applies. A queued task
  rechecks approval, the source owner/operator grant, login and usage holds before
  it starts. A queue wait remains bounded; this is not an unlimited work queue.
- A limit on the source account holds all borrowing workspaces. Signing out,
  losing ownership, losing operator access, or removing approval blocks new work.
  There is no automatic paid API fallback.
- Calls and tokens are attributed to the requesting workspace in `provider_usage`.
  Per-call cost is unknown, not an invented API price. The API dollar allowance
  is not applied to this account-login path; its actual plan, usage windows and
  any provider-side extra usage billing still apply. Plan & usage explains this.
- Personal Use/Stop controls cannot misreport changing a published global
  default; its source owner is directed to `/platform` instead.

Setting changes are immediate in the saving process and reach another process
within the existing 30-second settings cache. This pilot targets the current
single-instance VM. Account queues and reported usage holds are in memory;
multiple app replicas would need a shared queue/hold store before using this path.

This is a private-test implementation, not a statement of provider approval.
The official binary, authentication choices and provider limits are unchanged.

## Verification

- Unit suite: 2,169 passed, no failures on the final complete run.
- `scripts/e2e/claude-shared-test.ts`: 18 checks passed against a disposable
  PGlite database over a single PostgreSQL connection and a fake CLI. Covers
  source ownership/operator grants, checked models, approved/unapproved and
  own-provider workspaces, immutable tenant scope, usage attribution, real lead
  judging and CRM reply-classifier consumers, revocation, sign-out, shared limits
  and absence of copied login directories or API fallback.
- New runner tests cover serialized tasks, fresh directories, a limit reached
  while queued and approval revoked while queued.
- The first integration run exposed an attempted nested organization switch;
  it was replaced with the narrowly scoped credential-metadata query. The
  tenancy scope implementation was not weakened.
- Typecheck, focused ESLint and the organization-scope contract check pass.
  The final Node/Webpack production build with a 4 GB heap passes, including
  TypeScript and standalone output generation. It was built without deployment
  secrets; Better Auth warns about missing build-time configuration.

No real Claude generation, live provider, outreach send, Docker build or VM
deployment was performed by these checks. Native PostgreSQL concurrency and a
live Claude subscription call remain unverified here. The new end-to-end script
refuses a non-local database and must never be run on customer data.

The AST graph was regenerated locally. The GitHub connector's request-size
limit prevents uploading the 17 MB graph JSON; functional files can be published
independently. Regenerating the graph requires no model call.

## Deploy

Use the existing deploy branch and keep the CLI volume/installation overlay:

```bash
(
set -euo pipefail
cd ~/leads-x
export COMPOSE_FILE=docker-compose.yml:docker-compose.build.yml:docker-compose.discovery.yml:docker-compose.claude-code.yml
NEXT_BUILD_HEAP_MB=4096 bash docker/deploy.sh --branch codex/pilot-deploy-20261021
)
```

The existing migrations are re-runnable, including the Tavily older-schema fix.
The script still backs up the database and checks the new image before accepting
the deployment.

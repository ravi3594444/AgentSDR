# Claude Code login (owner-only pilot)

Branch `claude/mausbot-claude-login`, based on `f25af920441ef344b8d1a81f0343cbeb446272af`
(`claude/pilot-merge-20261021`, the latest verified integration commit). Not
merged and not deployed: it waits for review, separate from the UI release.

An owner signs Anthropic's own Claude Code CLI in with **their own Claude
account** from Settings → AI provider → Claude Code, and can then choose that
the organization's AI steps run on it instead of an API key. The method is
OpenMausBot's: run the installed, unmodified `claude` binary and let it do its
own sign-in.

## The conditions it is built to

Rechecked on 21 Oct 2026 at <https://code.claude.com/docs/en/legal-and-compliance>:

- **Unmodified binary, every built-in sign-in kept.** Hosting Claude Code
  requires that it "must not be modified" and that no authentication method
  built into it is removed, disabled or restricted. The CLI is installed from
  Anthropic's npm package as published (checksum-pinned), never patched, and
  never updates itself (`DISABLE_AUTOUPDATER=1`; it is updated with the
  image). The settings card offers all three of the CLI's own choices
  (`claude auth login --claudeai`, `--console`, `--sso`).
- **No intermediating.** "Each end user must authenticate with their own …
  credentials"; developers "may not collect, store, or intermediate Claude.ai
  credentials or session tokens — sign-in to a Claude account must complete
  through Anthropic's own flow." The app has no OAuth client, never sees a
  password or token, and never reads the CLI's credential files. The only
  thing that passes through it is the one-time code Anthropic's page shows,
  written once to the waiting CLI process's stdin, neither stored nor logged.
- **Not a shared backend.** Only an owner of the platform operator's
  organization (the team running this server) can sign in or select the
  engine, and only that organization's work runs on that person's login.
  It also refuses to run while the organization has any other member,
  because their chats and the work they start would run on one person's
  account. Other organizations cannot enable it (owner-only pilot).
- **Ordinary, individual use.** The page also says "Advertised usage limits for
  Pro and Max plans assume ordinary, individual usage of Claude Code and the
  Agent SDK." Background AI steps (reply sorting, lead judging) on a
  subscription are heavier than one person typing. Expect to reach limits
  sooner than in interactive use; the engine reports them, it never hides them.
- **Hosting.** Running Claude Code in a product or service requires accepting
  Anthropic's Commercial Terms. For this pilot the owner runs it on their own
  server for their own organization. Before offering it to any customer, each
  customer would need their own sign-in, and the operator should confirm the
  terms with Anthropic. An image built with the CLI contains Anthropic's binary
  under Anthropic's terms: do not publish it to a registry.

## What was inspected

OpenMausBot (<https://github.com/milind-soni/OpenMausBot>), commit
`bdcfc44044bc1f59fb49b0315aae85fb3c502e93`, Apache-2.0:
`docs/self-hosting.md` ("Signing the engines in without a terminal"),
`server/drivers/claude-login-auth.ts`, `server/drivers/claude.ts`,
`server/drivers/claude-limits.ts`, `server/drivers/claude-background.ts`,
`server/claude-accounts.ts`. The adapted parts and the changes are listed in
`docs/third-party/openmausbot/NOTICE.md`, with the license beside it.

Claude Code itself, version 2.1.306, was probed in this development
container:

- the official `linux-x64-musl` build runs on a bare Alpine 3.22 root (the
  base of `oven/bun:1-alpine`) with no extra packages;
- `auth login --claudeai` with `BROWSER=true` prints `Opening browser to sign
  in…`, then `https://claude.com/cai/oauth/authorize?code=true&…`, then waits
  at `Paste code here if prompted >`;
- logged out, `auth status --json` prints `{"loggedIn": false, "authMethod":
  "none", …, "configDirectory": …}` and exits 1;
- `-p --output-format stream-json --verbose --tools "" --json-schema …` gives a
  `system/init` frame whose only tool is `StructuredOutput`, a
  `rate_limit_event` with the account's windows and resets, and a `result`
  with `structured_output` and `usage`. One such generation (a word-sorting
  check on Haiku) was the only model call made from this container. It ran on
  this development container's own Claude login, **not the owner's**: it is
  format evidence, not the live probe below.
- In this container, `auth status` reports `loggedIn: true` (authMethod
  `oauth_token`) even with a cleared environment and an empty config
  directory: the cloud session supplies its own credential from outside both.
  That is exactly the case the engine guards against: a login the CLI reports
  that is not stored in the account's own directories is treated as signed
  out (`hasOwnLogin`), and no generation runs on it.
- **`@path` in a prompt is read even with no tools.** Found in review and
  reproduced against a local stub API (dummy key, no account): with
  `--tools ""` and the other isolation flags, a lead's text naming
  `@../../config/.credentials.json` (relative to the generation's working
  directory) or another account's absolute path put that file into every
  request. `--disallowedTools Read` did not stop it; a deny rule passed in
  `--settings` (`{"permissions":{"deny":["Read", …]}}`) did. Every generation
  now carries that rule (`GENERATION_SETTINGS`), and the probe through the
  app's own `runGeneration` sends 4 requests with neither marker; with the
  rule removed, both markers are in all 4.

## How it works

`src/lib/ai/claudeCode/`:

| File | What it does |
| --- | --- |
| `contract.ts` | Shapes shared by the route, the page and the server; the login methods and model aliases. Import-free. |
| `cliOutput.ts` | Pure readers: the sign-in link (Anthropic hosts only), the pasted code, `auth status --json`, the stream-json frames of a generation (answer, model, usage, reported windows, failures: signed out, usage limit with its reset, model unavailable, transient). |
| `cli.server.ts` | Per-account directories, the allowlisted environment, spawning and stopping the CLI's process group, `auth status` with the own-login check. |
| `login.server.ts` | The sign-in controller (adapted from OpenMausBot): start, the code once, cancel, sign out; one per account per process. |
| `runner.server.ts` | One generation: own-login check, held usage limit, a bounded process slot, an empty working directory, timeout and abort kill, errors as `ClaudeCodeError` with an HTTP-like status. |
| `engine.server.ts` | The organization's selection (`grid_providers` row `claude-code-engine`), the pilot gate, the binding a call runs on, the settings status, the model check. |
| `runtime.server.ts` | The adapter `completeStructured` uses: Claude Code when selected and the call names no API model, else the API runtime unchanged. |
| `testing/fake-claude.ts` | The fake CLI the tests run. |

**Accounts.** Each (organization, person) has
`$AGENTSDR_CLAUDE_CODE_DATA_DIR/accounts/<organization>/<person>/` with
`config/` (the CLI's `CLAUDE_CONFIG_DIR`, where it keeps `.credentials.json`),
`home/` (its `HOME`, where a keyless Console sign-in keeps its Anthropic
profile, which a config directory alone does not separate) and `work/` (an
empty directory per generation, removed afterwards). All are created `0700`;
ids must be UUIDs. The CLI manages the credentials; the app checks only that
they exist.

**Environment.** The CLI gets `PATH`, locale, proxy and CA variables, its
`HOME`/`CLAUDE_CONFIG_DIR`/`XDG_CONFIG_HOME`, `NO_COLOR` and
`DISABLE_AUTOUPDATER`, and nothing else: no `DATABASE_URL`,
`INTEGRATION_CREDENTIALS_KEY`, provider keys, `ANTHROPIC_API_KEY` (which would
silently turn a subscription login into API billing) or
`CLAUDE_CODE_OAUTH_TOKEN` (someone else's login).

**Sign-in.** `POST /api/ai/claude-code` `{action: "sign_in", method}` starts
`claude auth login --<method>` (after checking the account is not already
signed in), returns Anthropic's link once the CLI prints it, and holds the
process for 15 minutes. `submit_code` writes the pasted code to that process's
stdin once; the CLI's exit and `auth status` decide success. `cancel` stops
it; a second Sign in while one is being set up is refused. `sign_out` runs
`claude auth logout` and confirms; it is refused while a sign-in is in
progress or a generation runs or waits on the login. While the login
answers the organization's AI steps the page asks first: those steps then
fail until a sign-in, never moving to the API provider. Signing in again
after an expiry is the same flow ("Sign in again"); because the old login
file still makes `auth status` say signed in, that sign-in counts only when
the CLI's login itself exits cleanly (a wrong code leaves it expired).

**Selecting it.** `check_model` sends one short generation on the person's
account and records the model id the CLI actually ran (or why not), per
person. `use` requires a successful check of that model and an organization
whose only member is that person, and binds the organization to their login;
choosing another checked model while in use is the same `use`. Switching from
another owner's login is refused while generations run or wait on it.
`stop_using` returns the organization's AI steps to the API provider.

**What runs on it.** Every `completeStructured` call that names no model:
the assistant's turns, lead judging (`sortLeads`), the outreach writers and
reviewer, the CRM classifier and drafts, the reply agent, reply checks and
handoff briefs. Each keeps its own schema, `accept` validation and
retry-with-the-rejected-answer, because the adapter hands the CLI's
`structured_output` back as message content and `completeStructured` judges
it as it judges an API model's. Everything around those calls is unchanged:
the organization-scoped dispatcher, budgets and spend guards, pause/stop,
Review/Automatic, Do Not Contact, run state, takeover, and send idempotency
all sit outside the model call. The CLI has no route around them: `--tools ""`
leaves it only `StructuredOutput`; `--settings` denies Read, Edit, Write,
Glob, Grep, Bash, NotebookEdit, WebFetch and WebSearch (which also stops
`@path` reads); `--strict-mcp-config`, `--setting-sources ""`,
`--disable-slash-commands`, `--no-session-persistence`, an empty working
directory, and the system prompt in a file there (`--system-prompt-file`,
so it is not on the command line). Nothing is resumed between calls; the CLI
still writes its own bookkeeping (its settings, the directories it ran in)
into the account's config directory, and no call reads a conversation back
from it. A call
the CLI says was authenticated by a key from the server's own settings
(`apiKeySource` `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or
`apiKeyHelper`) is refused and its answer not used.

**What does not.** A call that names an API model (a table AI column saved for
one) keeps that connection. A call that needs OpenRouter's web plugin is
refused ("Claude Code does not offer"), never answered from memory; that
includes Prospecting's parent-company lookup. Call transcription and the
AI-provider web search read their own model settings and stay on the API
provider. These are named on the settings card, and admins and members, who
cannot open the Claude Code card, see a line saying that AI steps run on an
owner's Claude account.

**Limits and failures.** Each error says whether `completeStructured` may
try again (`retryable`): only a CLI that died before answering or an
overloaded API is retried. Its HTTP-like status serves the reply agent,
which stops on a 4xx: signed out or not signed in 401, usage limit or extra
usage 402, model unavailable 404, timeout 504, busy 503, anything else 400.
A usage limit is held until the reset the CLI reported (15 minutes when it
reported none, and never less than 5 minutes, so a reset already past on a
clock ahead cannot make every job spin): for one model's weekly window only
that model is held, for the 5-hour or weekly window the whole account. Held
calls fail at once without starting the CLI. A model check runs past one
model's weekly hold, so the owner can find a model that answers, never past
an account-wide one. A call answered with a credential from the server's own
settings holds the account for 15 minutes, so the misconfiguration is not
paid for on every job. A CLI that exits before it starts a session (an older
version refusing a flag) fails the call as an error, not retried, and its
unread prompt can no longer take the server down (an unhandled `EPIPE` on its
stdin did, under Bun). When the CLI reports that a call ran on extra usage
(billed beyond the plan), that answer is kept and the account is held until
the window resets, so nothing more is billed that way. A generation refused
as signed out or expired marks the login expired on the card (whatever the
stored file says), and Sign in again then runs the CLI's login even though
`auth status` still says signed in. While held, CRM reply sorting is put
back, checked again at least every 15 minutes until the reset (so a reset
the owner speeds up is noticed), for at most 8 days from the message; past
that it fails like any other classification. An explicit "stop contacting
me" is still marked Do Not Contact at once while the login is held, before
the job is put back. The reply agent puts the message in Inbox → Needs
you with the reason; other steps fail with the reason. Usage shown on the
card is only what the CLI's `rate_limit_event` reported (window, share used,
reset), with the time it was reported. The CLI's `total_cost_usd` (an
API-price estimate) is not recorded as spend: usage rows for Claude Code have
no cost, and they record the model id the CLI ran. Input tokens include
cached prompt tokens. Nothing ever moves to another provider on a failure.

**Processes.** At most `AGENTSDR_CLAUDE_CODE_MAX_PROCESSES` (default 2, at
most 8) generations run at once; each CLI was measured at about 260 MB. The
short `auth` and `--version` commands are not counted. A call waits at most
30 s (and never past its own timeout) for a slot, else fails as busy, not
retried. A generation past its timeout (the caller's plus 20 s for process
start) or whose caller aborts has its process group stopped; an
already-aborted call never starts, and one aborted while it waits for a slot
never starts the CLI. Generations waiting for a slot count as running, so
sign-out and switching see them. The engine row is cached per organization
for 30 s (a save updates it at once) and the member count for 10 s, both in
one process-wide cache, so a second copy of the module (Next can load one
per bundle) does not keep its own stale answer. Sign-in flows live in
memory: a restart ends one in progress (the page says to start again); the
CLI's login on disk survives, and work interrupted by a restart is picked up
by the existing job workers like any other interrupted model call.

## Setup on the VM

1. Add the overlay to the compose files (in `.env`):

   ```
   COMPOSE_FILE=docker-compose.yml:docker-compose.build.yml:docker-compose.discovery.yml:docker-compose.claude-code.yml
   ```

   It builds the image with Claude Code 2.1.306 for x86-64 (version and
   tarball SHA-512 pinned in the file; the download layer comes before the
   per-commit layers, so it is cached across deploys), mounts the
   `claude-code-data` volume
   at `/var/lib/agentsdr/claude-code` and sets two processes at a time. On an
   arm64 server, or for another version, set `AGENTSDR_CLAUDE_CODE_VERSION`
   and `AGENTSDR_CLAUDE_CODE_SHA512` in `.env`; the SHA-512 is the hex digest
   of `https://registry.npmjs.org/@anthropic-ai/claude-code-linux-<arch>-musl/-/claude-code-linux-<arch>-musl-<version>.tgz`
   (compare it with the `dist.integrity` the registry lists for that version).
   The variables are prefixed because Claude Code sets `CLAUDE_CODE_*`
   variables in shells it runs.
2. Deploy as usual (`docker/deploy.sh`). No database migration: the engine
   uses a `grid_providers` row.
3. Check the binary: `docker compose exec app claude --version`.
4. As an owner of the operator organization: Settings → AI provider → Claude
   Code → Sign in → open Anthropic's page → sign in → paste the code → Finish
   sign-in. Then Check a model, then Use Claude Code.

Local development: install Claude Code on the machine (or set
`AGENTSDR_CLAUDE_CODE_CLI` to its path); logins go to `./.data/claude-code`
(ignored by git and by the Docker build context) unless
`AGENTSDR_CLAUDE_CODE_DATA_DIR` says otherwise. The image carries
OpenMausBot's license and notice under `/app/licenses/third-party`.

## Tests

- `src/lib/ai/claudeCode/claudeCode.test.ts`, 33 tests (`bun test
  --conditions=react-server src/lib/ai/claudeCode/`): the readers against the
  real 2.1.306 output above and the generation flags (the Read deny rule, the
  system prompt by file); and against the fake CLI: sign-in success with the
  code passed once and found in no file the app wrote, the other login
  methods passed through, cancel, a wrong code, no link in time, a double
  Sign in refused, sign-out refused while a generation runs then sign-out and
  reconnect, restart (a sign-in in progress is gone, the login on disk
  remains), an expired login marked and signed in again although the stored
  file still says signed in, cross-account isolation (same organization and
  another one), a login reported from elsewhere on the machine, a credential
  from the server's settings refused, the allowlisted environment, valid
  output through `completeStructured` with the model id the CLI ran, prose
  and caller-rejected answers retried with the reason then failing, a usage
  limit (not retried, held, released after its reset), one model's weekly
  limit holding only that model while a check still runs, extra usage (the
  billed answer kept, the account then held; cached tokens counted), an
  expired login and an unavailable model (not retried), a crash retried, a
  hung process killed at the timeout and not retried, a busy server not
  retried, an already-aborted call never started, one aborted while waiting
  for a slot never started, a scratch directory that cannot be made leaking
  no slot, the process bound, a CLI exiting before reading a 2.4 MB prompt
  (fails the call, not the test process; without the stdin listener the run
  reports the unhandled pipe error), a reset already past still held 5
  minutes, an account-wide limit holding model checks, a server credential
  holding the next call, and signing in again with a wrong code leaving the
  login expired.
- `scripts/e2e/claude-code-engine.ts`, 28 checks on the local database with
  the fake CLI and every API request intercepted: nothing changes before
  selection; the pilot gate (operator owner yes; member, admin, another
  organization's owner no); sign-in, model check, selection; the real
  `sortLeads` and `classifyCrmReply` answered through Claude Code with their
  own validation and no API call; usage rows with the model id the CLI ran
  and no cost; a rejected answer retried; an API-model call kept off Claude
  Code; web search refused; a usage limit failing and holding without CLI or
  API; another member in the organization stops it (and the card says why)
  until the owner is alone again; a demoted owner refused; another
  organization's selection refused and never run on the owner's login; Stop
  using returns to the API path.
- The `@path` probe above, through the app's own `runGeneration` with the
  real 2.1.306 binary and a local stub API: 0 of 4 requests carry either
  credential marker; with the deny rule removed, all 4 carry both.
- Each safeguard was removed once to confirm a test fails without it: the
  own-login check (3 unit tests fail), the allowlisted environment (1), a
  non-retried limit (1), the operator gate (2 e2e checks), the API-model rule
  (2 e2e checks), the Read deny rule (the probe).
- `scripts/e2e/reply-agent.ts` runs `handleClassificationJob` with a held
  Claude login on "Please stop contacting me": the person is marked Do Not
  Contact at once and the job is put back within 15 minutes.
- The full unit suite, `npx tsc --noEmit`, eslint on the changed files and a
  production build (`next build --webpack`) pass.

## Remaining limits and what is not verified

- **No live probe on the owner's account yet.** It needs the owner's own
  browser sign-in on the VM. After deploying: sign in, Check the account
  default model and Haiku, note the model ids shown, then select it and let
  one CRM classification or one lead search's judging run (no outreach is
  sent by either). Record which models and functions worked in this file.
- **The Docker image was not built here** (no registry access from this
  container). The install steps were run in an Alpine 3.22 root with BusyBox
  1.37, and `docker compose config` renders the overlay; the first VM build is
  the real check (`claude --version` in the container).
- **Console sign-in that creates an API key** stores it "with your other
  credentials"; whether that lands in `.credentials.json` was not observed. If
  a Console login shows as signed out after succeeding, that is the cause.
- **Model choices** are the CLI's aliases (account default, Sonnet, Opus,
  Haiku); which work is learned only by checking each on the account.
- **Only a one-person organization can use it.** Claude Code refuses to run
  while the organization has any member besides the owner who signed in;
  per-person sign-ins for staff are not built.
- **Usage** shown is the last report the CLI made; there is no reading of the
  account's remaining allowance between calls, and no estimate is made.
- The settings card was checked in a browser with the fake CLI only.
- The JSON schema still goes on the command line (`--json-schema` takes no
  file); the largest is a few KB, well under the 128 KB per-argument limit.
- A person who leaves the organization keeps their login directory on disk;
  nothing removes it yet (sign out first, or delete
  `accounts/<organization>/<person>` from the volume).
- The reply agent does not wait for a usage limit's reset: it puts the
  message in Needs you with the reason. Only CRM reply sorting is put back.

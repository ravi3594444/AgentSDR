# AgentSDR_v2

## TypeScript, not JavaScript

Write all new code in TypeScript (`.ts` / `.tsx`). Do not add new `.js` or `.mjs`
files, including one-off tooling — a throwaway script tends not to stay
throwaway, and untyped code that touches the database is where schema drift
hides.

This applies to `scripts/` too. The existing files there are plain `.js` for
historical reasons; new migrations should be `.ts`, run with `bun run`.

`npx tsc --noEmit` must pass before anything is committed.

## `scripts/` is database migration history

`scripts/*.js` are **not** application logic and nothing in `src/` imports them.
They are one-shot migrations, run by hand (`node scripts/<name>.js`) against the
live Postgres, each loading `.env.local` and connecting via `DATABASE_URL`.

They matter more than their "scratch script" appearance suggests: `drizzle.config.ts`
declares `out: "./drizzle"`, but **no `drizzle/` directory exists** — no generated
migrations have ever been committed. So these files are the only written record of
how the schema was built, and the only reproducible path to a fresh database.

Do not delete them as dead code. Conventions:

- Guard DDL with `IF NOT EXISTS` / `IF EXISTS` so re-running is safe.
- Seed scripts should UPSERT, not blind-INSERT.
- Adding a column means updating both the migration and the matching Drizzle
  schema in `src/lib/**/schema.ts` — they are kept in sync by hand.

Longer term this should move to real Drizzle migrations; until then, treat
`scripts/` as the source of truth for schema history.

## Schema layout

Drizzle table definitions live in domain-scoped files, not one central schema:

- `src/lib/schema.ts` — the entry point `drizzle.config.ts` points at
- `src/lib/outreach/schema.ts` — campaigns, leads, mailboxes, emails
- `src/lib/crm/schema.ts` — CRM workflow, conversations, sequences, and knowledge
- `src/lib/inbox/schema.ts` — Master Inbox and inbound-delivery diagnostics
- `src/lib/qualification/schema.ts` — domain qualification
- `src/lib/calls/schema.ts` — WhatsApp calls placed from the app (`call_sessions`)
- `src/lib/scheduler/schema.ts` — the in-process scheduler's slot claims
  (`scheduled_job_runs`, platform-wide; see `src/lib/scheduler/`)
- `src/lib/auth/schema.ts` — Better Auth: users, sessions, accounts,
  verifications, organizations, members, invitations, teams, team_members

## Multi-tenancy: everything belongs to an organization

AgentSDR is multi-tenant. People sign in with Better Auth (email + password,
verified; Google when `GOOGLE_CLIENT_ID/SECRET` are set; auth mail through
Resend) and work inside an **organization** (roles owner / admin / member;
teams group people but do not scope data). Every piece of business data
belongs to exactly one organization. Read `docs/multi-tenancy/conventions.md`
before touching any query — it is the rulebook; `plan.md` beside it is the
history of the migration.

The non-negotiables:

- **Every entry point opens the organization scope once.** Routes:
  `withOrgContext(request, fn)` (or `requireCrmMutationContext` +
  `runInOrganization`). Server pages: `requirePageOrgContext()`. Workers,
  cron routes, webhooks and token links resolve the organization *from the
  data* (mailbox, Unipile account, call session, grid table, job row) and
  run each item in `runInOrganization(item.organizationId, …)`.
- **Every query on a scoped table filters by organization**: `inOrg(table)`
  in Drizzle, `organization_id = ${currentOrganizationId()}` in raw SQL,
  inherited tables through their scoped parent. Inserts set
  `organizationId` (TypeScript enforces it; the database has no default).
  Fetch-by-id of another organization's row is a 404.
- **It fails closed.** `currentOrganizationId()` outside a scope throws —
  never "default" to some organization.
- **A new table must be classified** in `src/lib/tenancy/registry.ts`
  (scoped / inherited / global) and, if scoped, created with
  `organization_id uuid NOT NULL REFERENCES organizations(id)`.
  `bun run scripts/check-organization-scope.ts --contract` fails on any
  unclassified table, missing column, invalid key or index.
- **Uniques are per organization** (email, domain, pipeline name, integration
  key, …) except provider identities (Unipile account, LinkedIn id, Gmail
  mailbox, provider message ids), which stay global because inbound webhooks
  find their organization through them.
- **Prove isolation after changing data access**: start a server on a
  disposable local copy and run `BASE_URL=… bun run --conditions=react-server
  scripts/e2e/tenancy-isolation.ts` — a second organization must see,
  change and count nothing of the first (it refuses to run against a
  non-local DATABASE_URL).

Settings that used to mean "the workspace" — platform integrations,
OpenRouter BYOK, AI and enrichment connections, the default CRM pipeline
(`ensureCrmDefaults()`), sequences, knowledge, lead categories, custom lead
fields — are per organization, created lazily on first use. Members can use
the product; owners and admins also manage integrations, AI settings,
members and teams (`requirePermission`, `src/lib/auth/permissions.ts`).
LinkedIn `JobRun`/`JobLog` are platform-wide (the cron covers every
organization), so only the **platform operator** — an owner or admin of the
initial organization (`metadata.initial`) — sees them (`isPlatformOperator`).

## Outreach merge fields

Lead columns beyond Email / First Name / Last Name / Name / Company are not
dropped on import. `src/lib/outreach/leadImport.ts` camelCases each unrecognized
CSV/XLSX header (`"Job Title"` → `jobTitle`) into the lead's `customFields` JSON,
and `src/lib/outreach/scheduler.ts` resolves any leftover `{{key}}` against it
case-insensitively. Unmatched tokens resolve to `""`, the same as a missing
first name.

## Platform integrations, not env

Unipile, Google Workspace (Gmail service account) and Cloudflare R2 are
connected **per organization** from the Connection page of the channel each
powers (Settings → Email / LinkedIn / WhatsApp), never from env —
there is no env fallback. `src/lib/platform/` owns them: `catalog.ts` (client-safe fields),
`credentials.ts` (`getPlatformCredentials` / `requirePlatformCredentials` /
`isPlatformConnected`), `verify.ts` (one live call before saving).

Each is one row per organization in `grid_providers` keyed `platform-<key>`
(unique per organization), its credentials encrypted in
`grid_provider_credentials` like every other integration. Reads are cached
30 s per process, keyed by (organization, platform), so a change reaches
other instances within that window. Unipile webhook URLs carry `org=`; a
webhook's secret is checked against the organization the payload's account
belongs to.

A feature works only while its integration is connected: background jobs
return early, user-facing routes answer 409 (`PlatformNotConnectedError`),
and pages wrap in `RequiresPlatform`, which shows a Connect prompt. New code
that calls one of these services must do the same — never read its keys
from `process.env`.

Env keeps only what is needed before the database can be read or decrypted
(`DATABASE_URL`, `BETTER_AUTH_*`, `INTEGRATION_CREDENTIALS_KEY`), platform
infrastructure shared by every organization (`RESEND_API_KEY`,
`AUTH_EMAIL_FROM`, `GOOGLE_CLIENT_ID/SECRET` for sign-in), public URLs,
cron secrets and tuning knobs. Two deliberate exceptions:

- Prospecting's domain qualification reads `APOLLO_API_KEY` (a master key).
  It is not an integration because that section is slated for removal;
  Apollo for tables is a separate, per-table enrichment connection.
- The table HTTP column's `authEnvVar` calls an API the user names, and
  reads the secret from an env var the user names. The name must start with
  `GRID_HTTP_SECRET_` (checked when the column is saved and again when it
  runs), so a member cannot point it at `DATABASE_URL` or
  `INTEGRATION_CREDENTIALS_KEY`. The call itself refuses loopback, private,
  link-local and CGNAT addresses (resolved, redirects re-checked) unless
  `GRID_HTTP_ALLOW_PRIVATE=true`; see `src/lib/grid/runners/http.ts`.

`scripts/migrate-env-to-integrations.ts` copied an existing env setup into
the store once (verifying each); keep it as the record of that move.

## Sending rules, not constants

Operational numbers — emails a day, send gaps, LinkedIn invitations and run
sizes, WhatsApp warm-up and new chats a day, the daily lead limit, the
default phone country — are per-organization **Sending rules**, declared once
in `src/lib/channels/rules.ts` (client-safe: default, hard min/max, a `safe`
edge past which the page warns). Stored in `channel_settings` (one row per
organization and channel, only the keys that differ from the default), read
through `channelRules(channel)` in `rules.server.ts` (cached 30 s). Resolution
is account override → organization rule → default; the overrides are
`"LinkedInAccount"."dailyInviteLimit"`, `whatsapp_accounts.new_chats_per_day`
and the mailbox's own `daily_send_limit`. A new limit is a registry entry plus
the engine reading it — never a new constant or env var.

**Sending is always on.** No engine has sending hours or days, and nothing may
add them back: the hour rules are retired (`RETIRED_RULE_KEYS`, refused on
save), mailboxes get always-open `working_hours` (`alwaysOpenHours`; its
timezone is only the day the mailbox's daily counter resets on, never change
it), LinkedIn `work*` fields stay null. **One input is visible**: the
"general" rule `newLeadsPerDay` (Settings → Daily lead limit), a
workspace-wide count of people contacted for the first time, across every
channel, on the workspace's day (general `timeZone` + `dayStartsAt`, on Your
business). It is enforced by `newLeadAllowance(tx, { personId, now })`
(`src/lib/channels/dailyLeadLimit.server.ts`) inside each engine's own
first-touch claim transaction, after that engine's lock, taking the
`new-leads:<org>` advisory lock last; the count is derived from the engines'
claim rows (no counter of its own). A new first-touch sender calls it the same
way. Per-channel pacing and the Autonomous caps keep their rules but have no
settings page (`GENERAL_RULE_PAGES.hidden`).

The `WHATSAPP_*` constants in `src/lib/whatsapp/contract.ts` remain only as
the defaults the extension shows (and agentsdr.ai, which copies this file) (that file must stay
import-free); `rules.test.ts` keeps them equal to the registry.

## Drizzle is the only ORM

The LinkedIn subsystem was migrated from Prisma to Drizzle. Prisma is gone —
no client, CLI, or generate step remains.

The 11 LinkedIn tables it created are still live and are now described by
`src/lib/linkedin/schema.ts`, written by introspecting the database rather
than transcribing `schema.prisma` (the two had drifted — see the note at the
top of that file about enum ordering). The archived Prisma migrations and
schema live in `docs/prisma-history/` as the written record of how those
tables were built; nothing there runs.

Two table families share one database:

- **snake_case tables** — this app's originals, `src/lib/**/schema.ts`
- **quoted PascalCase, 11 tables** — the LinkedIn ones,
  `src/lib/linkedin/schema.ts`

`drizzle.config.ts` sets `tablesFilter` to an allowlist (`OWNED_TABLES`) of
the application-owned snake_case tables. The LinkedIn tables are deliberately **excluded**:
drizzle-kit will not diff or manage them, so there is no path by which
`drizzle-kit push` can alter live LinkedIn data. Without the filter,
drizzle-kit sees the unlisted tables as drift and offers to DROP them.

**When you add a snake_case table, add it to `OWNED_TABLES` too**, or
drizzle-kit will not manage it. For a LinkedIn-table change, write a one-shot
migration in `scripts/` and update `src/lib/linkedin/schema.ts` by hand — the
same convention the rest of the schema already follows.

### The lead database is the one exception

`people`, `companies`, `entity_columns` and `import_runs` are scoped by
`organization_id` and are still deliberately **absent** from `OWNED_TABLES`:
they are hand-maintained through `scripts/create-lead-tables.ts` (and the
tenancy scripts), exactly like the LinkedIn tables.

Nothing alters them at runtime any more. Custom lead fields are keys in
`people.custom` / `companies.custom` (jsonb), defined per organization in
`entity_columns` — a key is an immutable `x_<slug>`. Each organization gets
its core registry rows on first use. Rename, archive and type change are
registry-only; a type change converts the stored values and is refused if
any cannot convert; a permanent delete strips the key from that
organization's rows. A key reaches SQL only as a bound parameter, after
matching the registry (`customFieldSql`). `bun run
scripts/check-lead-column-drift.ts` checks, across all organizations, that
`custom` keys are registered and that no stray physical `x_` column exists.

### LinkedIn ids are `text`, not `uuid`

Prisma applied `@default(cuid())` client-side, so those columns are `text`
with **no database default**, holding 18k+ existing cuids. They use
`$defaultFn(createId)` (`@paralleldrive/cuid2`) rather than the
`uuid().defaultRandom()` used everywhere else, because converting them would
mean ALTER TYPE across every id and foreign key on live data. Nothing in the
codebase parses or sorts by id, so old cuid v1 and new cuid2 values coexist
fine.

## The connection pool is a hard constraint

A PostgreSQL server's `max_connections` is shared by every deployment that
points at it, and managed databases often set it low (50 is common).
`DB_POOL_MAX` (default 8) bounds this app's single pool; before the Prisma
migration the process ran two pools, which is what made the ceiling easy to
hit, and idle connections from other deployments count against it too.

When the server is full, every query in the app fails at once with:

```
remaining connection slots are reserved for roles with the SUPERUSER attribute
```

That error means capacity, not a code bug — it shows up on snake_case and
PascalCase tables alike. Before raising `DB_POOL_MAX`, check
`pg_stat_activity`, and remember a rolling deploy briefly runs two containers.

## Where the LinkedIn half lives

Merged from `linkedin-automation-next`; everything is namespaced so nothing
of AgentSDR's had to move:

- `src/app/linkedin/*` — pages, under a segment layout that supplies the
  sidebar (that app's root layout carried it; ours does not)
- `src/app/api/linkedin/*` — its API
- `src/app/api/webhooks/*` — **kept at the old path on purpose**: Unipile is
  registered against `connection-accepted` and `message-received`. Those two
  are public in `proxy.ts`; `/api/webhooks/[id]` is NOT — it returns raw
  webhook bodies to the UI, so it must stay behind auth. Never make that
  prefix public wholesale.
- `src/lib/linkedin/*`, `src/components/linkedin/*`
- `src/jobs`, `src/functions`, `src/services` — the sending engine

Two `cn()` helpers exist and are **not** interchangeable: `@/utils/cn` extends
tailwind-merge with AlignUI typography groups, `@/lib/linkedin/utils` is a
plain `twMerge(clsx())`. Pointing LinkedIn components at the former silently
changes how their classes collapse. Leave them separate.

Inbound LinkedIn replies reach the CRM by direct call, not HTTP — see
`src/lib/linkedin/messages/forwardToAgentSdr.ts`.

### `.server.ts` siblings exist for a reason

`postgres.js` cannot be bundled for the browser (Prisma's client could be).
Where a module holds both pure helpers and database calls, and a client
component imports the pure half, the queries live in a `.server.ts` sibling:

- `searchLeadLimit.ts` / `.server.ts`
- `messages/connectionList.ts` / `.server.ts`
- `inviteRetry.ts` / `.server.ts`

Adding a `db` import to one of the client-safe modules breaks the build with
`Module not found: Can't resolve 'fs'` — put the query in the `.server`
sibling instead. A `import type` from a query module is always safe; it
erases at compile time.

## Work on `main`, commit freely, push only when asked

Commit directly to `main`. Do not open a feature branch, and do not open a
PR — the branch-then-PR flow is not wanted here, and review happens on `main`
after the fact if at all.

**Do not push.** Every push to `main` triggers a deployment, so pushes are
batched: commit as you go and leave them local until the user explicitly asks
to push, then send them all at once. Committing itself needs no confirmation.

Keep `npx tsc --noEmit` passing before each commit, since nothing else gates
what lands.

## Tests run under bun, both halves of them

`npm test` is `bun test --conditions=react-server` — about 560 tests across 76 files.

The suite is split between two runners by history: roughly half the files
import `bun:test` and half import `node:test`. Bun runs both, so this is not
worth converting. `node --test` is not an option — it dies on the first
`bun:test` import with `ERR_UNSUPPORTED_ESM_URL_SCHEME`.

`--conditions=react-server` is required, not decorative: nine files reach a
module that imports `server-only`, which throws outside that condition. The
`scripts/` entries above pass the same flag for the same reason.

## WhatsApp calling and the recorder extension

`extensions/whatsapp-recorder/` is a Chrome MV3 extension, built with
`bun run build:recorder` into its `dist/` (gitignored) and loaded unpacked.
`bun run build` also zips it (`package:recorder` → `release/`, gitignored),
and every deployment serves that zip to signed-in people at
`/downloads/call-recorder`; Settings → WhatsApp → Integrations shows the
installed version against it. From 0.14.0 its Update button opens the
extension's own Update page (`update.ts`, via the `recorder:update` bridge
request), which writes that zip into the folder Chrome loaded the extension
from — chosen once, File System Access, checked against the running
manifest — and reloads the extension.
It imports `src/lib/calls/contract.ts`, the one set of shapes the API, the
UI and the extension share — keep that file free of runtime imports.

The page reaches the extension through a content script and
`window.postMessage`, not `chrome.runtime` by id: an unpacked extension's id
differs on every machine. The origins it accepts are the built-in ones in
`extensions/whatsapp-recorder/src/origins.ts` (keep them in sync with the
manifest) plus any a person adds on the extension's Options page: those are
granted through `optional_host_permissions`, kept in chrome.storage.sync,
and get the bridge via `chrome.scripting.registerContentScripts`. A
self-hosted deployment needs no rebuild.

A call placed from AgentSDR is dialed and recorded inside web.whatsapp.com
itself: `wa-agent.ts` clicks Voice call, `wa-hook.ts` (the page's own JS
world) records from the call timer appearing to hang-up. WhatsApp Web runs
its own audio engine rather than WebRTC media tracks, so the hook taps what
WhatsApp routes to the speakers plus its microphone track — the header of
`wa-hook.ts` has the evidence. It depends on WhatsApp's English aria-labels
("Voice call", "End call"). Only calls placed from AgentSDR are recorded.

`/api/call-recorder/` is public in `proxy.ts`. The extension holds a
per-call bearer token (hash in `call_sessions.upload_token_hash`), never the
site cookie, and every route there starts with `authorizeRecorder()`.
Recordings live in Cloudflare R2 (the R2 integration) and are only ever reached
through short-lived presigned URLs.

Transcription runs through the BYOK-only OpenRouter runtime like every other
model call — never with `OPENROUTER_API_KEY` directly. The model is
chosen in Settings → AI provider (stored as `transcriptionModel` in the BYOK
settings; null means transcription is off). Gemini merges audio channels, so the stereo
recording does not give speaker labels for free there; rep/lead is inferred.


## The reply agent

A message from a lead of a running assistant outreach run is answered by
`src/lib/assistant/replyAgent/`, hooked into the CRM's classification job
(`handleClassificationJob`): one model call decides reply / tell_owner /
stop_contact / no_reply (a reply may carry an owner note → Needs you). The
harness (`agent.ts`, pure and tested) only checks what must never go out —
unbacked amounts, days, times, links, placeholders, done-claims — and hands
problems back to the agent for up to `MAX_TURNS`; hard rules (DNC,
suppression, run state, takeover, newer message, limits) are code, re-read
under the organization's advisory lock before `sendDraft`. Each message's
turns, timings and outcome are one `reply_agent_runs` row (unique per
message). Steer it with the owner's text (profile, instructions,
knowledge), not with word lists or examples in code. Explicit opt-outs,
non-members and taken-over chats still use the classifier and
`autopilotRun.server.ts`; `REPLY_AGENT=off` restores that path for all.

## Autonomous mode and the outreach writer

A chat in Autonomous mode (`src/lib/assistant/autonomy*.ts`,
`assistant_threads.autonomous`) starts the plans its assistant prepares
through `startOutreachRun`, in the name of the owner/admin who turned it on
(re-checked at each start), within the "general" Sending rules
`autonomousRunsPerDay` / `autonomousLeadsPerDay` / `autonomousSearchesPerDay`,
counted under the `autonomous:<org>` advisory lock. Never add a tool that
starts outreach; the model only prepares. Off (the default), nothing about
the Start button changes.

Outreach the assistant writes passes `src/lib/assistant/pitch.ts`
(structural checks fed back to the writer, never phrase lists) and a
reviewer model pass in `writer.server.ts`. A pitch problem retries a
bounded number of times and then keeps the best version: it must never
stop a plan.

## Objectives: one request pursued to an end

A request whose turn starts a lead search becomes an objective
(`src/lib/assistant/objective*.ts`, table `assistant_objectives`, unique per
organization and request message): a lead target, a time limit and a spend
cap, from the owner's words or the "general" Sending rules
`objectiveLeadTarget` / `objectiveHours` / `objectiveSpendUsd`. Its searches
stay ordinary jobs carrying the request's id; an `objective` job (the
driver, `objectiveDriver.server.ts`) waits while they run and, when they end
short of the target with time and budget left, resumes the request's turn
with a note (found vs target, spend and time left, each source's yield) so
the model picks the next source. It stops at the first of target reached,
sources exhausted, spend cap used, time limit, the owner's cancel
(`control_research`, `POST /api/assistant/objectives/[id]`) or a recorded
failure, stores the exact reason, and posts one report keyed by its report
key. Activity reads it through `objectiveView(requestMessageId)`.

- A new search tool calls `searchObjective(context)` before it starts
  anything, and its job carries `requestMessageId`.
- Paid work passes the request's `SpendGuard`
  (`objectiveSpendGuard(requestId)`) inside its own reservation
  transaction, after its provider lock: Apify's `startTrackedRun`, Treg's
  `callTregEndpoint`, `reserveQuota`'s `guard`. Its spend is read from the
  ledgers by the request's jobs and id, never kept as a second counter.

## Bright Data social research

Bright Data is the research provider behind `research_social_sources`
(`src/lib/brightdata/`, the job in `src/lib/discovery/socialResearch.server.ts`),
behind the `brightdata` feature and a per-organization key saved on the
Providers & features page (`brightdata_settings`, encrypted like every
integration). Only Reddit is searched natively (posts by keyword and
subreddit, with comments, behind the owner's own `reddit_enabled` switch);
X, Instagram and Facebook posts, profiles and pages come from a web search
(TinyFish, Tavily, the AI provider) or the owner's SERP zone, then are read
through Bright Data. A dataset listed in `catalog.ts` is not "operational":
the settings card shows per dataset only what this organization's own
collections returned.

Every collection is a `provider_usage` row (provider `brightdata`, product
`records` or `serp`), reserved at its most credits under the organization's
lock and the request's spend guard before Bright Data is called, settled
from the records it reported (failed inputs are billed too). A lost trigger
answer stays `uncertain` and is never sent again; a trigger refused
outright (a 429) costs nothing and is sent again after its `Retry-After`,
at most 3 times, never quickly (25 of them blacklist the IP); a retried
step polls its own collection; the same inputs settled within 7 days are
downloaded again for free; a collection that cannot be finished (its
progress unreadable past the job's deadline, the key removed) is given up
with its reserved credits kept counted. Bright Data's API does not report
the balance, so the monthly limit is AgentSDR's own count and every figure
says "estimated". Nothing tops up or changes a plan. Findings keep their link, quote, author and read time;
someone is contactable only through what their own profile, page or
website publishes — AgentSDR never messages anyone on Reddit, X or Facebook.

## WhatsApp messaging (Unipile)

Reps link their WhatsApp number in the Unipile dashboard; AgentSDR reads it
into `whatsapp_accounts` (`src/lib/whatsapp/accounts.ts`, "Sync from
Unipile" on /calling/accounts). Unipile account reads are split by provider:
`src/functions/syncAllAccounts.ts` takes only type LINKEDIN,
`src/services/unipile.whatsapp.ts` only WHATSAPP — keep them apart, and the
account-status webhook runs each sync in its own try/catch.

Unipile posts every messaging event, LinkedIn and WhatsApp alike, to one
webhook, `/api/webhooks/unipile-message`, which only routes by `account_type`
to the WhatsApp handler (`/api/webhooks/whatsapp-message`) or, for a LinkedIn
`message_received`, the LinkedIn one (`/api/webhooks/message-received`), and
drops the rest. Those two paths stay live and public in `proxy.ts` (exactly
those paths; the Unipile integration's webhook secret as `?secret=` or
`x-unipile-secret`) for hand-made registrations and the LinkedIn replay job.
Every delivery is logged raw in the LinkedIn webhook ledger.

Nobody registers these webhooks by hand any more: saving the Unipile
integration registers both (`connection-accepted` and `unipile-message`)
through Unipile's API (`src/lib/platform/unipileWebhooks.ts`),
each URL carrying `org=<organization id>` and each delivery the generated
secret as `x-unipile-secret`. `gateUnipileWebhook`
(`src/lib/linkedin/organizations.server.ts`) holds those URLs to both and drops
events for accounts that are not that organization's; URLs without `org` keep
the older rules. Registration replaces earlier ones (including the retired
separate `message-received` / `whatsapp-message` registrations) and is skipped on a
localhost origin. A new webhook route belongs in `UNIPILE_WEBHOOKS` and behind
the same gate.

A message's `origin` says who wrote it: `lead`, `agentsdr` (sent through
Unipile — the row is stored before the send so its echo is recognised), or
`phone` (an echo AgentSDR did not send: the rep typed it on the phone or in
WhatsApp Web). Replies reach the CRM through `src/lib/whatsapp/crmBridge.ts`
on a `whatsapp` conversation, like LinkedIn; a `phone`/`agentsdr` message
counts as the lead being answered.

Sends are guarded server-side (`contract.ts`): no new chats for 24 h after a
number is linked, 25 new chats a day per number, 10 s between sends, never
to Do Not Contact. A banned number also loses its calling.

### Message campaigns

`/whatsapp/campaigns` — cold sequences (a first message and timed
follow-ups) sent from chosen numbers; design in
`docs/whatsapp-campaigns/plan.md`, code in `src/lib/whatsapp/campaigns/`.
Tables `whatsapp_campaigns` / `_accounts` / `_leads` / `_sends`
(`scripts/create-whatsapp-campaign-tables.ts`). The sender
(`engine.ts`) is an in-process tick like the email scheduler —
production only, `PAUSE_WHATSAPP_OUTBOUND` — sending one step per number
per tick through `sendWhatsapp`, so every guardrail above applies. A
`whatsapp_campaign_sends` row per (lead, step) is the claim that keeps a
step from ever sending twice; a stale `sending` claim fails the lead as
"uncertain" rather than resending. The refusal `reason` on
`WhatsappSendRefusedError` is what the sender acts on — give any new
refusal one. A reply on any channel marks the Person's enrollments
`replied` in `ingestInboundReplyInTransaction`, beside email and LinkedIn;
the reply reaches Action required the usual way.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.
In a fresh container install it with `uv tool install graphifyy` (the hooks in `.claude/settings.json` and `.git/hooks` call `graphify` from PATH; `graphify hook install` re-adds the git hooks). The domain glossary is `CONTEXT.md`; the current plan and the decisions taken under it are in `docs/plans/`.

Rules:
- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- A committed graphify-out/graph.json is rewritten whole on every build, so a large diff to it in a pull request is expected. Do not flag it as churn or suggest skipping the graph rebuild or its hooks.

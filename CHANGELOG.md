# Changelog

All notable changes to AgentSDR are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Each release lists the database migrations it needs; see
[docs/maintainers/releasing.md](docs/maintainers/releasing.md).

## [Unreleased]

### Added

- Instagram outbound from approved assistant plans: one initial DM per
  assigned profile through Unipile, organization sending rules, durable
  attempt tracking, opt-out checks and reply handling under the run's mode.
  Instagram-only discovery profiles can enter these plans. Existing installs
  must run `bun scripts/add-instagram-outreach.ts` before starting the updated
  app. See [Instagram outbound](docs/product/INSTAGRAM_OUTBOUND.md).
- The assistant's `diagnose_delivery` tool reports stored email and Instagram
  sending gates and recent failures. Repeated identical status reads within
  a turn reuse the result and end the loop.

- **Two starting points in the assistant:** "Use my existing leads or
  inquiries" (a lead list from people already in AgentSDR, the latest
  import, a search, or the people who sent inquiries) and "Find potential
  customers for me". Both feed the same plan card, Start button, CRM,
  replies and handoffs.
- **The assistant reuses what the business already told AgentSDR** — saved
  documents (a price list answers price questions), the name the connected
  accounts send as, and the reply instructions — and asks only for what is
  missing. The business profile gains an optional *prices* field.
- **Lead review before outreach:** each lead's source and date, why it
  matched, each contact route with the page it came from, and only the
  lead's own words as evidence of need. A potential match is kept apart from
  someone who inquired, replied or is interested; a follow, like or generic
  comment is engagement, never intent; unknown location or budget stays
  unknown.
- **One Start for a whole request:** "Apply to the rest of this request"
  starts the request's other plans — including ones prepared later by
  searches still running — with the same reply mode, within the approved
  channels and size, for 24 hours, and stops applying once the approved run
  is paused or stopped.
- **Optional features, off for every organization until an owner or admin
  turns them on** (Settings → Organization → Optional features):
  - *Instagram messages* through Unipile (API v1, the existing connection):
    hosted sign-in, history import (kept as history, never answered),
    Instagram inbox and replies through the CRM. Approved assistant plans
    can send an initial Instagram DM under Settings → Instagram → Sending rules.
  - *Website and directory search*: finds businesses from a description
    through the organization's web-searching AI provider (OpenRouter web
    plugin or AI/ML API research model), reads their published contacts,
    and keeps each with the exact page it came from.
  - *Apify discovery (paid)*: Google Maps listings and Instagram hashtag and
    profile discovery through Actors the owner approves, within a monthly
    budget and per-run caps; when Apify is not set up, over budget or out of
    credit, searches fall back to the scraper or website search with the
    same request (so one Start still covers it). Never tops up or upgrades.
    An Instagram username can be proposed as a DM route; the sender resolves
    a messaging identity and applies account rules before attempting delivery.
  - *Inquiry intake*: an authenticated website-form webhook with field
    mapping (Settings → Inquiries) and Instagram first messages as
    inquiries. Inquiries are answered automatically only inside an inquiry
    run the owner started.

- **A "Where leads came from" table in Results:** each source's found,
  available-contact-route and left-out counts side by side. These are saved
  audience records, not verified deliverability or interest.

### Changed

- **The Results page says why a channel is not sending.** When leads are
  waiting, it names the gate the engine itself applies: outside the mailbox
  sending hours (with the next opening, e.g. "Monday 19 Oct at 09:00"), a
  paused outbound switch, no connected sending account, the daily allowance
  used, send gaps, or a queue that has not been built yet. Readiness is not
  presented as proof of sending. The assistant's results
  answer and the daily summary carry the same line, so "0 emails sent today"
  arrives with its reason instead of a guess.
- **WhatsApp recipient refusals have a readable reason.** Invalid-recipient
  refusals fail that lead once, without claiming the number has no WhatsApp
  account. Authentication and rate-limit responses retain their account-level
  meaning; registration status is not inferred from a generic provider error.

### Migrations

- `bun scripts/add-instagram-intake-discovery.ts` — additive and re-runnable:
  creates `organization_features`, `instagram_accounts`, `instagram_chats`,
  `instagram_messages`, `intake_endpoints`, `inquiries`,
  `lead_audience_member_insights`, `apify_settings` and `apify_runs`, and
  widens the channel checks to allow `instagram`, the job kinds
  `web_discovery` and `apify_instagram`, and the feature `apify_discovery` (added `NOT VALID`, then
  validated without blocking reads or writes). A fresh install gets it from
  `db/schema.sql`. Until it runs every optional feature reads as off, turning
  one on explains that the migration is needed, and the rest of the app works
  unchanged. With Docker Compose:
  `docker compose exec app agentsdr-entrypoint bun scripts/add-instagram-intake-discovery.ts`.

## [0.3.1] - 2026-10-08

### Fixed

- **`docker-compose.yml` names its release's image** (`0.3.1`) instead of
  `latest`. A server that had pulled an earlier `latest` kept running it with
  the new file: 0.2.0's image does not create the schema, so every query
  failed with `relation … does not exist`. Upgrade by downloading the new
  file; `AGENTSDR_VERSION` still overrides the tag.
- **First-run setup no longer loops.** On a fresh install the page bounced
  between `/sign-in` and `/setup` forever: the signed-in frame wrapped
  `/setup` and sent the session-less visitor to sign-in, which sent them back.
- **A rejected database password is explained at startup**: the bundled
  database keeps the password its volume was first created with, and the log
  now says so, with the two ways out.

## [0.3.0] - 2026-10-08

### Changed

- **Scheduled jobs run inside the app.** There is no cron container any more:
  Docker Compose is two containers, `db` and `app`. The jobs run in
  production only (never in `DEMO_MODE`); `INTERNAL_SCHEDULER=false` turns
  them off for an external cron, which calls the endpoints as before.
- **Database schema is created when the app starts.** The image creates it in
  an empty database before the server starts (there is no setup container). An
  existing database is only read, never changed. If this step fails the app
  does not start; `AGENTSDR_SKIP_DB_SETUP=true` skips it.
- **The daily rollover is per organization.** Each organization's email send
  queues, Gmail push watch renewal and LinkedIn daily-limit reset run at the
  start of its own day, set in Settings, Organization, Defaults (**Time zone**,
  default `UTC`, and **New day starts at**, default `00:00`). The first-run
  setup page stores the browser's time zone for the first organization.
- LinkedIn outreach now runs every 30 minutes, and the LinkedIn webhook replay
  every 10. The LinkedIn search queue is no longer scheduled: it runs when
  someone clicks Run.
- `CRON_SECRET` and `OUTREACH_TICK_SECRET` are optional: they are only needed
  to call the job endpoints from outside, and are no longer in
  `docker-compose.yml`. Unset, the endpoints refuse every secret call.
- The job endpoints skip work the in-app scheduler already did (organizations
  whose rollover ran today; a slot that already ran). `?force=1` skips that
  check.

### Fixed

- LinkedIn job logs: concurrent jobs no longer leave the console patched, so
  later lines landed in an old run's log. Log capture is now per run
  (`AsyncLocalStorage`).

### Migrations

- `bun scripts/create-scheduled-job-runs.ts` creates `scheduled_job_runs`,
  where each scheduled run is claimed. With Docker Compose:
  `docker compose exec app agentsdr-entrypoint bun scripts/create-scheduled-job-runs.ts`.
  A fresh install gets the table automatically. **Until the migration runs, no
  scheduled jobs run in-process** (the app logs a
  `[scheduler] Table scheduled_job_runs is missing` warning); the endpoints
  keep working.

**Upgrading a Docker Compose install from 0.2.0:**

1. Replace `docker-compose.yml` with the new one.
2. `docker compose up -d --remove-orphans` (removes the old `setup` and `cron`
   containers).
3. Run the migration above.

On Dokploy, nothing needs creating or scheduling any more; existing Schedule
Jobs are harmless and can be deleted. Keep `CRON_SECRET` and
`OUTREACH_TICK_SECRET` only if you keep calling the endpoints.

## [0.2.0] - 2026-10-08

**Upgrading a Docker Compose install from 0.1.0** (breaking): the new
`docker-compose.yml` no longer loads your whole `.env` into the containers;
it passes only the settings it lists by name. Before `docker compose up -d`:

1. Add `APP_URL=<your public address>` to `.env`. It replaces
   `BETTER_AUTH_URL` / `NEXT_PUBLIC_APP_URL`, which the new file does not
   read. Without it the app assumes `http://localhost:3000`.
2. Keep `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`,
   `INTEGRATION_CREDENTIALS_KEY`, `UNSUBSCRIBE_SECRET`, `CRON_SECRET` and
   `OUTREACH_TICK_SECRET` in `.env` exactly as they are.
3. Any other variable you relied on (a `PAUSE_*` switch, worker tuning,
   Apollo) must be added to the `environment` block of `docker-compose.yml`.

### Added

- **First-run setup page.** On a fresh install every visitor is sent to
  `/setup`: one form (name, organization, email, password) creates the first
  admin, already verified, and their organization, then signs them in. No
  email service is needed to get started. The page closes for good once an
  account exists.
- **Copy-and-run Docker Compose.** `docker-compose.yml` runs the published
  image (`ghcr.io/kandid-ai/agentsdr`), with no repository checkout and no
  files to mount. Every setting is listed by name in the file; the ones to
  replace are marked `# CHANGEME` and can be edited in place or set in a
  `.env`. It starts as-is on `localhost`; on any other `APP_URL` it refuses
  to start while a secret still has its placeholder. The scheduler runs from
  the same image. `docker-compose.build.yml` builds from source instead.
  The Docker guide is rewritten as numbered steps.
- **Public demo.** `DEMO_MODE=true` turns a separate deployment into a
  read-only AgentSDR anyone can open without signing in, and
  `bun run db:seed:demo` now fills it with Northwind, a fictional company's
  three months of email, LinkedIn and WhatsApp outbound, calls with
  transcripts, a full CRM pipeline with AI drafts awaiting review, Tables and
  Analytics. See docs/self-hosting/demo.mdx.

### Changed

- **License: MIT** (was AGPL-3.0-only). Anyone may use, modify, self-host,
  distribute and sell AgentSDR, including in closed-source products and
  hosted services, as long as the copyright and license notice is kept.
- **Email recipients**: inbound Gmail keeps every To and Cc, replies can go
  to all, and a colleague's reply joins the lead's thread.
  `scripts/backfill-email-recipients.ts` (optional, dry run by default)
  restores recipients on messages stored before.
- **Tables**: about 70 fixes across columns, AI and enrichment runs and the
  grid.
- **The app is only the app.** The marketing website, blog theme and launch
  film moved to their own repository (agentsdr.ai). `/` now opens the
  workspace (sign-in first), and the app asks search engines not to index it.
- **Call recorder 0.15.0**: the built-in hosted address is now
  `https://app.agentsdr.ai`. Self-hosted addresses are still added on the
  extension's Options page.

## [0.1.0] - 2026-10-06

The first public release.

### Added

- **Accounts, organizations and teams** with Better Auth: email and
  password sign-up with verification, Google sign-in, password reset,
  invitations, owner / admin / member roles, an organization switcher.
  Sign-up is invite-only by default (`AUTH_SIGNUP=open` opens it); the first
  account on a fresh install can always be created.
- **Multi-tenancy**: every record belongs to an organization; an isolation
  test suite (`scripts/e2e/tenancy-isolation.ts`) proves one organization
  cannot see, change or count another's data.
- **Per-organization integrations** configured in Settings — Unipile
  (LinkedIn and WhatsApp), Google Workspace (Gmail), Cloudflare R2,
  OpenRouter — with credentials encrypted at rest.
- Lead database with custom fields, email outreach with sequences and
  mailbox rotation, LinkedIn campaigns and search, WhatsApp messaging and
  recorded calls, an AI-assisted CRM inbox with reply classification and
  drafted responses, Tables with enrichment providers.
- **Fresh installs**: `bun run db:setup` creates the schema in an empty
  database from `db/schema.sql`; `bun run db:seed:demo` adds a demo
  organization with fictional data.
- **Unipile webhooks register themselves**: saving the Unipile integration
  registers the LinkedIn and WhatsApp webhooks in your Unipile workspace,
  each carrying your organization and a generated secret.
- **Settings by channel**: Email, LinkedIn and WhatsApp each have their
  accounts, their Connection (the integration they run on) and their
  **Sending rules** — the limits that used to be hardcoded (emails a day and
  the gap between them, sending hours, LinkedIn invitations a day and per run,
  delays, search leads a day, WhatsApp warm-up, new chats a day, seconds
  between sends) — with today's values as defaults, hard ceilings and a
  warning past the safe edge. A LinkedIn account or WhatsApp number can set
  its own daily limit; the default phone country is per organization.
  `/settings/integrations` redirects to the new pages.
- **Call recorder Options page**: add your own AgentSDR address in the
  extension; a self-hosted deployment no longer needs its own build.
- Docker Compose self-hosting, CI, and the project's community documents,
  including [responsible use](docs/responsible-use.md).
- **Public website** at [agentsdr.ai](https://agentsdr.ai): product pages for
  each channel, the AI CRM and the data tools, solutions for founders,
  agencies and sales teams, comparisons, guides and this changelog, with a
  sitemap and structured data for search.

### Migrations

- Existing single-workspace installations: follow
  [docs/multi-tenancy/cutover.md](docs/multi-tenancy/cutover.md)
  (`scripts/create-auth-tables.ts`, `scripts/add-organization-scope.ts`,
  then `scripts/finalize-organization-scope.ts` after deploying).
- Sending rules: `bun run scripts/add-channel-settings.ts` (additive; run it
  before deploying). The `WHATSAPP_*` sending variables are no longer read —
  set those limits in Settings → WhatsApp → Sending rules.

[Unreleased]: https://github.com/Kandid-ai/AgentSDR/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/Kandid-ai/AgentSDR/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Kandid-ai/AgentSDR/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Kandid-ai/AgentSDR/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Kandid-ai/AgentSDR/releases/tag/v0.1.0

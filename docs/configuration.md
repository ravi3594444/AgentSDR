---
title: "Configuration reference"
description: "Every environment variable AgentSDR reads: what it does, whether you need it, how to generate it, its default and where it is read."
icon: "sliders-horizontal"
---

This page lists every environment variable the running app reads, plus the few
that Docker Compose and the setup scripts read. Each one says whether you need
it, what happens without it, and how to get a value.

## How configuration works

AgentSDR keeps almost nothing in environment variables. The environment holds
only four kinds of thing:

1. **What the app needs before it can read the database**: the database
   connection, the sign-in secret and the encryption key.
2. **Shared platform services**: the email service that sends sign-in mail
   (Resend) and the optional Google sign-in button.
3. **Public URLs**: where people reach the app. (Optionally, passwords for
   calling the job endpoints from outside.)
4. **Tuning knobs and pause switches**: optional, with working defaults.

Everything else is set **per organization, inside the app**, and stored
encrypted in the database. There is no environment fallback for any of it:

| Set in the app | Where |
|---|---|
| Unipile (LinkedIn and WhatsApp), Google Workspace (Gmail), Cloudflare R2 | **Integrations** (`/integrations`), or the Connection page of each channel. See [integrations.md](integrations.md). |
| OpenRouter (AI) | **Settings → AI provider**. See [OpenRouter](integrations/openrouter.mdx). |
| Enrichment providers | **Integrations**. See [Enrichment providers](integrations/enrichment-providers.mdx). |
| Emails a day, send gaps, sending hours, LinkedIn invitations, WhatsApp warm-up and new chats a day | **Sending rules** (`/workspace/sending-rules`). See [Sending rules](workspace/sending-rules.mdx). |

If you are looking for `UNIPILE_API_KEY`, `OPENROUTER_API_KEY`, `R2_*` or a
Google service-account key: they are not read. See
[Removed variables](#removed-variables).

### Which file holds the values

| How you run AgentSDR | File | Notes |
|---|---|---|
| Docker Compose | `docker-compose.yml`, or a `.env` next to it | Every setting is listed by name in the compose file; a `.env` value wins over it. See [Docker Compose](self-hosting/docker-compose.mdx). |
| From source (`bun run dev`, `next start`) | `.env.local` | Next.js and Bun load it. See [From source](self-hosting/from-source.mdx). |
| A platform such as Dokploy | The platform's environment settings | See [Dokploy](self-hosting/dokploy.mdx). |

From source, start from `.env.example`: `cp .env.example .env.local`. With
Compose, edit the values in `docker-compose.yml` or write `NAME=value` lines in
a `.env`. Restart the app after any change. The
pause switches are re-read on every call, but most other values are read once
when the server starts.

Generate every secret on this page with:

```bash
openssl rand -hex 32
```

That prints 64 random hex characters. Use a different value for each secret.

## Minimum production configuration

Copy this block into `.env` and fill it in. A line starting with `#` is a
comment.

```bash
# Where PostgreSQL 16+ is. With Docker Compose this is built for you (the
# bundled database), so you can leave it out.
DATABASE_URL=postgres://agentsdr:CHANGE-ME@db.example.com:5432/agentsdr

# Docker Compose: set each secret (and POSTGRES_PASSWORD) in docker-compose.yml
# or here; a .env value wins over the default in the file.

# Set to "disable" only if your database has no TLS (the Compose database).
# Leave it out to require TLS, which hosted databases expect.
DATABASE_SSL=disable

# The address people and webhooks use to reach AgentSDR. No trailing slash.
BETTER_AUTH_URL=https://agentsdr.example.com

# Signs login sessions. Changing it later signs everyone out.
BETTER_AUTH_SECRET=<openssl rand -hex 32>

# Encrypts every saved integration credential. Never change it casually.
INTEGRATION_CREDENTIALS_KEY=<openssl rand -hex 32>

# Signs the one-click unsubscribe link in every email you send.
UNSUBSCRIBE_SECRET=<openssl rand -hex 32>

# Sends sign-up verification, password reset and invitation email.
# Needed before you invite anyone. Without it these emails go to the log.
RESEND_API_KEY=re_xxxxxxxxxxxx
# The sender. Its domain must be verified in Resend.
AUTH_EMAIL_FROM="AgentSDR <auth@yourdomain.com>"
```

Optional additions: `AUTH_SIGNUP=open` if anyone may sign up, and
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` for "Continue with Google".

## Database

PostgreSQL 16 or newer. Create the tables in an empty database with
`bun run db:setup` (the Docker image does this for you on first start, see
[`AGENTSDR_SKIP_DB_SETUP`](#agentsdr_skip_db_setup)).

### `DATABASE_URL`

| | |
|---|---|
| **Required?** | Yes. The app throws at start if it is missing: `DATABASE_URL is not set`. |
| **Default** | None. |
| **What it does** | The PostgreSQL connection string. Also used by drizzle-kit and every script. |
| **How to get it** | Your database host shows it. Format: `postgres://USER:PASSWORD@HOST:5432/DATABASE`. With Docker Compose you do not set it: Compose builds it from `POSTGRES_PASSWORD`. If you use your own database with Compose, set it here (see [Docker Compose](self-hosting/docker-compose.mdx)). Percent-encode special characters in the password (`@` becomes `%40`). |
| **Example** | `postgres://agentsdr:s3cret@db.example.com:5432/agentsdr` |
| **Read in** | `src/lib/db.ts`, `drizzle.config.ts`, `scripts/db/*.ts`, `scripts/lib/organization.ts` |

### `DATABASE_SSL`

| | |
|---|---|
| **Required?** | No. |
| **Default** | Unset: TLS is required. |
| **What it does** | `disable` connects without TLS. Any other value, or unset, requires TLS. If your database does not support TLS and you leave this unset, every query fails to connect. |
| **How to get it** | Use `disable` for a local or Compose database. Leave it unset or empty for hosted databases (Supabase, Neon, RDS and similar). |
| **Example** | `DATABASE_SSL=disable` |
| **Read in** | `src/lib/db.ts`, `scripts/db/setup.ts`, `scripts/db/dump-schema.ts`, `scripts/lib/organization.ts`, `scripts/check-organization-scope.ts` |

### `DB_POOL_MAX`

| | |
|---|---|
| **Required?** | No. |
| **Default** | `8` |
| **What it does** | The most connections this app holds open. A PostgreSQL server has a fixed `max_connections` shared by every client, and managed databases often set it low (50 is common). When the server is full, every query fails with `remaining connection slots are reserved for roles with the SUPERUSER attribute`. That error means capacity, not a bug. |
| **How to get it** | Keep it well under the server's `max_connections`, across all running copies of the app. A rolling deploy briefly runs two containers, so count double. Before raising it, check `select count(*) from pg_stat_activity;`. |
| **Example** | `DB_POOL_MAX=8` |
| **Read in** | `src/lib/db.ts` |

### `POSTGRES_PASSWORD` (Docker Compose only)

| | |
|---|---|
| **Required?** | Yes, with the bundled database. |
| **Default** | A `changeme-...` placeholder, accepted only on a localhost `APP_URL`. |
| **What it does** | The password of the bundled PostgreSQL container. Compose also builds the app's `DATABASE_URL` from it. |
| **How to get it** | Optional: `openssl rand -hex 24`. Letters and digits only (it becomes part of the database URL). The database stores it on first start, and changing the variable later does not change the stored password. |
| **Read in** | `docker-compose.yml` |

### `COMPOSE_FILE` (Docker Compose with your own PostgreSQL)

Set `COMPOSE_FILE=docker-compose.yml:docker-compose.external-db.yml` in `.env`
to skip the bundled database and use the `DATABASE_URL` you provide. This is
read by Docker Compose itself, not by the app. Needs Docker Compose 2.24 or
newer. With it, set `DATABASE_SSL` empty unless your database has no TLS. See
[Docker Compose](self-hosting/docker-compose.mdx).

## Auth and sign-up

AgentSDR uses Better Auth: email and password with verified email, plus Google
when configured.

### `BETTER_AUTH_SECRET`

| | |
|---|---|
| **Required?** | Yes. |
| **Default** | None. |
| **What it does** | Signs login sessions. Use 32 or more random characters. Changing it signs everyone out (nothing else breaks). |
| **How to get it** | `openssl rand -hex 32` |
| **Example** | `BETTER_AUTH_SECRET=3f9a...` (64 hex characters) |
| **Read in** | `src/lib/auth/server.ts` |

### `AUTH_SIGNUP`

| | |
|---|---|
| **Required?** | No. |
| **Default** | `invite-only` |
| **What it does** | Controls who can create an account. `invite-only`: the first account can always be created. After that, only an email address with a pending, unexpired invitation gets an account (anyone else sees the normal "check your email" response and nothing is created), and only owners and admins of the first organization (or the first user, before any organization exists) can create organizations. This also covers Google sign-in, and the sign-in page stops offering "Create one". `open`: anyone who can reach the instance can sign up and create organizations. Any value other than `open` means `invite-only`. |
| **How to get it** | Choose. Keep `invite-only` unless this is a public service. |
| **Example** | `AUTH_SIGNUP=open` |
| **Read in** | `src/lib/auth/signup.ts` |

## Secrets

### `INTEGRATION_CREDENTIALS_KEY`

| | |
|---|---|
| **Required?** | Yes. Without it the app throws `INTEGRATION_CREDENTIALS_KEY must be configured before saving or reading integration credentials` the first time an integration is saved or read. |
| **Default** | None. |
| **What it does** | The key for AES-256-GCM encryption of every saved integration credential (Unipile, Google Workspace, R2, OpenRouter, enrichment providers) for every organization. |
| **How to get it** | `openssl rand -hex 32`. Use the **same value on every instance** that shares the database. |
| **Example** | `INTEGRATION_CREDENTIALS_KEY=9c1e...` (64 hex characters) |
| **Read in** | `src/lib/integrations/credential-crypto.ts` |

<a id="rotating-the-encryption-key"></a>

**Treat this key as permanent.** Set it once, before anyone connects an
integration, and keep a copy outside the database (a password manager). The
credentials are encrypted with it and the database stores only the encrypted
text. If you change it or lose it, every saved credential becomes unreadable,
and you must reconnect each integration by hand.

**Rotating on purpose.** `scripts/rotate-integration-credentials.ts` re-encrypts
the stored credentials from an old key to a new one in one transaction:

1. Back up the database.
2. Put the **new** key in `INTEGRATION_CREDENTIALS_KEY` (at least 32
   characters) and the **old** key in `LEGACY_INTEGRATION_CREDENTIALS_KEYS`
   (comma-separated if there is more than one), in the shell where you run the
   script.
3. Dry run. It decrypts and re-encrypts in memory, rolls back, and prints a
   summary with key fingerprints (never the secrets):
   ```bash
   bun run rotate:integration-credentials
   ```
4. Check `unresolved` is `0` in the summary. A row is `unresolved` when none of
   the keys you gave can decrypt it.
5. Apply:
   ```bash
   bun run rotate:integration-credentials -- --apply
   ```
6. Set the new key as `INTEGRATION_CREDENTIALS_KEY` on every running instance
   and restart them. Rows already on the new key are reported `already_current`,
   so re-running is safe. The script connects over TLS, so point `DATABASE_URL`
   at a database that offers it.

The old `AUTH_SECRET` value is also tried automatically as a legacy key.

### `UNSUBSCRIBE_SECRET`

| | |
|---|---|
| **Required?** | Yes, to send email. Sending fails with `UNSUBSCRIBE_SECRET is not configured`. |
| **Default** | None. |
| **What it does** | The HMAC key that signs the unsubscribe link in every outreach email. A link is stateless: it carries the organization and address, signed, and can unsubscribe only that one address. |
| **How to get it** | `openssl rand -hex 32` |
| **Example** | `UNSUBSCRIBE_SECRET=b7d2...` |
| **Read in** | `src/lib/outreach/unsubscribeToken.ts` |

**Do not change it after you have sent email.** Links already sitting in
people's inboxes stop verifying, so those people can no longer unsubscribe by
clicking. That is a compliance problem. See
[Responsible use](responsible-use.md).

## URLs

### `BETTER_AUTH_URL`

| | |
|---|---|
| **Required?** | Yes. |
| **Default** | `NEXT_PUBLIC_APP_URL` if that is set, otherwise none. |
| **What it does** | The app's public origin, no trailing slash. It is read at **runtime** and used for Better Auth's links and trusted origin (sign-in from any other origin is refused), the unsubscribe links in sent email, and the Unipile hosted-auth redirect and webhook URLs. If it is wrong, links in email point to the wrong place and webhooks never arrive. |
| **How to get it** | The address you open AgentSDR at, including `https://`. It must be reachable from the internet if you use Gmail push, Unipile or the call recorder. |
| **Example** | `BETTER_AUTH_URL=https://agentsdr.example.com` |
| **Read in** | `src/lib/auth/server.ts`, `src/lib/http/publicAppUrl.ts`, `src/lib/outreach/render.ts`, `src/lib/linkedin/hostedAuthUrls.ts` |

### `NEXT_PUBLIC_APP_URL`

| | |
|---|---|
| **Required?** | No. |
| **Default** | None. |
| **What it does** | Legacy fallback for `BETTER_AUTH_URL`, used only when that is unset. Next.js inlines `NEXT_PUBLIC_*` values into the build, so an image built once carries the build-time value. Prefer `BETTER_AUTH_URL`. |
| **Read in** | `src/lib/http/publicAppUrl.ts`, `src/lib/auth/server.ts` |

### `OPENROUTER_SITE_URL`

| | |
|---|---|
| **Required?** | No. |
| **Default** | `http://localhost:3000` |
| **What it does** | Sent to OpenRouter as the `HTTP-Referer` header so requests are attributed to your site. It does not affect whether AI works: the OpenRouter key itself is per organization (**Settings → AI provider**). |
| **Example** | `OPENROUTER_SITE_URL=https://agentsdr.example.com` |
| **Read in** | `src/lib/ai/server/openrouter.ts` |

### `DEFAULT_PHONE_COUNTRY`

| | |
|---|---|
| **Required?** | No. |
| **Default** | None. |
| **What it does** | A two-letter country code (ISO 3166-1 alpha-2) used to read phone numbers typed without a leading `+`, for organizations that have not set one in **Settings → Organization → Defaults**. If neither is set, such numbers are treated as invalid. Read at runtime. `NEXT_PUBLIC_DEFAULT_PHONE_COUNTRY` is the older, build-time name and still works as a fallback. |
| **Example** | `DEFAULT_PHONE_COUNTRY=US` |
| **Read in** | `src/lib/calls/phone.ts`, `src/lib/calls/phone.server.ts` |

### `PORT` (Docker Compose)

| | |
|---|---|
| **Required?** | No. |
| **Default** | `3000` |
| **What it does** | The host port Compose publishes the app on (`${PORT:-3000}:3000`). It is not the port the app listens on inside the container, which is always `3000`. If you change it, change `BETTER_AUTH_URL` to match. |
| **Read in** | `docker-compose.yml` |

## Email for sign-in (Resend)

AgentSDR sends sign-up verification, password reset and invitation emails
through [Resend](https://resend.com). This is separate from your outreach
mailboxes, which send through Gmail. Setup steps:
[Resend](integrations/resend.mdx).

### `RESEND_API_KEY`

| | |
|---|---|
| **Required?** | Needed before you invite anyone in production. |
| **Default** | None. |
| **What it does** | Without it, no auth email is sent: each one is written to the server log instead (with a one-time warning in production), so you can copy a link from `docker compose logs app`. The first admin account, created on the setup page, needs no email. Invited users would wait for email that never arrives. |
| **How to get it** | Resend dashboard, [API Keys](https://resend.com/api-keys), create a key. Resend shows the value once and cannot show it again, so copy it then. See Resend's [API keys](https://resend.com/docs/dashboard/api-keys/introduction) page. |
| **Example** | `RESEND_API_KEY=re_123abc...` |
| **Read in** | `src/lib/auth/email.ts` |

### `AUTH_EMAIL_FROM`

| | |
|---|---|
| **Required?** | Yes when `RESEND_API_KEY` is set. Without it, sending throws `AUTH_EMAIL_FROM is not set`. |
| **Default** | None. |
| **What it does** | The sender of auth email. Its domain must be verified in Resend, or Resend refuses the message (`Resend refused the email`). |
| **How to get it** | Verify your domain in Resend under **Domains**, then use any address on it. |
| **Example** | `AUTH_EMAIL_FROM="AgentSDR <auth@yourdomain.com>"` |
| **Read in** | `src/lib/auth/email.ts` |

## Google sign-in

Adds a "Continue with Google" button. Setup steps:
[Google sign-in](integrations/google-sign-in.mdx). This is only about people
logging in; connecting a Gmail mailbox for sending is a per-organization
integration, [Google Workspace](integrations/google-workspace.mdx).

### `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`

| | |
|---|---|
| **Required?** | No. Both must be set, or the button does not appear. |
| **Default** | None. |
| **What it does** | Enables Google sign-in. With `AUTH_SIGNUP=invite-only`, Google sign-in follows the same invitation rule as email sign-up. |
| **How to get it** | In the Google Cloud console, open Google Auth Platform → **Clients**, click **Create client**, choose **Web application**, and add the authorized redirect URI below. Google shows the client secret when you create the client, so copy it then. See Google's [OAuth client setup](https://support.google.com/cloud/answer/6158849). |
| **Redirect URI** | `<BETTER_AUTH_URL>/api/auth/callback/google`, for example `https://agentsdr.example.com/api/auth/callback/google`. Google requires HTTPS except for `localhost`. |
| **Example** | `GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com` |
| **Read in** | `src/lib/auth/server.ts` |

## Scheduled jobs

The scheduled jobs run inside the app when `NODE_ENV=production` (`bun run
start` or the Docker image), never in a demo deployment: the daily rollover,
LinkedIn outreach every 30 minutes, webhook replay (LinkedIn and Instagram) every 10 minutes
and history pruning. Nothing to schedule and no secrets to set. The daily
rollover (email send queues, Gmail watch renewal, LinkedIn daily limits) runs
at the start of each organization's day, set in Settings, Organization,
Defaults: **Time zone** (default `UTC`) and **New day starts at** (default
`00:00`). Details: [Going to production](self-hosting/production.mdx#scheduled-jobs).

The same work is also available as endpoints, for a manual run or an external
cron. Each is protected by one of two optional secrets.

| Endpoint | Secret | How the caller sends it | What it does |
|---|---|---|---|
| `POST /api/outreach/build-queue` | `OUTREACH_TICK_SECRET` | header `x-tick-secret: <secret>` | Builds each mailbox's send queue and resets daily counters. |
| `POST /api/outreach/mailboxes/watch` | `OUTREACH_TICK_SECRET` | header `x-tick-secret: <secret>` | Renews Gmail push notifications, which expire after about 7 days. |
| `POST /api/outreach/tick` | `OUTREACH_TICK_SECRET` | header `x-tick-secret` (or `?secret=`) | One send tick. The app already ticks itself every minute in production: call it only to force one while debugging, and do not schedule it. |
| `POST /api/linkedin/jobs/run-outreach` | `CRON_SECRET` | header `Authorization: Bearer <secret>` | LinkedIn invitations and follow-ups. |
| `POST /api/linkedin/jobs/run-search-queue` | `CRON_SECRET` | same | The LinkedIn search queue (not scheduled: it runs when someone clicks Run). |
| `POST /api/linkedin/jobs/replay-webhooks` | `CRON_SECRET` | same | Retries failed webhook deliveries. |
| `POST /api/linkedin/jobs/reset-daily-limits` | `CRON_SECRET` | same | Resets LinkedIn daily limits. |

While the in-app scheduler is on, `run-outreach` and `replay-webhooks` answer
`{ "ok": true, "skipped": "already ran for slot ..." }` if it already ran that
slot, and the other three skip organizations whose daily rollover already ran
today. Add `?force=1` to skip this check.

### `INTERNAL_SCHEDULER`

| | |
|---|---|
| **Required?** | No. |
| **Default** | On in production, off otherwise. |
| **What it does** | `false` turns the in-app scheduled jobs off, so an external cron calls the endpoints above instead (set the two secrets below). |
| **Example** | `INTERNAL_SCHEDULER=false` |
| **Read in** | `src/lib/scheduler/internalScheduler.ts` |

### `AGENTSDR_SKIP_DB_SETUP`

| | |
|---|---|
| **Required?** | No. |
| **Default** | Unset: on start, the Docker image creates the schema if the database is empty. |
| **What it does** | `true` skips that step (for example when you manage the schema yourself). An existing database is never changed by it either way. If the step fails the app does not start. |
| **Example** | `AGENTSDR_SKIP_DB_SETUP=true` |
| **Read in** | `docker/entrypoint.sh` |

### `OUTREACH_TICK_SECRET`

| | |
|---|---|
| **Required?** | No. Only to call the email job endpoints from outside. Unset, they answer `401 unauthorized` to every secret call. |
| **Default** | None. Not in `docker-compose.yml`: add it to the `environment` block to use it. |
| **What it does** | Authenticates the email job endpoints. |
| **How to get it** | `openssl rand -hex 32` |
| **Read in** | `src/app/api/outreach/build-queue/route.ts`, `src/app/api/outreach/mailboxes/watch/route.ts`, `src/app/api/outreach/tick/route.ts` |

### `CRON_SECRET`

| | |
|---|---|
| **Required?** | No. Only to call the LinkedIn job endpoints from outside. Unset, they refuse every secret call. |
| **Default** | None. Not in `docker-compose.yml`. |
| **What it does** | The bearer secret for `/api/linkedin/jobs/*`. A caller with it works across every organization. A signed-in member calling the same routes only affects their own organization. |
| **How to get it** | `openssl rand -hex 32` |
| **Read in** | `src/proxy.ts`, `src/lib/linkedin/organizations.server.ts` |

## Workers and tuning

Four workers start with the server, beside the scheduled jobs above:

| Worker | Runs | Does |
|---|---|---|
| Email send loop | Production only (`NODE_ENV=production`), every minute | Sends queued email. |
| WhatsApp campaign loop | Production only, every 30 seconds | Sends the next step of WhatsApp campaigns. |
| Enrichment worker | Always | Fills Tables cells. |
| CRM worker | Always | Classifies replies, writes drafts, schedules follow-ups. |

The email and WhatsApp loops have no distributed lock, so run **one** instance
of the app. The enrichment and CRM workers claim work safely, so two instances
overlapping during a deploy are fine.

All of the following are optional. Values must be numbers in milliseconds
unless noted.

| Variable | Default | What it does | Read in |
|---|---|---|---|
| `OUTREACH_TICK_INTERVAL_MS` | `60000` | How often the in-process email send loop ticks. | `src/lib/outreach/internalScheduler.ts` |
| `WHATSAPP_CAMPAIGN_TICK_INTERVAL_MS` | `30000` (values under `1000` fall back to `30000`) | How often the WhatsApp campaign sender ticks. | `src/lib/whatsapp/campaigns/internalScheduler.ts` |
| `GRID_WORKER_POLL_MS` | `1000` | How often the enrichment worker looks for cells to run. | `src/lib/grid/worker.ts` |
| `GRID_WORKER_CONCURRENCY` | `8` | Enrichment cells processed at once. Lower it if a provider rate-limits you. | `src/lib/grid/worker.ts` |
| `GRID_CELL_TIMEOUT_MS` | `30000` | Per-cell timeout. | `src/lib/grid/worker.ts` |
| `CRM_WORKER_POLL_MS` | `1000` (minimum `100`) | CRM job poll interval. | `src/lib/crm/worker.ts` |
| `CRM_WORKER_CONCURRENCY` | `4` (minimum `1`) | CRM jobs processed at once. | `src/lib/crm/worker.ts` |
| `CRM_WORKER_STALE_LOCK_MS` | `300000` (minimum `1000`) | Age after which a claimed CRM job is treated as abandoned and re-queued. | `src/lib/crm/worker.ts` |

**Sending limits are not environment variables.** Emails a day per mailbox,
the gap between emails, LinkedIn invitations a day and per run, WhatsApp
warm-up, new chats a day and the gap between sends are set per organization in
**Workspace → Sending rules** (`/workspace/sending-rules`), with hard ceilings
and a warning past the safe edge. A LinkedIn account, WhatsApp number or
mailbox can override its daily limit. The rules, their defaults and bounds are
in `src/lib/channels/rules.ts`; see [Sending rules](workspace/sending-rules.mdx).
The `WHATSAPP_NEW_CHAT_WARMUP_HOURS`, `WHATSAPP_NEW_CHATS_PER_DAY` and
`WHATSAPP_MIN_SECONDS_BETWEEN_SENDS` variables of earlier versions are no
longer read.

### Pause switches

Switches that stop outbound work without a deploy. They were written for the
unified-People data migration, are off by default, and normally stay off. A
value of `1`, `true`, `yes` or `on` (case-insensitive) turns one on; anything
else is off. They are re-read on every call, so on platforms that refresh the
environment they take effect without a restart. All are read in
`src/lib/migration/controls.ts`.

| Variable | Effect when on |
|---|---|
| `PEOPLE_MIGRATION_MODE` | Master switch. Turns on every pause below, and answers `503` to campaign, import and manual-send changes (`POST`, `PUT`, `PATCH`, `DELETE` under `/api/grid/tables/`, `/api/linkedin/{campaigns,jobs,leads,messages/send,search}`, `/api/outreach/{campaigns,inbox/,mailboxes/}`). Inbound webhooks, unsubscribe links and reads keep working. |
| `PAUSE_CAMPAIGN_MUTATIONS` | Only the `503` on those routes. |
| `PAUSE_EMAIL_OUTBOUND` | Stops outgoing email. |
| `PAUSE_LINKEDIN_OUTBOUND` | Stops LinkedIn invitations and messages. |
| `PAUSE_WHATSAPP_OUTBOUND` | Stops WhatsApp messages. |
| `PAUSE_LINKEDIN_RESOLUTION` | Stops LinkedIn profile resolution. |
| `PAUSE_LINKEDIN_SEARCH` | Stops the LinkedIn search queue. |
| `PAUSE_GRID_WORKER` | Stops the enrichment worker. |

They are also an emergency brake: set `PAUSE_EMAIL_OUTBOUND=true` and restart,
and sending stops without touching any data. Remove it and restart to resume.
`.env.example` lists them as `false`; `PAUSE_WHATSAPP_OUTBOUND` is read by the
code but is not in `.env.example`, so add it yourself.

## Prospecting (domain qualification)

Used only by the Domains / qualification feature, which is slated for removal.
Apollo for Tables is a separate per-organization connection, see
[Enrichment providers](integrations/enrichment-providers.mdx). Read in
`src/lib/qualification/config.ts`.

| Variable | Required | Default | What it does |
|---|---|---|---|
| `APOLLO_API_KEY` | For qualification | empty | A **master** Apollo API key. The `mixed_people/api_search` endpoint needs one; other keys get `403`. Get it in Apollo under your API settings. Without it, qualification cannot call Apollo. |
| `APOLLO_BASE_URL` | No | `https://api.apollo.io/api/v1` | Apollo API base. |
| `APOLLO_THROTTLE_MS` | No | `0` | Minimum milliseconds between Apollo search calls. The endpoint allows roughly 600 an hour; use about `6000` in production. |
| `ADS_PROVIDER` | No | `mock` | Ads-check provider. The stage is deferred; leave unset. |
| `ADS_API_KEY`, `ADS_BASE_URL` | No | empty | Credentials for the deferred ads stage. |

## User-named variables (Tables HTTP column)

The HTTP column in Tables can authenticate with a bearer token read from an
environment variable whose **name the user types** in the column settings
(`authEnvVar`). The secret therefore comes from the server's environment and
never from the database, so it does not end up in database dumps.

- The name must start with `GRID_HTTP_SECRET_`, for example
  `GRID_HTTP_SECRET_ACME`. Anything else is refused when the column is saved
  and again when it runs, so a member cannot send `DATABASE_URL` or
  `INTEGRATION_CREDENTIALS_KEY` to a URL of their choosing. Set the variables
  your users reference in the same place as the rest of your environment,
  then restart.
- The value is sent as `Authorization: Bearer <value>`. If it already starts
  with `Bearer `, it is sent as is.
- If the variable is not set, the cell fails with `Environment variable <NAME> is not set on this server`.

The HTTP column also refuses to call loopback, private, link-local (including
cloud metadata) and CGNAT addresses, checked on the resolved address and again
on every redirect. A self-hosted install that needs internal APIs can set
`GRID_HTTP_ALLOW_PRIVATE=true`.

Read in `src/lib/grid/runners/http.ts`.

## Public demo

### `DEMO_MODE`

`true` turns the deployment into a public, read-only demo: visitors are signed
in as the seeded demo user without a password, every write is refused, no
background work starts, and the seeded data's dates move forward each day.
Only for a deployment with its own database seeded by `bun run db:seed:demo`.
See [Public demo](self-hosting/demo.mdx). Default off.

## Set by the platform

You normally do not set these.

| Variable | Notes |
|---|---|
| `NODE_ENV` | `production` under `next start` and in the Docker image. Turns on the email and WhatsApp send loops, and makes a missing `RESEND_API_KEY` log a one-time warning. |
| `NEXT_RUNTIME` | Set by Next.js. `src/instrumentation.ts` starts the workers only when it is `nodejs`. |
| `PORT`, `HOSTNAME` | The Docker image sets `PORT=3000` and `HOSTNAME=0.0.0.0` for the server inside the container. Not the same as the Compose `PORT` above. |

## Script-only variables

Read by tooling in `scripts/`, never by the running app.

| Variable | Script | What it does |
|---|---|---|
| `DEMO_PASSWORD` | `scripts/db/seed-demo.ts`, `/demo` | Password of the demo user created by `bun run db:seed:demo`, and the one `/demo` signs in with under `DEMO_MODE`. Default `demo-password-123`. |
| `PG_DUMP` | `scripts/db/dump-schema.ts` | Path to a `pg_dump` at least as new as the server, for `bun run db:schema:dump`. Default: `pg_dump` on `PATH`. |
| `ORGANIZATION_ID` | `scripts/lib/organization.ts` | Organization a one-shot script runs as; defaults to the initial organization. |
| `LEGACY_INTEGRATION_CREDENTIALS_KEYS`, `AUTH_SECRET` | `scripts/rotate-integration-credentials.ts` | Old keys to re-encrypt credentials from. See [rotating the key](#rotating-the-encryption-key). |
| `BASE_URL`, `INITIAL_OWNER_EMAIL`, `INITIAL_OWNER_PASSWORD`, `ISOLATION_SKIP_WRITES` | `scripts/e2e/tenancy-isolation.ts` | See [development.md](development.md#tenancy-isolation-test). |
| `INITIAL_ORG_NAME`, `INITIAL_ORG_SLUG`, `INITIAL_OWNER_NAME`, `INITIAL_OWNER_EMAIL`, `INITIAL_OWNER_PASSWORD` | `scripts/add-organization-scope.ts` | The one-time migration that introduced organizations. |
| `LIVE_TEST_PERSON` | `scripts/test-integrations-live.ts` | Path to a JSON file describing a test person. |
| `PEOPLE_BACKFILL_CONCURRENCY` | `scripts/backfill-campaign-people.ts` | Backfill concurrency (default 8). |
| `LINKEDIN_PARITY_DATABASE_URL`, `LINKEDIN_PARITY_EXPECTED_DATABASE` | `scripts/audit-linkedin-migration-parity.ts` | Explicit target for a parity audit. |
| `APP_GIT_SHA` (or `VERCEL_GIT_COMMIT_SHA`, `RAILWAY_GIT_COMMIT_SHA`, `GIT_SHA`) | `scripts/export-people-migration-reconciliation.ts`, `scripts/rollback-people-migration.ts` | Recorded in migration reports. |

## Removed variables

`AUTH_PASSWORD` and `AUTH_SECRET` belonged to the old single shared password
and are no longer read by the app (`AUTH_SECRET` survives only as a legacy key
in the rotation script). `OPENROUTER_API_KEY`, `UNIPILE_*`, the `GOOGLE_*`
service-account keys and `R2_*` are not read either: those services are
connected in the app. See [integrations.md](integrations.md).

## Next

- [Self-hosting overview](self-hosting.md)
- [Integrations overview](integrations.md)
- [Production checklist](self-hosting/production.mdx)
- [Troubleshooting](self-hosting/troubleshooting.mdx)

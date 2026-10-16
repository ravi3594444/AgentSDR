---
title: "Self-hosting"
description: "What you run, what you need, which outside accounts power which features, and the order to set AgentSDR up."
icon: "server"
---

AgentSDR is one Next.js application backed by one PostgreSQL database. There is
no queue server, no Redis and no separate worker process. This page is the map;
the step-by-step guides are linked in [Choose your path](#choose-your-path).

## What you are running

| Piece | What it is |
|---|---|
| The app | One Next.js server (Bun in the Docker image), listening on port 3000. It serves the UI, the API and the webhooks. |
| PostgreSQL | The only datastore. It holds everything, including your integrations' credentials, encrypted. |
| In-process workers | Started inside the app when it boots (`src/instrumentation.ts`): the email send loop, the WhatsApp campaign sender, the Tables enrichment worker and the CRM worker. Nothing to configure. See [Scheduled jobs](#scheduled-jobs). |
| Scheduled jobs | Also inside the app in production: the daily rollover, LinkedIn outreach and webhook replay. No cron container. |

The app is designed to run as a **single instance**. The outreach sender loop
has no distributed lock; two instances would each send. Do not scale `app` to
more than one replica. (The enrichment and CRM workers are safe to overlap;
the outreach scheduler is not.)

## Requirements

- PostgreSQL 16 or newer. `db:setup` refuses older servers. The schema is
  tested on 16, 17 and 18.
- Either Docker (with Compose), or Node.js 20.9+ / Bun 1.2+ to run from source.
  The Docker image and the repository's tooling use Bun.
- A public HTTPS origin if you want webhooks to reach you (Unipile, Gmail push)
  and email links to work for other people.
- A [Resend](https://resend.com) account, only if you will invite people or
  need password-reset email (see [Email](#email)).

## Outside accounts you will need

Third-party services (Unipile, Google Workspace, Cloudflare R2, OpenRouter,
enrichment providers) are not configured in the environment. You connect them
from inside the app, per organization. See [integrations.md](integrations.md).
Each feature switches on once the service it needs is connected.

| Account | Powers | Needed for | Guide |
|---|---|---|---|
| Resend | Sign-up verification, password reset and invitation email (per instance, in the environment) | Inviting anyone | [Resend](integrations/resend.mdx) |
| Google Workspace | Sending and reading Gmail through a service account | Email outreach and the inbox | [Google Workspace](integrations/google-workspace.mdx), [Gmail reply sync](integrations/gmail-reply-sync.mdx) |
| Unipile | LinkedIn and WhatsApp accounts, messaging and calling | LinkedIn, WhatsApp | [Unipile](integrations/unipile.mdx) |
| Cloudflare R2 | Call recordings and contact photos | WhatsApp call recording | [Cloudflare R2](integrations/cloudflare-r2.mdx) |
| OpenRouter | Every AI feature, on your own key | AI drafts, classification, AI columns | [OpenRouter](integrations/openrouter.mdx) |
| Enrichment providers | Tables columns | Tables enrichment | [Enrichment providers](integrations/enrichment-providers.mdx) |
| Google OAuth client | "Continue with Google" sign-in (optional) | Google sign-in | [Google sign-in](integrations/google-sign-in.mdx) |

## Choose your path

| Path | Best for | Guide |
|---|---|---|
| Docker Compose | Most people: download one file, set your secrets, run one command; database, schema and scheduled jobs included. | [Docker Compose](self-hosting/docker-compose.mdx) |
| From source | Development, or a host where you manage Node/Bun and Postgres yourself. | [From source](self-hosting/from-source.mdx) |
| Dokploy on a VPS | A self-hosted platform with domains, HTTPS and deploy-on-push. | [Dokploy](self-hosting/dokploy.mdx) |

Then read [Going to production](self-hosting/production.mdx) and keep
[Troubleshooting](self-hosting/troubleshooting.mdx) at hand. Every environment
variable is in the [configuration reference](configuration.md).

## Order of setup

1. **Install** with one of the paths above.
2. **First sign-up:** create the first account and your organization
   ([below](#first-sign-up-and-the-organization)).
3. **Connect integrations** in Settings, one per feature you want.
4. **Scheduled jobs:** nothing to set up; set each organization's time zone
   ([below](#scheduled-jobs)).
5. **Go live:** domain, HTTPS, Resend, backups ([production](self-hosting/production.mdx)).

## First sign-up and the organization

1. On a fresh install, open the app: the setup page creates the first admin
   account and your organization (a name and a URL slug), and no email
   verification is needed. You become the owner. Later accounts sign up at
   `/sign-up`, and password sign-in for them needs a verified email (see
   [Email](#email)); with no `RESEND_API_KEY` that email is written to the
   server log instead, so you can copy the link from there
   (`docker compose logs app`).
2. A signed-in user with no organization is sent to `/onboarding`.
3. Everything in AgentSDR belongs to an organization. Invite teammates from
   Settings, Members; an invitation is sent by email and expires after 7 days.
4. Connect your services in Settings, Integrations
   ([integrations.md](integrations.md)).

Who may sign up (`AUTH_SIGNUP`, the platform operator) is explained in
[Going to production](self-hosting/production.mdx#who-may-sign-up).

## Email

Sign-up verification, password reset and invitations are sent through Resend.
You need it only to invite people or reset passwords; the first admin does not.
Set `RESEND_API_KEY` and `AUTH_EMAIL_FROM` (an address on a domain you have
verified in Resend). Without `RESEND_API_KEY`, they are written to the server
log instead of sent. This is separate from the email your campaigns send, which
goes out through the Gmail accounts you connect. Details:
[Going to production](self-hosting/production.mdx#transactional-email-resend).

## Scheduled jobs

The scheduled jobs run inside the app in production, so there is no cron
container and nothing to schedule: the daily rollover (email send queues, Gmail
watch renewal, LinkedIn daily limits), LinkedIn outreach every 30 minutes,
webhook replay (LinkedIn and Instagram) every 10 minutes, and history pruning. The rollover
happens at the start of each organization's day, set in Settings, Organization,
Defaults (**Time zone** and **New day starts at**; UTC and 00:00 by default).
`INTERNAL_SCHEDULER=false` turns the jobs off if you prefer an external cron
calling the endpoints. The full table, the endpoints and their secrets (now
optional) are in
[Going to production](self-hosting/production.mdx#scheduled-jobs); crontab
examples are in [From source](self-hosting/from-source.mdx#scheduled-jobs-from-outside).

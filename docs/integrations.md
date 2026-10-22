---
title: "Integrations"
description: "How AgentSDR connects to outside services, where to connect each one, and the technical webhook reference."
icon: "plug"
---

AgentSDR talks to outside services in two ways:

- **Per organization**, connected inside the app and stored encrypted in the
  database. This covers Unipile, Google Workspace, Cloudflare R2, OpenRouter and
  the enrichment providers. Each organization connects its own accounts.
- **Per instance**, configured in the environment: Resend (auth email) and the
  Google OAuth client for "Continue with Google" sign-in. See
  [configuration.md](configuration.md).

## How per-organization integrations work

- **Encrypted at rest.** Credentials are encrypted (AES-256-GCM) with the key in
  `INTEGRATION_CREDENTIALS_KEY` before they are written to the database. Secret
  values are never sent back to the browser. Leave a secret field blank when
  editing to keep the saved value.
- **Verified on save.** Each credential is checked with one live call to the
  provider before it is saved. If the check fails, nothing is stored and the
  form shows the reason.
- **Cached for 30 seconds.** Connected credentials are cached per process, keyed
  by organization and integration, so a change reaches other server instances
  within 30 seconds.
- **No environment fallback.** The keys are never read from environment
  variables. An organization that has not connected a service does not have it.
- **Features switch off when it is missing.** Background jobs skip an
  organization that has not connected the integration, user-facing routes answer
  HTTP 409 (`PlatformNotConnectedError`: "X is not connected, connect it in
  Settings, ..."), and pages show a **Connect** prompt instead of their content.

## Who can manage integrations

Connecting, editing and disconnecting an integration needs the **owner** or
**admin** role. Members use the features but cannot change credentials.

## Where to connect each one

| Integration | What it powers | Where to connect it in the app | Guide |
|---|---|---|---|
| Google Workspace | Email accounts, email campaigns, sending and reading Gmail | Settings, Email, Connection | [Google Workspace](integrations/google-workspace.mdx) |
| Gmail reply sync (Pub/Sub, optional) | Picking up email replies | Same card: the "Gmail Pub/Sub topic" field | [Gmail reply sync](integrations/gmail-reply-sync.mdx) |
| Unipile | LinkedIn accounts, invitations, messages and search; WhatsApp messaging and calling | Settings, LinkedIn, Connection (the same connection also shows under Settings, WhatsApp, Integrations) | [Unipile](integrations/unipile.mdx) |
| Cloudflare R2 | WhatsApp call recordings and contact photos | Settings, WhatsApp, Integrations | [Cloudflare R2](integrations/cloudflare-r2.mdx) |
| OpenRouter | Every AI feature: reply classification and drafts, AI columns, call transcription | Settings, AI provider | [OpenRouter](integrations/openrouter.mdx) |
| Enrichment providers (15) | Enrichment columns in Tables | Inside Tables: Actions, Add enrichment, Add account | [Enrichment providers](integrations/enrichment-providers.mdx) |
| Resend (per instance) | Verification, password-reset and invitation email | Environment: `RESEND_API_KEY`, `AUTH_EMAIL_FROM` | [Resend](integrations/resend.mdx) |
| Google sign-in (per instance) | The "Continue with Google" button | Environment: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | [Google sign-in](integrations/google-sign-in.mdx) |

Two things are deliberately **not** stored in the database: the HTTP column's
bearer token (read from an environment variable whose name the user chooses; see
[configuration.md](configuration.md#user-named-variables-tables-http-column)),
and the prospecting master `APOLLO_API_KEY`.

Google sign-in is unrelated to the Google Workspace integration, which is the
Gmail service account.

## Webhooks reference

This section is the technical detail behind the Unipile guide. In normal use you
never touch it: saving the Unipile integration registers everything.

### Registered automatically

When the Unipile integration is saved, AgentSDR registers the webhooks it needs
in your Unipile workspace through Unipile's API (`POST /api/v1/webhooks`):

| Unipile source and events | URL |
|---|---|
| `users`: `new_relation` (a LinkedIn connection request was accepted) | `/api/webhooks/connection-accepted?org=<organization id>` |
| `messaging`: `message_received`, `message_read`, `message_delivered` (LinkedIn and WhatsApp) | `/api/webhooks/unipile-message?org=<organization id>` |

Each is registered with the header `x-unipile-secret: <webhook secret>`, which
Unipile sends on every delivery, and with a JSON content type (webhooks created
through the API carry none unless asked). Settings shows whether registration
worked, a **Register again** button, and **Show URLs and secret** (owners and
admins only) for registering them by hand.

`/api/webhooks/unipile-message` is one endpoint for both channels. It routes by
`account_type`: WhatsApp events go to the WhatsApp handler
(`/api/webhooks/whatsapp-message`), a LinkedIn `message_received` goes to the
LinkedIn handler (`/api/webhooks/message-received`), and anything else (a
LinkedIn read or delivery receipt, another provider) is acknowledged and
dropped. The two handler paths stay live and public for hand-made
registrations and the LinkedIn replay job. Earlier versions registered those two
paths separately; a new registration deletes them so no message arrives twice.

### How a delivery is checked

- A URL with `org=` must carry that organization's secret, in the
  `x-unipile-secret` header or as `?secret=`, or it is refused with 401 (as is an
  unknown organization or a malformed `org`). An event for an account that is not
  that organization's (not synced yet, or another organization's sharing the same
  Unipile workspace) is acknowledged with 200 and dropped, so Unipile does not
  retry it.
- Registering replaces, never duplicates: it removes this organization's earlier
  registrations and any hand-made registration of the same endpoints that names
  no organization. Other organizations' registrations are left alone.
  Disconnecting Unipile removes this organization's own (best effort).
- Registration is skipped while `BETTER_AUTH_URL` is a `localhost` address
  (`localhost`, `127.0.0.1`, `0.0.0.0`, `[::1]`), which Unipile's servers cannot
  reach. It is also skipped when no public URL or no webhook secret is stored.
  The Settings card says why.
- Hand-made URLs without `org=` still work as before: the organization is found
  from the account in the payload. The two LinkedIn endpoints accept such a
  request with no secret (and log a warning); the WhatsApp endpoint requires
  `?secret=` or the header. Clicking **Register again** replaces them.
- Every delivery is stored in a ledger first. Failed ones are retried by the
  `replay-webhooks` job ([self-hosting.md](self-hosting.md#scheduled-jobs)).
- Unipile itself retries a delivery up to five times if your server does not
  answer 200 within 30 seconds.

### Hosted auth notify URL (`?org=`)

When a user connects a LinkedIn account through the hosted wizard, AgentSDR gives
Unipile a `notify_url`:

```
<BETTER_AUTH_URL>/api/webhooks/unipile-account?secret=<webhook secret>&org=<organization id>
```

Unipile calls it when the wizard finishes (`CREATION_SUCCESS` or `RECONNECTED`),
and AgentSDR then syncs the LinkedIn and WhatsApp accounts, each in its own
try/catch. The `org` parameter tells the public endpoint whose secret to check
before it reads anything. URLs created before `org` existed carry only `secret`;
the organization is then the one whose stored secret matches. The payload is
treated as a nudge only: every field is re-read from the Unipile API. The notify
URL is **omitted** when `BETTER_AUTH_URL` (the public origin) is a `localhost`
address or when no webhook secret is stored, because Unipile's servers cannot
reach it. Locally, the redirect back to the accounts page syncs anyway.

### WhatsApp send limits

No warm-up after a number is linked (new chats start right away), 25 new chats a
day per number, and 30 seconds between sends are the defaults, enforced server-side. They
are per-organization sending rules (Workspace, Sending rules; see
[Sending rules](workspace/sending-rules.mdx)), not
environment variables.

# Managed SaaS: included services, operator panel, own providers, isolated Unipile

Branch `codex/managed-saas-20261022`, based on `origin/codex/pilot-deploy-20261021`
at `5c1d03f` (the deployed line). Not merged, not deployed.

A paying customer describes their business, connects their sending accounts
and asks the assistant for leads and outreach. AI, TinyFish, Tavily, Bright
Data, Apify and Unipile come from the platform by default (**Included
service**), with no developer account or key on the customer's side. A
customer can still choose **My own provider** per provider under Advanced;
an organization that already saved its own credentials keeps them and keeps
"My own provider" selected, so nothing changes for it on upgrade.

## Status

| Step | What | State |
|---|---|---|
| 0 | This plan | written |
| a | Platform operator grant (`platform_operators`), operator route guard, LinkedIn job logs | done: `scripts/grant-platform-operator.ts`, `src/lib/auth/operatorAccess.server.ts`; auth-policies e2e covers grant, re-grant, unknown address, revoke, workspace owners |
| b | Platform credential store, per-provider Included/My own choice, resolver | done: `src/lib/managed/` (catalog, allowances, store, modes, verify), the Anthropic engine adapter `src/lib/ai/server/anthropicRuntime.ts`; migration writes `own` for every organization with saved credentials |
| c | Consumers switched to the resolver (AI, Unipile, TinyFish, Tavily, Bright Data, Apify, workers, gates) | done for AI (incl. the Anthropic engine), TinyFish, Tavily, Bright Data, Apify; Unipile in (f); `scripts/e2e/managed-saas.ts` |
| d | Operator panel (default keys, Included AI engine and model, usage), adopt-defaults action | done: `/platform`, `/api/platform/*` (credentials, ai, usage, adopt); `scripts/e2e/platform-admin.ts` (owner/admin/member 404 on every route, 401 signed out, cross-origin 403, masked answers, adopt keeps originals) |
| e | Customer settings: Plan & usage, Advanced → Use your own providers | done: `/settings/usage`, `/settings/providers` (+ `/api/settings/providers`), the Unipile / Google / AI provider pages moved under Advanced, Included cards for TinyFish, Tavily, Bright Data, Apify |
| f | Unipile ownership, hosted-auth connection flow, scoped sync/send/webhooks, allowance | done: `src/lib/unipile/` (ownership, connect, accounts), `/api/unipile/connect`, `/api/unipile/accounts/disconnect`, the guarded client in `src/services/unipile.service.ts`, the `org=managed` webhook gate; `scripts/e2e/unipile-ownership.ts` (69 checks) |
| g | Usage accounting and allowances | done in the same commit: `provider_usage.credential_source` / `cost_usd`, `apify_runs.credential_source`, `src/lib/managed/usage.server.ts` (allowance locks), `aiMeter.server.ts` (every AI call metered) |
| h | Docs, gates, push | planned |

## Words

- **Included service**: a provider the platform supplies, on the platform's
  own credentials, within the workspace's allowance.
- **My own provider**: the workspace's own saved credentials for that
  provider. Explicit per provider. A failing or missing own key is an error;
  it never falls back to the platform's account.
- **Platform operator**: a person explicitly granted operator access in
  `platform_operators` by an operator command. Not a role in any
  organization; owning or creating a workspace never grants it.
- **Scope** (Unipile API v2): an isolation boundary for connected accounts
  inside one Unipile Application, with its own scoped API keys. Not used yet
  (see Unipile below); `unipile_account_owners.scope_id` is reserved for it.

## Design

### 1. Platform operator

- `platform_operators (user_id uuid PK → users, granted_by, note, granted_at)`,
  GLOBAL in the tenancy registry.
- Granted and revoked only by `bun run scripts/grant-platform-operator.ts
  --email <address> [--revoke]`, run by whoever runs the server. No route
  grants it.
- `isPlatformOperator(ctx)` reads that table by user id. The old rule
  ("owner or admin of the initial organization") is gone.
- Operator API routes start with `requireOperator(request)`: a signed-in
  session whose user is in `platform_operators`; anything else is 404 (the
  routes do not confirm they exist). Customer roles (owner, admin, member)
  grant nothing here.
- LinkedIn `JobRun`/`JobLog` (platform-wide, covering every organization)
  are visible only to platform operators. Decision: until the first grant,
  nobody sees them; the upgrade step below grants the existing operator.
- The Claude Code subscription-login pilot keeps its own gate (owner of the
  operator organization, `operatorOrganizationId`), unchanged: it is not a
  platform service and is never offered to other workspaces.

Upgrade step (explicit, documented, not inferred): after deploying, run
`bun run scripts/grant-platform-operator.ts --email <the operator's email>`.

### 2. Shared credentials and resolution

- `platform_credentials (provider PK, encrypted_payload, config jsonb,
  fingerprint, source_organization_id, updated_by, timestamps)`, GLOBAL.
  Providers: `unipile`, `openrouter`, `aimlapi`, `anthropic`, `tinyfish`,
  `tavily`, `brightdata`, `apify`. Encrypted with
  `INTEGRATION_CREDENTIALS_KEY` like every integration. `config` holds only
  non-secret values and masked hints (`…abcd`).
- `platform_settings (key PK, value jsonb)`, GLOBAL: the Included AI engine
  and its default model configuration (`key = 'ai'`).
- `provider_credential_modes (organization_id, provider, mode, reason,
  updated_by, updated_at)`, SCOPED, PK (organization, provider). Providers:
  `ai`, `unipile`, `tinyfish`, `tavily`, `brightdata`, `apify`. The
  migration writes `own` for every organization with saved credentials for
  that provider. With no row, the resolver uses `own` when own credentials
  exist and `managed` otherwise.
- Resolver (`src/lib/managed/`): every consumer asks for the workspace's
  credentials and gets `{ source: "managed" | "own", … }` or a reason it is
  unavailable. Managed = the platform's row; own = the workspace's row.
  Never both, never a fallback.
- Caches: platform credentials 30 s per process keyed by provider (cleared in
  this process on save/remove); modes 30 s keyed by (organization, provider).
  A rotation reaches other instances within 30 s.
- Google Workspace (Gmail service account) and Cloudflare R2 stay
  customer-owned only: Google is tied to the customer's own domain, and R2
  holds call recordings; neither was asked for as an included service.

### 3. AI engines

The operator stores AI/ML API, OpenRouter and Anthropic (Claude API) keys
and chooses which engine and default model every Included workspace uses.
Anthropic runs through a new runtime adapter (`src/lib/ai/server/anthropic*.ts`)
on the Messages API with the stored key; structured answers are one forced
tool call, like AI/ML API's function-call mode. The Claude Code subscription
login stays an owner-only pilot of the operator organization and is shown in
the panel as "owner-only pilot (subscription login)", not selectable.
Customers on My own provider keep their own connection and models.

### 4. Unipile

See "Unipile: what the docs say" below. v1 (what the code uses) has no
Scopes, so isolation is an authoritative ownership mapping
(`src/lib/unipile/`):

- `unipile_account_owners (account_id PK, organization_id, channel,
  credential_source, claimed_via, claimed_by, scope_id, status, timestamps)`,
  SCOPED. The Unipile account id stays globally unique (a provider identity);
  inbound webhooks find their organization through it. An owner is never
  replaced. Disconnecting marks the row `released`: the id stays that
  organization's and only it can make it active again.
- `unipile_connect_states (id, organization_id, user_id, channel, kind,
  reconnect_account_id, credential_source, token_hash, status, account_id,
  reason, created_at, expires_at, completed_at)`, SCOPED.
- Connecting (`POST /api/unipile/connect { channel, accountId? }`; the
  LinkedIn and Instagram link routes call the same code): the server mints
  the hosted-auth link for the signed-in workspace with an opaque state id as
  `name` and a per-link secret token in `notify_url` (only its sha256 is
  stored; links expire after 15 minutes; at most 20 links an hour per
  workspace). The browser names only a channel and, to reconnect, one of its
  own row ids; never an organization or a Unipile account id. LinkedIn
  accounts and WhatsApp numbers can be connected by any member (a rep's own,
  as before); Instagram accounts and email inboxes by owners and admins. On
  the Included Unipile a link needs the public origin (`BETTER_AUTH_URL`),
  since only the callback claims.
- Callback (`/api/webhooks/unipile-account?state=…&token=…`): the state must
  exist and the token match (else 401, nothing recorded); the body must name
  the state and report `CREATION_SUCCESS` (`RECONNECTED` for a reconnect).
  Then, recorded on the state: pending and unexpired; the workspace still on
  the Unipile that minted the link; the account re-read from Unipile with
  that key; its type the channel's; a new account created after the link was
  minted (5 minutes' clock skew), a reconnect exactly the account named. The
  claim runs under the organization's advisory lock and, on the Included
  Unipile, the connected-account allowance (workspace and platform, under
  that allowance's platform-wide lock). An account owned by another
  organization is refused and logged, never reassigned.
- Sync (LinkedIn, WhatsApp, Instagram, email) keeps only the accounts this
  organization owns; the rest of the listing is ignored, and a row whose
  account it does not own is marked disconnected like any unlisted one. With
  My own provider, an account the workspace's own key lists and nobody owns
  is claimed (`own_sync`), as syncs always did; never when the own key is the
  platform's key.
- Sends and reads: on the Included Unipile the client is wrapped so that
  every SDK call naming an account (`account_id`, `reconnect_account`, an
  `account.*(id)` call) is refused before it is sent unless the organization
  owns that account; minting links or connecting accounts outside the flow is
  refused; the raw LinkedIn search call checks the same. Calls addressed by
  chat id (sending into an existing chat, reading its messages) carry no
  account; their chat ids come only from the workspace's own rows, which are
  created only for accounts it owns.
- Disconnect (`POST /api/unipile/accounts/disconnect { channel, id }`,
  owners and admins): by the workspace's own row id; removed from Unipile,
  the row kept as disconnected, the ownership released.
- Webhooks: storing the platform's Unipile registers its webhooks once, with
  `org=managed` and the platform's generated secret (removing the key removes
  them). A delivery there is accepted only for an account whose active owner
  is on the Included Unipile, and its rows must be that owner's; anything else
  is acknowledged and dropped. Per-organization URLs (`org=<id>`) and
  hand-registered ones (no `org`) also drop an account owned by another
  organization.
- Existing accounts get an ownership row for the organization that holds
  them (`claimed_via = existing`, idempotent); an account two organizations
  hold is printed by the migration as a conflict and left with whichever
  ownership row exists.

### 5. Usage and allowances

- One platform-wide default allowance set in code (`src/lib/managed/allowances.ts`,
  the style of `src/lib/channels/rules.ts`): per workspace per month, and a
  platform budget per month, for each Included provider; connected accounts
  per channel for Unipile. No per-workspace plan editor.
- Every metered call is a `provider_usage` row with `credential_source`
  (`managed` / `own`) and `cost_usd` (estimated unless the provider reported
  it). Included use is reserved inside the provider's existing reservation
  transaction under a platform-wide advisory lock per provider, which checks
  both the workspace allowance and the platform budget; then settled. A lost
  answer stays `uncertain` and counted; nothing is re-sent automatically.
- The request research-spend cap (`spendCapUsd`, `objectiveSpendUsd`) keeps
  its meaning; the allowance is counted separately.

## Unipile: what the docs say

Read on 22 Oct 2026 (public pages only; nothing was called):

- <https://developer.unipile.com/v2.0/docs/scopes>
- <https://developer.unipile.com/v2.0/docs/authenticate-with-hosted-auth>
- <https://developer.unipile.com/v2.0/docs/api-keys.md>
- <https://developer.unipile.com/v2.0/reference/createapikey.md>
- <https://developer.unipile.com/v2.0/reference/createscope.md>
- <https://developer.unipile.com/v2.0/reference/createauthlink.md>
- <https://developer.unipile.com/v2.0/reference/getaccount.md>
- <https://developer.unipile.com/v2.0/reference/createwebhookendpoint.md>
- <https://developer.unipile.com/v2.0/reference/event-types-1.md>
- <https://developer.unipile.com/v2.0/docs/configure-a-webhook.md>
- <https://developer.unipile.com/v2.0/docs/migration-from-v1.md>,
  `migration-auth-and-accounts.md`, `migration-webhooks.md`,
  `transfer-accounts-subscription.md`, `webhooks-introduction.md`
- <https://developer.unipile.com/v2.0/llms.txt> (index)
- <https://developer.unipile.com/docs/hosted-auth> (v1)

**Scopes are a v2 feature.** v2 lives at `https://api.unipile.com/v2/…`,
not at the per-workspace DSN the code calls (`{DSN}/api/v1/…`, through
`unipile-node-sdk`). The v1 hosted-auth page documents a single `X-API-KEY`
and no scopes or per-tenant keys.

v2, as documented:

- A Scope is an isolation boundary inside one Application; it has an id
  (`scope_…`), a `name`, an optional `reference` unique in the Application
  (your tenant id), and `status` `active`/`disabled`. Scoped resources share
  the Application's configuration, Hosted Auth settings and webhook
  endpoints. Create: `POST /v2/scopes` `{ name, reference? }` with a Service
  API Key; also `GET/PATCH/DELETE /v2/scopes/{id}` (delete only when empty).
- Keys: Service API Key (Dashboard only; manages accounts, webhooks, scopes
  and keys), global Account API Key, scoped Account API Key. Create an
  account key: `POST /v2/api-keys` `{ name, expires_at, access: { type:
  "scope", scope_id } }` with a Service key → `{ object: "ApiKey", id: "pk_…",
  api_key }`; the token is returned once only. Every key expires
  (`401 api/expired_authorization` after); rotate by creating a new key and
  deleting the old one (`DELETE /v2/api-keys/{id}`). `GET /v2/accounts` with
  a scoped key lists only that scope's accounts.
- Assignment is permanent: "Once an account has a scope, the scope cannot be
  removed or replaced." A wrong assignment means removing the account and
  connecting it again. Reconnecting keeps the scope.
- Hosted auth: `POST /v2/auth/link` `{ expires_on, redirect_uri, providers |
  account_id, account_scope_id?, state?, domain?, config? }` →
  `{ object: "HostedAuthLink", link }`. Providers are lowercase in v2. There
  is no `notify_url` and no `name`: the redirect carries `account_id`,
  `provider` and `state`; the `account.add` / `account.reconnect` webhook
  carries `account` and `state`. The page says to treat the callback as a
  pointer and re-read `GET /v2/accounts/{account_id}`. No maximum lifetime is
  given.
- Webhooks: `POST /v2/webhooks/endpoints` `{ url, trigger_events,
  account_ids?, description? }` → includes a `secret`; deliveries are signed
  (`unipile-signature: t=<unix>,v0=<hex HMAC-SHA256 of "t.raw_body">`), no
  custom headers. Every event envelope carries `account_id`,
  `account_scope_id`, `account_provider` and `type`; route by
  `account_scope_id`. Event names changed (`message.new`, `relation.new`,
  `email.new`, `account.status.*`, …).
- Migration: v1 is not deprecated and has no end date; new features ship
  only in v2. Moving accounts to v2 is a copy run from the v1 dashboard with a
  v2 Service key; existing sessions are kept except WhatsApp, which must be
  reconnected in v2. The account object changes (`type` → `provider`,
  `connection_params` removed, which the WhatsApp phone reader uses today).

v1 hosted auth (what the code uses): `POST {DSN}/api/v1/hosted/accounts/link`
`{ type: create|reconnect, providers, api_url, expiresOn, notify_url, name,
success_redirect_url, failure_redirect_url, reconnect_account }`; the
`notify_url` receives `{ status: "CREATION_SUCCESS" | "RECONNECTED",
account_id, name }`, unsigned; links expire on Unipile's daily restart
whatever `expiresOn` says.

**Conclusion.** Scopes cannot be used without moving every Unipile call
(LinkedIn engine, WhatsApp, Instagram, email, webhooks) to v2 and copying
the accounts, which also forces every WhatsApp number to be reconnected.
That migration cannot be tested here without live calls. This branch uses
the fallback the owner allowed: an authoritative account→workspace mapping
created only by a verified hosted-auth callback (or the one-time backfill),
with every list, sync, send and webhook filtered by it. The v2 upgrade path
is below.

### The v2 upgrade (not done here)

1. Create a v2 Application, a Service API Key, and copy the subscription and
   accounts from the v1 dashboard (Transfer Accounts & Subscription).
2. Per workspace: `POST /v2/scopes { name, reference: <organization id> }`,
   then `POST /v2/api-keys { access: { type: "scope", scope_id } }`; store the
   scope id in `unipile_account_owners.scope_id` / a per-organization row and
   the key encrypted like every credential, with its `expires_at`; rotate
   before expiry.
3. Existing accounts: assign each owned account to its workspace's scope
   (`PATCH /v2/accounts/{id} { account_scope_id }`, Service key). Permanent,
   so only from `unipile_account_owners`, and only after its conflicts are
   resolved.
4. Hosted auth on `POST /v2/auth/link` with the scoped key (or
   `account_scope_id`) and `state`; claim on `account.add` with `state`.
5. Webhooks on `/v2/webhooks/endpoints`, verify `unipile-signature`, route by
   `account_scope_id`; rename the event handlers.
6. Reconnect every WhatsApp number.

## Decisions for the owner to confirm

1. The operator panel holds only default keys, the Included AI engine and
   model, and usage. No plan assignment, suspension or provider-health
   dashboard.
2. Allowances are one platform-wide default set in code; no per-workspace
   plans. Billing infrastructure does not exist in the repo; none was added.
3. LinkedIn job logs: platform operators only; nobody until the first grant.
4. Google Workspace and R2 remain My own provider only.

## Commit sequence

1. Plan doc.
2. Operator grant and guard.
3. Credential store, modes, resolver, migration.
4. Consumers on the resolver; AI engines incl. Anthropic.
5. Operator panel and adopt action.
6. Customer settings.
7. Unipile ownership and connection flow.
8. Usage accounting and allowances (if not folded into 4/7).
9. Docs and gates.

## Migration and deploy

Nothing new in env. `INTEGRATION_CREDENTIALS_KEY` (already set) encrypts the
platform's credentials; `BETTER_AUTH_URL` must be the public https origin,
since on the Included Unipile a connection is confirmed by Unipile calling
it back.

1. **Deploy the image as usual.** `docker/deploy.sh` runs
   `scripts/add-managed-saas.ts` with the other `DEFAULT_MIGRATIONS` (one
   transaction, `lock_timeout` 10 s, idempotent). It creates
   `platform_operators`, `platform_credentials`, `platform_settings`,
   `provider_credential_modes`, `unipile_account_owners`,
   `unipile_connect_states`; adds `provider_usage.credential_source` /
   `cost_usd` and `apify_runs.credential_source` (default `own`); writes
   `own` for every organization that saved its own AI connection, Unipile,
   TinyFish, Tavily, Bright Data or Apify key; gives every Unipile account an
   organization already holds an ownership row for it; prints the operator
   count, the ownership count and any ownership conflict (never resolved
   automatically). By hand: `bun run scripts/add-managed-saas.ts`.
2. **Grant the first operator, explicitly.** Until this runs nobody sees
   `/platform` or the LinkedIn job logs (before, owners and admins of the
   initial organization saw the job logs):
   `docker compose exec app bun scripts/grant-platform-operator.ts --email <operator email> --note "initial operator"`
   (`--list` shows grants, `--revoke` removes one).
3. **Default keys.** On `/platform` the operator stores each provider's key
   (verified with one call first; TinyFish's check is one search), or uses
   **Adopt** to copy the keys an existing organization (e.g. the initial one)
   saved for itself: that organization keeps its own rows and stays on My own
   provider. Storing Unipile generates the platform's webhook secret and
   registers the platform's webhooks (`org=managed`). Adopting the initial
   organization's Unipile means both its own registrations and the
   platform's sit on that Unipile account, so each event is delivered twice
   and each copy is routed to (or dropped for) its owner.
4. **Included AI.** Store at least one AI key, then pick the engine
   (OpenRouter, AI/ML API or Anthropic) and the default model; OpenRouter also
   needs BYOK-only routing confirmed. Until then Included workspaces' AI steps
   stop with "The included AI service is not available right now…" and
   nothing is sent.
5. **What customers see.** Organizations that had their own keys keep them,
   on My own provider, unchanged. Every other organization is on the
   Included service for each provider whose platform key is stored, within
   the allowances in `src/lib/managed/allowances.ts`. Their existing
   Unipile accounts (if any were on their own Unipile) stay theirs.

**Rollback.** Everything is additive (new tables; new columns with
defaults; one CHECK widened), so the previous image runs on the migrated
database: redeploy it. Then Included workspaces lose their Included
providers again (the old code has no such thing), accounts connected
through the platform's Unipile stay connected there unused, and the new
tables and columns are ignored; redeploying this version picks everything up
again. Do not drop the new tables: `unipile_account_owners` is the record of
who owns which account. To stop one Included provider at runtime without a
rollback, the operator removes its key on `/platform` (that process at once,
others within 30 s); workspaces on My own provider are unaffected.

## Verification

To be completed with the final gate run.

## Limitations

- **Unipile isolation is an ownership mapping, not Unipile Scopes** (v1 has
  none; see above). The callback's secret token travels only in the
  server-to-server `notify_url`; a forged callback without it claims
  nothing. A residual window remains: a workspace holding a valid token of
  its own could claim an account created in the platform's Unipile by
  someone else in the minutes before that account's own callback arrived,
  if it learned the new account's id (ids are not shown to browsers). The v2
  move removes this.
- An account whose claim is refused stays connected in the platform's
  Unipile (it is never deleted automatically); the operator removes such
  strays in Unipile's dashboard. They count against the subscription.
- If Unipile answers a "create" with an existing, older account id that no
  workspace owns (e.g. a profile connected earlier straight in Unipile's
  dashboard), the claim is refused ("not created by this connection"); an
  operator decides.
- Calls addressed by chat id (send into an existing chat, read its messages)
  are not re-checked against Unipile; their chat ids come only from the
  workspace's own rows, which exist only for accounts it owns.
- Two organizations sharing one own Unipile key (not the platform's): a sync
  still claims an unowned account for whichever syncs first, as before.
- Connecting an account on the Included Unipile needs the public origin; on
  localhost only own-key connections work. Here it was exercised against a
  stand-in only.
- AI columns in tables and image generation run on own AI only; on the
  Included service they are refused with a message pointing to My own
  provider.
- Allowances are one default set in code; no plan editor, no billing or
  invoices. An AI call reserves US$0.05 before it is sent and settles at its
  cost, so calls in flight together can pass the AI allowance by their own
  cost. Costs are estimates unless the provider reported them (Anthropic
  from tokens and list prices; TinyFish, Tavily and Bright Data from unit
  rates).
- A rotated or removed platform key reaches other instances within 30 s.
- `/platform` has no link in the app's navigation; operators open it by
  address.
- Google Workspace and Cloudflare R2 stay My own provider only.
- The Claude Code subscription pilot keeps its own gate (owner of the
  operator organization), separate from the platform operator grant; it is
  never offered to Included workspaces.

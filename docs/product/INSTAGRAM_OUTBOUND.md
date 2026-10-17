# Instagram outbound

Instagram discovery can feed an approved outreach plan. A connected Unipile
Instagram account sends **one initial DM per assigned profile**. Replies enter
the existing inbox and CRM and follow the run's Automatic or Review mode.
There are no unsolicited Instagram follow-ups in this implementation.

This extends the earlier inbox-only design in
[Instagram intake and discovery](INSTAGRAM_INTAKE_DISCOVERY.md).

## Upgrade and use

After building the new image, before starting its app service, run:

```sh
docker compose run --rm app bun scripts/add-instagram-outreach.ts
```

The additive migration is safe to run again. It adds an outbound queue and an
account throttle timestamp; existing messages and plans are preserved. Fresh
installs include the same schema.

Enable Instagram in Settings → Organization and connect an Instagram account
through Unipile. In Assistant, request Instagram discovery and outreach, then
review and start its plan (Autonomous mode uses its existing authorization and
daily caps). Explicit channel choices are respected. An Instagram search with
contactAfter and no channel choice prefers Instagram, then email and WhatsApp.
Other searches keep their normal channel preference. Each person gets one
assigned channel in a plan.

Settings → Instagram → Sending rules controls the initial DM cap, send gap and
hours. Defaults are 10 attempts per account in a rolling 24 hours, 5–10 minutes
between attempts, and Monday–Friday 09:00–17:00 UTC. **These are application
defaults, not Unipile or Instagram guarantees.** Accounts and recipients may
have stricter restrictions. A plan cannot exceed its approved initial-DM cap
even if the organization's cap is later raised.

The inquiry-intake checkbox is for new people who write first. Outbound
recipients' replies do not require that checkbox. Previously excluded
Instagram-only discoveries are not silently enrolled; run a new search to
prepare a new plan.

## Identity and delivery

Instagram-only profiles become People without fabricated email or phone
details. Matching is scoped to the organization and canonical username;
ambiguous identities are refused. A comment's numeric provider ID is not
treated as a discovered username.

Before each send, the worker resolves the exact username with Unipile's v1
profile endpoint and requires `provider_messaging_id`. It never substitutes a
scraped profile ID, `pk` or `provider_id`. The initial DM uses multipart
`POST /api/v1/chats` with that messaging ID in `attendees_ids`.

- [Retrieve a profile](https://developer.unipile.com/reference/userscontroller_getprofilebyidentifier)
- [Start a chat](https://developer.unipile.com/reference/chatscontroller_startnewchat)

Each run/person has one durable queue reservation. The worker rechecks
approval, run and member status, account connection, Do Not Contact, new
inbound replies, sender identity, sending hours, throttle and rolling cap
before crossing the send boundary. Account locks and claims coordinate app
instances. Pause and stop prevent new attempts; an already submitted DM may
complete.

Definite provider refusals are recorded as failed. A timeout, lost response,
5xx or restart after submission is recorded as delivery uncertain and is
**never automatically resent**. An early outbound webhook can reconcile the
reservation without appearing as a manual Instagram send. Uncertain sends
remain excluded from confirmed-send totals until reconciled.

`PAUSE_INSTAGRAM_OUTBOUND=true` pauses new initial DMs. The master
`PEOPLE_MIGRATION_MODE` also pauses them. This does not replace existing reply
controls.

## Diagnostics and verification

Ask the Assistant why a run is waiting. `diagnose_delivery` reports actual
email mailbox queues, working hours and timezone, next-send delay, capacity,
campaign status and recent failures; for Instagram it reports queue state,
account gates and recent failures. It does not measure worker liveness or
promise delivery. A lead's city never selects a sender's timezone.

Backend checks use simulated provider responses, including refusal, timeout,
post-send persistence failure, changed approval and identity checks. Database
replays cover fresh schema, queue deduplication, pause/stop, DNC/opt-out,
disconnection, restart and early webhook reconciliation. Live Unipile
permissions and recipient acceptance still need verification on the deployed
installation with an owner-selected test recipient.

To repeat the database replay on an empty local PostgreSQL database:

```sh
INSTAGRAM_TEST_DATABASE_URL=postgres://user:password@127.0.0.1:5432/agentsdr_test_instagram \
  bun --conditions=react-server scripts/test-instagram-outreach.ts
```

The replay refuses non-local databases and names outside `agentsdr_test_*`;
it initializes the fresh schema and simulates every provider send. It also
supports an isolated in-memory PGlite transport through
`INSTAGRAM_TEST_PGLITE_MODULE` pointing to a separately installed PGlite module.
